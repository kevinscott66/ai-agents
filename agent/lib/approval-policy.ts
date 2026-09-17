/**
 * Политика подтверждений владельца: что уходит на исполнение только после его
 * «да» в чате, при любой автономии и при MAC_AUTONOMOUS.
 *
 * Правило владельца: деньги, DNS, пуш в main, удаление, выключение машины и
 * сообщения третьим лицам — только после подтверждения. Раньше эти случаи
 * держались разными рубежами (ALWAYS_APPROVE_ACTIONS, owner-voice, bypass), и
 * части не было вовсе: DELETE_MESSAGE в режиме auto уходил сам, а прогон на
 * Mac с «git push origin main» при MAC_AUTONOMOUS не спрашивал никого. Здесь
 * список собран по категориям; permissions.payloadForcesApproval зовёт его
 * единой точкой, и гейт отвечает approval в любом режиме, кроме locked.
 *
 * Модуль без побочек и без БД. Описание — docs/approval-policy.md.
 */
import { isMacPowerOff } from "./mac-control.ts";

export const APPROVAL_CATEGORIES = [
  "money",
  "dns",
  "push_main",
  "delete",
  "shutdown",
  "third_party_message",
] as const;
export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<ApprovalCategory, string> = {
  money: "платное действие",
  dns: "изменение DNS",
  push_main: "запись в main",
  delete: "удаление",
  shutdown: "выключение или перезагрузка",
  third_party_message: "сообщение от имени владельца",
};

/**
 * Действия, которые целиком попадают в категорию, что бы ни было в payload.
 * Ключ — строка, а не ActionType: сюда заранее вписаны действия следующих
 * шагов (DNS через Cloudflare, платные заказы через подписанный гейт), и
 * политика должна встретить их раньше, чем они появятся в ACTION_TYPES.
 */
export const ACTION_CATEGORY: Readonly<Record<string, ApprovalCategory>> = Object.freeze({
  DELETE_MESSAGE: "delete",
  REVIEW_AND_MERGE_PR: "push_main",
  USERBOT_SEND_DM: "third_party_message",
  // Зарезервировано: шаг 8 (DNS) и платные действия (такси, еда, курьер, покупки).
  CLOUDFLARE_DNS: "dns",
  ORDER_TAXI: "money",
  TAXI_CANCEL: "money",
  ORDER_FOOD: "money",
  ORDER_DELIVERY: "money",
  MARKET_PURCHASE: "money",
});

/** Действия, где `via_userbot: true` значит «от лица владельца другому человеку». */
const USERBOT_ACTIONS = new Set(["SEND_MESSAGE", "SET_REACTION", "DELETE_MESSAGE"]);

/**
 * Эвристики для свободного промпта MAC_RUN_CLAUDE. Это не песочница — промпт
 * можно сформулировать в обход, — а пол: явная просьба сделать опасное не
 * должна уходить без человека только потому, что включён MAC_AUTONOMOUS.
 * Пропуск ловят остальные рубежи (MAC_DENIED_PROMPT_PATTERNS, права на Mac).
 */
const PROMPT_RULES: ReadonlyArray<[ApprovalCategory, RegExp]> = [
  ["push_main", /\bgit\s+push\b[^\n]*\b(main|master)\b|\bpush\b[^\n]*--force|\bforce[- ]push|пуш\S*\s+(в\s+)?(main|master|мейн)|(в|to)\s+(main|master)\b[^\n]*\b(push|пуш)/i],
  ["delete", /\brm\s+-[a-z]*[rf]|\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|push\s+[^\n]*--delete)|\bdrop\s+(table|database)\b|\btruncate\s+table\b|\bdelete\s+from\b|удал(и|ить|ите|яй)|стер(еть|и)(?![а-яё])|снес(и|ти)(?![а-яё])/i],
  ["dns", /\bdns\b|cloudflare|\bcname\b|(?<![а-яёa-z])[aа]-?запис|\bnameserver|днс/i],
  ["money", /оплат|купи|закаж|заказать|перевед|переве(сти|ди)\s|\bpayment\b|\bpay\b|\bpurchase\b|\bcheckout\b/i],
  ["shutdown", /\b(shutdown|reboot|halt|poweroff)\b|выключ(и|ить)\s+(мак|mac|компьютер|машину)|перезагру/i],
  ["third_party_message", /отправ(ь|ить)\s+(сообщени|письм|смс|email)|напиши\s+(ему|ей|им)(?![а-яё])|\bsend\s+(an?\s+)?(email|message)\b/i],
];

/** Категории, которые требуют подтверждения для этого действия. Пусто — политика не вмешивается. */
export function approvalCategories(actionType: string, payload: unknown): ApprovalCategory[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const out = new Set<ApprovalCategory>();
  const fixed = ACTION_CATEGORY[actionType];
  if (fixed) out.add(fixed);
  if (USERBOT_ACTIONS.has(actionType) && p.via_userbot === true) out.add("third_party_message");
  if (actionType === "MAC_CONTROL" && isMacPowerOff(p.command)) out.add("shutdown");
  // plan ничего не исполняет: план «как запушить в main» подтверждать не нужно.
  if (actionType === "MAC_RUN_CLAUDE" && p.mode !== "plan" && typeof p.prompt === "string") {
    for (const [category, re] of PROMPT_RULES) if (re.test(p.prompt)) out.add(category);
  }
  return APPROVAL_CATEGORIES.filter((c) => out.has(c));
}

/** Причина для карточки подтверждения либо null. */
export function approvalPolicyReason(actionType: string, payload: unknown): string | null {
  const categories = approvalCategories(actionType, payload);
  if (!categories.length) return null;
  return `политика владельца: ${categories.map((c) => CATEGORY_LABEL[c]).join(", ")} — только с подтверждением`;
}
