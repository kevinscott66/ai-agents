/**
 * Stage A: Mac daemon. Connects to the backend WebSocket bridge as a single
 * client, waits for "run" commands, spawns the `claude` CLI with stdin =
 * prompt, streams stdout/stderr back as chunks, and sends a final "result".
 *
 * Auto-reconnect with backoff 1→2→5→10s. Soft kill (SIGINT) of active child
 * on socket close. Project allowlist enforced via MAC_PROJECT_ROOTS (CSV).
 */
import { resolve as pathResolve, dirname } from "node:path";
import { realpathSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { bridgeSecretTransportError } from "./bridge-url.ts";
import { cancelRun, killAll, type KillableChild } from "./kill.ts";
import { parseBridgeMsg, toPermissionMode, type RunMsg } from "./protocol.ts";
import { sanitizeChildEnv, resolveClaudeBin } from "./child-env.ts";
import { createAuthGate } from "./auth-gate.ts";
// Порт в подсказке при старте: раньше литерал 8787 — это HTTP-порт Mini App,
// а не мост. Оператор по такой подсказке открывал WS к серверу панели, где
// апгрейда нет, и получал бесконечный реконнект без единого слова про порт.
import { DEFAULT_MAC_BRIDGE_PORT } from "../lib/constants.ts";

const URL_ENV = process.env.MAC_BRIDGE_URL;
const SECRET = process.env.MAC_BRIDGE_SECRET ?? "";
const ROOTS_CSV = process.env.MAC_PROJECT_ROOTS ?? "";
const CLAUDE_BIN = resolveClaudeBin(process.env);

if (!URL_ENV) {
  console.error(
    `MAC_BRIDGE_URL is required (e.g. wss://host:${DEFAULT_MAC_BRIDGE_PORT})`,
  );
  process.exit(1);
}
if (!SECRET || SECRET.length < 32) {
  console.error(
    "MAC_BRIDGE_SECRET must be set and at least 32 characters long",
  );
  process.exit(1);
}
if (!ROOTS_CSV.trim()) {
  console.error("MAC_PROJECT_ROOTS is required (CSV of absolute paths)");
  process.exit(1);
}
// Секрет уходит первым фреймом при открытии сокета, поэтому адрес проверяем
// здесь — после открытия проверять уже нечего, утечка состоялась.
const transportError = bridgeSecretTransportError(
  URL_ENV,
  process.env.MAC_BRIDGE_INSECURE_PLAINTEXT === "1",
);
if (transportError) {
  console.error(transportError);
  process.exit(1);
}

const ROOTS = ROOTS_CSV.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => pathResolve(p));

function resolveAllowedProject(project: string): string | null {
  const abs = pathResolve(project);
  // The project dir may not exist yet — a common task is to CREATE a new project
  // under an allowed root. So walk up to the nearest EXISTING ancestor and
  // canonicalize THAT with realpath (symlink-safe). Re-audit M1 protection holds:
  // the existing part is realpath'd, and pathResolve already collapsed any `..`,
  // and the non-existent tail can contain no symlinks.
  let anc = abs;
  while (!existsSync(anc)) {
    const parent = dirname(anc);
    if (parent === anc) return null; // reached fs root, nothing exists → deny
    anc = parent;
  }
  let realAnc: string;
  try {
    realAnc = realpathSync(anc);
  } catch {
    return null;
  }
  // The existing ancestor must sit inside an allowed root (canonical compare).
  const ancInRoot = ROOTS.some((root) => {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      return false;
    }
    return realAnc === realRoot || realAnc.startsWith(realRoot + "/");
  });
  if (!ancInRoot) return null;
  // `abs` is `anc` or below it by construction (we walked up from abs); with `..`
  // already collapsed, it cannot escape the realpath'd ancestor.
  if (!(abs === anc || abs.startsWith(anc + "/"))) return null;
  if (!existsSync(abs)) return abs;
  try {
    if (!lstatSync(abs).isDirectory()) return null;
    const realProject = realpathSync(abs);
    const insideRoot = ROOTS.some((root) => {
      try {
        const realRoot = realpathSync(root);
        return realProject === realRoot || realProject.startsWith(realRoot + "/");
      } catch {
        return false;
      }
    });
    return insideRoot ? realProject : null;
  } catch {
    return null;
  }
}

const activeChildren = new Map<string, ReturnType<typeof Bun.spawn>>();

function sendChunk(
  ws: WebSocket,
  id: string,
  stream: "stdout" | "stderr",
  data: string,
): void {
  try {
    ws.send(JSON.stringify({ type: "chunk", id, stream, data }));
  } catch {}
}

function sendResult(
  ws: WebSocket,
  id: string,
  ok: boolean,
  code: number | undefined,
  error?: string,
): void {
  try {
    ws.send(JSON.stringify({ type: "result", id, ok, code, error }));
  } catch {}
}

