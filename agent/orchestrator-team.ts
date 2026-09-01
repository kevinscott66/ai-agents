/**
 * Дирижёр + 11 ролей в одном процессе, с памятью.
 *
 * Память:
 *  - короткая (диалог) — SQLite через lib/db.ts, последние N сообщений чата;
 *  - длинная (вики)   — markdown в memory/, FTS5-индекс через lib/memory.ts;
 *  - compactor        — после ответа дешёвый LLM решает, что записать.
 *
 * Маршрутизация:
 *  - упомянули @конкретного бота → отвечает он;
 *  - никого не упомянули          → отвечает Дирижёр.
 */
import "./lib/telegraf-patch.ts";
import { Telegraf } from "telegraf";
import { CHARACTERS, type CharacterDef } from "./characters/index.ts";
import { createAnthropic } from "./lib/anthropic-client.ts";
import { rebuildWikiIndex } from "./lib/memory.ts";
import { type HandoffDeps } from "./lib/handoff.ts";
import { registerAdminCommands } from "./lib/admin-commands.ts";
import { registerErrorGuard } from "./lib/bot-error-guard.ts";
import { registerSeenProbe } from "./lib/watchdog.ts";
import { launchWithRestart, stopAllSafely } from "./lib/launch-restart.ts";
import { buildApprovalExecDeps } from "./lib/commands.ts";
import { type HealthMonitorHandle, type HealthSnapshot } from "./lib/health.ts";
import type { RunningBot } from "./lib/types.ts";
import { log } from "./lib/log.ts";
import { getErrorMessage } from "./lib/errors.ts";
import { DEFAULT_MESSAGE_HISTORY_LIMIT } from "./lib/constants.ts";
import { registerVoiceHandler } from "./orchestrator/voice-handler.ts";
import { registerMessageHandler } from "./orchestrator/message-handler.ts";
import { startBackgroundServices } from "./orchestrator/services.ts";
import { warnUnseededActionTypes } from "./lib/permissions.ts";
import { configureMiniAppMenuButton } from "./lib/miniapp-entry.ts";
import {
  createLocalRoleExecutors,
  startRoleRuntimeWorker,
  type RoleRuntimeWorkerHandle,
} from "./lib/role-runtime-worker.ts";
import { describeAllowlist, warnIfEmptyAllowlist } from "./lib/allowlist.ts";
import { useAgentSdk } from "./lib/agent-sdk-runtime.ts";
// T-320: pure helpers moved to ./orchestrator/helpers.ts; re-exported here for
// backward compat with tests/t322-orchestrator-team.test.ts.
export { tailLines, isMentioned } from "./orchestrator/helpers.ts";
import { parseHistoryLimit } from "./orchestrator/helpers.ts";

