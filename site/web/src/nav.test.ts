/**
 * Аудит 2026-08-13: три дефекта навигации, все про потерю места на странице.
 *
 * 1. «Назад» на детальной странице определяло «пришли изнутри» по
 *    `document.referrer`. Referrer описывает загрузку ДОКУМЕНТА и при pushState
 *    не меняется — в SPA он до конца жизни вкладки остаётся внешним. Значит у
 *    любого, кто пришёл из телеграма или поиска, «Назад» из карточки уводило на
 *    главную, теряя и фильтр, и поисковый запрос, и позицию прокрутки.
 *
 * 2. Заменивший referrer счётчик переходов ошибался в другую сторону: `onChange`
 *    роутера срабатывает и на «Назад», а счётчик только рос. После возврата сайт
 *    считал, что позади есть его собственные записи, и следующее «Назад» уходило
 *    на предыдущий документ вкладки — для пришедших из фида на сырой `/rss.xml`.
 *
 * 3. Подсветка текущего раздела сравнивала весь `url` от роутера, а он включает
 *    query. На `/drops?status=active` раздел переставал быть отмеченным — и
 *    визуально, и в `aria-current`. То есть ломалось ровно на тех адресах,
 *    которые редизайн и добавил, чтобы их можно было пересылать.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  markNavigation,
  navigationDepth,
  opensElsewhere,
  resetNavigations,
  scrollForNavigation,
  sectionPath,
  shouldGoBack,
} from "./nav";

/**
 * Модель истории вкладки. Считать вызовы `markNavigation` бессмысленно — именно
 * это и было ошибкой. Проверять нужно поведение на настоящем стеке: `push`
 * добавляет запись без состояния (так делает preact-router) и обрезает то, что
 * впереди, `back`/`forward` двигают указатель, состояние записи переживает оба.
 */
function makeHistory(entriesBefore = 0) {
  const stack: { url: string; state: unknown }[] = [];
  for (let i = 0; i < entriesBefore; i++) stack.push({ url: `/external-${i}`, state: null });
  stack.push({ url: "/", state: null });
  let i = stack.length - 1;

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
    /** Переход по ссылке внутри сайта: роутер зовёт pushState без состояния. */
    push(url: string) {
      stack.splice(i + 1);
      stack.push({ url, state: null });
      i = stack.length - 1;
      return markNavigation(h);
    },
    back() {
      if (i > 0) i--;
      return markNavigation(h);
    },
    forward() {
      if (i < stack.length - 1) i++;
      return markNavigation(h);
    },
    /** F5: модуль забывает всё, история — нет. */
    reload() {
      resetNavigations();
      return markNavigation(h);
    },
    here() {
      return stack[i]!.url;
    },
  };
  return h;
}

describe("глубина навигации", () => {
  beforeEach(() => resetNavigations());

  test("прямой заход по ссылке: позади ничего нашего — ведём на раздел", () => {
    const h = makeHistory(2); // до нас во вкладке уже был поиск и rss.xml
    markNavigation(h); // начальный рендер роутера
    expect(navigationDepth()).toBe(0);
    expect(shouldGoBack(navigationDepth())).toBe(false);
  });

  test("внутри сайта был переход — уходим по истории", () => {
    const h = makeHistory();
    markNavigation(h);
    h.push("/digests");
    expect(navigationDepth()).toBe(1);
    expect(shouldGoBack(navigationDepth())).toBe(true);
  });

  test("«Назад» не считается продвижением вперёд", () => {
    // Ровно тот сценарий, который уводил на /rss.xml: пришли из фида, прошли
    // раздел → карточку, вернулись дважды. На своей начальной записи глубина
    // обязана быть нулём, иначе третье «Назад» вынесет из сайта.
    const h = makeHistory(1);
    markNavigation(h);
    h.push("/digests");
    h.push("/digest/dig-1");
    expect(navigationDepth()).toBe(2);
    h.back();
    expect(navigationDepth()).toBe(1);
    h.back();
    expect(navigationDepth()).toBe(0);
    expect(shouldGoBack(navigationDepth())).toBe(false);
    expect(h.here()).toBe("/");
  });

  test("«Вперёд» возвращает прежнюю глубину, а не сбрасывает её", () => {
    const h = makeHistory();
    markNavigation(h);
    h.push("/digests");
    h.back();
    h.forward();
    expect(navigationDepth()).toBe(1);
    expect(shouldGoBack(navigationDepth())).toBe(true);
  });

  test("новый переход после возврата обрезает то, что было впереди", () => {
    const h = makeHistory();
    markNavigation(h);
    h.push("/digests");
    h.push("/digest/dig-1");
    h.back(); // на /digests, глубина 1
    h.push("/drops"); // новая ветка поверх
    expect(navigationDepth()).toBe(2);
  });

  test("перезагрузка не роняет «Назад» до перехода на раздел", () => {
    // history.state переживает F5, поэтому глубина восстанавливается. Раньше
    // счётчик обнулялся, и после обновления страницы «Назад» уводило на раздел,
    // теряя и фильтр, и прокрутку — при том что вернуться было куда.
    const h = makeHistory();
    markNavigation(h);
    h.push("/digests");
    h.push("/digest/dig-1");
    h.reload();
    expect(navigationDepth()).toBe(2);
    expect(shouldGoBack(navigationDepth())).toBe(true);
  });

  test("история без нашего состояния не ломает рендер", () => {
    // replaceState умеет бросать (песочница iframe, лимит вызовов). Навигация
    // должна продолжать работать в пределах вкладки.
    const broken = {
      state: null,
      length: 1,
      replaceState() {
        throw new Error("SecurityError");
      },
      back() {},
    };
    expect(() => markNavigation(broken)).not.toThrow();
    expect(navigationDepth()).toBe(0);
    expect(() => markNavigation(broken)).not.toThrow();
    expect(navigationDepth()).toBe(1);
  });
});

