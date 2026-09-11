/**
 * Аудит 2026-09-11: возврат чат-слота в gateOrDispatch обещал то, чего не
 * делал — и это при том, что ветка с обещанием сегодня недостижима.
 *
 * Резервация в gateOrDispatch двухступенчатая: сперва чат-бакеты
 * (`checkAndConsumeChatRateLimits`), потом агентский
 * (`checkAndConsumeRateLimit`). Отказ на втором шаге при успехе первого
 * оставляет слот чата занятым ходом, которого не будет, — и там стоял вызов
 * `refundChatRateLimits` с комментарием «вернуть, иначе проигравший всё равно
 * съедает лимит чата». Первая строка этой функции —
 * `if (NO_REFUND_ACTIONS.has(actionType)) return`, а в наборе лежит
 * GENERATE_IMAGE: для единственного платного действия возврат был no-op'ом.
 *
 * Почему NO_REFUND тут не к месту. Набор заведён против другого повода:
 * dispatch СОСТОЯЛСЯ и упал, возможно уже оплатив запрос к провайдеру, —
 * размен «шесть слотов в час против неограниченного счёта» подписан в
 * докблоке `NO_REFUND_ACTIONS` и должен пережить эту правку целиком. Здесь
 * dispatch'а не было вовсе: агентский бакет отказал ДО него, к провайдеру
 * никто не ходил. Поэтому чинится не изъятием GENERATE_IMAGE из набора, а
 * отдельной точкой `releaseUnusedChatReservation` — она говорит не «верни
 * слот за неудачу», а «этой резервацией не воспользовались».
 *
 * ПОЧЕМУ ТЕСТ НЕ ПОВЕДЕНЧЕСКИЙ. Первая версия этого файла гоняла
 * gateOrDispatch и проходила сразу — потому что ветку не задевала вовсе.
 * Достижимости у неё сейчас нет: ранняя проверка (`checkRateLimit`) и
 * резервация (`checkAndConsumeRateLimit`) считают один и тот же предикат —
 * обе уходят в `evaluateAllBuckets`, — между ними нет ни await, ни другого
 * потребителя агентского бакета, так что отказать на втором, пройдя на
 * первом, нечему. Выбор был между тестом, который ничего не проверяет, и
 * честным: единица поведения проверяется напрямую, а место её вызова — по
 * коду. Три предпосылки недостижимости тоже прибиты: если сломается любая,
 * ветка проснётся, и разбудивший увидит здесь, что она значит.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkAndConsumeChatRateLimits,
  checkPerChatRateLimit,
  refundChatRateLimits,
  releaseUnusedChatReservation,
  _resetRateLimits,
} from "../lib/rate-limits.ts";

const CHAT = -1_000_914;
const BOT = 777_001;
const ENV_KEY = "RATE_LIMIT_PER_CHAT_PER_MIN";
/** Один слот на чат: занятый виден сразу, без подсчёта остатка. */
const PER_CHAT_MAX = 1;

const DISPATCH = readFileSync(
  join(import.meta.dir, "..", "lib", "action-dispatch.ts"),
  "utf8",
);
const LIMITS = readFileSync(
  join(import.meta.dir, "..", "lib", "rate-limits.ts"),
  "utf8",
);

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = String(PER_CHAT_MAX);
  _resetRateLimits();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  _resetRateLimits();
});

const chatFree = (action: string) => checkPerChatRateLimit(CHAT, action).ok;

describe("неиспользованная резервация чата отпускается", () => {
  test("GENERATE_IMAGE: refundChatRateLimits не возвращает, release — возвращает", () => {
    const r = checkAndConsumeChatRateLimits(BOT, CHAT, "GENERATE_IMAGE");
    expect(r.ok).toBe(true);
    expect(chatFree("GENERATE_IMAGE")).toBe(false);

    // Пост-диспатчевый возврат для этого действия выключен — и остаётся.
    refundChatRateLimits(BOT, CHAT, "GENERATE_IMAGE", Date.now(), r.reservedAt);
    expect(chatFree("GENERATE_IMAGE")).toBe(false);

    releaseUnusedChatReservation(BOT, CHAT, "GENERATE_IMAGE", Date.now(), r.reservedAt);
    expect(chatFree("GENERATE_IMAGE")).toBe(true);
  });

  test("бакет бота отпускается вместе с чатовым", () => {
    const r = checkAndConsumeChatRateLimits(BOT, CHAT, "GENERATE_IMAGE");
    releaseUnusedChatReservation(BOT, CHAT, "GENERATE_IMAGE", Date.now(), r.reservedAt);
    // Оба бакета свободны — иначе следующий ход упрётся в половинчатое
    // состояние, которое checkAndConsumeChatRateLimits заводить запрещает.
    expect(checkAndConsumeChatRateLimits(BOT, CHAT, "GENERATE_IMAGE").ok).toBe(true);
  });

  test("десять холостых резерваций подряд чат не вычищают", () => {
    for (let i = 0; i < 10; i++) {
      const r = checkAndConsumeChatRateLimits(BOT, CHAT, "GENERATE_IMAGE");
      expect(r.ok).toBe(true);
      releaseUnusedChatReservation(BOT, CHAT, "GENERATE_IMAGE", Date.now(), r.reservedAt);
    }
    expect(chatFree("GENERATE_IMAGE")).toBe(true);
  });

  test("для действия вне NO_REFUND обе точки ведут себя одинаково", () => {
    const a = checkAndConsumeChatRateLimits(BOT, CHAT, "SEND_MESSAGE");
    refundChatRateLimits(BOT, CHAT, "SEND_MESSAGE", Date.now(), a.reservedAt);
    expect(chatFree("SEND_MESSAGE")).toBe(true);

    const b = checkAndConsumeChatRateLimits(BOT, CHAT, "SEND_MESSAGE");
    releaseUnusedChatReservation(BOT, CHAT, "SEND_MESSAGE", Date.now(), b.reservedAt);
    expect(chatFree("SEND_MESSAGE")).toBe(true);
  });

  test("истёкшую резервацию не снимает — как и refundBucket вообще", () => {
    // Аудит 2026-08-29: снимается ровно своя отметка, а вышедшая из окна —
    // ничья. Новая точка идёт через тот же refundBucket и обязана это
    // наследовать, иначе она снимет чужую, живую.
    const now = Date.now();
    const stale = checkAndConsumeChatRateLimits(BOT, CHAT, "GENERATE_IMAGE", now);
    const late = now + 10 * 60 * 1000;
    releaseUnusedChatReservation(BOT, CHAT, "GENERATE_IMAGE", late, stale.reservedAt);
    // Через десять минут отметка и так вне минутного окна: слот свободен, но
    // не потому, что его сняли.
    expect(checkPerChatRateLimit(CHAT, "GENERATE_IMAGE", late).ok).toBe(true);

    const fresh = checkAndConsumeChatRateLimits(BOT, CHAT, "GENERATE_IMAGE", late);
    expect(fresh.ok).toBe(true);
    releaseUnusedChatReservation(BOT, CHAT, "GENERATE_IMAGE", late, stale.reservedAt);
    // Чужая живая отметка на месте.
    expect(checkPerChatRateLimit(CHAT, "GENERATE_IMAGE", late).ok).toBe(false);
  });
});

