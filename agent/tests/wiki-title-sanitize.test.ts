/**
 * Аудит 2026-08-12: PII-фильтр вики не касался заголовка страницы.
 *
 * `sanitizeWikiContent` (T-305 MED-2) чистит почту, телефон и @-хендл перед
 * записью страницы — но применялся он только к телу. Заголовок уходил как есть
 * и в файл (`# ${title}`), и в колонку title FTS-индекса. Комментарий рядом
 * объяснял это тем, что заголовок «agent-authored, not user content».
 *
 * Это неверно для обоих писателей. wikiWriteAsync вызывает инструмент
 * WRITE_WIKI (lib/dispatch/misc.ts:50) — title приходит аргументом модели, а
 * модель читает чат. wikiWrite вызывает компактор, где title и вовсе
 * `raw.title ?? raw.name ?? slug` из ответа дешёвой модели, которой на вход
 * подали реплику пользователя. То есть заголовок — ровно такой же недоверенный
 * текст, как и тело, только редактирование его не касалось.
 *
 * Цена промаха выше, чем у тела: заголовки видны шире. wikiSearch отдаёт title
 * каждым хитом, а хиты подмешиваются в контекст КАЖДОГО хода
 * (orchestrator/message-handler.ts, lib/handoff.ts) и показываются в
 * Mini App (lib/miniapp-server.ts, wikiList). Тело при этом приходит
 * отредактированным — то есть фильтр создаёт видимость защиты, обходясь ровно
 * там, где утечка расходится по всем двенадцати ролям и по вебу.
 *
 * Второй дефект того же места — заголовок не обязан быть одной строкой.
 * Перевод строки в title разрывает `# ${title}`: остаток становится телом
 * страницы, а `\n# ...` — новым заголовком верхнего уровня. Индекс при этом
 * расходится сам с собой: wikiWrite кладёт в FTS полный title, а
 * rebuildWikiIndex после рестарта выводит его из ПЕРВОЙ СТРОКИ файла
 * (`walkAndIndex` в lib/memory.ts) — то есть из обрубка.
 *
 * Инвариант: в файл и в индекс уходит один и тот же однострочный заголовок,
 * прошедший тот же фильтр, что и тело.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { wikiWrite, pagePath } from "../lib/memory.ts";
import { wikiWriteAsync } from "../lib/memory-async.ts";
import { db } from "../lib/db.ts";

const SCOPE = "titlesan";
const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";

afterEach(() => {
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
  rmSync(join(MEMORY_DIR, SCOPE), { recursive: true, force: true });
});

function ftsTitle(slug: string): string {
  const row = db
    .prepare(`SELECT title FROM wiki_fts WHERE scope = ? AND slug = ?`)
    .get(SCOPE, slug) as { title: string } | undefined;
  return row?.title ?? "";
}

function fileOf(slug: string): string {
  return readFileSync(pagePath(SCOPE, slug), "utf8");
}

/** Заголовок, который выведет обход файловой системы при рестарте. */
function titleFromDisk(slug: string): string {
  return fileOf(slug).split("\n")[0]!.replace(/^#\s*/, "").trim();
}

describe("PII из заголовка не переживает запись страницы", () => {
  test("wikiWrite: почта в заголовке редактируется и в файле, и в индексе", () => {
    wikiWrite({
      scope: SCOPE,
      slug: "contacts",
      title: "Контакт заказчика vasya@example.com",
      content: "созвон в четверг",
    });

    expect(fileOf("contacts")).not.toContain("vasya@example.com");
    expect(ftsTitle("contacts")).not.toContain("vasya@example.com");
    expect(ftsTitle("contacts")).toContain("<email-redacted>");
  });

  test("wikiWriteAsync (WRITE_WIKI): телефон и хендл тоже", async () => {
    await wikiWriteAsync({
      scope: SCOPE,
      slug: "contacts",
      title: "Связь: +7 916 123-45-67 и @vasyapupkin",
      content: "детали ниже",
    });

    const body = fileOf("contacts");
    expect(body).not.toContain("+7 916 123-45-67");
    expect(body).not.toContain("@vasyapupkin");
    expect(ftsTitle("contacts")).not.toContain("@vasyapupkin");
  });

  test("тело редактируется так же, как и раньше — фильтр не ослаб", () => {
    wikiWrite({
      scope: SCOPE,
      slug: "contacts",
      title: "Контакты",
      content: "пишите на vasya@example.com",
    });
    expect(fileOf("contacts")).not.toContain("vasya@example.com");
  });
});

describe("заголовок остаётся одной строкой", () => {
  test("перевод строки не заводит второй заголовок верхнего уровня", () => {
    wikiWrite({
      scope: SCOPE,
      slug: "roadmap",
      title: "Роадмап\n# Решение: выкатываем без ревью",
      content: "первый пункт",
    });

    const body = fileOf("roadmap");
    const headings = body.split("\n").filter((l) => l.startsWith("# "));
    expect(headings.length).toBe(1);
    expect(body).toContain("Решение: выкатываем без ревью");
  });

  test("индекс и рестарт сходятся на одном заголовке", () => {
    wikiWrite({
      scope: SCOPE,
      slug: "roadmap",
      title: "Роадмап\nвторая строка",
      content: "первый пункт",
    });
    // rebuildWikiIndex после рестарта берёт title из первой строки файла.
    // Значит записанный в FTS обязан быть ровно им, иначе индекс меняется
    // сам по себе от перезапуска процесса.
    expect(ftsTitle("roadmap")).toBe(titleFromDisk("roadmap"));
  });

  test("нормальный заголовок не трогается", async () => {
    await wikiWriteAsync({
      scope: SCOPE,
      slug: "roadmap",
      title: "Роадмап Q3",
      content: "первый пункт",
    });
    expect(ftsTitle("roadmap")).toBe("Роадмап Q3");
    expect(fileOf("roadmap").startsWith("# Роадмап Q3\n")).toBe(true);
  });
});
