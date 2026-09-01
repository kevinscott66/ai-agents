/**
 * Аудит 2026-08-21: «Не удалось: 2 из 5» — и всё, гадайте.
 *
 * Пакетное решение апрувов (`decideMany`) шлёт по запросу на id и считает
 * неудачи как `catch { failed++ }`. Причина при этом выбрасывалась, хотя
 * сервер её присылает: `req()` в lib/api.ts кладёт поле `error` из тела в
 * `message`, а код — в `status`.
 *
 * Три разных исхода выглядели одинаково, а делать при них нужно строго разное:
 *
 *   • 403 — роль лишилась права решать; повторять бессмысленно;
 *   • 429 — исчерпано ведро рейт-лимита; помогает просто подождать;
 *   • «апрув уже решён» / истёк — список устарел, повторять нечего.
 *
 * Апрув стоит на необратимом действии. Единственный совет, который экран мог
 * дать, — «попробуйте ещё раз» вслепую, и в двух случаях из трёх он неверен.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  errorText,
  failureSummary,
} from "../miniapp/src/pages/Approvals.tsx";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Approvals.tsx"),
  "utf8",
);

describe("errorText — что показываем вместо молчания", () => {
  test("сообщение сервера идёт как есть", () => {
    // Ровно то, что кладёт req(): body.error.
    expect(errorText({ message: "approval already decided", status: 409 }))
      .toBe("approval already decided");
  });

  test("тело без поля error — остаётся код", () => {
    expect(errorText({ message: "HTTP 429", status: 429 })).toBe("HTTP 429");
  });

  test("пустое сообщение не выдаём за причину", () => {
    expect(errorText({ message: "   ", status: 403 })).toBe("HTTP 403");
  });

  test("сетевой сбой без status — не «undefined»", () => {
    expect(errorText({})).toBe("неизвестная ошибка");
    expect(errorText(null)).toBe("неизвестная ошибка");
  });

  test("Failed to fetch — тоже причина, и понятная", () => {
    expect(errorText(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
  });
});

describe("failureSummary — хвост тоста", () => {
  test("причин нет — хвоста нет", () => {
    expect(failureSummary([])).toBe("");
    expect(failureSummary(["", "   "])).toBe("");
  });

  test("одна причина на весь пакет — печатаем один раз", () => {
    // Типичный случай: упёрлись в общее ведро, все пять получили 429.
    const many = Array(5).fill("HTTP 429");
    expect(failureSummary(many)).toBe("HTTP 429");
  });

  test("две разные — обе", () => {
    expect(failureSummary(["HTTP 403", "approval already decided"]))
      .toBe("HTTP 403; approval already decided");
  });

  test("больше двух — две и счётчик остальных", () => {
    expect(failureSummary(["a", "b", "c", "d"])).toBe("a; b и ещё 2");
  });

  test("счётчик считает разные причины, а не запросы", () => {
    expect(failureSummary(["a", "a", "b", "b", "c"])).toBe("a; b и ещё 1");
  });

  test("длинный текст сервера обрезается с многоточием", () => {
    const long = "x".repeat(200);
    const out = failureSummary([long]);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });

  test("обрезка не выдаёт короткую причину за обрезанную", () => {
    expect(failureSummary(["HTTP 403"]).endsWith("…")).toBe(false);
  });
});

describe("тост целиком", () => {
  /** Как строка собирается в decideMany. */
  function toastText(failed: number, total: number, reasons: string[]) {
    const why = failureSummary(reasons);
    return `Не удалось: ${failed} из ${total}${why ? ` — ${why}` : ""}`;
  }

  test("причина попадает в текст", () => {
    expect(toastText(2, 5, ["HTTP 429", "HTTP 429"]))
      .toBe("Не удалось: 2 из 5 — HTTP 429");
  });

  test("без причин формат прежний — регрессии для старых вызовов нет", () => {
    expect(toastText(2, 5, [])).toBe("Не удалось: 2 из 5");
  });

  test("одиночное решение тоже объясняется", () => {
    expect(toastText(1, 1, ["approval already decided"]))
      .toBe("Не удалось: 1 из 1 — approval already decided");
  });
});

describe("страница действительно копит причины", () => {
  test("catch больше не пустой", () => {
    expect(SRC).not.toMatch(/\}\s*catch\s*\{\s*failed\+\+;\s*\}/);
    expect(SRC).toContain("reasons.push(errorText(e));");
  });

  test("хвост считается из накопленного, а не из кода последней ошибки", () => {
    expect(SRC).toContain("const why2 = failureSummary(reasons);");
  });

  test("failed по-прежнему считается — счёт в тосте не подменён длиной причин", () => {
    const decide = SRC.slice(SRC.indexOf("async function decideMany"));
    const body = decide.slice(0, decide.indexOf("\n  }\n") + 5);
    expect(body).toContain("failed++;");
    expect(body).toContain("`Не удалось: ${failed} из ${ids.length}");
  });
});