describe("opensElsewhere", () => {
  test("обычный клик ведёт по ссылке — ящик закрывается", () => {
    expect(opensElsewhere({})).toBe(false);
    expect(opensElsewhere({ button: 0 })).toBe(false);
  });

  test("cmd/ctrl/shift/alt открывают ссылку рядом — ящик остаётся", () => {
    // Открыть три раздела в фоновых вкладках — обычный способ читать такой
    // сайт. Раньше после первого же cmd-клика меню схлопывалось.
    expect(opensElsewhere({ metaKey: true })).toBe(true);
    expect(opensElsewhere({ ctrlKey: true })).toBe(true);
    expect(opensElsewhere({ shiftKey: true })).toBe(true);
    expect(opensElsewhere({ altKey: true })).toBe(true);
  });

  test("средняя кнопка — тоже новая вкладка", () => {
    expect(opensElsewhere({ button: 1 })).toBe(true);
  });
});

describe("sectionPath", () => {
  test("чистый путь остаётся собой", () => {
    expect(sectionPath("/drops")).toBe("/drops");
  });

  test("фильтр в адресе не сбрасывает подсветку раздела", () => {
    expect(sectionPath("/drops?status=active")).toBe("/drops");
    expect(sectionPath("/digests?q=Monad")).toBe("/digests");
    expect(sectionPath("/unlocks?range=30d&sort=desc")).toBe("/unlocks");
  });

  test("utm-хвост из телеграма тоже не сбрасывает", () => {
    expect(sectionPath("/about?utm_source=tg&utm_campaign=x")).toBe("/about");
  });

  test("хэш отрезается вместе с query", () => {
    expect(sectionPath("/digests#top")).toBe("/digests");
    expect(sectionPath("/digests?q=a#top")).toBe("/digests");
  });
});

/**
 * Направление перехода. Нужно не глубине, а прокрутке: `App.tsx` уводил страницу
 * наверх на ЛЮБУЮ смену адреса, затирая восстановление положения, которое
 * браузер делает сам при «Назад»/«Вперёд» и после F5.
 */
describe("направление перехода", () => {
  beforeEach(() => resetNavigations());

  test("первый рендер вкладки — initial, а не переход", () => {
    const h = makeHistory();
    expect(markNavigation(h)).toBe("initial");
  });

  test("переход по ссылке — forward", () => {
    const h = makeHistory();
    markNavigation(h);
    expect(h.push("/digests")).toBe("forward");
  });

  test("«Назад» и «Вперёд» — returning, прокрутку трогать нельзя", () => {
    const h = makeHistory();
    markNavigation(h);
    h.push("/digests");
    h.push("/digest/dig-1");
    expect(h.back()).toBe("returning");
    expect(h.forward()).toBe("returning");
  });

  test("F5 — initial: положение восстанавливает браузер, не мы", () => {
    const h = makeHistory();
    markNavigation(h);
    h.push("/digests");
    expect(h.reload()).toBe("initial");
  });

  test("новый переход после возврата снова forward", () => {
    const h = makeHistory();
    markNavigation(h);
    h.push("/digests");
    h.push("/digest/dig-1");
    h.back();
    expect(h.push("/drops")).toBe("forward");
  });

  test("глубина считается ровно как раньше", () => {
    // Замок: направление добавлено к прежнему поведению, а не вместо него.
    const h = makeHistory(1);
    markNavigation(h);
    h.push("/digests");
    h.push("/digest/dig-1");
    expect(navigationDepth()).toBe(2);
    h.back();
    h.back();
    expect(navigationDepth()).toBe(0);
    expect(shouldGoBack(navigationDepth())).toBe(false);
  });
});

describe("прокрутка наверх — только на переходе вперёд", () => {
  /** Считает, увели ли страницу наверх. */
  function count(direction: Parameters<typeof scrollForNavigation>[0]): number {
    let n = 0;
    scrollForNavigation(direction, () => {
      n += 1;
    });
    return n;
  }

  test("forward — уводим", () => {
    expect(count("forward")).toBe(1);
  });

  test("returning — не трогаем: положение восстановил браузер", () => {
    expect(count("returning")).toBe(0);
  });

  test("initial — не трогаем: F5 и хэш-якорь тоже за браузером", () => {
    expect(count("initial")).toBe(0);
  });

  test("сквозной сценарий ленты: вниз по списку → карточка → «Назад»", () => {
    const h = makeHistory();
    const seen: number[] = [];
    const step = (d: Parameters<typeof scrollForNavigation>[0]) => {
      let n = 0;
      scrollForNavigation(d, () => {
        n += 1;
      });
      seen.push(n);
    };
    resetNavigations();
    step(markNavigation(h)); // initial
    step(h.push("/digests")); // forward
    step(h.push("/digest/dig-1")); // forward
    step(h.back()); // returning — сюда и уезжала прокрутка
    expect(seen).toEqual([0, 1, 1, 0]);
  });
});
