/**
 * MAC handlers (MAC_RUN_CLAUDE, MAC_STOP).
 * Extracted from action-dispatch.ts for T-112 modularization.
 */
import { getErrorMessage } from "../errors.ts";
import type { Telegram } from "telegraf";
import { tgSendMessage } from "../telegram-actions.ts";
import {
  sendToMac as realSendToMac,
  isMacConnected as realIsMacConnected,
  isMacOnline as realIsMacOnline,
  isUserAllowed as realIsUserAllowed,
  stopMac as realStopMac,
} from "../mac-bridge.ts";
import { TELEGRAM_MESSAGE_TAIL_LIMIT } from "../constants.ts";
import { log } from "../log.ts";
import type { PayloadByType } from "../action-payload.ts";
import type { HandlerResult } from "./helpers.ts";

export type MacBridge = {
  isMacConnected: () => boolean;
  /**
   * Живость, а не просто «сокет есть». Необязателен ради тестовых заглушек,
   * которые давно передают только isMacConnected — см. macIsUsable().
   */
  isMacOnline?: () => boolean;
  sendToMac: (req: {
    project: string;
    prompt: string;
    mode: "ask" | "accept_edits" | "plan" | "auto" | "bypass";
    onProgress?: (s: {
      stdout: string;
      stderr: string;
      stdoutLen?: number;
      stderrLen?: number;
    }) => void;
  }) => Promise<{
    ok: boolean;
    code?: number;
    stdout: string;
    stderr: string;
    stdoutLen?: number;
    stderrLen?: number;
    truncated?: boolean;
    error?: string;
  }>;
  stopMac: () => Promise<{ ok: boolean; error?: string }>;
  isUserAllowed: (userId: string | undefined | null) => boolean;
};

/**
 * Аудит 2026-08-08: здесь стоял isMacConnected(), то есть «сокет не null».
 * Мак с закрытой крышкой держит TCP-соединение ещё долго после того, как
 * перестал отвечать: run уходил в пустоту, вызывающий висел все пять минут
 * RUN_TIMEOUT_MS и получал mac_timeout. При этом сам мост уже знал правду —
 * /api/health показывал mac_online:false тем же isMacOnline(), которого тут
 * не спрашивали.
 */
function macIsUsable(bridge: Pick<MacBridge, "isMacConnected" | "isMacOnline">): boolean {
  if (!bridge.isMacConnected()) return false;
  return bridge.isMacOnline ? bridge.isMacOnline() : true;
}

/**
 * Разобрать MAC_DENIED_PROMPT_PATTERNS в список регулярок.
 *
 * Аудит 2026-08-12: здесь стоял голый `split(",")`. Но запятая в регулярке —
 * метасимвол: она живёт внутри квантификатора `{n,m}`. Шаблон `rm\s{1,3}-rf`
 * резался на `rm\s{1` и `3}-rf`, и оба огрызка компилировались УСПЕШНО (в JS
 * без флага `u` незакрытая `{` — просто литерал) и не матчили ничего. То есть
 * правило исчезало молча: ни ошибки, ни warn, а MAC_DENIED_PROMPT_PATTERNS
 * непустой и выглядит рабочим.
 *
 * Поэтому делим только по запятым вне `{…}`. Экранированная `\{` скобки не
 * открывает — это литерал, и запятая за ней обычная.
 *
 * Повторный аудит 2026-08-20: у той же дыры остался второй вход. Незакрытая
 * `{` — то есть ровно та опечатка, из-за которой правило и ломается, — держала
 * `depth > 0` до конца строки, и ВСЕ последующие правила склеивались в одно.
 * Замер: `rm\s{1,3-rf,cat /etc/passwd,sudo` даёт один шаблон, он успешно
 * компилируется (в JS без флага `u` незакрытая `{` — литерал) и не матчит ни
 * `cat /etc/passwd`, ни `sudo`. Опять молча: переменная непустая и выглядит
 * настроенной. Поэтому несбалансированная `{` теперь ошибка, а вызывающий на
 * ней закрывается — как и на нечитаемом шаблоне.
 */
export function parseDeniedPatterns(csv: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let escaped = false;
  let inClass = false;
  const flush = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = "";
  };
  for (const ch of csv) {
    if (escaped) {
      escaped = false;
      buf += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      buf += ch;
      continue;
    }
    if (ch === "," && depth === 0 && !inClass) {
      flush();
      continue;
    }
    if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    else if (!inClass && ch === "{") depth++;
    else if (!inClass && ch === "}" && depth > 0) depth--;
    buf += ch;
  }
  if (depth > 0) {
    throw new Error(
      `незакрытая '{' в MAC_DENIED_PROMPT_PATTERNS — правила после неё склеились в одно`,
    );
  }
  if (inClass) {
    throw new Error(
      `незакрытая '[' в MAC_DENIED_PROMPT_PATTERNS — класс символов не закрыт`,
    );
  }
  flush();
  return out;
}

