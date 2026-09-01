/**
 * Аудит 2026-08-28: промах по словарю i18n молчал на именах из прототипа.
 *
 * `t()` доставал перевод обычным `messages[key]`, то есть поиском вместе с
 * прототипом объекта. `t("constructor")`, `t("toString")`, `t("__proto__")` и
 * `t("hasOwnProperty")` находили не ключ словаря, а члена Object.prototype:
 * `!message` оказывалось ложным, и ветка с `log.warn("[i18n] missing key")` не
 * выполнялась. Наружу при этом всё равно уходил фолбэк — то есть поведение
 * совпадало с промахом, а единственный сигнал о промахе терялся.
 *
 * Ключ приходит из вызывающего кода, и этот лог — способ заметить опечатку в
 * нём. Ключей вида `error.toString` в словаре нет только сейчас; правило «имя
 * ключа не должно случайно совпасть с членом прототипа» нигде не записано.
 *
 * Заодно: `fallback || key` игнорировал пустую строку — законный фолбэк
 * «здесь не печатать ничего» подменялся служебным идентификатором ключа.
 */
import { afterAll, afterEach, describe, expect, test, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { messages, t, setLocale } from "../lib/i18n.ts";
import { log } from "../lib/log.ts";

const PROTO_KEYS = [
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
  "valueOf",
  "isPrototypeOf",
  "propertyIsEnumerable",
];

let warned: string[] = [];
const spy = spyOn(log, "warn").mockImplementation((msg: string, meta?: unknown) => {
  warned.push(`${msg} ${JSON.stringify(meta ?? null)}`);
});

afterAll(() => {
  // Логгер общий на весь прогон каталога — шпиона надо снять.
  spy.mockRestore();
});

afterEach(() => {
  warned = [];
  // Локаль живёт в модульном синглтоне: bun гоняет весь каталог одним
  // процессом, и незакрытый 'en' утёк бы в соседние файлы (CLAUDE.md §3.8 п.7).
  setLocale("ru");
});

function missWarnings(): string[] {
  return warned.filter((w) => w.includes("[i18n] missing key"));
}

describe("предпосылки", () => {
  test("словарь — обычный объект, у него есть прототип", () => {
    expect(Object.getPrototypeOf(messages)).toBe(Object.prototype);
    for (const key of PROTO_KEYS) {
      // Прежняя проверка `if (!message)` на таком значении не срабатывала.
      expect(Boolean((messages as Record<string, unknown>)[key])).toBe(true);
      expect(Object.hasOwn(messages, key)).toBe(false);
    }
  });
});

describe("имя из прототипа — это промах, и он виден", () => {
  for (const key of PROTO_KEYS) {
    test(`${key}: возвращается ключ и пишется предупреждение`, () => {
      expect(t(key)).toBe(key);
      expect(missWarnings().length).toBe(1);
      expect(missWarnings()[0]).toContain(key);
    });
  }

  test("фолбэк для такого ключа работает как для любого другого промаха", () => {
    expect(t("toString", "запасной текст")).toBe("запасной текст");
    expect(missWarnings().length).toBe(1);
  });

  test("обычный несуществующий ключ ведёт себя так же", () => {
    expect(t("нет.такого.ключа")).toBe("нет.такого.ключа");
    expect(missWarnings().length).toBe(1);
  });
});

describe("пустая строка — законный фолбэк", () => {
  test("промах с пустым фолбэком не подставляет имя ключа", () => {
    expect(t("нет.такого.ключа", "")).toBe("");
    expect(t("toString", "")).toBe("");
  });

  test("отсутствие фолбэка по-прежнему даёт ключ", () => {
    expect(t("нет.такого.ключа")).toBe("нет.такого.ключа");
  });
});

describe("настоящие ключи не задеты", () => {
  for (const key of Object.keys(messages)) {
    test(`${key} отдаёт русский текст и молчит`, () => {
      expect(t(key)).toBe(messages[key].ru);
      expect(missWarnings()).toEqual([]);
    });
  }

  test("фолбэк не перебивает существующий перевод", () => {
    const key = "characters.tone";
    expect(t(key, "запасной")).toBe(messages[key].ru);
    expect(t(key, "")).toBe(messages[key].ru);
  });

  test("переключение локали отдаёт английский текст", () => {
    setLocale("en");
    expect(t("characters.tone")).toBe(messages["characters.tone"].en);
    expect(missWarnings()).toEqual([]);
  });
});

describe("применение", () => {
  const SRC = readFileSync(new URL("../lib/i18n.ts", import.meta.url), "utf-8");
  const CODE = SRC.split("\n")
    .filter((l) => {
      const s = l.trimStart();
      return !s.startsWith("//") && !s.startsWith("*") && !s.startsWith("/*");
    })
    .join("\n");

  test("поиск идёт по собственным ключам", () => {
    expect(CODE).toContain("Object.hasOwn(messages, key)");
  });

  test("фолбэк выбирается через ??, а не через ||", () => {
    expect(CODE).toContain("return fallback ?? key;");
    expect(CODE).toContain("(fallback ?? key)");
    expect(CODE).not.toContain("fallback || key");
  });
});
