/**
 * Аудит 2026-08-20, вторая итерация по тому же месту: гейт «не хватает ёмкости
 * — не шлём ничего» держался на ЧТЕНИИ ёмкости, а не на её занятии.
 *
 * `userbotFloodCapacity` намеренно не занимает слот, а коммит идёт только
 * ПОСЛЕ успешной отправки (`withUserbotFloodGuard`). Между ними лежит сетевой
 * round-trip — то есть окно check-then-act:
 *
 *   ход A: partCount=7, free=20 → гейт пропускает
 *   ход B (до первого коммита A): free всё ещё 20 → тоже пропускает
 *   дальше 14 частей идут вперемешку и ведро кончается на середине
 *
 * что даёт ровно тот отказ, ради которого гейт и писали: оборванное сообщение
 * ОТ ЛИЦА ВЛАДЕЛЬЦА, которое нельзя повторить — повтор дублирует уже
 * доставленное (`PartialSendError`).
 *
 * Одновременность ходов здесь не гипотеза: telegraf разбирает пачку из
 * getUpdates через `Promise.all`, а веер по ролям в message-handler идёт без
 * `await` (то же обоснование записано в `agent-sdk-runtime.ts:99` и
 * `rate-limits.ts`). Ключ ведра — `userbot:<characterId>:chat:<chatId>`;
 * owner-voice ограничен оркестратором, значит у конкурирующих ходов он один.
 *
 * Инвариант: сколько бы ходов ни стартовало одновременно, число реальных
 * отправок в ведро не превышает лимит, и ни один ход не останавливается на
 * середине — он либо уходит целиком, либо отказывается целиком.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { dispatchAction, type DispatchResult } from "../lib/action-dispatch.ts";
import {
  _resetRateLimits,
  userbotFloodCapacity,
  reserveUserbotFloodSlots,
} from "../lib/rate-limits.ts";
import { splitForTelegram } from "../lib/telegram-chunking.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";
import { setAutonomy } from "../lib/permissions.ts";

const TEST_CHAT = -1_000_821;
const CHAR = "orchestrator";
const prev = saveAutonomy();

const failed = (r: DispatchResult): Extract<DispatchResult, { ok: false }> =>
  r as Extract<DispatchResult, { ok: false }>;

/**
 * Текст на несколько частей. Важно, чтобы 2 × parts превышало лимит (20) —
 * иначе два хода уместились бы в ведро и без резерва, и тест бы ничего не
 * доказывал; это проверяется утверждением в самом тесте.
 */
const LONG = Array.from(
  { length: 240 },
  (_, i) => `Строка ${i} ${"я".repeat(200)}`,
).join("\n\n");

/** Юзербот, у которого каждая отправка висит до внешнего разрешения. */
function gatedUb() {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  return {
    calls,
    open: () => release(),
    ub: {
      isNoop: false,
      async sendMessage(_c: number, t: string) {
        await gate;
        calls.push(t.slice(0, 8));
        return { message_id: calls.length };
      },
    } as never,
  };
}

const ctx = (ub: unknown) =>
  ({ agentKey: CHAR, chatId: TEST_CHAT, userbot: ub, telegram: undefined }) as never;

