/**
 * T-541: Userbot multi-session router
 * 
 * Manages multiple agent → TG userbot session mappings.
 * Each agent can have its own dedicated Telegram account via separate StringSession.
 * 
 * Key features:
 * - Lazy session initialization (on first action call)
 * - Agent-specific session isolation
 * - Proper lifecycle management
 * - Fallback to singleton userbot for backward compatibility
 */

import { existsSync } from "node:fs";
import { type UserbotHandle, startUserbot, getCurrentUserbot } from "./userbot.ts";
import { log } from "./log.ts";

export interface UserbotRouterOpts {
  /** Callback for incoming messages from any agent session */
  onMessage: (msg: {
    chatId: string;
    messageId: number;
    fromUserId: string | null;
    fromName: string | null;
    text: string;
    isService: boolean;
    isOutgoing: boolean;
    raw: unknown;
    via: "userbot";
    agentKey: string;  // Which agent session received this
  }) => void;
  /** Default allowed chat IDs (applied to all agents unless overridden) */
  defaultAllowedChatIds: Array<string | number>;
}

export interface AgentSessionConfig {
  sessionFile: string;
  allowedChatIds: Array<string | number>;
}

/**
 * Итоговый allowlist сессии.
 *
 * Аудит 2026-08-27: докстринг `defaultAllowedChatIds` обещает «applied to all
 * agents unless overridden», но класс это поле не читал ни разу — дефолт
 * подставлялся только снаружи, в `resolveCharacterUserbotConfig`. Поэтому
 * `registerAgent(key, { sessionFile, allowedChatIds: [] })` (публичный метод,
 * им же пользуются тесты) поднимал сессию с ПУСТЫМ allowlist: `canonicalChatId`
 * возвращает null на всё, сессия подключается, ест трафик и не ингестит ни
 * одного сообщения — наблюдаемо неотличимо от «в чатах никто не пишет».
 *
 * Отдельной функцией, а не строкой внутри `startSession`: `startSession`
 * приватна и в тестах подменяется целиком, так что внутри неё правило было бы
 * непроверяемым.
 */
export function effectiveAllowedChatIds(
  config: AgentSessionConfig,
  defaults: Array<string | number>,
): Array<string | number> {
  return config.allowedChatIds && config.allowedChatIds.length > 0
    ? config.allowedChatIds
    : defaults;
}

export class UserbotRouter {
  private sessions = new Map<string, UserbotHandle>();
  private configs = new Map<string, AgentSessionConfig>();
  /**
   * Аудит 2026-08-08: старты, которые ещё не завершились.
   *
   * `startUserbot` — это сетевое подключение к Telegram, секунды. Проверка
   * `sessions.has(agentKey)` в начале и `sessions.set(agentKey, handle)` в
   * конце разнесены на всё это время, а getAgentHandle зовётся из dispatch'а,
   * где действия одного агента идут параллельно (реакции на несколько
   * сообщений, fan-out в discussion-режиме). Два одновременных вызова оба
   * видели пустую карту и оба поднимали клиента НА ОДНОМ И ТОМ ЖЕ файле
   * сессии. Последствия хуже, чем лишнее соединение: `sessions.set` оставлял
   * победителя, а проигравший продолжал жить со своим обработчиком апдейтов —
   * то есть каждое входящее сообщение уезжало в onMessage ДВАЖДЫ, ингестилось
   * дважды и агенты отвечали на него дважды. Остановить этот handle было уже
   * некому: ссылки на него не осталось нигде.
   */
  private starting = new Map<string, Promise<UserbotHandle | null>>();
  /**
   * Аудит 2026-08-27: роутер остановлен — новых сессий не поднимаем.
   *
   * `stopAll()` зовётся из `orchestrator/services.ts` БЕЗ await, параллельно
   * живому диспатчу. Без этого флага `getAgentHandle`, пришедший в окно
   * остановки, не находил ни `sessions`, ни `starting` и поднимал вторую
   * сессию НА ТОМ ЖЕ файле — а `startSession` клала её в `sessions` уже после
   * `sessions.clear()`. То есть ровно тот осиротевший клиент с живым
   * обработчиком апдейтов, против которого написан комментарий в stopAll.
   *
   * Аудит 2026-08-28: флаг теперь проверяется ПЕРВЫМ в `getAgentHandle` —
   * остановленный роутер не только не поднимает новых сессий, но и не отдаёт
   * уже поднятые. Подробности — там же.
   */
  private stopped = false;
  private opts: UserbotRouterOpts;

  constructor(opts: UserbotRouterOpts) {
    this.opts = opts;
  }

