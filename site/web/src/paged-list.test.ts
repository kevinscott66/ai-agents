/**
 * Аудит 2026-08-12, продолжение: три дыры в `usePagedList`, которые видно
 * только на переключении фильтра и на живом ингесте.
 *
 * 1. Смена фильтра не сбрасывала список. `load(0)` заменял `items` только по
 *    приходу ответа, поэтому между кликом по чипу и ответом на экране висела
 *    прежняя выдача вместе со старым `total`. `hasMore` считается как
 *    `items.length < total`, то есть кнопка «Показать ещё» оставалась активной
 *    и просила `offset` от ЧУЖОГО списка — попутно отменяя ещё не пришедшую
 *    первую страницу нового фильтра.
 *
 *    Замер старой логики (9 из 25 загружено, клик по «Закончился», сразу клик
 *    «Показать ещё»):
 *      после клика по чипу:  items=9 (все от «Все»), total=25, hasMore=true
 *      после «Показать ещё»: первая страница «Закончился» отменена,
 *                            пришла страница ended@offset=9
 *      итог: в выдаче «Закончился» девять карточек не из этого фильтра
 *
 * 2. Повторный клик по «Показать ещё», пока страница в полёте, отменял её же
 *    запрос и просил тот же `offset` заново.
 *
 * 3. Пагинация по `offset`, а не по курсору: если между запросами страниц в
 *    начало списка приедет новая запись (ингест пишет дайджесты в любой
 *    момент), всё сдвинется на одну позицию и последний элемент первой
 *    страницы придёт во второй ещё раз — Preact получает дублирующийся `key`.
 *
 * Тест держит копию `load`/`loadMore` ровно той формы, что в хуке (как
 * latest.test.ts — рендерера в проекте нет), и проверяет инварианты:
 * список пуст с момента запроса новой выборки, вторая страница не стартует
 * поверх первой, повторы при склейке отбрасываются.
 */
import { describe, expect, test } from "bun:test";
import { createLatest } from "./latest";

type Item = { id: string };
type Page = { items: Item[]; total: number };
type Status = "loading" | "more" | "success" | "error";

/**
 * Копия состояния и обеих функций хука. Держать в синхроне с
 * `usePagedList.ts` — расхождение сделает тест декоративным.
 */
function makeList(
  fetchPage: (offset: number, signal: AbortSignal) => Promise<Page>,
  keyOf?: (i: Item) => string,
) {
  const latest = createLatest();
  const state = {
    items: [] as Item[],
    total: 0,
    status: "loading" as Status,
    fetched: 0,
    exhausted: false,
  };

  function load(offset: number): Promise<void> {
    const { signal, isCurrent } = latest.start();
    if (offset === 0) {
      state.items = [];
      state.total = 0;
      state.fetched = 0;
      state.exhausted = false;
    }
    state.status = offset === 0 ? "loading" : "more";
    return fetchPage(offset, signal)
      .then((res) => {
        if (!isCurrent()) return;
        if (offset === 0) {
          state.items = res.items;
        } else if (!keyOf) {
          state.items = [...state.items, ...res.items];
        } else {
          const seen = new Set(state.items.map(keyOf));
          state.items = [
            ...state.items,
            ...res.items.filter((x) => !seen.has(keyOf(x))),
          ];
        }
        state.fetched = offset + res.items.length;
        state.exhausted = res.items.length === 0;
        state.total = res.total;
        state.status = "success";
      })
      .catch((e: Error) => {
        if (!isCurrent() || e.name === "AbortError") return;
        state.status = "error";
      });
  }

  function loadMore(): Promise<void> {
    if (state.status === "loading" || state.status === "more") return Promise.resolve();
    return load(state.fetched);
  }

  // Курсор — по отданным строкам, кнопка — по показанному. Разные величины, и
  // это не небрежность: подробности в шапке `usePagedList.ts`.
  const hasMore = () => !state.exhausted && state.items.length < state.total;

  return { state, load, loadMore, hasMore };
}

/** Фейковый api: страницы по `size`, id вида `<фильтр>-<номер>`. */
function fake(filter: string, size: number, total: number, delayMs: number) {
  return (offset: number, signal: AbortSignal): Promise<Page> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const n = Math.max(0, Math.min(size, total - offset));
        resolve({
          items: Array.from({ length: n }, (_, i) => ({ id: `${filter}-${offset + i}` })),
          total,
        });
      }, delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
}

describe("смена фильтра", () => {
  test("список пуст с момента запроса, а не с момента ответа", async () => {
    const list = makeList(fake("all", 9, 25, 0));
    await list.load(0);
    expect(list.state.items.length).toBe(9);
    expect(list.hasMore()).toBe(true);

    // Клик по чипу «Закончился»: эффект по deps зовёт load(0). Ответ ещё в пути.
    const pending = makeList(fake("ended", 9, 4, 50));
    pending.state.items = list.state.items;
    pending.state.total = list.state.total;
    const p = pending.load(0);

    // Ключевой момент: прямо сейчас, до ответа.
    expect(pending.state.items).toEqual([]);
    expect(pending.state.total).toBe(0);
    // А значит кнопки «Показать ещё» на экране нет и нажать её нельзя.
    expect(pending.hasMore()).toBe(false);

    await p;
    expect(pending.state.items.map((i) => i.id)).toEqual([
      "ended-0", "ended-1", "ended-2", "ended-3",
    ]);
    expect(pending.state.total).toBe(4);
  });

  test("«Показать ещё» во время загрузки первой страницы — не запускает вторую", async () => {
    const list = makeList(fake("ended", 9, 40, 30));
    const first = list.load(0);
    // Пользователь успел кликнуть (кнопка осталась бы на экране в старой версии).
    await list.loadMore();
    await first;
    // Старое поведение: первая страница отменена, пришла ended@offset=9.
    expect(list.state.items.map((i) => i.id)[0]).toBe("ended-0");
    expect(list.state.items.length).toBe(9);
  });
});

