/**
 * Аудит 2026-08-21: в тёмной теме нативная хрома оставалась светлой.
 *
 * `color-scheme` не был объявлен нигде — ни в `miniapp/src/styles.css`, ни в
 * `index.html`, ни из JS. Проверено грепом по всему `miniapp/src` и
 * `index.html`: единственные вхождения были в `node_modules`.
 *
 * CSS красит только закрытый контрол. Выпадающий список `<select>` рисует не
 * страница, а движок, и без `color-scheme` он берёт светлое умолчание. В
 * приложении одиннадцать `<select>`, и в тёмной теме Telegram каждый
 * открывался белым листом. Туда же — каретка в шести `<input>` и двух
 * `<textarea>`, подсветка выделения и скроллбары.
 *
 * Отдельный случай — `pages/Agents.tsx:318`: единственный `<select>` без
 * какого-либо CSS-правила (`.filter-row select` его не достаёт, класса нет,
 * инлайнового фона нет). Он рисовался целиком по умолчанию движка, то есть
 * белой коробкой на тёмном фоне. Общий `color-scheme` чинит и его — без
 * правки самого места.
 *
 * Порядок источников в `colorSchemeOf`: сначала `Telegram.WebApp.colorScheme`
 * (Telegram знает свою тему точно), потом яркость `bg_color`, и только потом
 * «не знаю» — тогда работает объявленный в CSS `light dark`, и хрома идёт за
 * системной темой. Разойтись с Telegram она может, залипнуть светлой — нет.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { colorSchemeOf, applyColorScheme } from "../miniapp/src/lib/theme.ts";

const MINIAPP = join(import.meta.dir, "..", "miniapp");
const CSS = readFileSync(join(MINIAPP, "src", "styles.css"), "utf8");
const THEME = readFileSync(join(MINIAPP, "src", "lib", "theme.ts"), "utf8");

describe("colorSchemeOf: Telegram знает точно", () => {
  test("declared перевешивает цвет фона", () => {
    // Тёмный фон, но Telegram говорит «светлая» — верим Telegram.
    expect(colorSchemeOf({ bg_color: "#17212b" }, "light")).toBe("light");
    expect(colorSchemeOf({ bg_color: "#ffffff" }, "dark")).toBe("dark");
  });

  test("мусор в declared игнорируем и падаем на цвет", () => {
    expect(colorSchemeOf({ bg_color: "#17212b" }, "Dark")).toBe("dark");
    expect(colorSchemeOf({ bg_color: "#17212b" }, 1 as any)).toBe("dark");
    expect(colorSchemeOf({ bg_color: "#ffffff" }, null)).toBe("light");
  });
});

describe("colorSchemeOf: яркость фона", () => {
  test("реальные фоны Telegram", () => {
    expect(colorSchemeOf({ bg_color: "#17212b" })).toBe("dark"); // Telegram Dark
    expect(colorSchemeOf({ bg_color: "#ffffff" })).toBe("light"); // Telegram Light
    expect(colorSchemeOf({ bg_color: "#212d3b" })).toBe("dark"); // Telegram Night
  });

  test("короткая запись #rgb", () => {
    expect(colorSchemeOf({ bg_color: "#000" })).toBe("dark");
    expect(colorSchemeOf({ bg_color: "#fff" })).toBe("light");
  });

  test("регистр и пробелы не мешают", () => {
    expect(colorSchemeOf({ bg_color: "  #17212B  " })).toBe("dark");
  });

  test("зелёный ярче синего при том же числе — считаем яркость, а не сумму", () => {
    // #0000ff и #00ff00 по сумме каналов равны, по восприятию — нет.
    expect(colorSchemeOf({ bg_color: "#0000ff" })).toBe("dark");
    expect(colorSchemeOf({ bg_color: "#00ff00" })).toBe("light");
  });
});

describe("colorSchemeOf: не угадываем", () => {
  test("нет параметров — null", () => {
    expect(colorSchemeOf(null)).toBe(null);
    expect(colorSchemeOf(undefined)).toBe(null);
    expect(colorSchemeOf({})).toBe(null);
  });

  test("не цвет — null, а не «светлая»", () => {
    // Залипнуть на светлой — ровно тот дефект, который чиним.
    expect(colorSchemeOf({ bg_color: "rgb(0,0,0)" })).toBe(null);
    expect(colorSchemeOf({ bg_color: "#12345" })).toBe(null);
    expect(colorSchemeOf({ bg_color: "" })).toBe(null);
    expect(colorSchemeOf({ bg_color: 0 as any })).toBe(null);
  });
});

describe("applyColorScheme", () => {
  function fakeEl() {
    const props: Record<string, string> = {};
    return {
      props,
      style: { setProperty: (k: string, v: string) => void (props[k] = v) },
    };
  }

  test("пишет свойство на элемент", () => {
    const el = fakeEl();
    applyColorScheme("dark", el as any);
    expect(el.props["color-scheme"]).toBe("dark");
  });

  test("null не трогает элемент — остаётся CSS-умолчание", () => {
    const el = fakeEl();
    applyColorScheme(null, el as any);
    expect(el.props["color-scheme"]).toBeUndefined();
  });
});

describe("подключено к теме", () => {
  test(":root объявляет color-scheme", () => {
    const root = CSS.slice(CSS.indexOf(":root"), CSS.indexOf("}"));
    expect(root).toContain("color-scheme: light dark;");
  });

  test("запасное значение — не одиночный light", () => {
    // `color-scheme: light` был бы тем же дефектом, только явным.
    expect(CSS).not.toMatch(/color-scheme:\s*light\s*;/);
  });

  test("syncThemeFromTelegram проставляет схему, а не только переменные", () => {
    const fn = THEME.slice(THEME.indexOf("export function syncThemeFromTelegram"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("applyColorScheme(");
    expect(body).toContain("wa?.colorScheme");
  });

  test("схема едет через ту же функцию, что и themeChanged", () => {
    // initTelegramTheme подписывает на themeChanged именно syncThemeFromTelegram —
    // значит переключение темы в Telegram доезжает целиком, а не наполовину.
    const init = THEME.slice(THEME.indexOf("export function initTelegramTheme"));
    expect(init).toContain("syncThemeFromTelegram()");
    expect(init).toContain('wa.onEvent("themeChanged", handler)');
  });
});
