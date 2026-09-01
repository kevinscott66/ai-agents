/**
 * Аудит 2026-08-20 — в DELEGATION_REFUSALS лежала строка без производителя.
 *
 * `"delegation depth exceeded"` не выдаёт никто: потолок цепочки
 * (`chain.length > 5` в action-dispatch.ts) отвечает текстом
 * `delegation cycle detected: path=[…] exceeds max length 5`, который и так
 * ловится подстрокой `"delegation cycle"`.
 *
 * Мёртвая запись в списке-классификаторе — это не косметика. Список читают как
 * ответ на вопрос «чем покрыта глубина», и следующая правка потолка легко
 * переписала бы текст ошибки на этот фантом: покрытие пропало бы молча, а на
 * штатный отказ снова поехали бы три диагностические задачи на доску.
 *
 * Тест сканирует ИСХОДНИК производителя, поэтому ловит расхождение в обе
 * стороны: и новый фантом в списке, и переписанный текст ошибки в коде.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { DELEGATION_REFUSALS, isByDesignRefusal } from "../lib/diagnostic.ts";

const DISPATCH_SRC = readFileSync(
  new URL("../lib/action-dispatch.ts", import.meta.url),
  "utf8",
);

/**
 * Аудит 2026-08-21: проверка «запись встречается в исходнике» была сужена до
 * подстроки в action-dispatch.ts и на новых записях сломалась бы вхолостую.
 * `delegate_skipped:` собирается шаблоном `delegate_${outcome.status}:` — как
 * литерал в коде его нет, хотя производитель у него самый настоящий. Поэтому
 * каждая запись явно называет, ЧТО именно искать в исходнике; список
 * `DELEGATION_REFUSALS` и эта карта обязаны совпадать ключ в ключ.
 */
const PRODUCERS: Record<string, string> = {
  "cannot delegate to self": "cannot delegate to self",
  "delegation cycle": "delegation cycle detected",
  "(all candidates stopped)": "(all candidates stopped)",
  "delegate_skipped:": "`delegate_${outcome.status}: ${outcome.reason}`",
  // Исходы гейта (аудит 2026-08-28). Производитель у всех трёх один —
  // `gateRefusalText`, поэтому ищем сами шаблоны: переписать текст, не тронув
  // их, нельзя.
  "pending_approval:": "`pending_approval: ${r.reason}`",
  "rate_limited:": "`rate_limited: ${r.reason}`",
  "forbidden:": "`forbidden: ${r.reason}`",
  "parent task is cancelled:": "`parent task is cancelled: ${parentId}.",
};

describe("аудит 2026-08-20: каждая запись списка отказов имеет производителя", () => {
  test("фантомной записи больше нет", () => {
    expect(DELEGATION_REFUSALS).not.toContain("delegation depth exceeded");
  });

  test("каждая запись встречается в исходнике action-dispatch.ts", () => {
    for (const refusal of DELEGATION_REFUSALS) {
      const needle = PRODUCERS[refusal];
      // Новая запись без производителя в карте — сразу видно, кто её добавил.
      expect(needle, `нет производителя для "${refusal}"`).toBeDefined();
      expect(DISPATCH_SRC).toContain(needle!);
    }
  });

  test("карта не разрослась сверх списка", () => {
    // Обратная сторона: запись убрали из списка, а строку в карте забыли — и
    // следующий читатель решит, что покрытие есть.
    expect(Object.keys(PRODUCERS).sort()).toEqual([...DELEGATION_REFUSALS].sort());
  });

  test("список не пуст — иначе тест выше проходил бы вхолостую", () => {
    expect(DELEGATION_REFUSALS.length).toBeGreaterThan(0);
  });

  test("настоящий отказ по глубине классифицируется как отказ", () => {
    // Дословно из action-dispatch.ts: `chain.length > 5`.
    const real =
      "delegation cycle detected: path=[orchestrator,pm,product,backend,frontend,tgdev] exceeds max length 5";
    expect(DISPATCH_SRC).toContain("exceeds max length 5");
    expect(isByDesignRefusal(real)).toBe(true);
  });

  test("остальные две формы цикла — тоже отказ", () => {
    expect(
      isByDesignRefusal(
        "delegation cycle detected: path=[pm,backend] target='backend' appears in last 2 entries",
      ),
    ).toBe(true);
    expect(
      isByDesignRefusal("delegation cycle: 'qa' is already in chain [pm→qa]"),
    ).toBe(true);
    expect(isByDesignRefusal("cannot delegate to self")).toBe(true);
  });

  test("настоящая поломка отказом не считается", () => {
    // Эти три текста дают тот же `no roles accepted`, но их надо чинить.
    expect(isByDesignRefusal("no resolveAgent in dispatch ctx")).toBe(false);
    expect(isByDesignRefusal("no handoffDeps in dispatch ctx")).toBe(false);
    expect(isByDesignRefusal("target agent not found: design")).toBe(false);
  });
});
