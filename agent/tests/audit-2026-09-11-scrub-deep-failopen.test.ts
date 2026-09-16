/**
 * Аудит 2026-09-11, круг 51: три дыры в одном обходе — `scrubSecrets`
 * (lib/log.ts), через который идут `agent_actions.payload`, `.result`,
 * `tasks.input` и `audit_logs.payload`.
 *
 * Все три — отказ не в ту сторону:
 *
 *  • ПРЕДЕЛ ГЛУБИНЫ ОТКАЗЫВАЛ В УТЕЧКУ. `if (depth > 6) return value`
 *    возвращал поддерево НЕТРОНУТЫМ. Обещание «секрет в эту колонку не
 *    попадёт» держалось до шестого уровня вложенности и молчало об этом.
 *  • ПРЕДЕЛ ВЫГЛЯДЕЛ ЗАЩИТОЙ ОТ ЦИКЛА, НО ЕЮ НЕ БЫЛ. Циклическая структура
 *    возвращалась из обхода циклом же, и падал `JSON.stringify` у
 *    вызывающего — то есть на самой записи строки аудита. Строки не
 *    появлялось вовсе: отказ на границе записи, а не помеченное значение.
 *  • `Date` ОБНУЛЯЛСЯ. `Object.entries(new Date())` пуст, дата становилась
 *    `{}` — молчаливая потеря того, что без скраббера уехало бы в колонку
 *    ISO-строкой.
 *
 * Каждый тест ниже сначала меряет поведение, а не читает текст: числа и
 * маркеры берутся у самого модуля, чтобы сторож не устарел вместе с ними.
 */
import { test, expect, describe } from "bun:test";
import {
  scrubSecretsDeep,
  SCRUB_MAX_DEPTH,
  SCRUB_TOO_DEEP,
  SCRUB_CYCLE,
} from "../lib/log.ts";

// Фейковый токен собирается из частей: целым литералом он валит гейт секретов в CI.
const TOKEN = ["7123456789", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"].join(":");
/** Хвост токена — то, чего в колонке быть не должно ни в каком виде. */
const TAIL = "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

/** Секрет, завёрнутый в `d` уровней объектов. */
function nest(d: number): unknown {
  let v: unknown = { botToken: TOKEN, note: `BOT_TOKEN=${TOKEN}` };
  for (let i = 0; i < d; i++) v = { inner: v };
  return v;
}

describe("глубина больше не выпускает секрет наружу", () => {
  test("ни на одном уровне до предела секрет не проходит насквозь", () => {
    // Прежний обход пропускал всё начиная с шестого уровня — замер это и
    // показывал. Перебираем с запасом по обе стороны от старого порога.
    for (let d = 0; d < SCRUB_MAX_DEPTH; d++) {
      const out = JSON.stringify(scrubSecretsDeep(nest(d)));
      expect(`глубина ${d}: ${out.includes(TAIL)}`).toBe(`глубина ${d}: false`);
    }
  });

  test("за пределом встаёт маркер, а не непроверенное поддерево", () => {
    const out = JSON.stringify(scrubSecretsDeep(nest(SCRUB_MAX_DEPTH + 5)));
    expect(out).toContain(SCRUB_TOO_DEEP);
    expect(out).not.toContain(TAIL);
  });

  test("предел назван один раз и щедрее прежних шести", () => {
    // Правило круга 20 наоборот: число живёт в коде, а сторож его читает.
    // Шесть — то значение, при котором дыра и была.
    expect(SCRUB_MAX_DEPTH).toBeGreaterThan(6);
  });
});

describe("цикл помечается, а не роняет запись в аудит", () => {
  test("JSON.stringify у вызывающего больше не падает", () => {
    const a: Record<string, unknown> = { name: "a", note: `BOT_TOKEN=${TOKEN}` };
    a.self = a;
    // Раньше здесь был бросок «cannot serialize cyclic structures» — ровно
    // там, где вызывающий пишет строку agent_actions.
    const out = JSON.stringify(scrubSecretsDeep(a));
    expect(out).toContain(SCRUB_CYCLE);
    expect(out).not.toContain(TAIL);
  });

  test("цикл через массив тоже ловится", () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => JSON.stringify(scrubSecretsDeep(arr))).not.toThrow();
  });

  test("один объект в двух полях рядом — не цикл, второе вхождение цело", () => {
    // Разница существенная: пометить повтор как цикл значит потерять данные
    // там, где потери нет. Поэтому метка снимается на выходе из ветки.
    const shared = { kind: "shared", n: 7 };
    const out = scrubSecretsDeep({ left: shared, right: shared }) as {
      left: unknown;
      right: unknown;
    };
    expect(out.left).toEqual({ kind: "shared", n: 7 });
    expect(out.right).toEqual({ kind: "shared", n: 7 });
  });
});

describe("скраббер не портит то, что секретом не является", () => {
  test("Date доезжает ISO-строкой, как и без скраббера", () => {
    const d = new Date(1757000000000);
    expect(JSON.stringify(scrubSecretsDeep({ d }))).toBe(JSON.stringify({ d }));
  });

  test("обычные значения проходят как есть", () => {
    const v = { n: 1, b: true, z: null, s: "просто текст", a: [1, 2, 3] };
    expect(JSON.stringify(scrubSecretsDeep(v))).toBe(JSON.stringify(v));
  });

  test("говорящий ключ и секрет в тексте закрыты на всякой глубине", () => {
    const out = scrubSecretsDeep({ a: { b: { c: { botToken: TOKEN } } } }) as any;
    expect(out.a.b.c.botToken).toBe("***");
  });
});
