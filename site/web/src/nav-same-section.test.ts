/**
 * Клик по пункту меню того раздела, в котором уже находишься.
 *
 * Ссылки в шапке — обычные `<a href="/drops">`; переход делает глобальный
 * обработчик preact-router. Он не сравнивает адрес с текущим: `route()` зовёт
 * `history.pushState` всегда. А `onChange` роутера вызывается только когда
 * адрес изменился. Отсюда два разных дефекта с одним корнем.
 *
 * 1. Стоя на `/drops?status=live`, жмём «Дропы». Адрес становится `/drops` —
 *    фильтр из него исчез. Но список остался прежним: `useQueryParam` читает
 *    адрес один раз при инициализации, а секция не перемонтируется. Дальше
 *    адрес и картинка расходятся: скопированная ссылка покажет другое, F5
 *    покажет другое.
 *
 * 2. Стоя на `/drops` без параметров, жмём «Дропы». Адрес не изменился —
 *    `onChange` не сработал, `markNavigation` не позвался, — но запись в
 *    историю роутер положил. Она осталась без нашей метки глубины. Уходим в
 *    другой раздел, жмём «Назад» — попадаем на эту непомеченную запись, и
 *    отсутствие метки читается как «новая запись, ушли вперёд»: глубина растёт
 *    вместо того чтобы падать, а `scrollForNavigation` уводит наверх ленту,
 *    положение которой браузер только что восстановил. То есть ровно то, от
 *    чего защищались в аудите 2026-08-13, — через дверь, которую тогда не
 *    заметили.
 *
 * Чинится в одном месте: такой клик гасится и перехода не делает.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  markNavigation,
  navigationDepth,
  resetNavigations,
  scrollForNavigation,
  swallowsNavClick,
} from "./nav";

beforeEach(() => resetNavigations());

describe("swallowsNavClick", () => {
  test("тот же раздел с фильтром в адресе — гасим", () => {
    expect(swallowsNavClick({}, "/drops?status=live", "/drops")).toBe(true);
  });

  test("тот же раздел без параметров — гасим", () => {
    expect(swallowsNavClick({}, "/drops", "/drops")).toBe(true);
  });

  test("другой раздел — переход как обычно", () => {
    expect(swallowsNavClick({}, "/unlocks", "/drops")).toBe(false);
  });

  test("детальная страница внутри раздела — это переход", () => {
    // `/drops/foo` — не `/drops`; отсюда клик по «Дропы» ведёт наверх списка.
    expect(swallowsNavClick({}, "/drops/some-slug", "/drops")).toBe(false);
  });

  test("cmd-клик не гасим — он открывает вкладку, а не переходит", () => {
    // Погасив его, мы отняли бы единственный способ открыть текущий раздел
    // второй вкладкой; сам роутер модифицированные клики не трогает.
    expect(swallowsNavClick({ metaKey: true }, "/drops", "/drops")).toBe(false);
    expect(swallowsNavClick({ ctrlKey: true }, "/drops", "/drops")).toBe(false);
    expect(swallowsNavClick({ button: 1 }, "/drops", "/drops")).toBe(false);
  });

  test("хэш не делает раздел другим", () => {
    expect(swallowsNavClick({}, "/about#faq", "/about")).toBe(true);
  });
});

describe("что даёт гашение — на модели истории", () => {
  /**
   * Модель вкладки. Ключевое отличие от `nav.test.ts`: здесь есть `pushSilent`
   * — запись, которую роутер кладёт, не вызвав `onChange`, потому что адрес не
   * изменился. Именно она и остаётся без метки глубины.
   */
  function makeHistory() {
    const stack: { url: string; state: unknown }[] = [{ url: "/drops", state: null }];
    let i = 0;
    const h = {
      get state() {
        return stack[i]!.state;
      },
      get length() {
        return stack.length;
      },
      replaceState(state: unknown) {
        stack[i]!.state = state;
      },
      push(url: string) {
        stack.splice(i + 1);
        stack.push({ url, state: null });
        i = stack.length - 1;
        return markNavigation(h);
      },
      /** pushState без onChange: адрес тот же, метку поставить некому. */
      pushSilent(url: string) {
        stack.splice(i + 1);
        stack.push({ url, state: null });
        i = stack.length - 1;
      },
      back() {
        if (i > 0) i--;
        return markNavigation(h);
      },
      get depthIndex() {
        return i;
      },
    };
    return h;
  }

  /** Клик по пункту меню так, как его теперь обрабатывает шапка. */
  function clickNav(h: ReturnType<typeof makeHistory>, current: string, href: string) {
    if (swallowsNavClick({}, current, href)) return; // погашен, истории не касаемся
    h.pushSilent(href);
  }

  test("непомеченная запись — вот чем она оборачивалась", () => {
    // Контрольный прогон: так вело себя приложение до гашения. Метки нет,
    // поэтому «Назад» на эту запись читается как ход вперёд — со всем, что из
    // этого следует: прокрутка наверх поверх восстановленной браузером и
    // растущая вместо падающей глубина.
    const h = makeHistory();
    markNavigation(h);
    h.pushSilent("/drops"); // клик по «Дропам», стоя на «Дропах»
    h.push("/unlocks");
    expect(h.back()).toBe("forward");
  });

  test("гашёный клик не кладёт запись вовсе", () => {
    const h = makeHistory();
    markNavigation(h);
    const before = h.length;
    clickNav(h, "/drops", "/drops");
    expect(h.length).toBe(before);
  });

  test("и «Назад» после него ведёт туда, где были", () => {
    const h = makeHistory();
    markNavigation(h);
    clickNav(h, "/drops", "/drops");
    h.push("/unlocks");
    expect(h.back()).toBe("returning");
  });

  test("и ленту наверх не уводит", () => {
    const h = makeHistory();
    markNavigation(h);
    clickNav(h, "/drops", "/drops");
    h.push("/unlocks");

    let scrolled = false;
    scrollForNavigation(h.back(), () => {
      scrolled = true;
    });
    expect(scrolled).toBe(false);
  });

  test("и глубина остаётся честной", () => {
    const h = makeHistory();
    markNavigation(h);
    clickNav(h, "/drops", "/drops");
    h.push("/unlocks");
    h.back();
    // Позади только запись входа: наружу «Назад» уже не уведёт.
    expect(navigationDepth()).toBe(0);
  });

  test("клик по другому разделу переход делает", () => {
    const h = makeHistory();
    markNavigation(h);
    const before = h.length;
    clickNav(h, "/drops", "/unlocks");
    expect(h.length).toBe(before + 1);
  });
});