  /**
   * Register an agent session configuration.
   * Does not start the session immediately (lazy initialization).
   */
  registerAgent(agentKey: string, config: AgentSessionConfig): void {
    this.configs.set(agentKey, config);
    log.debug(`[userbot-router] registered agent ${agentKey} with session ${config.sessionFile}`);
  }

  /**
   * Get or create userbot handle for a specific agent.
   * Returns null if agent not registered or session unavailable.
   */
  async getAgentHandle(agentKey: string): Promise<UserbotHandle | null> {
    // Остановленный роутер не открывает новых соединений и НЕ ОТДАЁТ старых.
    // Вызывающие штатно переживают null — все три (setReaction, deleteMessage,
    // dispatch) уходят на синглтон или на явную ошибку.
    //
    // Аудит 2026-08-28: проверка стояла третьей, после кэша `sessions` и после
    // `starting`, и потому работала только когда `stopAll()` уже дошёл до
    // `sessions.clear()`. А `stopAll` зовут из `orchestrator/services.ts` БЕЗ
    // await, и между установкой флага и `clear()` он ждёт сперва все
    // стартующие сессии, потом все `handle.stop()` — на сети это секунды. Всё
    // это время карта полна, и параллельный диспатч получал handle, чей клиент
    // прямо сейчас отключают: дальше `setReaction`/`deleteMessage` уходили в
    // gramjs на закрытом соединении, то есть в исключение вместо тихого
    // фолбэка на синглтон, ради которого null и возвращается.
    if (this.stopped) {
      log.warn(`[userbot-router] роутер остановлен, сессию для ${agentKey} не отдаём`);
      return null;
    }

    // Check if already started
    if (this.sessions.has(agentKey)) {
      return this.sessions.get(agentKey)!;
    }

    // Старт уже идёт — ждём тот же промис, а не поднимаем вторую сессию.
    const inFlight = this.starting.get(agentKey);
    if (inFlight) return inFlight;

    // Load config
    const config = this.configs.get(agentKey);
    if (!config) {
      log.debug(`[userbot-router] agent ${agentKey} not registered`);
      return null;
    }

    // Check if session file exists
    if (!existsSync(config.sessionFile)) {
      log.warn(`[userbot-router] no session file for ${agentKey}: ${config.sessionFile}`);
      return null;
    }

    // Запись в карту — синхронно, ДО первого await: иначе окно гонки просто
    // сужается, а не закрывается.
    const started = this.startSession(agentKey, config).finally(() => {
      this.starting.delete(agentKey);
    });
    this.starting.set(agentKey, started);
    return started;
  }

  private async startSession(
    agentKey: string,
    config: AgentSessionConfig,
  ): Promise<UserbotHandle | null> {
    try {
      // Start userbot session
      const handle = await startUserbot({
        sessionPath: config.sessionFile,
        allowedChatIds: effectiveAllowedChatIds(config, this.opts.defaultAllowedChatIds),
        onMessage: (msg) => {
          // Relay message with agent context
          this.opts.onMessage({
            ...msg,
            agentKey,
          });
        },
      });

      if (handle.isNoop) {
        log.warn(`[userbot-router] failed to start session for ${agentKey}`);
        return null;
      }

      this.sessions.set(agentKey, handle);
      log.info(`[userbot-router] started session for agent: ${agentKey}`);
      return handle;
    } catch (error) {
      log.error(`[userbot-router] error starting session for ${agentKey}`, { error: String(error) });
      return null;
    }
  }

  /**
   * Выбрать аккаунт для действия от имени агента — на тех же правилах, что и
   * `getUserbotHandle` ниже.
   *
   * Аудит 2026-08-28: у роутера было две двери к откату, и вторая правило не
   * знала. `getUserbotHandle` отказывает, если сессия агента ОБЪЯВЛЕНА, но
   * недоступна: оператор ставит USERBOT_SESSION_SMM ровно затем, чтобы smm
   * ходил со своего аккаунта, и молчаливый уход на общий — подмена личности, а
   * не деградация. А `setReaction`/`deleteMessage` откатывались безусловно и
   * прямо это обещали в докстринге.
   *
   * Прод сегодня ходит мимо этих методов (`lib/dispatch/telegram.ts` резолвит
   * handle сам), так что это была не утечка, а заряженная мина.
   *
   * Правило нельзя занять у `getUserbotHandle`: та функция смотрит на
   * модульный `_routerInstance`, а не на `this` — экземпляр, созданный в
   * тестах или вторым, ушёл бы мимо своих же сессий. Повторяем против `this`.
   *
   * Незарегистрированный агент и вызов без ключа откатываются как прежде: это
   * исходный режим «роутера нет, все ходят через общий аккаунт».
   */
  private async resolveForAction(agentKey: string | undefined): Promise<UserbotHandle | null> {
    if (agentKey) {
      const handle = await this.getAgentHandle(agentKey);
      if (handle && !handle.isNoop) return handle;
      if (this.getAgentStatus(agentKey).registered) {
        log.warn(
          `[userbot-router] персональная сессия ${agentKey} объявлена, но недоступна — на общий аккаунт НЕ откатываемся`,
        );
        return null;
      }
    }

    const fallbackHandle = getCurrentUserbot();
    return fallbackHandle && !fallbackHandle.isNoop ? fallbackHandle : null;
  }

