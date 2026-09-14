/**
 * Аудит 2026-08-13: единственная константа лимитера была порогом УБОРКИ, а не
 * потолком карты, и звалась при этом MAX_BUCKETS — по имени читалась потолком.
 * Сегодня их две и каждая названа своей работой: `EVICT_AT_BUCKETS` и
 * `HARD_MAX_BUCKETS` (http-utils.ts).
 *
 * Уборка удаляет только протухшие вёдра. При потоке РАЗНЫХ клиентов протухших
 * нет — их возраст меньше TTL, — поэтому размер карты равен
 * `частота новых ключей × BUCKET_TTL_MS` и потолка не имел вовсе. Замер
 * (200 000 ключей, 1000 новых в секунду): 120 999 живых вёдер, то есть 12×
 * «предела», 48 МБ, 413 байт на ведро. На порядок больший поток — ~480 МБ в
 * однопроцессном сервере, который делит поток с SQLite.
 *
 * Появился настоящий потолок. Он бьёт только по СОЗДАНИЮ новых анонимных
 * вёдер: у них ключ — адрес клиента, то есть их число задаёт тот, кто шлёт
 * запросы. Вёдра по user.id ограничены allowlist'ом и не трогаются — иначе
 * чужой флуд запирал бы владельца из его же Mini App.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  consumeRateToken,
  _resetRateLimiter,
  _rateLimiterSize,
} from "../lib/http-utils.ts";

/**
 * Зеркала приватных констант http-utils. Копия осознанная, как и `MAX`/`TTL`
 * в tests/miniapp-anon-rate-limit — тест не должен уметь менять
 * потолок, который проверяет, иначе он пройдёт и после того, как потолок молча
 * поднимут до бесконечности.
 */
const HARD_MAX = 50_000;
const EVICT_AT = 10_000;
const TTL = 120_000;
const EVICT_INTERVAL = 1_000;

const T0 = 1_700_000_000_000;

/** Форма опций анонимного ведра (ANON_LIMIT в miniapp-server). */
const anon = (now: number) => ({
  capacity: 300,
  refillPerSec: 20,
  denyOnOverflow: true,
  now: () => now,
});

/** Заполнить карту `n` разными ключами на момент `now`. */
function fill(n: number, now: number, opts: Record<string, unknown> = {}): void {
  for (let i = 0; i < n; i++) {
    consumeRateToken(`anon:2001:db8::${i}`, { ...anon(now), ...opts });
  }
}

beforeEach(() => {
  _resetRateLimiter();
});

describe("жёсткий потолок карты вёдер", () => {
  test("новый анонимный ключ при переполнении получает отказ, а не ведро", () => {
    fill(HARD_MAX, T0);
    expect(_rateLimiterSize()).toBe(HARD_MAX);

    // Свежий клиент в ту же секунду: протухших вёдер нет, освобождать нечего.
    const r = consumeRateToken("anon:2001:db8::newcomer", anon(T0));

    expect(r.ok).toBe(false);
    expect((r as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
    // Главное: ведро НЕ создано, карта не выросла.
    expect(_rateLimiterSize()).toBe(HARD_MAX);
  });

  test("поток новых ключей при переполнении не двигает размер карты вовсе", () => {
    fill(HARD_MAX, T0);
    for (let i = 0; i < 5_000; i++) {
      consumeRateToken(`anon:2001:db8:ffff::${i}`, anon(T0));
    }
    // До правки здесь было бы HARD_MAX + 5000 и дальше без предела.
    expect(_rateLimiterSize()).toBe(HARD_MAX);
  });

  test("уже заведённое анонимное ведро при переполнении обслуживается", () => {
    consumeRateToken("anon:2001:db8::regular", anon(T0));
    fill(HARD_MAX, T0);

    // Отказ на входе в карту — не отказ в обслуживании тем, кто уже в ней.
    expect(consumeRateToken("anon:2001:db8::regular", anon(T0)).ok).toBe(true);
  });

  test("вёдра по user.id заводятся при переполнении как обычно", () => {
    fill(HARD_MAX, T0);

    // Без denyOnOverflow: число таких ключей ограничено allowlist'ом, и отказ
    // означал бы, что чужой флуд запирает владельца из его же Mini App.
    const post = consumeRateToken(770001, { now: () => T0 });
    const get = consumeRateToken("get:770001", {
      capacity: 120,
      refillPerSec: 4,
      now: () => T0,
    });

    expect(post.ok).toBe(true);
    expect(get.ok).toBe(true);
    expect(_rateLimiterSize()).toBe(HARD_MAX + 2);
  });

  test("когда вёдра флуда протухают, место освобождается и новый ключ проходит", () => {
    fill(HARD_MAX, T0);
    // Позже TTL и позже интервала уборки — проход по карте состоится.
    const later = T0 + TTL + EVICT_INTERVAL + 1;

    const r = consumeRateToken("anon:2001:db8::later", anon(later));

    expect(r.ok).toBe(true);
    // Всё, что было, протухло; осталось одно новое ведро.
    expect(_rateLimiterSize()).toBe(1);
  });
});

describe("здоровые пути не тронуты", () => {
  test("ниже потолка denyOnOverflow ничего не меняет", () => {
    fill(EVICT_AT, T0);
    expect(_rateLimiterSize()).toBe(EVICT_AT);

    const r = consumeRateToken("anon:2001:db8::below", anon(T0));

    expect(r.ok).toBe(true);
    expect(_rateLimiterSize()).toBe(EVICT_AT + 1);
  });

  test("отказ по переполнению не возвращает токены активному отправителю", () => {
    const flooder = { capacity: 5, refillPerSec: 0.0001, denyOnOverflow: true };
    for (let i = 0; i < 5; i++) {
      expect(consumeRateToken("anon:flooder", { ...flooder, now: () => T0 }).ok).toBe(
        true,
      );
    }
    expect(consumeRateToken("anon:flooder", { ...flooder, now: () => T0 }).ok).toBe(
      false,
    );

    fill(HARD_MAX, T0);

    // Ведро флудера свежее TTL — уцелело, и лимит для него по-прежнему закрыт.
    // Потолок ужесточает лимитер, а не открывает обход через переполнение.
    expect(
      consumeRateToken("anon:flooder", { ...flooder, now: () => T0 + 1 }).ok,
    ).toBe(false);
  });

  test("расход токенов внутри ведра не зависит от размера карты", () => {
    fill(HARD_MAX, T0);

    // Ключ уже в карте (создан внутри fill, одно списание из 300).
    const key = "anon:2001:db8::0";
    let ok = 0;
    for (let i = 0; i < 400; i++) {
      if (consumeRateToken(key, anon(T0)).ok) ok += 1;
    }
    // Отдаёт ровно остаток и закрывается — переполнение карты на это не влияет.
    expect(ok).toBe(299);
    expect(consumeRateToken(key, anon(T0)).ok).toBe(false);
  });
});
