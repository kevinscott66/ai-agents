/**
 * Аудит 2026-08-21: поле «фильтр по типу» на вкладке «Логи» слало запрос на
 * каждую букву.
 *
 * `Logs.tsx` объявляет эффект перезагрузки как `[agent, status, type]`. Первые
 * два — `<select>`, там смена дискретна. Третий — `<input>` со свободным
 * вводом, и его `onChange` пишет в состояние каждое нажатие. Тело эффекта:
 * `setItems([])`, `load(true)` и снятие с повторной установкой подписки на SSE
 * `action.executed`.
 *
 * Замерено пробой: «SEND_MESSAGE» — двенадцать букв, значит двенадцать
 * `GET /api/actions`, двенадцать пересборок подписки и двенадцать очисток
 * списка. Одиннадцать запросов из двенадцати спрашивают префикс, которого нет
 * ни у одного типа действия («S», «SE», «SEN»…). Ведро GET-лимита — capacity
 * 120, refill 4/с: одна правка фильтра съедает десятую часть ведра и
 * восстанавливается три секунды, а исправленная опечатка — ещё столько же.
 *
 * Инвариант: пока пользователь печатает, запросов нет; после паузы уходит
 * ровно один — с полным набранным значением.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDebouncer,
  INPUT_DEBOUNCE_MS,
} from "../miniapp/src/lib/debounce.ts";
import { createCoalescer } from "../miniapp/src/lib/coalesce.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WORD = "SEND_MESSAGE";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Logs.tsx"),
  "utf8",
);

describe("createDebouncer", () => {
  test("первый вызов НЕ уходит сразу — это и есть отличие от коалесера", () => {
    const d = createDebouncer(20);
    let runs = 0;
    d.schedule(() => runs++);
    expect(runs).toBe(0);
    d.cancel();
  });

  test("двенадцать нажатий — один запуск, с полным словом", async () => {
    const d = createDebouncer(20);
    const seen: string[] = [];
    for (let i = 1; i <= WORD.length; i++) {
      const value = WORD.slice(0, i);
      d.schedule(() => seen.push(value));
      await sleep(2); // беглый набор: пауза короче окна
    }
    expect(seen).toEqual([]);
    await sleep(60);
    expect(seen).toEqual([WORD]);
    d.cancel();
  });

  test("пауза длиннее окна — запуск на каждое законченное значение", async () => {
    const d = createDebouncer(20);
    const seen: string[] = [];
    d.schedule(() => seen.push("SEND"));
    await sleep(60);
    d.schedule(() => seen.push("SEND_MESSAGE"));
    await sleep(60);
    expect(seen).toEqual(["SEND", "SEND_MESSAGE"]);
    d.cancel();
  });

  test("cancel снимает отложенный запуск", async () => {
    const d = createDebouncer(20);
    let runs = 0;
    d.schedule(() => runs++);
    d.cancel();
    await sleep(60);
    expect(runs).toBe(0);
  });

  test("cancel после срабатывания ничего не ломает", async () => {
    const d = createDebouncer(20);
    let runs = 0;
    d.schedule(() => runs++);
    await sleep(60);
    d.cancel();
    await sleep(30);
    expect(runs).toBe(1);
  });

  test("окно по умолчанию заметно длиннее межбуквенного интервала", () => {
    // ~150 мс — типичный интервал беглого набора. Окно должно его перекрывать,
    // иначе debounce срабатывает посреди слова.
    expect(INPUT_DEBOUNCE_MS).toBeGreaterThan(150);
    // И оставаться ниже порога, на котором пауза читается как «подвисло».
    expect(INPUT_DEBOUNCE_MS).toBeLessThanOrEqual(500);
  });
});

describe("почему не переиспользован createCoalescer", () => {
  test("коалесер на том же вводе уходит в сеть по первой букве", async () => {
    const c = createCoalescer(20);
    const seen: string[] = [];
    for (let i = 1; i <= WORD.length; i++) {
      const value = WORD.slice(0, i);
      c.schedule(() => seen.push(value));
      await sleep(2);
    }
    // Ведущий вызов — ровно тот бессмысленный запрос по префиксу, из-за
    // которого этот аудит и появился.
    expect(seen[0]).toBe("S");
    await sleep(60);
    // И на длинном слове окно успевает открыться ещё раз посреди набора:
    // запусков больше одного, тогда как у хвостового debounce он ровно один.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(WORD);
    c.cancel();
  });
});

describe("Logs.tsx: в перезагрузку идёт отстоявшее значение", () => {
  test("эффект зависит от typeQuery, а не от сырого type", () => {
    expect(SRC).toContain("}, [agent, status, typeQuery]);");
    expect(SRC).not.toContain("}, [agent, status, type]);");
  });

  test("в запрос уходит typeQuery", () => {
    expect(SRC).toContain("type: typeQuery || undefined,");
  });

  test("поле ввода по-прежнему показывает сырое значение", () => {
    // Иначе курсор и текст «залипали» бы на треть секунды.
    expect(SRC).toContain("value={type}");
    expect(SRC).toContain("onChange={(e) => setType(e.currentTarget.value)}");
  });

  test("значение берётся через useDebouncedValue", () => {
    expect(SRC).toContain("const typeQuery = useDebouncedValue(type);");
  });
});

describe("useDebouncedValue: возврат к применённому значению", () => {
  test("отложенный запуск снимается, а не срабатывает вхолостую", () => {
    // Набрал лишнюю букву и стёр её — перезагружать не на что.
    const HOOK = readFileSync(
      join(import.meta.dir, "..", "miniapp", "src", "lib", "debounce.ts"),
      "utf8",
    );
    expect(HOOK).toContain("if (value === settled) {");
    expect(HOOK).toContain("deb.cancel();");
  });
});
