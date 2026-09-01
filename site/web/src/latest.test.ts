/**
 * Аудит 2026-08-12: гонка в списке дайджестов.
 *
 * «Показать ещё» и «Повторить» звали load() без AbortSignal, а эффект поиска
 * отменял только собственный контроллер. Поздний ответ старого запроса
 * дописывался в результаты поиска через `[...prev, ...res.items]` и заодно
 * переписывал offset/total.
 *
 * Замер до правки (копия старого load() поверх игрушечного состояния,
 * задержки 120 мс у «Показать ещё» и 10 мс у поиска):
 *
 *   старт:        items=6 offset=6 total=100
 *   после поиска: items=кит-0,кит-1 offset=2 total=2
 *   после хвоста: items=кит-0,кит-1,all-6,all-7,all-8,all-9,all-10,all-11
 *                 offset=12 total=100 status=success
 *   в выдаче поиска «кит» видно 8 карточек, из них чужих: 6
 *
 * Инвариант: состояние списка складывается только из последнего запуска
 * загрузки; всё, что стартовало раньше, не влияет ни на items, ни на
 * offset/total.
 */
import { describe, expect, test } from "bun:test";
import { createLatest } from "./latest";

describe("createLatest", () => {
  test("новый запуск отменяет предыдущий и делает его неактуальным", () => {
    const l = createLatest();
    const first = l.start();
    expect(first.isCurrent()).toBe(true);
    expect(first.signal.aborted).toBe(false);

    const second = l.start();
    expect(first.isCurrent()).toBe(false);
    expect(first.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  test("cancel отменяет текущий — размонтирование не оставляет хвостов", () => {
    const l = createLatest();
    const run = l.start();
    l.cancel();
    expect(run.signal.aborted).toBe(true);
    expect(run.isCurrent()).toBe(false);
  });

  test("актуален всегда ровно один запуск", () => {
    const l = createLatest();
    const runs = [l.start(), l.start(), l.start(), l.start()];
    expect(runs.filter((r) => r.isCurrent()).length).toBe(1);
    expect(runs[3]!.isCurrent()).toBe(true);
  });
});

// --- та самая гонка, целиком ---------------------------------------------

type Res = { items: { id: string }[]; total: number };

/** Фейковый api: q="" — общий список, q="кит" — узкая выдача из двух штук. */
function fakeFetch(
  pageSize: number,
  off: number,
  signal: AbortSignal | undefined,
  q: string | undefined,
  delayMs: number,
): Promise<Res> {
  const narrow = !!q;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      resolve({
        items: Array.from({ length: narrow ? 2 : pageSize }, (_, i) => ({
          id: `${q || "all"}-${off + i}`,
        })),
        total: narrow ? 2 : 100,
      });
    }, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
}

/** Состояние секции + load() ровно той формы, что в DigestsSection. */
function makeSection() {
  const latest = createLatest();
  const state = { items: [] as { id: string }[], total: 0, offset: 0, status: "loading" };
  const pageSize = 6;

  function load(off: number, q: string, delayMs: number) {
    const { signal, isCurrent } = latest.start();
    state.status = off === 0 ? "loading" : "more";
    return fakeFetch(pageSize, off, signal, q, delayMs)
      .then((res) => {
        if (!isCurrent()) return;
        state.items = off === 0 ? res.items : [...state.items, ...res.items];
        state.total = res.total;
        state.offset = off + res.items.length;
        state.status = "success";
      })
      .catch((e: Error) => {
        if (!isCurrent() || e.name === "AbortError") return;
        state.status = "error";
      });
  }

  return { state, load };
}

describe("список дайджестов под гонкой", () => {
  test("поздний «Показать ещё» не попадает в выдачу поиска", async () => {
    const { state, load } = makeSection();
    await load(0, "", 0);
    expect(state.items.length).toBe(6);

    const more = load(state.offset, "", 120); // сигнала у него больше нет только на словах
    await new Promise((r) => setTimeout(r, 40));
    await load(0, "кит", 10); // пользователь ввёл запрос
    await more;

    // Старое поведение: 8 карточек, из них 6 чужих; offset=12, total=100.
    expect(state.items.map((i) => i.id)).toEqual(["кит-0", "кит-1"]);
    expect(state.offset).toBe(2);
    expect(state.total).toBe(2);
  });

  test("отменённый запрос не переводит секцию в ошибку", async () => {
    const { state, load } = makeSection();
    const first = load(0, "", 120);
    await load(0, "кит", 5);
    await first;
    expect(state.status).toBe("success");
  });

  test("«Показать ещё» без помех работает как раньше", async () => {
    const { state, load } = makeSection();
    await load(0, "", 0);
    await load(state.offset, "", 0);
    expect(state.items.map((i) => i.id)).toEqual([
      "all-0", "all-1", "all-2", "all-3", "all-4", "all-5",
      "all-6", "all-7", "all-8", "all-9", "all-10", "all-11",
    ]);
    expect(state.offset).toBe(12);
    expect(state.total).toBe(100);
  });
});
