/**
 * Аудит 2026-08-28: режим роли спрашивался по одной роли за раз — двенадцать
 * запросов там, где хватает одного.
 *
 * `Agents.tsx` звала `api.autonomy({ agent: key })` в цикле по всем ролям: на
 * монтирование и ещё раз на КАЖДОЕ событие `agent.autonomy`. Ручка при этом
 * отдаёт `agent_overrides` целиком независимо от параметра `agent`
 * (miniapp-server.ts:1712, комментарий «отдаём список всегда: он короткий»), а
 * из ответа читались ровно два поля — этот список и `admin`. Эффективный
 * `r.mode`, единственное, что зависит от параметра, не читался вовсе. То есть
 * двенадцать ответов различались полем, которое выбрасывали.
 *
 * Цена — общее ведро GET'ов: 120 с доливом 4/с (miniapp-server.ts:554), одно
 * на все запросы вкладки. Событие `agent.autonomy` шлёт POST этой же страницы,
 * то есть переключение ролей подряд — обычный сценарий: 12 запросов на
 * нажатие плюс перезагрузка списка. Десяток нажатий выбирал ведро целиком, и
 * админ получал 429 на всю Mini App от собственной работы.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ownAutonomyModes } from "../miniapp/src/pages/Agents.tsx";

const SRC = readFileSync(
  new URL("../miniapp/src/pages/Agents.tsx", import.meta.url).pathname,
  "utf8",
);
const SERVER = readFileSync(
  new URL("../lib/miniapp-server.ts", import.meta.url).pathname,
  "utf8",
);

const BODY = SRC.slice(
  SRC.indexOf("async function loadAgentAutonomy"),
  SRC.indexOf("async function setAgentAutonomy"),
);

describe("предпосылки", () => {
  test("ручка отдаёт список переопределений независимо от параметра agent", () => {
    const handler = SERVER.slice(
      SERVER.indexOf('if (path === "/api/autonomy" && method === "GET")'),
      SERVER.indexOf('if (path === "/api/autonomy" && method === "POST")'),
    );
    expect(handler).toContain("agent_overrides: listAgentAutonomyOverrides(),");
    // Фильтра по agentParam у списка нет — иначе один ответ не заменил бы 12.
    expect(handler).not.toMatch(/listAgentAutonomyOverrides\([^)]/);
  });

  test("из ответа читаются только список и флаг админа, но не эффективный mode", () => {
    expect(BODY).toContain("agent_overrides");
    expect(BODY).toContain("r?.admin !== undefined");
    expect(BODY).not.toContain("r.mode");
  });
});

describe("ownAutonomyModes", () => {
  test("роль со своей строкой получает её режим", () => {
    expect(ownAutonomyModes([{ agent: "design", mode: "auto" }], ["design"])).toEqual({
      design: "auto",
    });
  });

  test("роль без строки — inherit, а не пустое значение", () => {
    expect(ownAutonomyModes([{ agent: "design", mode: "auto" }], ["qa"])).toEqual({
      qa: "inherit",
    });
  });

  test("один ответ раскладывается на все двенадцать ролей", () => {
    const keys = [
      "orchestrator", "pm", "product", "backend", "frontend", "tgdev",
      "aieng", "qa", "smm", "copy", "design", "perm",
    ];
    const out = ownAutonomyModes(
      [
        { agent: "design", mode: "auto" },
        { agent: "qa", mode: "locked" },
      ],
      keys,
    );
    expect(Object.keys(out)).toEqual(keys);
    expect(out.design).toBe("auto");
    expect(out.qa).toBe("locked");
    expect(out.backend).toBe("inherit");
  });

  test("пустой и отсутствующий список — все inherit, без падения", () => {
    expect(ownAutonomyModes([], ["a", "b"])).toEqual({ a: "inherit", b: "inherit" });
    expect(ownAutonomyModes(undefined, ["a"])).toEqual({ a: "inherit" });
  });

  test("лишние роли в ответе не попадают в результат", () => {
    const out = ownAutonomyModes(
      [{ agent: "design", mode: "auto" }, { agent: "ghost", mode: "auto" }],
      ["design"],
    );
    expect(out).toEqual({ design: "auto" });
  });

  test("пустой список ключей даёт пустой результат", () => {
    expect(ownAutonomyModes([{ agent: "design", mode: "auto" }], [])).toEqual({});
  });
});

describe("страница спрашивает режимы одним запросом", () => {
  test("в загрузке ровно один вызов ручки, и он без параметра agent", () => {
    expect(BODY.match(/api\.autonomy\(/g) ?? []).toHaveLength(1);
    expect(BODY).toContain("api.autonomy()");
    expect(BODY).not.toContain("api.autonomy({ agent");
  });

  test("раскладка ответа идёт через ownAutonomyModes", () => {
    expect(BODY).toContain("ownAutonomyModes(");
  });

  test("цикла по ролям на вызове больше нет", () => {
    expect(SRC).not.toContain("for (const a of agents) loadAgentAutonomy(");
    expect(SRC.match(/loadAgentAutonomy\(agents\.map\(\(a\) => a\.key\)\)/g) ?? []).toHaveLength(2);
  });

  test("отказ помечает все запрошенные роли, а не одну", () => {
    const failure = BODY.slice(BODY.indexOf("} catch"));
    expect(failure).toContain("setAutoErr");
    expect(failure).toContain("for (const k of keys)");
  });
});

describe("прежние инварианты страницы на месте", () => {
  test("флаг админа по-прежнему выводится из ответа ручки", () => {
    expect(SRC).toContain("if (r?.admin !== undefined) setAdminBlocked(!r.admin);");
  });

  test("пустого catch не появилось (аудит 2026-08-27)", () => {
    // Только код: комментарий цитирует исправленное («было `catch {}`») и
    // сломал бы проверку — так же, как в audit-2026-08-27.
    const code = BODY.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/catch\s*\{\s*\}/);
    expect(code).toContain("setAutoErr");
  });

  test("реакция на 403 при записи сохранена — ровно две точки взвода", () => {
    expect((SRC.match(/setAdminBlocked\(true\)/g) ?? []).length).toBe(2);
  });
});
