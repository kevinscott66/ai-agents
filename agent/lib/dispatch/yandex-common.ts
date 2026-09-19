/**
 * Общее у трёх Яндекс-потоков (такси, покупки, доставка): проверка владельца,
 * запрос к Mac, уведомление владельцу, тексты отказов гейта, очередь исполнителя.
 *
 * Шаги исполнителя (claim → prepare → checkFinal → confirm) и их тексты остаются
 * в модулях сервисов: сообщения и ветки там разные.
 */
import { randomBytes } from "node:crypto";
import { parseUserIdList } from "../allowlist.ts";
import { log } from "../log.ts";
import { SignedActionRefusal } from "../signed-actions.ts";

export type YandexNotifier = {
  text: (userId: string, text: string) => Promise<void>;
  photo: (userId: string, jpegBase64: string, caption: string) => Promise<void>;
};

export type MacReply = { ok: boolean; stdout: string; error?: string };

export type YandexInlineContext = { agentKey: string; chatId: number; triggerUserId?: string; delegationChain?: string[] };

/** Ключ сессии браузера на один подписанный заказ. */
export const newYandexSession = () => randomBytes(24).toString("base64url");

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Код отказа гейта или текст прочей ошибки. */
export const refusalCode = (e: unknown) => (e instanceof SignedActionRefusal ? e.code : errorText(e));

export const inlineDelegated = (ctx: YandexInlineContext) => (ctx.delegationChain ?? []).some((k) => k !== ctx.agentKey);

export type YandexOwnerPolicy = {
  enabled: () => boolean;
  /** Ответ при выключенном флаге, целиком. */
  disabledText: string;
  /** Английское имя в `forbidden: … is restricted to orchestrator`. */
  scope: string;
  /** Русское имя в `forbidden: … — только по просьбе владельца в его личном чате`. */
  ownerNoun: string;
};

/** Только оркестратор, только владелец и только в его личном чате, без делегирования. */
export function yandexOwnerRefusal(
  policy: YandexOwnerPolicy,
  agentKey: string,
  chatId: number,
  userId: string | undefined,
  delegated: boolean,
): string | null {
  if (!policy.enabled()) return policy.disabledText;
  if (agentKey !== "orchestrator") return `forbidden: ${policy.scope} is restricted to orchestrator (caller: ${agentKey})`;
  const owners = parseUserIdList(process.env.MINIAPP_ADMIN_USER_IDS);
  if (delegated || !userId || !owners.includes(Number(userId)) || String(chatId) !== userId) {
    return `forbidden: ${policy.ownerNoun} — только по просьбе владельца в его личном чате`;
  }
  return null;
}

/** Запрос к Mac → проверенный ответ. Ошибка моста — исключение с её кодом. */
export async function askYandexMac<Req extends { op: string }, Out>(
  send: (request: Req, userId: string, chatId: number) => Promise<MacReply>,
  parse: (raw: string, expected: Req["op"]) => Out,
  failCode: string,
  request: Req,
  userId: string,
  chatId: number,
): Promise<Out> {
  const res = await send(request, userId, chatId);
  if (!res.ok) throw new Error(res.error ?? failCode);
  return parse(res.stdout, request.op);
}

/** Сообщение владельцу: со скриншотом — фото с подписью, иначе текст. Сбой только в лог. */
export function yandexTeller(tag: string, notifier: () => YandexNotifier | undefined) {
  return async (userId: string, text: string, screenshot?: string): Promise<void> => {
    const notify = notifier();
    if (!notify) {
      log.warn(`[${tag}] notifier is not configured`, { text });
      return;
    }
    try {
      if (screenshot) await notify.photo(userId, screenshot, text);
      else await notify.text(userId, text);
    } catch (error) {
      log.error(`[${tag}] notify failed`, { error: String(error) });
    }
  };
}

const GATE_TEXT: Partial<Record<string, string>> = {
  no_active_key: "на телефоне нет активного ключа подписи — владелец регистрирует его в приложении",
  limit_amount: "сумма выше лимита на один заказ (PAID_ACTION_MAX_RUB)",
  limit_daily: "дневной лимит платных действий исчерпан",
  payload_invalid: "заявка не проходит проверку гейта",
};

/**
 * Текст ошибки выдачи заявки гейтом. `overrides` — тексты, которые у сервиса
 * свои (у доставки — имя переменной лимита).
 */
export function gateIssueError(e: unknown, overrides: Partial<Record<string, string>> = {}): string {
  if (e instanceof SignedActionRefusal) return overrides[e.code] ?? GATE_TEXT[e.code] ?? e.code;
  return errorText(e);
}

/** Исполнитель один: следующая задача ждёт, пока не закончится предыдущая. */
export function serialQueue() {
  let queue: Promise<void> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const run = queue.then(task);
      queue = run.then(() => {}, () => {});
      return run;
    },
    reset() {
      queue = Promise.resolve();
    },
  };
}
