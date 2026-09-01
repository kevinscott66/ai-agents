/**
 * Аудит 2026-08-29: рефанд не должен снимать ЧУЖУЮ отметку.
 *
 * `refundBucket` снимал «последнюю отметку внутри окна», без всякой связи с
 * той резервацией, которую откатывают. Для быстрого действия это безобидно —
 * отметки внутри одного окна взаимозаменяемы. Для долгого это ровно наоборот:
 * `MAC_RUN_CLAUDE` ждёт mac-мост до пяти минут и на таймауте возвращает
 * `{ok:false}` без `sideEffect`, то есть штатно рефандится, а его собственная
 * резервация к этому моменту из минутного окна уже вышла и в счёте не
 * участвует. Рефанд находил живую отметку соседнего хода и снимал её — лимит
 * «N в минуту» пропускал N+1-й вызов.
 *
 * Проверяем ровно это: истёкшая резервация откатывается в ноль, живая — в один
 * слот, а вызов без `reservedAt` сохраняет прежнее поведение.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  checkAndConsumeRateLimit,
  refundRateLimit,
  checkAndConsumeChatRateLimits,
  refundChatRateLimits,
  _resetRateLimits,
} from "../lib/rate-limits.ts";

const AGENT = "audit-refund-expired";
const ACTION = "DELEGATE_TO_ROLE"; // perAgent 6/мин
const PER_AGENT_MAX = 6;
const MINUTE = 60_000;
const T0 = 5_000_000;
/** Пять минут — таймаут mac-моста; резервация T0 давно вне минутного окна. */
const LATE = T0 + 5 * MINUTE;

const BOT = 4242;
const CHAT = -100999;
const PER_BOT_CHAT_MAX = 20; // связывающий потолок пары (бот, чат)

/** Сколько ещё резерваций пройдёт в момент `now`. Мутирует корзины — вызывать последним. */
function drainAgent(now: number, cap = 40): number {
  let n = 0;
  while (n < cap && checkAndConsumeRateLimit(AGENT, ACTION, now).ok) n++;
  return n;
}

function drainChat(now: number, cap = 40): number {
  let n = 0;
  while (n < cap && checkAndConsumeChatRateLimits(BOT, CHAT, ACTION, now).ok) n++;
  return n;
}

describe("refundBucket: истёкшая резервация не крадёт живой слот", () => {
  beforeEach(() => _resetRateLimits());
  afterEach(() => _resetRateLimits());

  test("резервирующие функции возвращают собственную отметку", () => {
    const r = checkAndConsumeRateLimit(AGENT, ACTION, T0);
    expect(r.ok).toBe(true);
    expect(r.reservedAt).toBe(T0);

    const c = checkAndConsumeChatRateLimits(BOT, CHAT, ACTION, T0);
    expect(c.ok).toBe(true);
    expect(c.reservedAt).toBe(T0);
  });

  test("отказ резервации не выдаёт reservedAt", () => {
    for (let i = 0; i < PER_AGENT_MAX; i++) {
      expect(checkAndConsumeRateLimit(AGENT, ACTION, T0).ok).toBe(true);
    }
    const denied = checkAndConsumeRateLimit(AGENT, ACTION, T0);
    expect(denied.ok).toBe(false);
    expect(denied.reservedAt).toBeUndefined();
  });

  test("агентский бакет: рефанд истёкшей резервации — no-op", () => {
    const stale = checkAndConsumeRateLimit(AGENT, ACTION, T0);
    expect(stale.ok).toBe(true);

    // Пять минут спустя чужой ход занимает слот.
    expect(checkAndConsumeRateLimit(AGENT, ACTION, LATE).ok).toBe(true);

    // Долгое действие провалилось и рефандится своей отметкой.
    refundRateLimit(AGENT, ACTION, LATE, stale.reservedAt);

    // Чужая отметка должна уцелеть: свободных слотов на один меньше потолка.
    expect(drainAgent(LATE)).toBe(PER_AGENT_MAX - 1);
  });

  test("чат-бакеты: рефанд истёкшей резервации — no-op", () => {
    const stale = checkAndConsumeChatRateLimits(BOT, CHAT, ACTION, T0);
    expect(stale.ok).toBe(true);

    expect(checkAndConsumeChatRateLimits(BOT, CHAT, ACTION, LATE).ok).toBe(true);
    refundChatRateLimits(BOT, CHAT, ACTION, LATE, stale.reservedAt);

    expect(drainChat(LATE)).toBe(PER_BOT_CHAT_MAX - 1);
  });

  test("живая резервация по-прежнему возвращает ровно один слот", () => {
    const fresh = checkAndConsumeRateLimit(AGENT, ACTION, T0);
    expect(fresh.ok).toBe(true);
    const soon = T0 + 1_000;

    refundRateLimit(AGENT, ACTION, soon, fresh.reservedAt);

    expect(drainAgent(soon)).toBe(PER_AGENT_MAX);
  });

  test("одновременные ходы взаимозаменяемы: рефанд снимает один слот из двух", () => {
    const a = checkAndConsumeRateLimit(AGENT, ACTION, T0);
    const b = checkAndConsumeRateLimit(AGENT, ACTION, T0);
    expect(a.reservedAt).toBe(b.reservedAt);

    refundRateLimit(AGENT, ACTION, T0, a.reservedAt);

    expect(drainAgent(T0)).toBe(PER_AGENT_MAX - 1);
  });

  test("без reservedAt поведение прежнее — снимается последняя отметка в окне", () => {
    checkAndConsumeRateLimit(AGENT, ACTION, T0);
    checkAndConsumeRateLimit(AGENT, ACTION, T0 + 1_000);

    refundRateLimit(AGENT, ACTION, T0 + 2_000);

    expect(drainAgent(T0 + 2_000)).toBe(PER_AGENT_MAX - 1);
  });

  test("рефанд по несуществующей отметке ничего не портит", () => {
    checkAndConsumeRateLimit(AGENT, ACTION, T0);

    refundRateLimit(AGENT, ACTION, T0, T0 - 7); // отметки с таким временем нет

    expect(drainAgent(T0)).toBe(PER_AGENT_MAX - 1);
  });

  test("GENERATE_IMAGE не рефандится и с reservedAt", () => {
    const r = checkAndConsumeRateLimit(AGENT, "GENERATE_IMAGE", T0);
    expect(r.ok).toBe(true);

    refundRateLimit(AGENT, "GENERATE_IMAGE", T0, r.reservedAt);

    // Слот списан безвозвратно — общий бакет агента (60/мин) на один меньше.
    let n = 0;
    while (n < 70 && checkAndConsumeRateLimit(AGENT, "MAC_RUN_CLAUDE", T0).ok) n++;
    expect(n).toBe(59);
  });
});
