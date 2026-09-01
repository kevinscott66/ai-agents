/**
 * Аудит 2026-08-21: экран «404 — страница не найдена», до которого нельзя
 * добраться, и дыра в типах, которая одна и могла бы до него довести.
 *
 * В App.tsx стояло `const knownTab = TABS.some((t) => t.key === tab)` и ветка
 * `{!knownTab && …}` на двадцать с лишним строк разметки. Но `tab` объявлен как
 * `useState<TabKey>("dashboard")`, а меняет его только `setTab` из трёх мест:
 * кнопка таб-бара (перебор по TABS), стрелки клавиатуры (индекс в TABS) и
 * карточки «Сводки». Ни хеша, ни deep link, ни значения с сервера. То есть
 * `knownTab` — константа `true`, а ветка — мёртвая.
 *
 * Единственная лазейка была рядом: `<Dashboard onNav={setTab as any} />` при
 * `onNav: (tab: any) => void` в самой странице. Опечатка в ключе карточки
 * («aprovals») прошла бы обе проверки типов и увела приложение ровно на этот
 * несуществующий экран — то есть 404 существовал как страховка от дыры,
 * которую проще было закрыть.
 *
 * Дыра закрыта (`TabKey` вместо `any`, каст убран), мёртвая разметка удалена.
 * Условие корректности удаления одно: у КАЖДОГО ключа union'а есть своя ветка
 * рендера. Иначе вместо «404» получится пустой экран без единого слова. Это и
 * стережёт тест ниже — руками такое не удержать, ключей девять.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TABS } from "../miniapp/src/lib/tabnav.ts";

const SRC_DIR = join(import.meta.dir, "..", "miniapp", "src");
const read = (...p: string[]) => readFileSync(join(SRC_DIR, ...p), "utf8");

const APP = read("App.tsx");
const TABNAV = read("lib", "tabnav.ts");
const DASH = read("pages", "Dashboard.tsx");

/** Члены union'а TabKey прямо из исходника — не из типа, тип в рантайме стёрт. */
function unionMembers(): string[] {
  const start = TABNAV.indexOf("export type TabKey =");
  expect(start).toBeGreaterThan(-1);
  const decl = TABNAV.slice(start, TABNAV.indexOf(";", start));
  return [...decl.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("список вкладок замкнут сам на себя", () => {
  test("union и TABS описывают один и тот же набор", () => {
    const keys = TABS.map((t) => t.key);
    expect([...unionMembers()].sort()).toEqual([...keys].sort());
  });

  test("ключи не повторяются", () => {
    const keys = TABS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("у каждой вкладки есть подпись и иконка", () => {
    for (const t of TABS) {
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(t.icon.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("полнота веток рендера — то, чем заменили 404", () => {
  test("у каждого ключа своя ветка в App.tsx", () => {
    const missing = TABS.map((t) => t.key).filter(
      (k) => !APP.includes(`{tab === "${k}" &&`),
    );
    expect(missing).toEqual([]);
  });

  test("веток ровно столько же, сколько вкладок — лишних не осталось", () => {
    const branches = [...APP.matchAll(/\{tab === "([^"]+)" &&/g)].map((m) => m[1]);
    expect(branches.sort()).toEqual(TABS.map((t) => t.key).sort());
  });
});

describe("мёртвая разметка удалена вместе с причиной, а не вместо неё", () => {
  test("ветки «страница не найдена» больше нет", () => {
    expect(APP).not.toContain("knownTab");
    expect(APP).not.toContain("Страница не найдена");
    expect(APP).not.toContain(">404<");
  });

  test("каст, который один и мог бы до неё довести, убран", () => {
    expect(APP).not.toContain("setTab as any");
    expect(APP).toContain("<Dashboard onNav={setTab} />");
  });

  test("страница объявляет проп по типу, а не как any", () => {
    expect(DASH).toContain("onNav: (tab: TabKey) => void;");
    expect(DASH).not.toContain("onNav: (tab: any) => void;");
  });
});

describe("все переходы указывают на существующие вкладки", () => {
  const keys = new Set<string>(TABS.map((t) => t.key));

  test("начальная вкладка существует", () => {
    const m = APP.match(/useState<TabKey>\("([^"]+)"\)/);
    expect(m).not.toBeNull();
    expect(keys.has(m![1])).toBe(true);
  });

  test("литералы в setTab(...) — валидные ключи", () => {
    // Сейчас их нет вовсе: таб-бар и стрелки берут ключ из TABS, а
    // единственный литерал жил в кнопке «На главную» удалённой ветки.
    // Проверка сторожит появление новых.
    const lits = [...APP.matchAll(/setTab\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(lits.filter((k) => !keys.has(k))).toEqual([]);
  });

  test("литералы в onNav(...) на «Сводке» — валидные ключи", () => {
    const lits = [...DASH.matchAll(/onNav\("([^"]+)"\)/g)].map((m) => m[1]);
    // Четыре кликабельные карточки, у каждой ещё и onKeyDown — восемь вызовов.
    expect(lits.length).toBeGreaterThanOrEqual(4);
    expect(lits.filter((k) => !keys.has(k))).toEqual([]);
  });

  test("контроль: несуществующий ключ этой же проверкой ловится", () => {
    const fake = [...'onNav("aprovals")'.matchAll(/onNav\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(fake.filter((k) => !keys.has(k))).toEqual(["aprovals"]);
  });
});