describe("reserveUserbotFloodSlots", () => {
  beforeEach(() => _resetRateLimits());

  test("занимает слоты сразу, а не при отправке", () => {
    const max = userbotFloodCapacity(CHAR, TEST_CHAT).max;
    const r = reserveUserbotFloodSlots(CHAR, TEST_CHAT, 5);
    expect(r.ok).toBe(true);
    expect(userbotFloodCapacity(CHAR, TEST_CHAT).free).toBe(max - 5);
  });

  test("второй резерв не получает уже занятое", () => {
    const max = userbotFloodCapacity(CHAR, TEST_CHAT).max;
    expect(reserveUserbotFloodSlots(CHAR, TEST_CHAT, max).ok).toBe(true);
    const second = reserveUserbotFloodSlots(CHAR, TEST_CHAT, 1);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.free).toBe(0);
  });

  test("release возвращает незанятое", () => {
    const max = userbotFloodCapacity(CHAR, TEST_CHAT).max;
    const r = reserveUserbotFloodSlots(CHAR, TEST_CHAT, 8);
    expect(r.ok).toBe(true);
    if (r.ok) r.release(3);
    expect(userbotFloodCapacity(CHAR, TEST_CHAT).free).toBe(max - 5);
  });

  test("release не выедает больше, чем держит", () => {
    const max = userbotFloodCapacity(CHAR, TEST_CHAT).max;
    const a = reserveUserbotFloodSlots(CHAR, TEST_CHAT, 4);
    const b = reserveUserbotFloodSlots(CHAR, TEST_CHAT, 4);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) {
      a.release(100);
      a.release(100);
    }
    // Резерв b остался нетронутым.
    expect(userbotFloodCapacity(CHAR, TEST_CHAT).free).toBe(max - 4);
  });

  test("старый release не снимает новую резервацию после очистки bucket-ов", () => {
    const max = userbotFloodCapacity(CHAR, TEST_CHAT).max;
    const old = reserveUserbotFloodSlots(CHAR, TEST_CHAT, 1, 7_000);
    expect(old.ok).toBe(true);
    _resetRateLimits();
    const current = reserveUserbotFloodSlots(CHAR, TEST_CHAT, 1, 7_000);
    expect(current.ok).toBe(true);
    if (old.ok) old.release(1);
    expect(userbotFloodCapacity(CHAR, TEST_CHAT, 7_000).free).toBe(max - 1);
  });

  test("без контекста — fail-open, как и у проверки лимита", () => {
    expect(reserveUserbotFloodSlots(undefined, TEST_CHAT, 5).ok).toBe(true);
    expect(reserveUserbotFloodSlots(CHAR, undefined, 5).ok).toBe(true);
    expect(userbotFloodCapacity(CHAR, TEST_CHAT).free).toBe(
      userbotFloodCapacity(CHAR, TEST_CHAT).max,
    );
  });
});

describe("два одновременных owner-voice хода в один чат", () => {
  beforeEach(() => {
    _resetRateLimits();
    cleanupChat(TEST_CHAT, CHAR);
    setAutonomy("chat", String(TEST_CHAT), "auto");
  });
  afterAll(() => {
    cleanupChat(TEST_CHAT, CHAR);
    restoreAutonomy(prev);
  });

  test("второй отказывается целиком, а не рвётся на середине", async () => {
    const parts = splitForTelegram(LONG).length;
    const max = userbotFloodCapacity(CHAR, TEST_CHAT).max;
    // Условие осмысленности теста: вдвоём в ведро они не помещаются.
    expect(parts * 2).toBeGreaterThan(max);

    const { ub, calls, open } = gatedUb();
    // Оба хода стартуют до того, как первый успел что-либо отправить, —
    // ровно то, что делает Promise.all над пачкой апдейтов.
    const a = dispatchAction(
      "SEND_MESSAGE",
      { text: LONG, via_userbot: true } as never,
      ctx(ub),
    );
    const b = dispatchAction(
      "SEND_MESSAGE",
      { text: LONG, via_userbot: true } as never,
      ctx(ub),
    );
    open();
    const [ra, rb] = await Promise.all([a, b]);

    const oks = [ra, rb].filter((r) => r.ok);
    const errs = [ra, rb].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(errs.length).toBe(1);
    expect(failed(errs[0]!).error).toContain("Не отправлено ничего");
    // Ушёл ровно один целый ответ. Раньше проходили оба гейта, части шли
    // вперемешку, и второй обрывался посреди — в чате владельца обрубок.
    expect(calls.length).toBe(parts);
  });

  test("когда ёмкости хватает обоим — уходят оба целиком", async () => {
    const { ub, calls, open } = gatedUb();
    const a = dispatchAction(
      "SEND_MESSAGE",
      { text: "короткий раз", via_userbot: true } as never,
      ctx(ub),
    );
    const b = dispatchAction(
      "SEND_MESSAGE",
      { text: "короткий два", via_userbot: true } as never,
      ctx(ub),
    );
    open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(calls.length).toBe(2);
    const c = userbotFloodCapacity(CHAR, TEST_CHAT);
    expect(c.max - c.free).toBe(2);
  });
});
