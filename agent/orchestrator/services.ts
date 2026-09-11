/**
 * T-320: Background-service wiring extracted from main() in orchestrator-team.ts.
 *
 * startBackgroundServices() starts all background services (watchdog, health,
 * miniapp, self-diag, backup, digest, db-maint, userbot, userbot-router,
 * mac-bridge) and returns a handle whose stop() tears them all down (except
 * bots and process.exit, which stay in main's own signal handler).
 *
 * Аудит 2026-09-11: роутера юзерботов (`buildUserbotRouter`/`setUserbotRouter`)
 * в списке не было. Ищущий, кто на старте поднимает MTProto-сессии ролей (T-401),
 * решал по этому перечню, что файл про них не знает, и заводил второй
 * источник — при живом singleton это подмена личности в исходящих, то есть
 * ровно то, что T-401 запрещает.
 */
import Anthropic from "@anthropic-ai/sdk";
import { dirname } from "node:path";
import { DEFAULT_MINIAPP_PORT, MAX_TIMER_MS } from "../lib/constants.ts";
import { resolveDbPath } from "../lib/db-path.ts";
import { log } from "../lib/log.ts";
import type { RunningBot } from "../lib/types.ts";
import type { HandoffDeps } from "../lib/handoff.ts";
import type { HealthMonitorHandle, HealthSnapshot } from "../lib/health.ts";
import { startWatchdog } from "../lib/watchdog.ts";
import { startHealthMonitor, publicHealth } from "../lib/health.ts";
import {
  startMiniappServer,
  parseAllowedIds,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { startSelfDiagPoller, type SelfDiagPollerHandle } from "../lib/self-diag.ts";
import { startBackupScheduler, type BackupSchedulerHandle } from "../lib/backup.ts";
import { startDigestScheduler, type DigestSchedulerHandle } from "../lib/digest.ts";
import {
  startMaintScheduler,
  setSchedulerDisabled,
  type MaintSchedulerHandle,
} from "../lib/db-maint.ts";
import { startUserbot, setCurrentUserbot, type UserbotHandle } from "../lib/userbot.ts";
import {
  buildUserbotRouter,
  setUserbotRouter,
  type UserbotRouter,
} from "../lib/userbot-router.ts";
import { startMacBridge } from "../lib/mac-bridge.ts";
import { makeUserbotRecorder } from "../lib/userbot-ingest.ts";
import { CHARACTERS } from "../characters/index.ts";
import { buildApprovalExecDeps } from "../lib/commands.ts";

export interface BackgroundServicesDeps {
  bots: RunningBot[];
  allowed: string[];
  anthropic: Anthropic | null;
  model: string;
  handoffDeps: HandoffDeps;
  getHealthSnapshot: () => HealthSnapshot[] | null;
  setCurrentHealth: (h: HealthMonitorHandle | null) => void;
}

export interface BackgroundServicesHandle {
  stop(): void;
}

/**
 * Числовая настройка из env: положительное целое, иначе дефолт.
 *
 * Аудит 2026-08-08: интервалы читались как
 * `process.env.X ? Number(process.env.X) : undefined`. Опечатка в env даёт NaN,
 * и он доезжает до setInterval — а тот трактует NaN как 1 мс. Проверено на
 * рантайме проекта: ~770 тиков в секунду. Для watchdog это загруженный на ровном
 * месте процесс, для health-монитора — getMe в Telegram по каждому из 12 ботов
 * с той же частотой, то есть прямая дорога к 429 и блокировке всей команды.
 * Bun печатает TimeoutNaNWarning, но одна строка в stderr при таком потоке логов
 * не замечается.
 *
 * `undefined` (переменная не задана) возвращаем как есть — у каждого шедулера
 * свой дефолт, и подменять его здесь значило бы держать вторую копию.
 *
 * Санитайзер стоит здесь, а не внутри шедулеров: services.ts — единственное
 * место, где env вообще читается, остальные вызовы передают литералы.
 *
 * Это не значит, что внутри шедулеров проверок нет: `sanitizeHourUTC` (digest.ts)
 * и `sanitizeMaintOpt` (db-maint.ts) стоят на своих местах и стерегут значение,
 * пришедшее литералом. Но env-вход у DIGEST_HOUR_UTC / DB_MAINT_HOUR_UTC
 * разбирает всё-таки этот файл — соседней `_envHour`, а не этой функцией: час
 * законно бывает нулём, и «не задано» от «задан ноль» отличимо только до
 * `Number()`. Почему обоих санитайзеров внутри шедулеров для этого мало —
 * в докблоке `_envHour` ниже.
 */

export function _envPositiveInt(
  name: string,
  fallback?: number,
): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_TIMER_MS) {
    log.warn(`[services] некорректный ${name} — берём дефолт`, {
      got: raw,
      fallback: fallback ?? "(дефолт шедулера)",
    });
    return fallback;
  }
  return n;
}

