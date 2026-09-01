/**
 * Аудит 2026-08-11: навигация по табам с клавиатуры застревала после первого шага.
 *
 * Таб-бар сделан по roving tabindex: фокусируемая кнопка ровно одна
 * (`tabIndex={tab === t.key ? 0 : -1}`), остальные из tab-порядка исключены.
 * Такой паттерн работает только если обработчик стрелки ПЕРЕНОСИТ фокус DOM на
 * новую кнопку. Обработчик же менял только состояние `tab`.
 *
 * В результате фокус оставался на изначально нажатой кнопке, `currentIndex`
 * снова вычислялся из её же `t.key`, и второе нажатие стрелки звало setTab с
 * уже выбранным значением: `nextIndex !== currentIndex` больше не выполнялось
 * ни разу. Пройти с клавиатуры дальше соседней вкладки было нельзя, а фокус
 * висел на кнопке с `tabIndex={-1}` — то есть следующий Tab уводил из таб-бара.
 *
 * Здесь проверяется арифметика перехода (вынесена в чистую функцию) и то, что
 * страница действительно двигает фокус, а не только состояние.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { nextTabIndex } from "../miniapp/src/lib/tabnav.ts";

const TOTAL = 9; // столько вкладок в App.tsx на момент написания

describe("nextTabIndex — арифметика перехода по стрелкам", () => {
  test("вправо/вниз двигают на следующую", () => {
    expect(nextTabIndex("ArrowRight", 0, TOTAL)).toBe(1);
    expect(nextTabIndex("ArrowDown", 3, TOTAL)).toBe(4);
  });

  test("влево/вверх двигают на предыдущую", () => {
    expect(nextTabIndex("ArrowLeft", 4, TOTAL)).toBe(3);
    expect(nextTabIndex("ArrowUp", 1, TOTAL)).toBe(0);
  });

  test("список закольцован в обе стороны", () => {
    expect(nextTabIndex("ArrowRight", TOTAL - 1, TOTAL)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, TOTAL)).toBe(TOTAL - 1);
  });

  test("остальные клавиши не двигают выделение", () => {
    for (const k of ["Enter", " ", "Escape", "a", "Tab", "PageDown"]) {
      expect(nextTabIndex(k, 2, TOTAL)).toBe(2);
    }
  });

  test("подряд идущие шаги проходят весь список, а не застревают", () => {
    // Ровно тот сценарий, который был сломан: девять нажатий вправо должны
    // вернуть в начало, побывав на каждой вкладке по разу.
    let i = 0;
    const seen: number[] = [i];
    for (let n = 0; n < TOTAL - 1; n++) {
      i = nextTabIndex("ArrowRight", i, TOTAL);
      seen.push(i);
    }
    expect(new Set(seen).size).toBe(TOTAL);
    expect(nextTabIndex("ArrowRight", i, TOTAL)).toBe(0);
  });

  test("мусорный индекс не выкидывает за границы", () => {
    // findIndex отдаёт -1, если вкладку не нашли: считаем текущей первую и
    // дальше двигаемся как обычно, но никогда не выходим за [0, TOTAL).
    for (const bad of [-1, TOTAL, TOTAL + 5, 1.5, NaN]) {
      for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Enter"]) {
        const r = nextTabIndex(key, bad, TOTAL);
        expect(Number.isInteger(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(TOTAL);
      }
    }
    expect(nextTabIndex("ArrowRight", -1, TOTAL)).toBe(1);
    expect(nextTabIndex("ArrowLeft", -1, TOTAL)).toBe(TOTAL - 1);
    expect(nextTabIndex("ArrowRight", 0, 0)).toBe(0);
  });
});

describe("App.tsx — таб-бар двигает фокус, а не только состояние", () => {
  let src = "";

  // Чтение — в beforeAll, а не отдельным тестом: `bun test --randomize`
  // перемешивает тесты и ВНУТРИ файла, и при неудачном порядке проверки ниже
  // получали пустую строку («expected to contain … received: ""»). Тест,
  // который готовит состояние для соседей, — это фикстура, а не тест. T-751.
  beforeAll(async () => {
    src = await Bun.file(
      new URL("../miniapp/src/App.tsx", import.meta.url),
    ).text();
    expect(src.length).toBeGreaterThan(0);
  });

  test("арифметика перехода берётся из tabnav, а не пишется в JSX", () => {
    expect(src).toContain('from "./lib/tabnav"');
    expect(src).toContain("nextTabIndex(");
    expect(src).not.toContain("(currentIndex + 1) % TABS.length");
  });

  test("эффект на смену вкладки переносит фокус DOM", () => {
    const effect = src.slice(src.indexOf("scrollIntoView"));
    const body = effect.slice(0, effect.indexOf("}, [tab]);"));
    expect(body).toContain("focus(");
    // Фокус нельзя воровать при клике мышью или на старте — только когда он
    // уже внутри таб-бара.
    expect(body).toContain("activeElement");
  });

  test("параметр колбэка не затеняет состояние tab", () => {
    expect(src).not.toContain("TABS.findIndex(tab =>");
    expect(src).not.toContain("TABS.findIndex((tab)");
  });
});