async function handleRun(ws: WebSocket, msg: RunMsg): Promise<void> {
  const { id, project, prompt, mode } = msg;
  let allowedProject = resolveAllowedProject(project);
  if (!allowedProject) {
    // T-721: tell the caller which roots ARE allowed so it can retry with a
    // valid path — WITHOUT widening the allowlist (which stays a hard control).
    sendResult(
      ws,
      id,
      false,
      undefined,
      `project_not_allowed: ${project}. Allowed roots: ${ROOTS.join(", ") || "(none configured)"}`,
    );
    return;
  }
  // The project dir may not exist yet (task = build a NEW project here). Bun.spawn
  // fails if cwd doesn't exist, so create it (allowlist already verified it's a
  // new dir UNDER an allowed root). Without this, "build into a fresh dir" → code=1.
  if (!existsSync(project)) {
    try {
      mkdirSync(project, { recursive: true });
      console.log(`[daemon] created project dir ${project}`);
    } catch (e) {
      sendResult(ws, id, false, undefined, `mkdir failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }
  // Re-check after mkdir and use the canonical cwd. This narrows the window in
  // which a symlink replacement could redirect Claude outside the allowlist.
  allowedProject = resolveAllowedProject(project);
  if (!allowedProject) {
    sendResult(ws, id, false, undefined, "project_not_allowed_after_create");
    return;
  }
  // Наших режимов пять, у CLI — четыре. Таблица соответствия и объяснение,
  // почему `auto` не отдельный режим, живут в protocol.ts (SEC-audit LOW-1).
  const permissionMode = toPermissionMode(mode);
  console.log(
    `[daemon] run id=${id} project=${project} mode=${mode} (CLAUDE_PERMISSION_MODE=${permissionMode})`,
  );
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({
      // Re-audit C1: pass the REAL `--permission-mode` flag. Previously the mode
      // was only set via the CLAUDE_PERMISSION_MODE env var, which the Claude CLI
      // ignores — so the operator-selected mode (plan/ask/…) was never enforced.
      cmd: [CLAUDE_BIN, "--print", "--permission-mode", permissionMode],
      cwd: allowedProject,
      // SEC-audit: the spawned `claude` must not inherit daemon credentials.
      // Authentication belongs to the local Claude installation/keychain; only
      // the explicit non-secret runtime environment crosses this boundary.
      env: sanitizeChildEnv(process.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    sendResult(
      ws,
      id,
      false,
      undefined,
      `spawn_failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  activeChildren.set(id, child);
  // Feed prompt on stdin and close.
  try {
    const w = child.stdin as unknown as WritableStreamDefaultWriter<Uint8Array>;
    const enc = new TextEncoder();
    if (typeof (child.stdin as any).write === "function") {
      (child.stdin as any).write(enc.encode(prompt));
      (child.stdin as any).end();
    } else {
      await w.write(enc.encode(prompt));
      await w.close();
    }
  } catch (e) {
    console.error("[daemon] stdin write failed:", e);
  }

  let stderrTail = "";
  const pumpStream = async (
    stream: ReadableStream<Uint8Array> | null,
    kind: "stdout" | "stderr",
  ) => {
    if (!stream) return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = dec.decode(value, { stream: true });
      if (kind === "stderr") stderrTail = (stderrTail + text).slice(-600);
      sendChunk(ws, id, kind, text);
    }
    const tail = dec.decode();
    if (tail) sendChunk(ws, id, kind, tail);
  };
  try {
    await Promise.all([
      pumpStream(child.stdout as any, "stdout"),
      pumpStream(child.stderr as any, "stderr"),
    ]);
    const code = await child.exited;
    activeChildren.delete(id);
    // On failure include the stderr tail so «code=1» is diagnosable in chat
    // (auth errors, missing deps, etc.) instead of an opaque exit code.
    sendResult(
      ws,
      id,
      code === 0,
      code,
      code === 0 ? undefined : `exit ${code}: ${stderrTail.trim().slice(-300) || "(no stderr)"}`,
    );
  } catch (e) {
    activeChildren.delete(id);
    sendResult(
      ws,
      id,
      false,
      undefined,
      e instanceof Error ? e.message : String(e),
    );
  }
}

function killAllChildren(): void {
  // SIGINT с переходом на SIGKILL — см. mac-daemon/kill.ts. Раньше здесь был
  // только SIGINT, а следом clear(): процесс, проигнорировавший сигнал,
  // оставался жить, и демон о нём уже не помнил.
  const n = killAll(activeChildren as Map<string, KillableChild>);
  if (n > 0) console.log(`[daemon] killing ${n} active run(s)`);
}

let backoffIdx = 0;
const BACKOFFS = [1000, 2000, 5000, 10000];

// Liveness watchdog. Мост пингует каждые 30с. Если SSH-туннель умирает молча
// (сон/смена сети), WS становится «полуоткрытым зомби» — событие close не
// приходит минутами, и daemon не реконнектится, хотя launchd уже перезапустил
// туннель. Watchdog ловит тишину (нет ни одного сообщения, включая ping, за
// STALE_MS) и принудительно закрывает сокет → close → scheduleReconnect через
// свежий туннель. Это и есть «мак в сети → сессия подключается сама».
let watchdog: ReturnType<typeof setInterval> | null = null;
let lastBridgeMsg = 0;
/** Период пинга моста — `PING_INTERVAL_MS` в `agent/lib/mac-bridge.ts`. */
const BRIDGE_PING_MS = 30_000;
/** Тишина дольше 2.5 пинга = соединение мёртвое (а не «пинг разошёлся с тиком»). */
const STALE_MS = 2.5 * BRIDGE_PING_MS;
/** Тикаем вдвое чаще пинга: задержка обнаружения ≤ полпинга. */
const WATCHDOG_TICK_MS = BRIDGE_PING_MS / 2;

function startWatchdog(ws: WebSocket): void {
  stopWatchdog();
  watchdog = setInterval(() => {
    if (Date.now() - lastBridgeMsg > STALE_MS) {
      console.warn(
        `[daemon] no bridge traffic for >${STALE_MS}ms — stale connection, forcing reconnect`,
      );
      stopWatchdog();
      try {
        ws.close();
      } catch {}
    }
  }, WATCHDOG_TICK_MS);
}

function stopWatchdog(): void {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
}

function connect(): void {
  const url = URL_ENV!;
  // Гейт на соединение: реконнект начинает с нуля. Модульный флаг здесь был бы
  // дырой — коннект после падения туннеля унаследовал бы доверие от предыдущего.
  const gate = createAuthGate();
  console.log(`[daemon] connecting → ${url}`);
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error("[daemon] WebSocket ctor failed:", e);
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", () => {
    console.log("[daemon] socket open, sending auth");
    lastBridgeMsg = Date.now();
    startWatchdog(ws);
    ws.send(JSON.stringify({ type: "auth", secret: SECRET }));
  });
  ws.addEventListener("message", (ev) => {
    // Любое сообщение от моста = признак живого соединения (для watchdog).
    // Считаем ДО разбора: кривой кадр — тоже признак живого моста.
    lastBridgeMsg = Date.now();
    const msg = parseBridgeMsg(ev.data);
    if (msg === null) return;
    // Мост доказывает себя `auth_ok` ровно так же, как демон доказывает себя
    // секретом. До этого исполняемые кадры не принимаются — иначе `run`
    // приходит от того, кто просто занял адрес моста. Подробности — auth-gate.ts.
    if (!gate.accepts(msg)) {
      console.warn(`[daemon] dropping '${msg.type}' received before auth_ok`);
      return;
    }
    switch (msg.type) {
      case "ping":
        // Мост шлёт ping каждые 30с и считает мак мёртвым без pong за 60с.
        // Раньше daemon его игнорировал → lastPongTime на мосту всегда null →
        // mac_online залипал в «assume online» даже у зомби-сокета. Отвечаем.
        try {
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {}
        return;
      case "auth_ok":
        console.log("[daemon] authenticated");
        gate.markAuthenticated();
        backoffIdx = 0;
        return;
      case "auth_fail":
        console.error("[daemon] auth failed:", msg.error);
        ws.close();
        return;
      case "run":
        handleRun(ws, msg).catch((e) => {
          console.error("[daemon] handleRun error:", e);
          // Мост ждёт ответ по id; без него вызов доживёт до mac_timeout, то
          // есть «мак завис» вместо настоящей причины. Отвечаем всегда.
          sendResult(
            ws,
            msg.id,
            false,
            undefined,
            `handler_failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
        return;
      case "bad_run":
        // Кадр не прошёл разбор, но id адресуемый — говорим прямо, что не так.
        console.error(`[daemon] bad run msg id=${msg.id}: ${msg.reason}`);
        sendResult(ws, msg.id, false, undefined, `bad_run_msg: ${msg.reason}`);
        return;
      case "cancel": {
        // Точечная отмена одного прогона. Мост шлёт её по своему таймауту —
        // до аудита 2026-08-11 брошенный `claude` продолжал работать в проекте
        // владельца, хотя ответа от него уже никто не ждал.
        const hit = cancelRun(
          activeChildren as Map<string, KillableChild>,
          msg.id,
        );
        console.log(
          `[daemon] cancel id=${msg.id} → ${hit ? "killing" : "not running"}`,
        );
        return;
      }
      case "stop":
        console.log("[daemon] received stop signal - killing all active processes");
        killAllChildren();
        return;
    }
  });
  ws.addEventListener("close", () => {
    console.log("[daemon] socket closed");
    stopWatchdog();
    killAllChildren();
    scheduleReconnect();
  });
  ws.addEventListener("error", (ev) => {
    console.error("[daemon] socket error:", (ev as any).message ?? ev);
  });
}

function scheduleReconnect(): void {
  const wait = BACKOFFS[Math.min(backoffIdx, BACKOFFS.length - 1)];
  backoffIdx++;
  setTimeout(connect, wait);
}

process.once("SIGINT", () => {
  killAllChildren();
  process.exit(0);
});
process.once("SIGTERM", () => {
  killAllChildren();
  process.exit(0);
});

connect();