const anthropicApiKey = process.env["ANTHROPIC_API_KEY"]?.trim();
const subscriptionMode = useAgentSdk();
const claudeOAuthToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"]?.trim();
const MODEL = process.env.ANTHROPIC_LARGE_MODEL?.trim() || "claude-sonnet-4-6";
const ALLOWED = (process.env.TELEGRAM_ALLOWED_GROUP_IDS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const HISTORY_LIMIT = parseHistoryLimit(
  process.env.MEMORY_HISTORY_LIMIT,
  DEFAULT_MESSAGE_HISTORY_LIMIT,
);

if (subscriptionMode && !claudeOAuthToken) {
  log.error("USE_AGENT_SDK=true requires CLAUDE_CODE_OAUTH_TOKEN");
  process.exit(1);
}
if (!subscriptionMode && !anthropicApiKey) {
  log.error("Need ANTHROPIC_API_KEY, or configure CLAUDE_CODE_OAUTH_TOKEN for Claude subscription");
  process.exit(1);
}

// Через фабрику, а не `new Anthropic({...})`: она отключает ретраи SDK, чтобы
// они не перемножались с циклом в callAnthropic (до 18 запросов на вызов).
// Именно этот клиент уходит в tool-loop, то есть в основной прод-путь.
const anthropic = anthropicApiKey ? createAnthropic(anthropicApiKey) : null;
log.info(subscriptionMode
  ? "Inference: Claude Code subscription (OAuth); raw API fallback disabled"
  : "Inference: Anthropic API");
const bots: RunningBot[] = [];
const handoffDeps: HandoffDeps = {
  anthropic,
  model: MODEL,
  historyLimit: HISTORY_LIMIT,
  bots,
};

let currentHealth: HealthMonitorHandle | null = null;
export function getHealthSnapshot(): HealthSnapshot[] | null {
  return currentHealth ? currentHealth.snapshot() : null;
}

export async function buildBot(def: CharacterDef): Promise<RunningBot | null> {
  const token = process.env[def.envToken];
  if (!token) {
    log.warn(`[${def.key}] no token in $${def.envToken} — skipping`);
    return null;
  }
  // handlerTimeout: дефолт telegraf — 90с. Под Agent SDK (подписка) тяжёлый ход
  // агента (web_search в несколько запросов + сборка дайджеста + генерация
  // обложки + ревью) легко превышает 90с → telegraf роняет апдейт «Promise timed
  // out». Поднимаем до 5 минут (env HANDLER_TIMEOUT_MS).
  const bot = new Telegraf(token, {
    handlerTimeout: Number(process.env.HANDLER_TIMEOUT_MS ?? "300000") || 300000,
  });
  const me = await bot.telegram.getMe();
  const running: RunningBot = { def, bot, username: me.username ?? "", id: me.id };

  // ДО регистрации хендлеров: без своего bot.catch дефолтный обработчик
  // telegraf перебрасывает ошибку, она рушит Promise.all в Polling.loop и
  // роняет поллинг этого бота целиком (см. lib/bot-error-guard.ts).
  registerErrorGuard(bot, def.key, ALLOWED);

  // C7: отметка «апдейт получен» — первая middleware, до команд и хендлеров.
  // Раньше она стояла внутри message/voice-хендлеров и не видела админ-команды,
  // которые telegraf дальше не пускает. См. registerSeenProbe в lib/watchdog.ts.
  registerSeenProbe(bot, def.key);

  // C4: команды модерации — только для Lead-бота (orchestrator).
  if (def.key === "orchestrator") {
    // Те же резолверы, что получает обычный путь агента: без resolveAgent
    // одобренные CREATE_TEAM_CHANNEL и DELEGATE_TO_ROLE падали на пустом ctx
    // (аудит 2026-08-12, см. ApprovalExecDeps).
    registerAdminCommands(
      bot,
      buildApprovalExecDeps({ bots, handoffDeps }),
      ALLOWED,
    );
  }

  // T-320: voice + message handlers extracted to ./orchestrator/*.ts
  registerVoiceHandler(bot, def, running, ALLOWED);
  registerMessageHandler(bot, def, running, {
    bots,
    allowed: ALLOWED,
    historyLimit: HISTORY_LIMIT,
    anthropic,
    model: MODEL,
    handoffDeps,
  });

  return running;
}

export async function main() {
  rebuildWikiIndex();
  log.info("Wiki FTS5 index rebuilt.");

  for (const def of CHARACTERS) {
    try {
      const rb = await buildBot(def);
      if (rb) bots.push(rb);
    } catch (e) {
      log.error(`[${def.key}] init failed`, { error: String(e) });
    }
  }
  if (!bots.length) {
    log.error("No bots configured. Set TELEGRAM_BOT_TOKEN (orchestrator) at minimum.");
    process.exit(1);
  }
  log.info(
    `Поднимаю ${bots.length}/${CHARACTERS.length} ботов: ${bots
      .map((b) => `${b.def.key}=@${b.username}`).join(", ")}`
  );
  // Аудит 2026-08-21: тут был фолбэк «any», то есть пустой список
  // рекламировался как «без ограничений». Граница fail-closed (см.
  // lib/allowlist.ts): пустой список = не отвечаем нигде. Плюс громкий
  // warn — для Mini App и ингеста юзербота он был, а для апдейтов ботов,
  // то есть для основного пути прода, не звал никто.
  warnIfEmptyAllowlist("TELEGRAM_ALLOWED_GROUP_IDS (bot updates)", ALLOWED);
  log.info(`Allowed chats: ${describeAllowlist(ALLOWED)}`);
  if (process.env.MINIAPP_ENABLED === "true") {
    const lead = bots.find((b) => b.def.key === "orchestrator");
    if (lead) {
      try {
        const menu = await configureMiniAppMenuButton(lead.bot);
        if (menu.ok) {
          log.info(`[miniapp] Lead menu button configured: ${menu.url}`);
        } else {
          log.warn(`[miniapp] Lead menu button not configured: ${menu.reason}`);
        }
      } catch (e) {
        log.warn("[miniapp] Lead menu button update failed", { error: String(e) });
      }
    }
  }
  warnUnseededActionTypes();
  // Без await: промис живёт весь процесс. dropPendingUpdates применяется
  // только к холодному старту — см. lib/launch-restart.ts.
  for (const b of bots) void launchWithRestart(b);

  const services = await startBackgroundServices({
    bots,
    allowed: ALLOWED,
    anthropic,
    model: MODEL,
    handoffDeps,
    getHealthSnapshot,
    setCurrentHealth: (h) => { currentHealth = h; },
  });

  let roleRuntime: RoleRuntimeWorkerHandle | null = null;
  const lead = bots.find((b) => b.def.key === "orchestrator");
  if (lead) {
    roleRuntime = startRoleRuntimeWorker({
      executors: createLocalRoleExecutors({
        anthropic,
        model: MODEL,
        orchestrator: lead,
        bots,
        handoffDeps,
      }),
      runtime: {
        workerId: `orchestrator-${process.pid}`,
      },
    });
    log.info("[role-runtime] local SPAWN_ROLE worker started");
  } else {
    log.info("[role-runtime] local SPAWN_ROLE worker disabled or orchestrator unavailable");
  }

  const stop = (sig: string) => {
    log.info(`\n${sig} — останавливаю всех`);
    // Ни один шаг остановки не должен помешать выходу: исключение отсюда
    // вылетает из слушателя сигнала, process.exit(0) не выполняется, и
    // процесс перестаёт реагировать на SIGTERM (см. шапку launch-restart.ts).
    // По той же причине и остановка воркера ролей — в своём try.
    try {
      roleRuntime?.stop();
    } catch (e) {
      log.warn(`roleRuntime.stop() не прошёл: ${getErrorMessage(e).slice(0, 200)}`);
    }
    try {
      services.stop();
    } catch (e) {
      log.warn(`services.stop() не прошёл: ${getErrorMessage(e).slice(0, 200)}`);
    }
    const failed = stopAllSafely(bots, sig);
    if (failed) log.warn(`${failed} из ${bots.length} ботов не остановились штатно`);
    process.exit(0);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  // Держим процесс живым, даже если все launch-промисы упадут до следующего тика.
  await new Promise<void>(() => {});
}

if (import.meta.main) {
  main().catch((e) => {
    log.error("Fatal", { error: String(e) });
    process.exit(1);
  });
}
