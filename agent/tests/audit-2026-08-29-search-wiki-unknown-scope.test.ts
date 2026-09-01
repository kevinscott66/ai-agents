/**
 * Аудит 2026-08-29: SEARCH_WIKI молчал о частичном промахе по scope.
 *
 * Список scope'ов приходил от модели и прогонялся через `filter`. Полный
 * промах она видела ("no valid scopes"), а частичный — нет: на
 * ["_team","backend","bakcend"] инструмент отдавал хиты первых двух так, будто
 * искал по всем трём. Единственный вывод, доступный модели из такого ответа, —
 * «в bakcend совпадений нет», хотя scope с таким именем просто не существует.
 * Опечатка в имени роли — самый вероятный источник такого списка, и именно она
 * получалась неотличимой от честной пустой выдачи.
 *
 * Соседи по файлу так себя не ведут: READ_WIKI отвечает `unknown scope: …`,
 * LIST_RECENT_MESSAGES отбивает неизвестные `kinds`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
// Циклический импорт: если первым в частичном прогоне вычисляется
// `lib/tools-schema.ts`, `agent-sdk-runtime` падает на `INLINE_TOOL_NAMES`
// before initialization. Порядок фиксируем явно.
import "../lib/agent-sdk-runtime.ts";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { wikiWrite } from "../lib/memory.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_912;
const TEST_AGENT = "pm";
const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";
const PFX = `swscope_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let savedAutonomy: ReturnType<typeof saveAutonomy>;

function cleanupWikiFiles(): void {
  for (const scope of ["_team", TEST_AGENT]) {
    for (const sub of ["pages", "projects", "decisions"]) {
      const dir = join(MEMORY_DIR, scope, sub);
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          if (f.startsWith("swscope_")) {
            try {
              rmSync(join(dir, f));
            } catch {
              // страницы могло уже не быть — важен итог, не путь к нему
            }
          }
        }
      } catch {
        // каталога может не быть вовсе
      }
    }
  }
  db.prepare(`DELETE FROM wiki_fts WHERE slug LIKE 'swscope_%'`).run();
}

async function search(input: Record<string, unknown>) {
  const out = await executeTool("SEARCH_WIKI", input, {
    agentKey: TEST_AGENT,
    chatId: TEST_CHAT,
  });
  return JSON.parse(out) as {
    ok: boolean;
    error?: string;
    count?: number;
    hits?: Array<{ scope: string; slug: string; line: string }>;
  };
}

beforeEach(() => {
  savedAutonomy = saveAutonomy();
  cleanupWikiFiles();
  wikiWrite({
    scope: "_team",
    slug: `${PFX}_alpha`,
    title: "Scope probe alpha",
    content: "Alpha scope probe page for the unknown-scope audit.",
  });
});
afterEach(() => {
  cleanupWikiFiles();
  restoreAutonomy(savedAutonomy);
});

describe("SEARCH_WIKI: неизвестный scope", () => {
  test("частичный промах — отказ, а не тихо усечённый поиск", async () => {
    const parsed = await search({
      query: "alpha scope probe",
      scopes: ["_team", "bakcend"],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("bakcend");
    // Хиты не отдаём: неполный результат, выданный за полный, — это и была
    // исходная неисправность.
    expect(parsed.hits).toBeUndefined();
  });

  test("в отказе названы все неизвестные, а не первый попавшийся", async () => {
    const parsed = await search({
      query: "alpha",
      scopes: ["_team", "bakcend", "frontned"],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("bakcend");
    expect(parsed.error).toContain("frontned");
  });

  test("полностью неизвестный список тоже называет промахи поимённо", async () => {
    const parsed = await search({ query: "alpha", scopes: ["bakcend"] });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("bakcend");
  });

  test("пустой список scope'ов остаётся отдельным отказом", async () => {
    const parsed = await search({ query: "alpha", scopes: [] });
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("no valid scopes");
  });

  test("корректный список работает как прежде", async () => {
    const parsed = await search({
      query: "alpha scope probe",
      scopes: ["_team"],
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.hits!.some((h) => h.slug === `${PFX}_alpha`)).toBe(true);
  });

  test("умолчание не проверяется — оно наше, а не модели", async () => {
    // `["_team", ctx.agentKey]` собирает сам инструмент. Падать на собственном
    // значении по умолчанию, если ключ агента вдруг не роль, было бы хуже, чем
    // сузить поиск.
    const parsed = await search({ query: "alpha scope probe" });
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBeGreaterThan(0);
  });
});
