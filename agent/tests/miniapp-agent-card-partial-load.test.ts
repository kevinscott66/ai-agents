/**
 * Карточка агента теряла список действий из-за 403 на СОСЕДНЕМ запросе.
 *
 * `openAgent` тянул две ручки одним `Promise.all`:
 *   • `GET /api/permissions` — админская (miniapp-server.ts, requireAdmin);
 *   • `GET /api/actions` — открыта любому из аллоу-листа, контент режется
 *     redactContent, но сам список видят все.
 *
 * `Promise.all` реджектится на ПЕРВОМ отказе и выбрасывает результаты
 * остальных. То есть у не-админа 403 от прав уносил с собой и действия: в
 * карточке «Действий пока нет» — при том что действия есть и читать их ему
 * можно. Рядом показывалось «права доступны только для просмотра», хотя
 * `perms` осталось пустым и смотреть было нечего.
 *
 * Инвариант: отказ одной ручки не должен гасить другую. Проверяем текстом —
 * DOM-харнесса в проекте нет, а `Promise.all` в этом теле и есть сам дефект.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENTS_TSX = join(
  import.meta.dir,
  "..",
  "miniapp",
  "src",
  "pages",
  "Agents.tsx",
);

/** Тело функции по имени — от `{` после сигнатуры до парной `}`. */
function functionBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at === -1) throw new Error(`не нашёл ${signature}`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`не закрылось тело ${signature}`);
}

describe("карточка агента переживает частичный отказ", () => {
  const src = readFileSync(AGENTS_TSX, "utf8");
  const body = functionBody(src, "async function openAgent(");

  test("403 на правах не уносит с собой список действий", () => {
    // Promise.allSettled — можно, Promise.all — нет: он реджектится на первом
    // отказе и выбрасывает уже полученный ответ второй ручки.
    expect(body).not.toMatch(/Promise\.all\s*\(/);
  });

  test("обе ручки по-прежнему запрашиваются", () => {
    // Чтобы проверка выше нельзя было пройти, просто удалив запрос.
    expect(body).toContain("api.permissions(");
    expect(body).toContain("api.actions(");
    expect(body).toContain("setRecentActions");
  });

  test("сообщение про read-only не показывается при пустом списке прав", () => {
    // «права доступны только для просмотра» при perms=[] — текст без предмета.
    // Ветку 403 держим честной: она объясняет, что прав не видно вовсе.
    expect(body).not.toContain("права доступны только для просмотра");
  });
});
