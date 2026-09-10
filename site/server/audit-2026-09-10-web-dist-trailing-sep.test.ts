/**
 * Аудит 2026-09-10: `SITE_WEB_DIST` с хвостовым слэшем выключал ВСЮ статику,
 * не сказав об этом ни строкой в логе.
 *
 * `serveStatic` защищается от обхода путей сравнением
 * `filePath.startsWith(dist + sep)`. `join(dist, rel)` хвостовой разделитель
 * схлопывает, поэтому при `dist = "/opt/web/dist/"` слева стоял нормальный
 * `/opt/web/dist/assets/index-abc.js`, а справа — `/opt/web/dist//`, которому
 * не соответствует ни один реальный путь. Каждый ассет сбрасывался на `dist`,
 * тот не файл, дальше срабатывала ветка «отсутствующий ассет обязан отдавать
 * 404» — и отдавала. При этом `/` продолжал работать (там `join` даёт ровно
 * `dist`, и равенство `filePath !== dist` спасало), то есть сайт открывался
 * пустой оболочкой: index.html есть, ни одного бандла нет.
 *
 * Прогон логики до правки, `dist="/x/dist/"`:
 *
 *   /assets/a.js -> сброшен на dist -> 404
 *   /about       -> сброшен на dist -> SPA-фолбэк (index.html)
 *   /            -> не сброшен      -> index.html
 *
 * Предыдущий аудит этой же функции (2026-08-21) нормализовал только пустую
 * строку. Хвостовой слэш в пути к каталогу — не опечатка, а обычная форма
 * записи, и переменную задаёт человек: CI и оператор.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { webDist, makeFetchHandler } from "./index.ts";

const SAVED = process.env.SITE_WEB_DIST;
const created: string[] = [];

/** Каталог с оболочкой и одним хешированным бандлом — как после сборки Vite. */
function builtDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-dist-sep-"));
  created.push(dir);
  const dist = join(dir, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>оболочка</title>");
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log('бандл');");
  return dist;
}

afterEach(() => {
  if (SAVED === undefined) delete process.env.SITE_WEB_DIST;
  else process.env.SITE_WEB_DIST = SAVED;
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SITE_WEB_DIST с хвостовым разделителем", () => {
  test("webDist снимает хвостовой слэш", () => {
    const d = builtDist();
    process.env.SITE_WEB_DIST = d + sep;
    expect(webDist()).toBe(d);
  });

  test("снимает и несколько разделителей подряд", () => {
    const d = builtDist();
    process.env.SITE_WEB_DIST = d + sep + sep;
    expect(webDist()).toBe(d);
  });

  test("путь без хвоста не меняется", () => {
    const d = builtDist();
    process.env.SITE_WEB_DIST = d;
    expect(webDist()).toBe(d);
  });

  test("корень не превращается в пустой путь", () => {
    process.env.SITE_WEB_DIST = sep;
    expect(webDist()).toBe(sep);
  });

  test("бандл отдаётся, а не 404 — это и есть сломанный случай", async () => {
    process.env.SITE_WEB_DIST = builtDist() + sep;
    const r = await makeFetchHandler()(
      new Request("http://x/assets/index-abc.js"),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("бандл");
  });

  test("тот же бандл без хвостового слэша — контрольный прогон", async () => {
    process.env.SITE_WEB_DIST = builtDist();
    const r = await makeFetchHandler()(
      new Request("http://x/assets/index-abc.js"),
    );
    expect(r.status).toBe(200);
  });

  test("оболочка продолжает отдаваться (она ломалась не первой)", async () => {
    process.env.SITE_WEB_DIST = builtDist() + sep;
    const r = await makeFetchHandler()(new Request("http://x/"));
    expect(await r.text()).toContain("оболочка");
  });

  test("гейт обхода путей от правки не ослаб", async () => {
    process.env.SITE_WEB_DIST = builtDist() + sep;
    for (const p of ["/../index.html", "/assets/../../index.html", "/%2e%2e/index.html"]) {
      const r = await makeFetchHandler()(new Request(`http://x${p}`));
      expect(await r.text()).not.toContain("бандл");
    }
  });
});