  /**
   * Сообщение об отказе. Подстрока `No userbot session available` историческая
   * — на неё смотрят вызывающие и тесты, поэтому причина дописывается справа,
   * а не вместо. Причин ровно две, и они требуют разных действий оператора:
   * починить объявленную сессию или, наоборот, ничего не объявлять.
   */
  private noSessionError(agentKey: string | undefined): Error {
    const declared = !!agentKey && this.getAgentStatus(agentKey).registered;
    return new Error(
      declared
        ? `No userbot session available: сессия '${agentKey}' объявлена, но недоступна — на общий аккаунт не откатываемся`
        : "No userbot session available",
    );
  }

  /**
   * Execute SET_REACTION action via specific agent.
   * Uses the singleton userbot only when the agent has no session declared.
   */
  async setReaction(
    agentKey: string | undefined,
    chatId: number | string,
    msgId: number,
    emoji: string,
  ): Promise<void> {
    const handle = await this.resolveForAction(agentKey);
    if (!handle) throw this.noSessionError(agentKey);
    return await handle.setReaction(chatId, msgId, emoji);
  }

  /**
   * Execute DELETE_MESSAGE action via specific agent.
   * Uses the singleton userbot only when the agent has no session declared.
   */
  async deleteMessage(
    agentKey: string | undefined,
    chatId: number | string,
    msgId: number,
  ): Promise<void> {
    const handle = await this.resolveForAction(agentKey);
    if (!handle) throw this.noSessionError(agentKey);
    return await handle.deleteMessage(chatId, msgId);
  }

  /**
   * Stop all active userbot sessions.
   */
  async stopAll(): Promise<void> {
    // Сессия, которая поднимается прямо сейчас, иначе доедет до sessions уже
    // после того, как карта очищена: соединение останется жить с обработчиком
    // апдейтов и без единой ссылки на себя. Дожидаемся стартующих и гасим их
    // общим циклом ниже — startSession кладёт результат в sessions сам.
    //
    // Аудит 2026-08-27: флаг ставится ПЕРВЫМ, синхронно, и здесь же убран
    // `this.starting.clear()`. Очистка не была нужна (`.finally()` в
    // getAgentHandle удаляет каждую запись сам) и открывала ровно ту дыру,
    // которую этот комментарий объявляет закрытой: пока идёт await ниже,
    // параллельный getAgentHandle не видел стартующего промиса и начинал
    // второй старт на том же файле сессии.
    this.stopped = true;
    const pending = [...this.starting.values()];
    if (pending.length > 0) await Promise.allSettled(pending);

    const promises: Promise<void>[] = [];

    for (const [agentKey, handle] of this.sessions.entries()) {
      promises.push(
        handle.stop().catch((error) => {
          log.error(`[userbot-router] error stopping ${agentKey}`, { error: String(error) });
        })
      );
    }

    await Promise.allSettled(promises);
    this.sessions.clear();
    log.info("[userbot-router] stopped all sessions");
  }

