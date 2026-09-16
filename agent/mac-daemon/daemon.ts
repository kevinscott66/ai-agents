/**
 * Stage A: Mac daemon. Connects to the backend WebSocket bridge as a single
 * client, waits for "run" commands, spawns the `claude` CLI with stdin =
 * prompt, streams stdout/stderr back as chunks, and sends a final "result".
 *
 * Auto-reconnect with backoff 1→2→5→10s. Soft kill (SIGINT) of active child
 * on socket close. Project allowlist enforced via MAC_PROJECT_ROOTS (CSV).
 */
import { resolve as pathResolve, dirname } from "node:path";
import { realpathSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { bridgeSecretTransportError } from "./bridge-url.ts";
import { cancelRun, killAll, type KillableChild } from "./kill.ts";
import { parseBridgeMsg, toPermissionMode, type RunMsg } from "./protocol.ts";
import { sanitizeChildEnv, resolveClaudeBin } from "./child-env.ts";
import { isolatedClaudeProbeEnv } from "./readiness-config.ts";
import { tmpdir } from "node:os";
import { claudeReadinessCommand, probeClaudeReadiness } from "./readiness-preflight.ts";
import { probeClaudeAuth } from "./auth-preflight.ts";
import { spawnWithFallback, type ProviderMetadata } from "./provider-fallback.ts";
import { codexCommand } from "./codex-command.ts";
import { runAssistantOperation, assistantErrorCode } from "./assistant.ts";
import { createDaemonHandshake } from "./auth-handshake.ts";
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

const assistantControllers = new Map<string, AbortController>();
const runControllers = new Map<string, AbortController>();
const activeChildren = new Map<string, KillableChild>();

const handshakes = new WeakMap<WebSocket, ReturnType<typeof createDaemonHandshake>>();
function sendDaemonFrame(ws: WebSocket, body: string): void {
  const frame = handshakes.get(ws)?.wrap(body);
  if (!frame) throw new Error("bridge_not_authenticated");
  ws.send(JSON.stringify(frame));
}

function sendChunk(
  ws: WebSocket,
  id: string,
  stream: "stdout" | "stderr",
  data: string,
): void {
  try {
    sendDaemonFrame(ws, JSON.stringify({ type: "chunk", id, stream, data }));
  } catch {}
}

function sendResult(
  ws: WebSocket,
  id: string,
  ok: boolean,
  code: number | undefined,
  error?: string,
  metadata?: ProviderMetadata,
): void {
  try {
    sendDaemonFrame(ws, JSON.stringify({ type: "result", id, ok, code, error, ...metadata }));
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
    `[daemon] run id=${id} project=${project} provider=${msg.provider ?? "claude"} mode=${mode} (CLAUDE_PERMISSION_MODE=${permissionMode})`,
  );
  const childEnv = sanitizeChildEnv(process.env);
  const commandFor = (provider: "claude" | "codex") => provider === "codex"
    ? codexCommand(mode, process.env)
    : [CLAUDE_BIN, "--print", "--permission-mode", permissionMode];
  let selectedProvider = msg.provider ?? "claude";
  const probeEnvOverrides = msg.allowFallback === true && selectedProvider === "claude" && mode !== "bypass"
    ? isolatedClaudeProbeEnv(allowedProject, childEnv) : null;
  let preflightReason: ProviderMetadata["fallbackReason"];
  if (msg.allowFallback === true && selectedProvider === "claude" && mode !== "bypass"
      && probeEnvOverrides !== null) {
    const controller = new AbortController();
    runControllers.set(id, controller);
    let auth: Awaited<ReturnType<typeof probeClaudeAuth>> = "unknown";
    try {
    auth = await probeClaudeAuth(() => {
      const probe = Bun.spawn({cmd:[CLAUDE_BIN,"auth","status","--json"],
        cwd:allowedProject!,env:childEnv,detached:true,stdin:"ignore",stdout:"pipe",stderr:"ignore"});
      return {stdout:probe.stdout,exited:probe.exited,kill:signal=>probe.kill(signal),processGroupId:probe.pid};
    }, controller.signal, child => activeChildren.set(id, child));
    if (auth === "unavailable") preflightReason = "authentication_unavailable";
    if (auth === "available" && !controller.signal.aborted) {
      // No project instructions, tools, hooks, MCP or user prompt enter this
      // disposable readiness request. OAuth/keychain identity remains unchanged.
      const probeCwd = mkdtempSync(pathResolve(tmpdir(), "agent-readiness-"));
      try {
        const readiness = await probeClaudeReadiness(() => {
          const probe = Bun.spawn({cmd:claudeReadinessCommand(CLAUDE_BIN),
            cwd:probeCwd,env:{...childEnv,...probeEnvOverrides},detached:true,stdin:"ignore",stdout:"pipe",stderr:"ignore"});
          return {stdout:probe.stdout,exited:probe.exited,kill:signal=>probe.kill(signal),processGroupId:probe.pid};
        }, controller.signal, child => activeChildren.set(id, child));
        if (readiness === "quota_exhausted" || readiness === "billing_unavailable"
            || readiness === "authentication_unavailable") preflightReason = readiness;
      } finally { rmSync(probeCwd,{recursive:true,force:true}); }
    }
    } finally {
      activeChildren.delete(id);
      runControllers.delete(id);
    }
    if (controller.signal.aborted || auth === "cancelled") {
      sendResult(ws,id,false,undefined,"cancelled",{provider:selectedProvider,requestedProvider:selectedProvider});
      return;
    }
    // Awaiting a probe opens a filesystem race: revalidate the canonical cwd.
    allowedProject = resolveAllowedProject(project);
    if (!allowedProject) {
      sendResult(ws,id,false,undefined,"project_not_allowed_after_preflight");
      return;
    }
    if (preflightReason) selectedProvider = "codex";
  }
  const spawned = spawnWithFallback(selectedProvider, mode, preflightReason ? false : msg.allowFallback, provider => Bun.spawn({
      // Re-audit C1: pass the REAL `--permission-mode` flag. Previously the mode
      // was only set via the CLAUDE_PERMISSION_MODE env var, which the Claude CLI
      // ignores — so the operator-selected mode (plan/ask/…) was never enforced.
      cmd: commandFor(provider),
      cwd: allowedProject,
      // Give each run its own group so cancellation includes shell/tool children.
      detached: true,
      // SEC-audit: the spawned `claude` must not inherit daemon credentials.
      // Authentication belongs to the local Claude installation/keychain; only
      // the explicit non-secret runtime environment crosses this boundary.
      env: childEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }), provider => Bun.which(commandFor(provider)[0], { PATH: childEnv.PATH, cwd: allowedProject! }) === null);
  const metadata: ProviderMetadata = preflightReason
    ? {...spawned.metadata, requestedProvider:"claude", fallbackReason:preflightReason}
    : spawned.metadata;
  if ("error" in spawned) {
    const e = spawned.error;
    sendResult(ws, id, false, undefined, `spawn_failed: ${e instanceof Error ? e.message : String(e)}`, metadata);
    return;
  }
  const child = spawned.child;
  activeChildren.set(id, {kill:signal=>child.kill(signal),exited:child.exited,processGroupId:child.pid});
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
      metadata,
    );
  } catch (e) {
    activeChildren.delete(id);
    sendResult(
      ws,
      id,
      false,
      undefined,
      e instanceof Error ? e.message : String(e),
      metadata,
    );
  }
}