describe("проводка Header.tsx", () => {
  const RAW = readFileSync(
    new URL("./components/Header.tsx", import.meta.url),
    "utf8",
  );
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("решение принимает общая функция, и её ответ — единственное условие", () => {
    // Условие целиком, без приписок вроде `&& false`: иначе проводка мертва,
    // а тест зелен.
    expect(SRC).toMatch(/if \(swallowsNavClick\(e, url, href\)\) \{/);
  });

  test("в этой же ветке клик глушится обоими способами", () => {
    // preventDefault отменяет переход браузера, но глобальный слушатель
    // роутера `defaultPrevented` не смотрит — его останавливает только
    // stopPropagation. Одного из двух не хватает, поэтому проверяем обе
    // строки именно внутри ветки гашения.
    expect(SRC).toMatch(
      /if \(swallowsNavClick\(e, url, href\)\) \{[\s\S]{0,120}?e\.preventDefault\(\);[\s\S]{0,120}?e\.stopPropagation\(\);/,
    );
  });

  test("и лента уходит к началу", () => {
    // Единственное решение «на вкус» здесь: нажатие на свой же раздел читаем
    // как просьбу вернуться к началу списка. Раньше это делал перезапуск
    // секции — как побочный эффект перехода, которого больше нет.
    expect(SRC).toMatch(
      /if \(swallowsNavClick\(e, url, href\)\) \{[\s\S]{0,200}?window\.scrollTo\(\{ top: 0 \}\);/,
    );
  });

  test("пункты меню и логотип ходят через него", () => {
    expect(SRC).toMatch(/onClick=\{\(e\) => navClick\(e, n\.href\)\}/);
    expect(SRC).toMatch(/onClick=\{\(e\) => navClick\(e, "\/"\)\}/);
  });
});
