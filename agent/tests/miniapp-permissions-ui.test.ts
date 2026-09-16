/**
 * Аудит 2026-08-14: три находки в управлении правами, все три — про то, что
 * элемент выглядит рабочим, но им нельзя воспользоваться.
 *
 * 1. Матрица прав переключалась кликом по `<td>` (Permissions.tsx:189-196), а
 *    флаги права в карточке роли — кликом по `<span>` (Agents.tsx:386-399).
 *    Ни то, ни другое не достижимо табом, не объявляет роль скринридеру и не
 *    нажимается с клавиатуры. В Telegram WebView это единственный способ
 *    менять права — то есть для клавиатуры и VoiceOver страница нерабочая.
 *    Значение ячейки при этом передавалось символом (`✓`, `?`, `·`) и цветом
 *    фона: символ читается как есть, цвет не читается вовсе.
 *
 * 2. Класс запрещённой ячейки — `forbidden` (тип Cell), а правило в
 *    styles.css:440 звалось `.denied`. Запрещённые ячейки не красились ничем:
 *    от пустого места они отличались только точкой.
 *
 * 3. `perms.length === 0` считалось «загружается» (ветка загрузки прав в
 *    `Agents.tsx`, ныне отдельное состояние `permsLoading`). Ноль
 *    строк — это ещё и честный ответ ручки; для роли без прав скелетон
 *    пульсировал бесконечно, обещая данные, которых уже не будет.
 *
 * Инвариант: у каждого состояния ячейки есть свой цвет, каждый переключатель
 * — кнопка, а «грузится» отличимо от «пусто».
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CELL_LABELS, type Cell } from "../miniapp/src/pages/Permissions.tsx";
import { permsPanel } from "../miniapp/src/pages/Agents.tsx";

function read(...p: string[]): string {
  return readFileSync(join(import.meta.dir, "..", "miniapp", "src", ...p), "utf8");
}

const CSS = read("styles.css");
const PERMS = read("pages", "Permissions.tsx");
const AGENTS = read("pages", "Agents.tsx");

const CELLS = Object.keys(CELL_LABELS) as Cell[];

describe("у каждого состояния ячейки есть своё правило в CSS", () => {
  test("три состояния — три правила, включая запрещённое", () => {
    expect(CELLS.sort()).toEqual(["allowed", "approval", "forbidden"]);
    for (const c of CELLS) {
      expect(CSS).toContain(`.perm-cell.${c}`);
    }
  });

  test("правила под несуществующий класс больше нет", () => {
    // `.denied` не ставит никто: страница знает только значения типа Cell.
    expect(CSS.includes(".perm-cell.denied")).toBe(false);
    for (const c of CELLS) expect(PERMS).toContain(`"${c}"`);
  });

  test("цвет не единственный носитель смысла — есть подпись словами", () => {
    for (const c of CELLS) expect(CELL_LABELS[c].length).toBeGreaterThan(0);
    expect(PERMS).toContain("aria-label");
    expect(PERMS).toContain("CELL_LABELS[cell]");
  });
});

describe("переключатели прав — кнопки, а не крашеные ячейки", () => {
  test("матрица: клик и клавиатура на кнопке, а не на td", () => {
    const cellBlock = PERMS.slice(PERMS.indexOf("className={`perm-cell "));
    expect(cellBlock).toContain('className="perm-cell-btn"');
    // Прежняя форма: обработчик прямо на ячейке таблицы.
    expect(PERMS.includes("<td\n") && /<td[^>]*\n\s*onClick=/.test(PERMS)).toBe(false);
  });

  test("матрица: кнопка занимает клетку целиком и видна при фокусе", () => {
    expect(CSS).toContain(".perm-matrix .perm-cell-btn");
    expect(CSS).toContain(".perm-matrix .perm-cell-btn:focus-visible");
    expect(CSS).toContain(".flag:focus-visible");
  });

  test("флаги роли: button с aria-pressed вместо span", () => {
    const flags = AGENTS.slice(AGENTS.indexOf('className="perm-flags"'));
    const block = flags.slice(0, flags.indexOf("</div>\n                </div>"));
    expect(block).toContain('type="button"');
    expect(block).toContain("aria-pressed");
    expect(block.includes("<span")).toBe(false);
  });

  test("readonly действительно выключает флаг, а не только курсор", () => {
    expect(AGENTS).toContain("disabled={readonly}");
    // Прежняя форма: единственным признаком нередактируемости был курсор.
    expect(AGENTS.includes('cursor: readonly ? "default" : "pointer"')).toBe(false);
  });
});

describe("«грузится» отличимо от «пусто»", () => {
  test("до ответа — скелетон", () => {
    expect(permsPanel(true, 0, null)).toBe("loading");
  });

  test("ответ пришёл пустым — так и сказано, скелетон не вечен", () => {
    expect(permsPanel(false, 0, null)).toBe("empty");
  });

  test("ошибка не притворяется загрузкой", () => {
    expect(permsPanel(false, 0, "Только для админа.")).toBe("error");
    // Даже если ошибка пришла при непустом списке — сообщение важнее.
    expect(permsPanel(false, 3, "403")).toBe("error");
  });

  test("есть строки — список", () => {
    expect(permsPanel(false, 3, null)).toBe("list");
  });

  test("флаг гасится до разбора ответа — во всех ветках сразу", () => {
    const open = AGENTS.slice(AGENTS.indexOf("async function openAgent("));
    const body = open.slice(0, open.indexOf("async function toggle("));
    expect(body).toContain("setPermsLoading(true)");
    expect(body).toContain("setPermsLoading(false)");
    // Гасим один раз, до ветвления: иначе ветку легко забыть.
    expect(body.split("setPermsLoading(false)").length - 1).toBe(1);
    expect(body.indexOf("setPermsLoading(false)")).toBeLessThan(
      body.indexOf('if (permsRes.status === "fulfilled")'),
    );
  });

  test("страница спрашивает решение у permsPanel, а не считает длину", () => {
    expect(AGENTS).toContain("permsPanel(permsLoading, perms.length, permErr)");
    expect(AGENTS.includes("perms.length === 0 && !permErr")).toBe(false);
  });
});