/**
 * Час UTC из env: целое 0..23, иначе дефолт.
 *
 * Аудит 2026-08-28: `DIGEST_HOUR_UTC` и `DB_MAINT_HOUR_UTC` читались тернарником
 * `process.env.X ? Number(process.env.X) : def`. Для этих двух переменных
 * тернарник не годится, и по причине, которой нет у остальных: ноль здесь —
 * ЗАКОННОЕ значение (полночь UTC).
 *
 * systemd `EnvironmentFile=` отдаёт строку `KEY=` как ПУСТУЮ СТРОКУ, а не как
 * отсутствие ключа, а `KEY= ` (случайный пробел после `=`, глазом не видный) —
 * как `" "`. Пустая строка falsy, и её тернарник переживал. Пробел truthy, и
 * `Number(" ")` — ноль. Ноль проходит и `sanitizeHourUTC` (digest.ts), и
 * `sanitizeMaintOpt` (db-maint.ts): у обоих нижняя граница 0, оба молчат.
 *
 * Итог: дайджест команды и суточное обслуживание БД (archive + VACUUM) молча
 * переезжают на 00:00 UTC с 06:00 и 04:00 — из-за пробела в конфиге и без
 * единой строки в логе. Прецедент того же класса уже исправлен в `envInt`
 * (lib/alerting.ts) — там тоже `.trim()` перед `Number()`.
 *
 * Соседние `_envPositiveInt`/`_envPort` этой дырой не страдают: у них ноль
 * негодное значение, `" "` до них доезжает как 0 и честно уходит в warn.
 */
export function _envHour(name: string, fallback: number): number {
  const raw = process.env[name];
  // trim ПЕРЕД Number: `Number("")` и `Number(" ")` — оба ноль, то есть
  // законный час. Отличить «не задано» от «задан ноль» можно только здесь.
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 23) return n;
  log.warn(`[services] некорректный ${name} — берём дефолт`, {
    got: raw,
    fallback,
  });
  return fallback;
}

const MAX_PORT = 65535;

/**
 * Порт из env: целое 1..65535, иначе дефолт.
 *
 * Аудит 2026-08-28: MINIAPP_PORT читался тем же `_envPositiveInt`, у которого
 * потолок — `MAX_TIMER_MS` (2^31-1). Для таймера это верная граница, для порта
 * — никакая: `MINIAPP_PORT=87878` (лишняя цифра в 8787) проходит проверку
 * целиком. Bun при этом НЕ бросает, а молча зажимает значение в 65535
 * (проверено на рантайме проекта: 70000, 65536, 131072 и 1e10 — все дают
 * `server.port === 65535`). В логе бодрое «Mini App backend on `:87878`», nginx
 * стучится в 8787 и не находит никого.
 *
 * Ровно та же дыра, что была у MAC_BRIDGE_PORT до аудита 2026-08-08, и лечится
 * так же — см. `_resolveBridgePort` в lib/mac-bridge.ts.
 */
export function _envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && n <= MAX_PORT) return n;
  log.warn(`[services] некорректный ${name} — берём дефолт`, {
    got: raw,
    fallback,
  });
  return fallback;
}

