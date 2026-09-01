import { describe, expect, test } from "bun:test";
import {
  formatPct,
  formatUsd,
  formatDate,
  formatDateShort,
  formatDateTime,
  safeHref,
  plural,
  dateMs,
  byDate,
} from "./format";

describe("formatUsd", () => {
  test("null/undefined/NaN/Infinity → «—»", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
    expect(formatUsd(NaN)).toBe("—");
    expect(formatUsd(Infinity)).toBe("—");
  });
  test("scales to тыс/млн/млрд", () => {
    expect(formatUsd(0)).toContain("$0");
    expect(formatUsd(1500)).toContain("тыс");
    expect(formatUsd(2_500_000)).toContain("млн");
    expect(formatUsd(3_000_000_000)).toContain("млрд");
  });
  test("negative keeps a sign, never $-", () => {
    expect(formatUsd(-5_000_000).startsWith("-$")).toBe(true);
  });
});

describe("formatPct", () => {
  test("null/undefined/NaN → «—»", () => {
    expect(formatPct(null)).toBe("—");
    expect(formatPct(undefined)).toBe("—");
    expect(formatPct(NaN)).toBe("—");
  });
  test("0 renders as 0%", () => {
    expect(formatPct(0)).toBe("0%");
  });
  test("tiny non-zero values do not collapse to 0%", () => {
    expect(formatPct(0.001)).not.toBe("0%");
  });
});

describe("date helpers", () => {
  test("invalid ISO falls back to the raw string", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });
});

describe("plural (RU)", () => {
  const f = (n: number) => plural(n, "дайджест", "дайджеста", "дайджестов");
  test("one form: 1, 21, 101", () => {
    expect(f(1)).toBe("дайджест");
    expect(f(21)).toBe("дайджест");
    expect(f(101)).toBe("дайджест");
  });
  test("few form: 2, 3, 4, 22", () => {
    expect(f(2)).toBe("дайджеста");
    expect(f(4)).toBe("дайджеста");
    expect(f(22)).toBe("дайджеста");
  });
  test("many form: 0, 5, 11..14, 25", () => {
    expect(f(0)).toBe("дайджестов");
    expect(f(5)).toBe("дайджестов");
    expect(f(11)).toBe("дайджестов");
    expect(f(14)).toBe("дайджестов");
    expect(f(25)).toBe("дайджестов");
  });
});

describe("safeHref", () => {
  test("allows only http(s)", () => {
    expect(safeHref("https://x.io")).toBe("https://x.io");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref("")).toBeUndefined();
  });
});

describe("formatDateShort", () => {
  const now = new Date("2026-08-12T12:00:00Z");

  test("в текущем году года нет — он только съедает ширину", () => {
    const s = formatDateShort("2026-08-20T00:00:00Z", now);
    expect(s).toContain("20");
    expect(s).not.toContain("2026");
  });

  test("в другом году год обязателен: календарь анлоков уходит за зиму", () => {
    // Без этого «24 мар.» в списке ближайших событий читается как март
    // текущего года, то есть как уже прошедшая дата.
    const s = formatDateShort("2027-03-24T00:00:00Z", now);
    expect(s).toContain("2027");
  });

  test("мусор возвращается как есть, а не как «Invalid Date»", () => {
    expect(formatDateShort("не дата", now)).toBe("не дата");
  });
});

describe("dateMs / byDate", () => {
  test("нечитаемая дата — null, а не NaN", () => {
    expect(dateMs("2026-08-12T00:00:00Z")).toBe(Date.parse("2026-08-12T00:00:00Z"));
    expect(dateMs("не дата")).toBeNull();
    expect(dateMs("")).toBeNull();
  });

  test("сортирует по возрастанию и по убыванию", () => {
    const rows = [{ d: "2026-08-03" }, { d: "2026-08-01" }, { d: "2026-08-02" }];
    const asc = [...rows].sort(byDate((r: { d: string }) => r.d, true));
    expect(asc.map((r) => r.d)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    const desc = [...rows].sort(byDate((r: { d: string }) => r.d, false));
    expect(desc.map((r) => r.d)).toEqual(["2026-08-03", "2026-08-02", "2026-08-01"]);
  });

  test("битые строки уезжают в конец и не ломают порядок остальных", () => {
    // Компаратор с NaN несогласован, а TimSort на несогласованном компараторе
    // не гарантирует порядок ВСЕГО массива, а не только битой строки. Здесь
    // строк больше 32 — именно за этим порогом TimSort перестаёт быть простой
    // вставкой и расхождение становится видимым.
    const rows = Array.from({ length: 40 }, (_, i) => ({
      d: i % 7 === 0 ? "мусор" : `2026-08-${String(28 - (i % 28)).padStart(2, "0")}`,
    }));
    for (const asc of [true, false]) {
      const out = [...rows].sort(byDate((r: { d: string }) => r.d, asc));
      const bad = out.filter((r) => r.d === "мусор").length;
      expect(out.slice(out.length - bad).every((r) => r.d === "мусор")).toBe(true);
      const good = out.slice(0, out.length - bad).map((r) => Date.parse(r.d));
      const sorted = [...good].sort((a, b) => (asc ? a - b : b - a));
      expect(good).toEqual(sorted);
    }
  });
});