  /**
   * Get list of active agent sessions.
   */
  getActiveAgents(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get agent session status.
   */
  getAgentStatus(agentKey: string): { 
    registered: boolean; 
    active: boolean; 
    sessionFile?: string; 
  } {
    const config = this.configs.get(agentKey);
    const handle = this.sessions.get(agentKey);

    return {
      registered: !!config,
      active: !!(handle && !handle.isNoop),
      sessionFile: config?.sessionFile,
    };
  }

  /**
   * Get all registered agent configurations.
   */
  getAllConfigs(): Map<string, AgentSessionConfig> {
    return new Map(this.configs);
  }
}

/* ────── character → router wiring (T-401) ────── */

/** Minimal structural shape of a character that may carry userbot config. */
export interface UserbotConfigurableCharacter {
  key: string;
  userbot?: AgentSessionConfig;
}

/**
 * Resolve the userbot session config for one character.
 * Precedence: explicit `character.userbot` field → env override
 * (`USERBOT_SESSION_<KEY>` + optional `USERBOT_ALLOWED_CHATS_<KEY>` CSV).
 * Returns null when neither is configured (→ singleton fallback applies).
 */
export function resolveCharacterUserbotConfig(
  char: UserbotConfigurableCharacter,
  defaultAllowedChatIds: Array<string | number>,
): AgentSessionConfig | null {
  // 1) Explicit declarative config on the character wins.
  if (char.userbot?.sessionFile && char.userbot.sessionFile.trim()) {
    const ids = char.userbot.allowedChatIds;
    return {
      sessionFile: char.userbot.sessionFile.trim(),
      allowedChatIds: ids && ids.length > 0 ? ids : defaultAllowedChatIds,
    };
  }

  // 2) Runtime env override (keeps session paths out of source).
  const upper = char.key.toUpperCase();
  const sessionFile = process.env[`USERBOT_SESSION_${upper}`]?.trim();
  if (sessionFile) {
    // Аудит 2026-08-27: решение принималось по НЕразобранному CSV, поэтому
    // `USERBOT_ALLOWED_CHATS_SMM=","` (или `" , "`) давало `csv.length > 0`,
    // а после `filter(Boolean)` — пустой массив: сессия молча переставала
    // ингестить что-либо. При этом НЕзаданная переменная честно откатывалась
    // на дефолт. Ровно тот «лишняя запятая — и всё выпало на filter(Boolean)»,
    // о котором предупреждает шапка userbot.ts. Решаем по РЕЗУЛЬТАТУ разбора.
    const csv = process.env[`USERBOT_ALLOWED_CHATS_${upper}`]?.trim();
    const parsed = csv ? csv.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const allowedChatIds = parsed.length > 0 ? parsed : defaultAllowedChatIds;
    return { sessionFile, allowedChatIds };
  }

  return null;
}

/**
 * Build and populate a UserbotRouter from a list of characters.
 * Registers every character that has a resolvable userbot config (declarative
 * or env). Returns null when NO character is configured, so the caller can keep
 * the singleton-only behaviour untouched (zero overhead, no router installed).
 */
export function buildUserbotRouter(
  characters: UserbotConfigurableCharacter[],
  opts: UserbotRouterOpts,
): UserbotRouter | null {
  const router = new UserbotRouter(opts);
  let registered = 0;
  for (const char of characters) {
    const cfg = resolveCharacterUserbotConfig(char, opts.defaultAllowedChatIds);
    if (cfg) {
      router.registerAgent(char.key, cfg);
      registered++;
    }
  }
  if (registered === 0) {
    log.debug("[userbot-router] no per-character userbot config — singleton only");
    return null;
  }
  log.info(`[userbot-router] built router for ${registered} character session(s)`);
  return router;
}

/* ────── module-level singleton for global access ────── */

let _routerInstance: UserbotRouter | null = null;

export function setUserbotRouter(router: UserbotRouter | null): void {
  _routerInstance = router;
}

export function getUserbotRouter(): UserbotRouter | null {
  return _routerInstance;
}

/**
 * Get userbot handle for action dispatch.
 *
 * Персональная сессия агента, иначе — общий синглтон. ЕДИНСТВЕННАЯ точка,
 * где принимается решение об откате: обе копии `resolveUserbotHandle`
 * (`lib/action-dispatch.ts`, `lib/dispatch/telegram.ts`) обязаны отдавать
 * результат этой функции как есть, а не откатываться на синглтон второй раз.
 *
 * Аудит 2026-08-28: откат был безусловным, и это подменяло ЛИЧНОСТЬ. Оператор
 * объявляет `USERBOT_SESSION_SMM` ровно затем, чтобы smm публиковал со своего
 * аккаунта. Файл сессии протухает (Telegram инвалидирует их штатно) —
 * `getAgentHandle` отдаёт null, и каждая следующая публикация уходит В КАНАЛ
 * с ЛИЧНОГО аккаунта владельца, а действие отчитывается `ok, via: "userbot"`.
 * Ни строки о подмене. Явно объявленная сессия не деградирует молча до чужой:
 * зарегистрирован, но недоступен — это отказ, а не другой аккаунт.
 *
 * Агенты БЕЗ объявленной сессии откатываются как и раньше: это исходный режим
 * «роутера нет, все ходят через общий аккаунт», и ломать его нечем.
 */
export async function getUserbotHandle(agentKey?: string): Promise<UserbotHandle | null> {
  if (_routerInstance && agentKey) {
    const handle = await _routerInstance.getAgentHandle(agentKey);
    if (handle) {
      return handle;
    }
    if (_routerInstance.getAgentStatus(agentKey).registered) {
      log.warn(
        `[userbot-router] персональная сессия ${agentKey} объявлена, но недоступна — ` +
          `на общий аккаунт НЕ откатываемся`,
      );
      return null;
    }
  }

  // Fallback to singleton userbot
  return getCurrentUserbot();
}