describe("повторный клик по «Показать ещё»", () => {
  test("не отменяет собственный запрос", async () => {
    const list = makeList(fake("all", 6, 60, 20));
    await list.load(0);
    const a = list.loadMore();
    const b = list.loadMore(); // второй клик, пока первый в полёте
    await Promise.all([a, b]);
    expect(list.state.status).toBe("success");
    expect(list.state.items.length).toBe(12);
  });
});

describe("склейка страниц при смещающемся списке", () => {
  test("повтор из-за вставки в начало отбрасывается", async () => {
    // Первая страница пришла до вставки, вторая — после: `all-5` придёт дважды.
    let shift = 0;
    const fetchPage = (offset: number): Promise<Page> => {
      const n = 6;
      const items = Array.from({ length: n }, (_, i) => ({
        id: `all-${offset + i - shift}`,
      }));
      return Promise.resolve({ items, total: 60 });
    };

    const dumb = makeList(fetchPage); // без keyOf — старое поведение
    await dumb.load(0);
    shift = 1; // приехал новый дайджест, всё сдвинулось на одну позицию
    await dumb.load(6);
    const dumbIds = dumb.state.items.map((i) => i.id);
    expect(dumbIds.length).toBe(12);
    expect(new Set(dumbIds).size).toBe(11); // дубль есть

    shift = 0;
    const smart = makeList(fetchPage, (i) => i.id);
    await smart.load(0);
    shift = 1;
    await smart.load(6);
    const ids = smart.state.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // дублей нет
    expect(ids).toContain("all-5");
  });

  /**
   * Аудит 2026-08-13. Дедуп из теста выше сам породил вторую поломку: смещение
   * бралось из `items.length`, а дедуп ровно эту длину и укорачивал. Значит
   * после каждой вставки в начало ленты смещение переставало расти, и следующая
   * страница запрашивалась той же самой — целиком отбрасывалась при склейке.
   *
   * Наружу это выглядело хуже, чем «не догрузилось»: `items.length < total`
   * выполнялось всегда, поэтому кнопка «Показать ещё» оставалась на экране
   * навсегда и на каждый клик не делала ничего.
   */
  test("смещение считается по отданным строкам, а не по длине списка", async () => {
    const FEED = Array.from({ length: 7 }, (_, i) => ({ id: `A${i + 1}` }));
    let feed = FEED;
    const PAGE = 6;
    const fetchPage = (offset: number): Promise<Page> =>
      Promise.resolve({
        items: feed.slice(offset, offset + PAGE),
        total: feed.length,
      });

    const list = makeList(fetchPage, (i) => i.id);
    await list.load(0);
    expect(list.state.items.length).toBe(6);

    // Ингест вставил свежий дайджест в начало ленты — всё сдвинулось.
    feed = [{ id: "NEW" }, ...FEED];

    const lengths: number[] = [];
    for (let i = 0; i < 5; i++) {
      await list.loadMore();
      lengths.push(list.state.items.length);
    }

    // Со старым offset=items.length здесь было [7, 7, 7, 7, 7] при hasMore=true.
    expect(lengths[0]).toBe(7);
    expect(list.hasMore()).toBe(false);
    expect(list.state.items.map((i) => i.id)).toEqual([
      "A1", "A2", "A3", "A4", "A5", "A6", "A7",
    ]);
  });

  test("пустая страница при непустом total гасит кнопку", async () => {
    // total посчитан отдельным запросом и разъехался с выдачей.
    const fetchPage = (offset: number): Promise<Page> =>
      Promise.resolve({ items: offset === 0 ? [{ id: "x" }] : [], total: 99 });

    const list = makeList(fetchPage, (i) => i.id);
    await list.load(0);
    expect(list.hasMore()).toBe(true);
    await list.loadMore();
    expect(list.hasMore()).toBe(false);
  });

  /**
   * Обратная сторона той же монеты: кнопку нельзя показывать по `fetched`.
   * Дедуп выбросил повтор, курсор доехал до `total`, а на экране на одну
   * запись меньше — с `fetched < total` кнопка исчезала, и верхняя новая
   * запись не догружалась никогда. Аудит воспроизвёл как «Показано
   * дайджестов: 7 из 8» без кнопки.
   */
  test("кнопка считается по показанному, а не по курсору", async () => {
    const FEED = Array.from({ length: 7 }, (_, i) => ({ id: `A${i + 1}` }));
    let feed = FEED;
    const PAGE = 6;
    const fetchPage = (offset: number): Promise<Page> =>
      Promise.resolve({
        items: feed.slice(offset, offset + PAGE),
        total: feed.length,
      });

    const list = makeList(fetchPage, (i) => i.id);
    await list.load(0);
    feed = [{ id: "NEW" }, ...FEED];
    await list.loadMore();

    // Курсор: 6 + 2 отданные строки = 8, ровно `total`. Показано — семь.
    expect(list.state.fetched).toBe(8);
    expect(list.state.total).toBe(8);
    expect(list.state.items.length).toBe(7);
    // С `fetched < total` здесь было бы false, то есть кнопки нет.
    expect(list.hasMore()).toBe(true);
  });
});