/**
 * Хвост строки, не разрезающий суррогатную пару.
 *
 * Аудит 2026-08-20: `slice(-LIMIT)` режет по code unit'ам. Лимит чётный, но
 * стоит выводу содержать нечётное число не-BMP символов — и граница ложится в
 * середину пары. Замер: хвост начинается с одиночного `0xdd25`,
 * `isWellFormed()` даёт false, `JSON.stringify` пропускает его как `\udd25`,
 * и до Telegram доезжает суррогат без пары — а у него нет кодировки в UTF-8,
 * которую Bot API требует. Отправка отваливается целиком, `.catch(() => {})`
 * это глотает, и оператор не видит результата прогона вообще.
 */
export function tailByCodePoints(s: string, limit: number): string {
  if (s.length <= limit) return s;
  let start = s.length - limit;
  const c = s.charCodeAt(start);
  // Младший суррогат в начале хвоста — значит старший остался за границей.
  if (c >= 0xdc00 && c <= 0xdfff) start++;
  return s.slice(start);
}

export type MacHandlerContext = {
  agentKey: string;
  chatId: number;
  telegram?: Telegram;
  macBridge?: MacBridge;
};

export type MacHandlerResult = HandlerResult;

export async function handleMacRunClaude(
  payload: PayloadByType["MAC_RUN_CLAUDE"],
  ctx: MacHandlerContext,
): Promise<MacHandlerResult> {
  const p = payload;
  const bridge = ctx.macBridge ?? {
    isMacConnected: realIsMacConnected,
    isMacOnline: realIsMacOnline,
    sendToMac: realSendToMac,
    isUserAllowed: realIsUserAllowed,
  };
  if (!bridge.isUserAllowed(p._userId)) {
    return { ok: false, error: "forbidden" };
  }

  // Check denied patterns before proceeding
  const deniedPatternsEnv = process.env.MAC_DENIED_PROMPT_PATTERNS ?? "";
  if (deniedPatternsEnv.trim()) {
    let patterns: string[];
    try {
      patterns = parseDeniedPatterns(deniedPatternsEnv);
    } catch (e) {
      // Тот же выбор, что и ниже на нечитаемом шаблоне: разобрать денилист не
      // вышло — значит неизвестно, попадал ли под него промпт.
      log.error("[mac] MAC_DENIED_PROMPT_PATTERNS не разбирается", {
        error: getErrorMessage(e),
      });
      return {
        ok: false,
        error: "forbidden: некорректный MAC_DENIED_PROMPT_PATTERNS",
      };
    }
    for (const pattern of patterns) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (e) {
        // Аудит 2026-08-12: тут стоял `log.warn` и продолжение цикла, то есть
        // сломанное правило денилиста просто выпадало из проверки и запрос
        // уходил на Mac. У денилиста при нечитаемом правиле выход один — отказ:
        // мы не знаем, попадал под него промпт или нет, а на том конце
        // запускается Claude Code на машине владельца.
        log.error(`[mac] некорректный шаблон денилиста '${pattern}'`, {
          error: String(e),
        });
        return {
          ok: false,
          error: "forbidden: некорректный шаблон в MAC_DENIED_PROMPT_PATTERNS",
        };
      }
      if (regex.test(p.prompt)) {
        return { ok: false, error: "forbidden: prompt matches denied pattern" };
      }
    }
  }

  // Check bypass mode authorization
  if (p.mode === "bypass") {
    const allowBypass = process.env.MAC_ALLOW_BYPASS === "true";
    if (!allowBypass) {
      return { ok: false, error: "forbidden: bypass mode not enabled" };
    }
    // Человек здесь обязателен при любой autonomy — это форсит гейт через
    // payloadForcesApproval/isBypassMacRun (lib/permissions.ts). Раньше здесь
    // стояла ссылка на SEMI_AUTO_RISKY, но она держала только semi_auto: в
    // `auto` (и тем более при MAC_AUTONOMOUS=true) bypass уходил на исполнение
    // без подтверждения. MAC_ALLOW_BYPASS выше — «разрешён в принципе», не
    // «разрешён без спроса».
  }

  if (!macIsUsable(bridge)) {
    return { ok: false, error: "mac_offline" };
  }
  const chatId = ctx.chatId;
  const tg = ctx.telegram;
  // Periodic system progress updates every 10s while the run is in flight.
  let lastNoticeAt = Date.now();
  let lastLen = 0;
  const onProgress = (snap: {
    stdout: string;
    stderr: string;
    stdoutLen?: number;
    stderrLen?: number;
  }) => {
    const now = Date.now();
    // Длины берём полные: хвост в памяти обрезан MAC_STREAM_TAIL_BYTES, и по
    // нему счётчик «сколько утекло» встал бы на плато.
    const totalLen =
      (snap.stdoutLen ?? snap.stdout.length) +
      (snap.stderrLen ?? snap.stderr.length);
    if (tg && now - lastNoticeAt >= 10_000 && totalLen > lastLen) {
      lastNoticeAt = now;
      lastLen = totalLen;
      tgSendMessage(tg, {
        chatId,
        text: `[mac] running… ${totalLen}B streamed`,
      }).catch(() => {});
    }
  };
  let res;
  try {
    res = await bridge.sendToMac({
      project: p.project,
      prompt: p.prompt,
      mode: p.mode,
      onProgress: tg ? onProgress : undefined,
    });
  } catch (e) {
    const msg = getErrorMessage(e);
    return { ok: false, error: msg };
  }
  // Final single message back to the chat with the result.
  //
  // Аудит 2026-08-29: результат сообщения нужно ЗАПОМНИТЬ. Ниже провал
  // возвращался голым `{ok:false}`, а `action-dispatch.ts` на таком провале
  // (`if (res.sideEffect) refundNeeded = false;`) возвращает слот лимита
  // обратно — при том, что в чат уже ушёл `[mac][fail] …` с хвостом вывода.
  // Это ровно тот случай, который комментарий там запрещает: «провал, уже
  // оставивший след снаружи, рефандить нельзя».
  //
  // Транспортные отказы моста (`mac_offline`, `mac_busy`, `mac_send_dropped`,
  // `mac_timeout`) сюда не доходят — они РЕЖЕКТЯТ промис и уходят в catch выше,
  // до всякой отправки; их рефанд правильный и описан в `rate-limits.ts`.
  // Резолв с `ok:false` — это ответ демона: `project_not_allowed`,
  // `spawn_failed`, ненулевой код выхода CLI. Каждый из них уже написал в чат.
  //
  // Флаг ставим по факту отправки, а не безусловно: без `ctx.telegram` (и при
  // упавшей отправке) следа снаружи нет, и рефанд по-прежнему уместен.
  let notified = false;
  if (tg) {
    const combined =
      (res.stdout || "") +
      (res.stderr ? `\n--- stderr ---\n${res.stderr}` : "");
    const tail = tailByCodePoints(combined, TELEGRAM_MESSAGE_TAIL_LIMIT);
    const header = res.ok
      ? `[mac][done] ${p.project} (code=${res.code ?? 0})`
      : `[mac][fail] ${p.project}${res.error ? `: ${res.error}` : ""}`;
    await tgSendMessage(tg, {
      chatId,
      text: `${header}\n\n${tail || "<no output>"}`,
    })
      .then(() => {
        notified = true;
      })
      .catch(() => {});
  }
  if (!res.ok) {
    return {
      ok: false,
      error: res.error ?? `mac run failed (code=${res.code ?? "?"})`,
      ...(notified ? { sideEffect: true } : {}),
    };
  }
  return {
    ok: true,
    result: {
      project: p.project,
      mode: p.mode,
      code: res.code ?? 0,
      stdoutLen: res.stdoutLen ?? res.stdout.length,
      stderrLen: res.stderrLen ?? res.stderr.length,
      ...(res.truncated ? { truncated: true } : {}),
    },
  };
}

