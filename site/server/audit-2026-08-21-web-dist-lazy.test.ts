/**
 * Аудит 2026-08-21: `SITE_WEB_DIST` перестаёт работать, если модуль уже
 * загружен, — и на чистом чекауте это ломает пять чужих тестов.
 *
 * `index.ts:44` фиксировал каталог фронта один раз, на загрузке модуля:
 *
 *   const WEB_DIST = process.env.SITE_WEB_DIST ?? join(import.meta.dir, "..", "web", "dist");
 *
 * Комментарий над строкой прямо объясняет, зачем нужна подмена: «в CI
 * серверные тесты идут ДО сборки веба, то есть `../web/dist` там не
 * существует». Ровно этот сценарий и не работал: `digest-meta.test.ts`
 * импортирует `index.ts` СТАТИЧЕСКИ и грузится раньше по алфавиту
 * (`digest-meta` < `digest-not-found`), поэтому к моменту, когда
 * `digest-not-found.test.ts` выставляет `SITE_WEB_DIST` на свой временный
 * каталог и делает `await import("./index.ts")`, модуль уже закеширован со
 * старым значением.
 *
 * Замер на чистом `origin/main` с `git clean` (то есть без `site/web/dist`):
 *
 *   cd site/server && bun test digest-not-found.test.ts   ->  5 pass / 0 fail
 *   cd site/server && bun test                            ->  271 pass / 5 fail
 *
 * Падает `Content-Type`: вместо оболочки приходит `text/plain;charset=utf-8`,
 * потому что `serveStatic` видит несуществующий `../web/dist` и возвращает
 * null. Локально этого не видно — там `dist` собран, поэтому задокументированный
 * baseline «276 pass / 0 fail» верен только на машине со сборкой.
 *
 * Тест держит само свойство «читается в момент вызова», а не порядок файлов:
 * порядок — деталь, которая поменяется при первом же переименовании.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webDist, makeFetchHandler } from "./index.ts";

const SAVED = process.env.SITE_WEB_DIST;
const created: string[] = [];

afterEach(() => {
  if (SAVED === undefined) delete process.env.SITE_WEB_DIST;
  else process.env.SITE_WEB_DIST = SAVED;
});

function distWithShell(marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
  created.push(dir);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), `<!doctype html><title>${marker}</title>`);
  return join(dir, "dist");
}

describe("каталог фронта читается в момент вызова, а не на импорте", () => {
  test("переменная, выставленная ПОСЛЕ импорта модуля, действует", () => {
    const d = distWithShell("first");
    process.env.SITE_WEB_DIST = d;
    expect(webDist()).toBe(d);
  });

  test("повторная смена переменной тоже видна", () => {
    const a = distWithShell("a");
    const b = distWithShell("b");
    process.env.SITE_WEB_DIST = a;
    expect(webDist()).toBe(a);
    process.env.SITE_WEB_DIST = b;
    expect(webDist()).toBe(b);
  });

  test("без переменной — прежний путь ../web/dist", () => {
    delete process.env.SITE_WEB_DIST;
    expect(webDist().endsWith(join("web", "dist"))).toBe(true);
  });

  test("пустая строка не считается заданной", () => {
    process.env.SITE_WEB_DIST = "";
    expect(webDist().endsWith(join("web", "dist"))).toBe(true);
  });

  test("обработчик отдаёт оболочку из каталога, заданного после импорта", async () => {
    process.env.SITE_WEB_DIST = distWithShell("после-импорта");
    const r = await makeFetchHandler()(new Request("http://x/какой-то-spa-маршрут"));
    expect(r.headers.get("content-type") ?? "").toContain("text/html");
    expect(await r.text()).toContain("после-импорта");
  });
});

afterEach(() => {
  // Удаляем именно каталог из mkdtemp. `join(d, "..")` тут был бы уже tmpdir().
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});
