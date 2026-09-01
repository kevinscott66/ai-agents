// Аудит 2026-08-20: первая ступень загрузочной лестницы Mini App была мертва.
//
// В main.tsx стояло:
//
//   function debug(stage) { …красит #boot-err / #boot-label… }
//   debug("JS loaded, importing modules…");   // ← statement
//   import React from "react";                // ← declarations
//   …
//   debug("imports ok, mounting…");
//
// Расчёт был на то, что первый вызов покрасит экран ДО подтягивания модулей, и
// зависший импорт (битый чанк после редеплоя, SyntaxError в старом WebView
// Telegram) будет отличим от «модуль вообще не поехал». Но `import` —
// декларация: спецификация вычисляет весь граф зависимостей до первого
// statement тела модуля. Оба вызова уходили в один и тот же тик, вплотную.
// Видно прямо в собранном бандле:
//
//   se("JS loaded, importing modules…");se("imports ok, mounting…");
//
// То есть состояние «JS загрузился, тянем модули» не показывалось НИКОГДА — ни
// в успешном запуске, ни в упавшем, — и оба сбоя выглядели одинаково: сплэш
// навсегда застывал на «Загружаем интерфейс…» из index.html.
//
// Починка: побочный эффект переехал в отдельный модуль без собственных
// импортов, который main.tsx импортирует первым. Порядок вычисления модулей —
// это порядок импортов, а у листа графа зависимостей нет, поэтому он и есть
// первый выполненный код бандла.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const MAIN = strip(read("../miniapp/src/main.tsx"));
const PROBE = strip(read("../miniapp/src/boot-probe.ts"));

const STAGE_1 = "JS loaded, importing modules…";
const STAGE_2 = "imports ok, mounting…";

describe("main.tsx — ничего не выполняется до импортов", () => {
  test("выше первого import нет ни одного statement", () => {
    const i = MAIN.search(/^import\b/m);
    expect(i).toBeGreaterThanOrEqual(0);
    const head = MAIN.slice(0, i).trim();
    expect(head).toBe("");
  });

  test("первый импорт — boot-probe, он же и есть первый выполненный код", () => {
    const first = MAIN.match(/^import\s[^;]*?from\s*"([^"]+)"/m);
    expect(first).not.toBeNull();
    expect(first![1]).toBe("./boot-probe");
  });

  test("main.tsx больше не объявляет свой debug", () => {
    expect(MAIN).not.toMatch(/function\s+debug\s*\(/);
  });

  test("поздние ступени по-прежнему рисуются", () => {
    expect(MAIN).toContain(STAGE_2);
    expect(MAIN).toMatch(/debug\("react mounted"\)/);
    // Ступень «монтирование упало» тоже красится — но текстом для человека.
    // Раньше сюда уезжала строка исключения (`debug("MOUNT ERROR: " + e)`):
    // сплэш Mini App виден любому, кто открыл панель, а сообщение JS-ошибки
    // это стек и пути сборки. Диагностика ушла в console.error, на экран
    // остался понятный текст, поэтому здесь проверяется факт вызова, а не
    // конкретная строка.
    const tail = MAIN.slice(MAIN.lastIndexOf("} catch"));
    expect(tail).toMatch(/debug\("[^"]+"\)/);
    expect(tail).toContain("console.error");
    expect(tail).not.toMatch(/debug\([^)]*\be\b/);
  });
});

describe("boot-probe.ts — лист графа зависимостей", () => {
  test("не импортирует ничего: раньше него выполниться нечему", () => {
    expect(PROBE).not.toMatch(/^\s*import\b/m);
  });

  test("красит первую ступень на верхнем уровне модуля", () => {
    expect(PROBE).toMatch(new RegExp(`^debug\\("${STAGE_1}"\\);`, "m"));
  });

  test("экспортирует debug наружу — второй копии быть не должно", () => {
    expect(PROBE).toMatch(/export\s+function\s+debug\s*\(/);
  });

  test("трогает те же узлы сплэша, что и index.html", () => {
    const html = read("../miniapp/index.html");
    for (const id of ["boot-err", "boot-label"]) {
      expect(PROBE).toContain(id);
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("не роняет запуск, если узлов сплэша нет", () => {
    expect(PROBE).toMatch(/catch\s*\{\s*\}/);
  });
});

describe("ступени не дублируются", () => {
  test("каждая подпись живёт ровно в одном месте", () => {
    const both = MAIN + PROBE;
    expect(both.split(STAGE_1).length - 1).toBe(1);
    expect(both.split(STAGE_2).length - 1).toBe(1);
  });

  test("подписи различимы — иначе лестница снова схлопнется", () => {
    expect(STAGE_1).not.toBe(STAGE_2);
  });
});