function killAllChildren(): void {
  for (const controller of runControllers.values()) controller.abort();
  for (const controller of assistantControllers.values()) controller.abort();
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
  const handshake = createDaemonHandshake(SECRET);
  console.log(`[daemon] connecting → ${url}`);
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error("[daemon] WebSocket ctor failed:", e);
    scheduleReconnect();
    return;
  }
  handshakes.set(ws, handshake);
  ws.addEventListener("open", () => {
    console.log("[daemon] socket open, sending auth");
    lastBridgeMsg = Date.now();
    startWatchdog(ws);
    ws.send(JSON.stringify(handshake.hello));
  });
  ws.addEventListener("message", (ev) => {
    // Любое сообщение от моста = признак живого соединения (для watchdog).
    // Считаем ДО разбора: кривой кадр — тоже признак живого моста.
    lastBridgeMsg = Date.now();
    const raw = gate.authenticated ? handshake.unwrap(ev.data) : ev.data;
    if (raw === null) { ws.close(); return; }
    const msg = parseBridgeMsg(raw);
    if (msg === null) return;
    // Executable frames require a verified, connection-bound mutual HMAC handshake.
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
          sendDaemonFrame(ws, JSON.stringify({ type: "pong" }));
        } catch {}
        return;
      case "auth_challenge": {
        const proof = handshake.challenge(msg);
        if (!proof) { ws.close(); return; }
        ws.send(JSON.stringify(proof));
        return;
      }
      case "auth_ok":
        if (!handshake.accept(msg.proof)) { ws.close(); return; }
        console.log("[daemon] authenticated");
        gate.markAuthenticated();
        backoffIdx = 0;
        return;
      case "auth_fail":
        console.error("[daemon] auth failed:", msg.error);
        ws.close();
        return;
      case "assistant":
        if (assistantControllers.size) {
          sendResult(ws, msg.id, false, undefined, "assistant_busy");
          return;
        }
        const controller = new AbortController();
        assistantControllers.set(msg.id, controller);
        runAssistantOperation(msg.operation, undefined, undefined, controller.signal).then(output => {
          sendChunk(ws, msg.id, "stdout", output);
          sendResult(ws, msg.id, true, 0);
        }).catch(error => {
          sendResult(ws, msg.id, false, undefined, assistantErrorCode(error));
        }).finally(() => { assistantControllers.delete(msg.id); });
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
        assistantControllers.get(msg.id)?.abort();
        runControllers.get(msg.id)?.abort();
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
