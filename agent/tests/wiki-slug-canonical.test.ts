/**
 * Аудит 2026-08-08: один файл вики попадал в индекс под двумя разными slug'ами.
 *
 * wikiWrite индексировал страницу под slug'ом, который назвал вызывающий
 * («roadmap»), а файл клал в `<scope>/pages/roadmap.md`. rebuildWikiIndex при
 * старте (orchestrator-team.ts) стирал индекс и заполнял его из файловой
 * системы, выводя slug из пути («pages/roadmap»). Обе формы читаются в один и
 * тот же файл, поэтому расхождение молчало — до первой перезаписи страницы
 * после рестарта: DELETE по «roadmap» не попадал в строку «pages/roadmap», и в
 * индексе оказывались две строки на один файл, причём у старой — устаревший
 * текст.
 *
 * Путь основной, а не край: SYSTEM компактора требует slug вида `<kebab>` без
 * слэша, то есть под правило попадали все личные страницы всех 12 ролей.
 * Цена — дубли в Wiki-вью Mini App и потраченные слоты в промпте: потребители
 * читают по 4 хита wikiSearch, а один файл занимал два.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  wikiWrite,
  wikiSearch,
  wikiList,
  wikiRead,
  slugFromPath,
} from "../lib/memory.ts";
import { db } from "../lib/db.ts";

const SCOPE = "slugtest";
const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";

afterEach(() => {
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ?`).run(SCOPE);
  rmSync(join(MEMORY_DIR, SCOPE), { recursive: true, force: true });
});

function rows(): { slug: string; content: string }[] {
  return db
    .prepare(`SELECT slug, content FROM wiki_fts WHERE scope = ? ORDER BY slug`)
    .all(SCOPE) as { slug: string; content: string }[];
}

/** Ключ, который выведет обход файловой системы при рестарте. */
function slugFromDisk(relPath: string): string {
  return slugFromPath(SCOPE, resolve(MEMORY_DIR, SCOPE, relPath));
}

describe("вики: один файл — один slug в индексе", () => {
  test("ключ записи совпадает с ключом, который выведет рестарт из пути", () => {
    wikiWrite({ scope: SCOPE, slug: "roadmap", title: "Roadmap", content: "alpha" });
    // Это и есть суть бага: две независимые деривации ключа (от вызывающего и
    // от пути файла) обязаны сойтись, иначе rebuildWikiIndex переименует
    // строку и следующая же перезапись заведёт дубль.
    expect(rows().map((r) => r.slug)).toEqual([slugFromDisk("pages/roadmap.md")]);
    // И это та форма, которую агенты уже используют: без каталога по умолчанию.
    expect(rows()[0]!.slug).toBe("roadmap");
  });

  test("две формы slug'а от вызывающего дают одну строку, а не две", () => {
    // «roadmap» и «pages/roadmap» — один и тот же файл: pagePath подставляет
    // «pages» ровно для slug'ов без слэша.
    wikiWrite({ scope: SCOPE, slug: "roadmap", title: "Roadmap", content: "alpha" });
    wikiWrite({ scope: SCOPE, slug: "pages/roadmap", title: "Roadmap", content: "beta" });

    const after = rows();
    expect(after.length).toBe(1);
    // И содержимое свежее: устаревший текст не должен оставаться находимым.
    expect(after[0]!.content).toContain("beta");
    expect(after[0]!.content).not.toContain("alpha");
  });

  test("поиск отдаёт один хит на один файл, а не два", () => {
    wikiWrite({
      scope: SCOPE,
      slug: "roadmap",
      title: "Roadmap",
      content: "уникальноеслово",
    });
    wikiWrite({
      scope: SCOPE,
      slug: "pages/roadmap",
      title: "Roadmap",
      content: "уникальноеслово",
    });

    expect(wikiSearch("уникальноеслово", [SCOPE], 4).length).toBe(1);
    // Слот в промпте один — потребители читают по 4 хита и раньше тратили
    // два на один и тот же файл.
    expect(wikiList(SCOPE).length).toBe(1);
  });

  test("легаси-строка под путевым slug'ом вычищается перезаписью", () => {
    // Строка, которую оставил в индексе rebuildWikiIndex старой версии.
    db.prepare(
      `INSERT INTO wiki_fts(scope, slug, title, content) VALUES (?, ?, ?, ?)`,
    ).run(SCOPE, "pages/roadmap", "Roadmap", "устаревший");

    wikiWrite({ scope: SCOPE, slug: "roadmap", title: "Roadmap", content: "beta" });

    const after = rows();
    expect(after.length).toBe(1);
    expect(after[0]!.content).not.toContain("устаревший");
  });

  test("slug из индекса читается обратно в тот же файл", () => {
    wikiWrite({ scope: SCOPE, slug: "roadmap", title: "Roadmap", content: "alpha" });
    expect(wikiRead(SCOPE, rows()[0]!.slug)).toContain("alpha");
  });

  test("подпапка, которой нет в pagePath, в slug'е сохраняется", () => {
    // «notes» не каталог по умолчанию, схлопывать нечего: отбросив его, мы
    // получили бы slug, который читается в другой файл.
    wikiWrite({
      scope: SCOPE,
      slug: "notes/deep",
      title: "Deep",
      content: "содержимое",
    });
    expect(rows().map((r) => r.slug)).toEqual(["notes/deep"]);
    expect(wikiRead(SCOPE, rows()[0]!.slug)).toContain("содержимое");
    // Повторная запись — по-прежнему одна строка.
    wikiWrite({ scope: SCOPE, slug: "notes/deep", title: "Deep", content: "ещё" });
    expect(rows().length).toBe(1);
  });
});
