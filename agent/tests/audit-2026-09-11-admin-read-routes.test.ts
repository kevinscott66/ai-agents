/**
 * Аудит 2026-09-11, круг 24: докблок про viewer-scope перечислял четыре
 * админские ЧИТАЮЩИЕ ручки, а их пять.
 *
 * Абзац над `REDACTED_NOTE` в lib/miniapp-server.ts существует затем, чтобы
 * следующий читатель не вывел из «мутации требуют админа» обратное — «чтение
 * обходится allowlist'ом». Записан он закрытым списком, то есть как инвариант,
 * и в списке не было `GET /api/audit-logs` — ручки, отдающей алерты и отказы
 * по правкам. Кода это не касалось: гейт там стоит и запинен
 * tests/miniapp-audit-logs. Врал ровно тот абзац, который написан, чтобы не
 * соврали другие.
 *
 * Цена — в следующей правке, и она двусторонняя. Расширяющий viewer-scope
 * сверится со списком и решит, что `/api/audit-logs` наблюдателю открыт (он
 * закрыт). Наводящий порядок «приведём код к описанию» снимет с него гейт.
 *
 * Поэтому список сверяется с кодом, а не вычитывается глазами: тест собирает
 * все GET-ветки, вызывающие `requireAdmin`, и требует совпадения множеств.
 * Шестая админская читалка, добавленная мимо абзаца, роняет этот тест.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "lib", "miniapp-server.ts"), "utf8");
const LINES = SRC.split("\n");

/** `if (path === "/api/x" && method === "GET") {` — ветка с литеральным путём. */
const LITERAL_ROUTE = /path === "(\/api\/[^"]+)" && method === "(GET|POST|PUT|DELETE|PATCH)"/;
/** `if (someMatch && method === "GET") {` — ветка по регулярке, пути литералом нет. */
const MATCHER_ROUTE = /\b([A-Za-z_][A-Za-z0-9_]*Match) && method === "(GET|POST|PUT|DELETE|PATCH)"/;

/**
 * Ближайшая ветка выше по файлу — та, в теле которой мы стоим.
 *
 * Годится именно «ближайшая», а не «первая сверху»: ветки идут подряд, и у
 * `/api/budgets` (POST) заголовок стоит ниже заголовка `/api/budget-settings`
 * (GET), хотя `requireAdmin` у них через десяток строк друг от друга.
 */
function routesWithAdminGate(): { literal: string[]; matcher: string[] } {
  const literal: string[] = [];
  const matcher: string[] = [];
  let current: { kind: "literal" | "matcher"; name: string; method: string } | null = null;
  for (const line of LINES) {
    const lit = line.match(LITERAL_ROUTE);
    if (lit) current = { kind: "literal", name: lit[1], method: lit[2] };
    else {
      const mat = line.match(MATCHER_ROUTE);
      if (mat) current = { kind: "matcher", name: mat[1], method: mat[2] };
    }
    if (!line.includes("requireAdmin(user)")) continue;
    if (!current || current.method !== "GET") continue;
    (current.kind === "literal" ? literal : matcher).push(current.name);
  }
  return { literal: [...new Set(literal)].sort(), matcher: [...new Set(matcher)].sort() };
}

/** Пути из того самого абзаца: от «ЧИТАЮЩИХ ручек» до закрывающей пометки аудита. */
function routesNamedInDoc(): string[] {
  const start = LINES.findIndex((l) => l.includes("ЧИТАЮЩИХ ручек"));
  expect(start).toBeGreaterThan(-1);
  const rest = LINES.slice(start);
  const end = rest.findIndex((l) => l.includes("(аудит 2026-09-11)"));
  expect(end).toBeGreaterThan(-1);
  const text = rest.slice(0, end + 1).join(" ");
  return [...new Set([...text.matchAll(/\/api\/[a-z/-]+/g)].map((m) => m[0]))].sort();
}

describe("список админских читающих ручек сверен с кодом", () => {
  test("докблок viewer-scope перечисляет ровно те GET, что требуют админа", () => {
    expect(routesNamedInDoc()).toEqual(routesWithAdminGate().literal);
  });

  test("админского GET по регулярке нет — иначе список нечем сверять", () => {
    // Такая ветка не имеет литерального пути, то есть в абзац её вписать можно
    // только руками, а сверить — нельзя. Появится — решать, как называть, а не
    // молча выпадать из проверки.
    expect(routesWithAdminGate().matcher).toEqual([]);
  });

  test("счётное слово в абзаце совпадает с числом ручек", () => {
    const n = routesNamedInDoc().length;
    const words: Record<number, string> = {
      3: "три", 4: "четыре", 5: "пять", 6: "шесть", 7: "семь", 8: "восемь",
    };
    const start = LINES.findIndex((l) => l.includes("ЧИТАЮЩИХ ручек"));
    // Числительное стоит на строке ВЫШЕ: «админа требуют и пять / ЧИТАЮЩИХ ручек».
    expect(LINES[start - 1]).toContain(words[n]);
  });
});