export async function handleMacStop(
  payload: PayloadByType["MAC_STOP"],
  // `_userId` живёт в payload, не в ctx: раньше сигнатура объявляла его здесь,
  // хотя код читал его оттуда — расхождение, из-за которого проверку легко
  // было принять за контекстную.
  ctx: MacHandlerContext,
): Promise<MacHandlerResult> {
  const bridge = ctx.macBridge ?? {
    stopMac: realStopMac,
    isMacConnected: realIsMacConnected,
    isMacOnline: realIsMacOnline,
    isUserAllowed: realIsUserAllowed,
  };

  // Check user authorization (same as MAC_RUN_CLAUDE)
  const triggerUserId = payload._userId;
  if (!bridge.isUserAllowed(triggerUserId)) {
    return { ok: false, error: "forbidden" };
  }

  // Намеренно isMacConnected, а не macIsUsable: MAC_STOP — аварийный тормоз.
  // Мак, отставший с pong, всё ещё может принять «убей всё», и отказать ему
  // страшнее, чем отправить stop в уже мёртвый сокет.
  if (!bridge.isMacConnected()) {
    return { ok: false, error: "mac_offline" };
  }

  try {
    const result = await bridge.stopMac();
    if (!result.ok) {
      return { ok: false, error: result.error ?? "stop failed" };
    }

    // Send notification to chat if available
    const tg = ctx.telegram;
    const chatId = ctx.chatId;
    if (tg) {
      await tgSendMessage(tg, {
        chatId,
        text: "[mac] All running Claude processes have been stopped",
      }).catch(() => {});
    }

    return { ok: true, result: { stopped: true } };
  } catch (e) {
    const msg = getErrorMessage(e);
    return { ok: false, error: msg };
  }
}
