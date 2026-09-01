import { describe, expect, test, afterEach } from "bun:test";
import {
  MAX_QUERY_LEN,
  normalizeQuery,
  readQueryParam,
  writeQueryParam,
} from "./useQueryParam";

/**
 * Окна в bun test нет, поэтому подменяем его заглушкой: `location` читаем,
 * `history.replaceState` записываем обратно в неё — ровно как это делает браузер.
 */
function stubWindow(search: string, hash = "", pathname = "/drops") {
  const loc = { pathname, search, hash };
  const calls: string[] = [];
  (globalThis as Record<string, unknown>).window = {
    location: loc,
    history: {
      state: null,
      replaceState(_s: unknown, _t: string, url: string) {
        calls.push(url);
        const q = url.indexOf("?");
        const h = url.indexOf("#");
        const qEnd = h === -1 ? url.length : h;
        loc.search = q === -1 ? "" : url.slice(q, qEnd);
        loc.hash = h === -1 ? "" : url.slice(h);
        loc.pathname = url.slice(0, q === -1 ? qEnd : q);
      },
    },
  };
  return { loc, calls };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe("readQueryParam", () => {
  test("возвращает значение параметра", () => {
    stubWindow("?status=active");
    expect(readQueryParam("status")).toBe("active");
  });

  test("нет параметра — null", () => {
    stubWindow("?other=1");
    expect(readQueryParam("status")).toBe(null);
  });

  test("нет окна — null, а не бросок", () => {
    expect(readQueryParam("status")).toBe(null);
  });

  /* Тот же класс падения, что чинит url.ts: decodeURIComponent на «%» кидает
     URIError прямо из render. URLSearchParams — не кидает. */
  test("битый percent-escape не роняет разбор", () => {
    stubWindow("?q=%&status=soon");
    expect(readQueryParam("q")).toBe("%");
    expect(readQueryParam("status")).toBe("soon");
  });
});

describe("writeQueryParam", () => {
  test("добавляет параметр", () => {
    const { loc } = stubWindow("");
    writeQueryParam("status", "soon");
    expect(loc.search).toBe("?status=soon");
  });

  test("null удаляет параметр и знак вопроса вместе с ним", () => {
    const { loc, calls } = stubWindow("?status=soon");
    writeQueryParam("status", null);
    expect(loc.search).toBe("");
    expect(calls[0]).toBe("/drops");
  });

  test("пустая строка удаляет так же, как null", () => {
    const { loc } = stubWindow("?q=base");
    writeQueryParam("q", "");
    expect(loc.search).toBe("");
  });

  /* Реферальные и utm-хвосты приходят из чужих ссылок: если фильтр их сотрёт,
     статистика перехода потеряется на первом же клике по чипу. */
  test("чужие параметры остаются на месте", () => {
    const { loc } = stubWindow("?utm_source=tg&status=soon");
    writeQueryParam("status", "ended");
    const params = new URLSearchParams(loc.search);
    expect(params.get("utm_source")).toBe("tg");
    expect(params.get("status")).toBe("ended");
  });

  test("якорь сохраняется", () => {
    const { loc } = stubWindow("", "#drops");
    writeQueryParam("status", "active");
    expect(loc.hash).toBe("#drops");
    expect(loc.search).toBe("?status=active");
  });

  test("кириллица и пробелы уезжают в адрес закодированными", () => {
    const { loc } = stubWindow("");
    writeQueryParam("q", "база данных");
    expect(loc.search).not.toContain(" ");
    expect(readQueryParam("q")).toBe("база данных");
  });

  test("нет окна — тихо ничего не делает", () => {
    expect(() => writeQueryParam("status", "soon")).not.toThrow();
  });
});

describe("normalizeQuery", () => {
  test("срезает пробелы по краям", () => {
    expect(normalizeQuery("  base  ")).toBe("base");
  });

  test("режет по лимиту длины", () => {
    const long = "a".repeat(MAX_QUERY_LEN + 50);
    expect(normalizeQuery(long).length).toBe(MAX_QUERY_LEN);
  });

  test("пустой ввод остаётся пустым", () => {
    expect(normalizeQuery("   ")).toBe("");
  });
});
