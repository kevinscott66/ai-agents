/**
 * Аудит 2026-09-11, круг 28: докблок с `@param`/`@returns` над тем, у чего нет
 * ни параметров, ни возврата.
 *
 * Круг 27 вернул символам 32 осиротевших докблока и завёл на них проверку —
 * tests/audit-2026-09-11-orphan-docblocks. Та проверка ищет ГЕОМЕТРИЮ: два
 * докблока подряд, между ними ничего или одна пустая строка. Второй половины
 * того же дефекта она не видит вовсе — когда блок ровно один и стоит вплотную
 * к коду, но к ЧУЖОМУ: символ, который блок описывал, уехал ниже, а над блоком
 * оказалась константа, регулярка или интерфейс. Геометрия при этом безупречна,
 * и tsserver честно показывает описание при наведении — на соседа.
 *
 * Два таких нашлись сразу, и оба одинаковые: `parseBudgetEnv` (token-budget.ts)
 * лежал на `const MALFORMED_ENV_BUDGET = 100_000`, `floodBackoffMs`
 * (userbot-flood.ts) — на `export const INITIAL_BACKOFF_MS = 1_000`. В обоих
 * случаях сама функция оставалась без единой строки объяснения, а константа
 * получала чужой контракт: «@returns null — здесь не задано, смотри дальше»
 * над числом, которое ничего не возвращает.
 *
 * Почему проверяется именно `@param`/`@returns`, а не «докблок вообще»:
 * это единственные теги, которые ОБЯЗЫВАЮТ владельца быть вызываемым. Проза
 * над константой законна и полезна, отсутствие тегов ничего не доказывает, а
 * их наличие — доказывает: у `const X = 1_000` параметров нет ни при какой
 * трактовке. Проверка, которую нельзя удовлетворить подгонкой: единственный
 * способ её пройти — поставить блок над тем, о чём он написан.
 *
 * Что делать, когда тест упал: перенести докблок к функции, которую он
 * описывает, и оставить над константой одну честную строку про неё саму.
 */
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["lib", "orchestrator", "tests", "tools", "mac-daemon", "miniapp/src"];

/**
 * Тег только в начале строки докблока.
 *
 * Внутри кавычек `"@param"` — это данные, а не контракт: и memory.ts, и
 * tests/wiki-pii-code-blocks цитируют JSDoc как ПРИМЕР того, что портил
 * PII-фильтр вики. Обе цитаты — законный текст, и обе ловились, пока тег
 * искался где угодно в блоке.
 */
const OWNER_TAG = /^\s*\*\s*@(param|returns?)\b/m;

const DOC_OPENS = /^\s*\/\*\*/;
const DOC_ENDS = /\*\//;

/**
 * Похоже ли на объявление чего-то вызываемого.
 *
 * Намеренно широко: метод, стрелка, перегрузка, `export function`, сигнатура в
 * интерфейсе. Дефект — «над КОНСТАНТОЙ», а не «оформлено не так, как я люблю»,
 * и цена ложного срабатывания здесь выше цены пропуска.
 */
const CALLABLE =
  /(\bfunction\b|=>|\)\s*(:[^=]*)?\{\s*$|\bconstructor\b|^\s*(export\s+)?(async\s+)?[A-Za-z_$][\w$]*\s*(<[^>]*>)?\s*\()/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Владелец блока: первая строка ниже, которая не пуста и не комментарий. */
export function ownerLine(lines: string[], docEnd: number): string {
  let j = docEnd + 1;
  while (j < lines.length && (lines[j].trim() === "" || /^\s*\/\//.test(lines[j]))) j++;
  return lines[j] ?? "";
}

function misattached(file: string): string[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!DOC_OPENS.test(lines[i])) continue;
    let end = i;
    while (end < lines.length && !DOC_ENDS.test(lines[end])) end++;
    if (end >= lines.length) break;
    const body = lines.slice(i, end + 1).join("\n");
    if (OWNER_TAG.test(body)) {
      const owner = ownerLine(lines, end);
      if (!CALLABLE.test(owner)) {
        found.push(`${file}:${end + 2} — @param/@returns над «${owner.trim().slice(0, 60)}»`);
      }
    }
    i = end;
  }
  return found;
}

describe("@param и @returns стоят над вызываемым", () => {
  test("по дереву — ни одного докблока с тегами над константой", () => {
    const found: string[] = [];
    for (const root of ROOTS) for (const f of walk(root)) found.push(...misattached(f));
    expect(found).toEqual([]);
  });

  test("разметка владельца: пустые строки и `//` пропускаются, докблок — нет", () => {
    const lines = ["/** x */", "", "// побочная заметка", "export function f() {}"];
    expect(ownerLine(lines, 0)).toBe("export function f() {}");
  });

  test("вызываемым считается и метод, и стрелка, и сигнатура интерфейса", () => {
    for (const owner of [
      "export function floodBackoffMs(",
      "  async run(ctx: Ctx): Promise<void> {",
      "const f = (a: number) => a + 1;",
      "  resolve(key: string): number;",
    ]) {
      expect(CALLABLE.test(owner)).toBe(true);
    }
  });

  test("константа вызываемой не считается — иначе проверка пуста", () => {
    for (const owner of [
      "export const INITIAL_BACKOFF_MS = 1_000;",
      "const MALFORMED_ENV_BUDGET = 100_000;",
      "const HANDLE_RE = /(^|[\\s(])@([A-Za-z0-9_]{4,})/g;",
    ]) {
      expect(CALLABLE.test(owner)).toBe(false);
    }
  });

  test("тег внутри кавычек — цитата, а не контракт", () => {
    expect(OWNER_TAG.test(' *   "/**\\n * @param x …"')).toBe(false);
    expect(OWNER_TAG.test(' * "@param"/"@returns" в JSDoc — так же.')).toBe(false);
    expect(OWNER_TAG.test(" * @param attempt   0-based retry attempt number")).toBe(true);
  });
});