describe("вызывающие разведены по поводу", () => {
  test("ветка проигрыша зовёт release, а не refund", () => {
    // Конец ищем ОТ начала ветки: такой же `return` есть и у ранней проверки,
    // выше по файлу, и простой indexOf дал бы пустой срез.
    const from = DISPATCH.indexOf("  if (!reserve.ok) {");
    expect(from).toBeGreaterThan(0);
    const branch = DISPATCH.slice(
      from,
      DISPATCH.indexOf('kind: "rate_limited", reason, retryInMs', from),
    );
    expect(branch).toContain("releaseUnusedChatReservation(");
    expect(branch).not.toContain("refundChatRateLimits(");
  });

  test("пост-диспатчевый возврат по-прежнему идёт через refundChatRateLimits", () => {
    const fn = DISPATCH.slice(
      DISPATCH.indexOf("function refundDispatchReservations("),
      DISPATCH.indexOf("let approvalTransactionFaultForTests"),
    );
    expect(fn).toContain("refundChatRateLimits(");
    expect(fn).not.toContain("releaseUnusedChatReservation(");
  });

  test("у release ровно один вызывающий во всём lib/", () => {
    // Смысл «резервация не использована» узкий и проверяемый; расползшись, он
    // превратится во второй refundChatRateLimits без NO_REFUND_ACTIONS.
    const calls = DISPATCH.match(/^\s*releaseUnusedChatReservation\(/gm) ?? [];
    expect(calls).toHaveLength(1);
    // В самом rate-limits.ts имя встречается ровно один раз — в объявлении.
    expect(LIMITS.match(/releaseUnusedChatReservation\(/g) ?? []).toHaveLength(1);
    expect(LIMITS).toContain("export function releaseUnusedChatReservation(");
  });

  test("GENERATE_IMAGE остался в NO_REFUND_ACTIONS", () => {
    expect(LIMITS).toContain('const NO_REFUND_ACTIONS = new Set<string>(["GENERATE_IMAGE"]);');
    const refund = LIMITS.slice(
      LIMITS.indexOf("export function refundChatRateLimits("),
      LIMITS.indexOf("export function releaseUnusedChatReservation("),
    );
    // Выход по набору — первая строка тела, до всякой работы.
    expect(refund).toContain("): void {\n  if (NO_REFUND_ACTIONS.has(actionType)) return;");
  });

  test("release в NO_REFUND_ACTIONS не заглядывает — в этом вся разница", () => {
    const fn = LIMITS.slice(
      LIMITS.indexOf("export function releaseUnusedChatReservation("),
      LIMITS.indexOf("/**\n * Снять отметку резервации из корзины."),
    );
    expect(fn).not.toContain("NO_REFUND_ACTIONS");
  });
});

describe("предпосылки недостижимости ветки", () => {
  const between = DISPATCH.slice(
    DISPATCH.indexOf("const rl = rlBotChat.ok ? checkRateLimit("),
    DISPATCH.indexOf("const reserveChat = checkAndConsumeChatRateLimits("),
  );
  /** Только код: сами комментарии в этом куске про await и говорят. */
  const code = between.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  test("между ранней проверкой и резервацией нет await", () => {
    expect(code).not.toMatch(/\bawait\b/);
  });

  test("и нет второго потребителя агентского бакета", () => {
    expect(code).not.toMatch(/checkAndConsumeRateLimit\(|commitRateLimit\(/);
  });

  test("обе проверки считают один предикат — evaluateAllBuckets", () => {
    const probe = LIMITS.slice(
      LIMITS.indexOf("export function checkRateLimit("),
      LIMITS.indexOf("export function checkAndConsumeRateLimit("),
    );
    expect(probe).toContain("return evaluateAllBuckets(agentKey, actionType, now);");
    const reserve = LIMITS.slice(
      LIMITS.indexOf("export function checkAndConsumeRateLimit("),
      LIMITS.indexOf("function evaluateAllBuckets("),
    );
    expect(reserve).toContain("const decision = evaluateAllBuckets(agentKey, actionType, now);");
  });
});
