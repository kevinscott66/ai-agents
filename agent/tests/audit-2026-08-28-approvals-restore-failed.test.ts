/**
 * Аудит 2026-08-28: одна ошибка в пакете возвращала на экран уже исполненные апрувы.
 *
 * `decideMany` снимает строки оптимистично, а на любой сбой делал
 * `setItems(snapshot)` — снимком, снятым ДО удаления. Пакет из пяти, четыре
 * прошли, пятая упала (403/429/«уже решён») — и на экране снова все пять.
 * Апрув стоит ровно на необратимых действиях: публикация в канал, отправка
 * сообщения, отправка документа. Вернувшаяся карточка предлагает одобрить их
 * второй раз, а кнопка «Одобрить все (N)» делает это одним тапом.
 *
 * Второй эффект того же снимка: строки, приехавшие по SSE `approval.created`
 * за время пакета, затирались. Пакет идёт последовательно, по HTTP-запросу на
 * апрув, так что окно — не мгновение.
 *
 * Хвостовой `load()` чинил и то и другое, но лишь после ответа сервера.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { restoreFailed } from "../miniapp/src/pages/Approvals.tsx";

const SRC = readFileSync(
  new URL("../miniapp/src/pages/Approvals.tsx", import.meta.url).pathname,
  "utf8",
);

interface Row {
  id: string;
}
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));

describe("restoreFailed", () => {
  test("возвращаются только упавшие, исполненные остаются снятыми", () => {
    const snapshot = rows("a", "b", "c", "d", "e");
    // Пакет снял все пять; упала только "e".
    const out = restoreFailed<Row>([], snapshot, new Set(["e"]));
    expect(out.map((r) => r.id)).toEqual(["e"]);
  });

  test("порядок берётся из снимка, а не из порядка ошибок", () => {
    const snapshot = rows("a", "b", "c", "d");
    const out = restoreFailed<Row>([], snapshot, new Set(["d", "b"]));
    expect(out.map((r) => r.id)).toEqual(["b", "d"]);
  });

  test("строки, приехавшие за время пакета, не теряются", () => {
    const snapshot = rows("a", "b");
    // "z" пришла по SSE и уже лежит в состоянии; "a" упала.
    const out = restoreFailed<Row>(rows("z"), snapshot, new Set(["a"]));
    expect(out.map((r) => r.id)).toEqual(["a", "z"]);
  });

  test("строка, оставшаяся в состоянии, берётся из него — она свежее", () => {
    const snapshot = [{ id: "a", v: 1 }];
    const current = [{ id: "a", v: 2 }];
    expect(restoreFailed(current, snapshot, new Set(["a"]))).toEqual(current);
  });

  test("без упавших состояние не меняется", () => {
    const snapshot = rows("a", "b", "c");
    expect(restoreFailed(rows("c"), snapshot, new Set()).map((r) => r.id)).toEqual(["c"]);
  });

  test("упавшая строка не задваивается, если она уже в состоянии", () => {
    const snapshot = rows("a", "b");
    const out = restoreFailed<Row>(rows("a"), snapshot, new Set(["a"]));
    expect(out.map((r) => r.id)).toEqual(["a"]);
  });

  test("пустой снимок и пустое состояние дают пустой список", () => {
    expect(restoreFailed<Row>([], [], new Set(["a"]))).toEqual([]);
  });

  test("весь пакет упал — список восстанавливается целиком", () => {
    const snapshot = rows("a", "b", "c");
    const out = restoreFailed<Row>([], snapshot, new Set(["a", "b", "c"]));
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("пакетное решение больше не воскрешает исполненное", () => {
  const body = SRC.slice(
    SRC.indexOf("async function decideMany"),
    SRC.indexOf("function confirmReject"),
  );

  test("снимок целиком в состояние не возвращается", () => {
    expect(body).not.toContain("setItems(snapshot)");
  });

  test("восстановление идёт через restoreFailed и множество упавших", () => {
    expect(body).toContain("restoreFailed(");
    expect(body).toContain("failedIds");
  });

  test("упавший id попадает в множество там же, где считается ошибка", () => {
    // В `catch` пакета: рядом с failed++ и разбором причины.
    const catchBlock = body.slice(body.indexOf("} catch"), body.indexOf("setBusy((m) => {", body.indexOf("} catch")));
    expect(catchBlock).toContain("failedIds.add(id)");
  });

  test("хвостовой load() на месте — сервер по-прежнему последнее слово", () => {
    expect(body).toContain("load();");
  });
});