export async function startBackgroundServices(
  deps: BackgroundServicesDeps,
): Promise<BackgroundServicesHandle> {
  const {
    bots,
    allowed: ALLOWED,
    anthropic,
    model: MODEL,
    handoffDeps,
    getHealthSnapshot,
    setCurrentHealth,
  } = deps;

  const lead = bots.find((b) => b.def.key === "orchestrator");

  // C7: watchdog за молчащими ботами.
  const watchdog = startWatchdog({
    bots,
    intervalMs: _envPositiveInt("WATCHDOG_INTERVAL_MS"),
    silenceMs: _envPositiveInt("WATCHDOG_SILENCE_MS"),
    alert: async (msg) => {
      // НЕ логируем здесь повторно: watchdog.ts уже сделал log.warn(msg).
      // Этот callback отвечает только за доставку в чат.
      // Алерты в чат — только если явно включено (по умолчанию выкл,
      // чтобы не спамить «молчит N мин» когда бот просто в покое).
      if (process.env.WATCHDOG_TG_ALERTS !== "true") return;
      if (!lead || !ALLOWED.length) return;
      for (const chatId of ALLOWED) {
        try {
          await lead.bot.telegram.sendMessage(chatId, msg);
        } catch (e) {
          log.error("[watchdog] sendMessage failed", { error: String(e) });
        }
      }
    },
  });

  // C22: active health checks (Telegram getMe per bot, cached).
  let health: HealthMonitorHandle | null = null;
  if (process.env.HEALTH_ENABLED !== "false") {
    try {
      const intervalMs = _envPositiveInt("HEALTH_INTERVAL_MS");
      health = startHealthMonitor({
        bots,
        intervalMs,
        onSnapshot: (snap) => {
          // M2: SSE fan-out. Imported lazily to avoid cycles.
          import("../lib/events-bus.ts").then(({ emit }) => {
            // publicHealth, а не сырой snap: подписчиков SSE фильтрует только
            // allowlist, admin-проверки там нет, и в `lastError` приезжал текст
            // ошибки node-fetch вместе с токеном бота из URL.
            emit("agent.health", { snapshot: publicHealth(snap) });
          }).catch(() => {});
        },
      });
      setCurrentHealth(health);
    } catch (e) {
      log.error("[health] failed to start", { error: String(e) });
    }
  } else {
    log.info("[health] disabled via HEALTH_ENABLED=false");
  }

  // C13a: Mini App backend (optional, disabled by default).
  let miniapp: MiniappServerHandle | null = null;
  if (process.env.MINIAPP_ENABLED === "true") {
    try {
      miniapp = startMiniappServer({
        port: _envPort("MINIAPP_PORT", DEFAULT_MINIAPP_PORT),
        allowedUserIds: parseAllowedIds(process.env.MINIAPP_ALLOWED_USER_IDS),
        adminUserIds: parseAllowedIds(process.env.MINIAPP_ADMIN_USER_IDS),
        getHealth: () => getHealthSnapshot(),
        // T-547: give the Mini App a way to actually execute approved actions
        // via the requesting agent's bot. Same bundle as admin commands —
        // resolveAgent тоже обязателен (аудит 2026-08-12, ApprovalExecDeps).
        //
        // Аудит 2026-08-13: набор собирался тут руками и был неполон — не
        // хватало handoffDeps, из-за чего одобренный в вебе DELEGATE_TO_ROLE
        // необратимо сжигал заявку. Теперь общий конструктор с /approve, см.
        // buildApprovalExecDeps.
        approvalDeps: buildApprovalExecDeps({ bots, handoffDeps }),
      });
    } catch (e) {
      log.error("[miniapp] failed to start", { error: String(e) });
    }
  }

  // C15: self-diagnostic retry loop. Picks pending diag-tasks (assigned to
  // aieng, _diag=true) and asks aieng for a corrected payload; retries once.
  let selfDiag: SelfDiagPollerHandle | null = null;
  if (process.env.SELF_DIAG_ENABLED !== "false") {
    const aieng = bots.find((b) => b.def.key === "aieng");
    if (!aieng) {
      log.warn("[self-diag] aieng bot not running — poller disabled");
    } else {
      selfDiag = startSelfDiagPoller({
        intervalMs: _envPositiveInt("SELF_DIAG_INTERVAL_MS", 30_000)!,
        deps: {
          anthropic,
          model: MODEL,
          // Исполняем от имени роли, чьи полномочия проверил гейт self-diag,
          // а не от aieng (аудит 2026-08-08): иначе бот-отправитель, ведро
          // rate-limit и атрибуция в аудите расходятся с авторизацией.
          buildDispatchCtx: ({ chatId, agentKey }) => {
            const actor = bots.find((b) => b.def.key === agentKey);
            if (!actor) return null;
            return {
              agentKey,
              chatId,
              botId: actor.id, // T-240: per-bot-per-chat rate limiting
              telegram: actor.bot.telegram,
              resolveAgent: (key) => bots.find((b) => b.def.key === key),
              handoffDeps,
            };
          },
        },
      });
      log.info("[self-diag] poller started");
    }
  } else {
    log.info("[self-diag] poller disabled via SELF_DIAG_ENABLED=false");
  }

  // C17: nightly backups (DB snapshot + wiki tarball, 14-day retention).
  let backup: BackupSchedulerHandle | null = null;
  if (process.env.BACKUP_ENABLED !== "false") {
    try {
      // Аудит 2026-08-27: `??` пропускал пустое `MEMORY_DB_PATH=`, и
      // `dirname("")` давал `"."` — планировщик бэкапов получал `dataDir: "."`
      // вместо каталога базы.
      const dbPath = resolveDbPath(process.env.MEMORY_DB_PATH);
      backup = startBackupScheduler({
        dataDir: dirname(dbPath),
        // Аудит 2026-08-28: `??` пропускал пустое `BACKUP_DIR=` — та же
        // дыра, что закрыли выше для MEMORY_DB_PATH. Пустая строка доезжала
        // до `ensureDir("")` в runBackup, `fs.mkdirSync("")` бросал ENOENT,
        // и бросал он ДО try — то есть мимо всех emitAlert планировщика
        // (`backup_failed` / `backup_empty` / `backup_partial`). Наружу
        // оставался один log.warn «scheduler tick error» раз в сутки, а
        // бэкапов не было вообще.
        backupDir: process.env.BACKUP_DIR?.trim() || "./backups",
      });
    } catch (e) {
      log.error("[backup] failed to start", { error: String(e) });
    }
  } else {
    log.info("[backup] disabled via BACKUP_ENABLED=false");
  }

  // C18: daily team digest at DIGEST_HOUR_UTC (default 06:00 UTC).
  let digest: DigestSchedulerHandle | null = null;
  if (process.env.DIGEST_ENABLED !== "false") {
    if (!lead) {
      log.warn("[digest] orchestrator/lead bot not running — disabled");
    } else if (!ALLOWED.length) {
      log.warn("[digest] no ALLOWED chats configured — disabled");
    } else {
      try {
        digest = startDigestScheduler({
          sender: {
            sendMessage: (chatId, text) =>
              lead.bot.telegram.sendMessage(chatId, text),
          },
          chatIds: ALLOWED,
          hourUTC: _envHour("DIGEST_HOUR_UTC", 6),
        });
      } catch (e) {
        log.error("[digest] failed to start", { error: String(e) });
      }
    }
  } else {
    log.info("[digest] disabled via DIGEST_ENABLED=false");
  }

  // C31 DB-maint: gcStaleTasks каждые 30 минут, archive + compact раз в сутки в 04:00 UTC.
  let maint: MaintSchedulerHandle | null = null;
  if (process.env.DB_MAINT_ENABLED !== "false") {
    try {
      maint = startMaintScheduler({
        dailyHourUTC: _envHour("DB_MAINT_HOUR_UTC", 4),
        archiveDays: process.env.DB_MAINT_ARCHIVE_DAYS
          ? Number(process.env.DB_MAINT_ARCHIVE_DAYS)
          : 30,
      });
    } catch (e) {
      log.error("[db-maint] failed to start", { error: String(e) });
    }
  } else {
    // Аудит 2026-08-20: без этой отметки /readyz навсегда уходил в 503 —
    // `_schedulerLastRun` ставится только внутри startMaintScheduler, а
    // «метки нет» проверка readiness читала как «таймер заклинил». Флаг
    // разводит «выключено оператором» и «должно было работать, но не идёт».
    // Отказ самого старта (catch выше) флаг НЕ ставит — там 503 по делу.
    setSchedulerDisabled(true);
    log.info("[db-maint] disabled via DB_MAINT_ENABLED=false");
  }

  // Shared recorder: mirror any incoming MTProto message (singleton OR a
  // per-character routed session) into the same short-memory store the Bot API
  // uses, so service messages and any-emoji reactions become visible to the
  // agent team. via=userbot is captured in the agent_key namespace.
  // Аудит 2026-08-12: правило «что считать сообщением пользователя» переехало в
  // lib/userbot-ingest.ts — вместе с тем, чего здесь не было: свои же боты
  // сидят в том же чате, и их ответы приезжали сюда как пользовательские.
  const recordUserbotMessage = makeUserbotRecorder({
    ownBotIds: bots.map((b) => b.id),
  });

  // C30: MTProto userbot — passive observer + occasional actor. Non-fatal.
  let userbot: UserbotHandle | null = null;
  if (process.env.TELEGRAM_USERBOT_PHONE) {
    try {
      userbot = await startUserbot({
        allowedChatIds: ALLOWED,
        onMessage: (m) => recordUserbotMessage(m),
      });
      setCurrentUserbot(userbot);
      if (userbot.isNoop) {
        log.info("[userbot] running in no-op mode");
      } else {
        log.info("[userbot] connected, listening");
      }
    } catch (e) {
      log.error("[userbot] start failed (non-fatal)", { error: String(e) });
    }
  } else {
    log.info("[userbot] TELEGRAM_USERBOT_PHONE not set — userbot disabled");
  }

  // T-401: per-character userbot routing. Opt-in — only installed when at least
  // one character declares a userbot session (declarative or via env). When no
  // character is configured, buildUserbotRouter returns null and dispatch keeps
  // using the singleton userbot above (zero behaviour change for prod today).
  let userbotRouter: UserbotRouter | null = null;
  try {
    userbotRouter = buildUserbotRouter(CHARACTERS, {
      defaultAllowedChatIds: ALLOWED,
      onMessage: (m) => recordUserbotMessage(m),
    });
    if (userbotRouter) {
      setUserbotRouter(userbotRouter);
      log.info(
        `[userbot-router] installed for agents: ${userbotRouter.getActiveAgents().length === 0 ? Array.from(userbotRouter.getAllConfigs().keys()).join(",") : userbotRouter.getActiveAgents().join(",")}`,
      );
    }
  } catch (e) {
    log.error("[userbot-router] build failed (non-fatal)", { error: String(e) });
  }

  // Stage A: Mac bridge — WebSocket server for the Mac daemon. Non-fatal if
  // MAC_BRIDGE_SECRET is unset (no-op). Refuses to start if secret < 32 chars.
  let macBridge: { stop: () => void } | null = null;
  if (process.env.MAC_BRIDGE_SECRET) {
    try {
      macBridge = startMacBridge();
    } catch (e) {
      log.error("[mac-bridge] start failed", { error: String(e) });
    }
  } else {
    log.info("[mac-bridge] MAC_BRIDGE_SECRET not set — disabled");
  }

  return {
    stop() {
      watchdog.stop();
      if (userbotRouter) {
        userbotRouter
          .stopAll()
          .catch((e) => log.error("[userbot-router] stop error", { error: String(e) }));
        setUserbotRouter(null);
      }
      if (userbot) {
        userbot.stop().catch((e) => log.error("[userbot] stop error", { error: String(e) }));
        setCurrentUserbot(null);
      }
      if (health) {
        health.stop();
        setCurrentHealth(null);
      }
      if (miniapp) miniapp.stop();
      if (selfDiag) selfDiag.stop();
      if (backup) backup.stop();
      if (digest) digest.stop();
      if (maint) maint.stop();
      if (macBridge) macBridge.stop();
    },
  };
}
