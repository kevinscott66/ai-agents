/**
 * Аудит 2026-09-10: два шаблона из девяти нельзя было выбрать словами, которые
 * им же и приписаны.
 *
 * `selectTemplate` (lib/designer/svg-templates.ts) идёт по `SVG_TEMPLATES` по
 * порядку и возвращает первый шаблон, чьё ключевое слово нашлось в запросе.
 * Пять ключей были записаны сразу двум шаблонам — и второй из пары не
 * выбирался ни при каком запросе:
 *
 *   dashboard, metrics          → infographic перекрывал status-dashboard
 *   data, analytics, statistics → infographic перекрывал simple-chart
 *
 * «Нарисуй dashboard» приносило инфографику при живом `status-dashboard.svg`.
 * Молча: перекрытие видно только если разложить два списка рядом.
 *
 * Второй дефект той же функции — сравнение подстрокой. `app` (ui-mockup) сидит
 * внутри `happy`, `ops` — внутри `develops`, `post` — внутри `postpone`.
 *
 * Модуль ни откуда не вызывается (см. его шапку) — это готовая дизайнерская
 * работа, ждущая проводки. Дефект чинится здесь по той же причине, что и
 * экранирование 2026-08-11: иначе он достанется тому, кто будет проводить, уже
 * в виде «шаблон есть, а не выбирается».
 */
import { describe, expect, test } from "bun:test";
import {
  SVG_TEMPLATES,
  selectTemplate,
} from "../lib/designer/svg-templates.ts";

describe("ключевые слова шаблонов не пересекаются", () => {
  test("каждый ключ принадлежит ровно одному шаблону", () => {
    const owner = new Map<string, string>();
    const collisions: string[] = [];
    for (const t of SVG_TEMPLATES) {
      for (const k of t.keywords) {
        const prev = owner.get(k);
        if (prev) collisions.push(`${k}: ${prev} перекрывает ${t.id}`);
        else owner.set(k, t.id);
      }
    }
    expect(collisions).toEqual([]);
  });

  test("каждый шаблон достижим хотя бы одним своим ключом", () => {
    const unreachable = SVG_TEMPLATES.filter(
      (t) => !t.keywords.some((k) => selectTemplate(k).id === t.id),
    ).map((t) => t.id);
    expect(unreachable).toEqual([]);
  });
});

describe("выбор идёт по слову, а не по подстроке", () => {
  test("dashboard приносит дашборд, а не инфографику", () => {
    expect(selectTemplate("нарисуй dashboard").id).toBe("status-dashboard");
    expect(selectTemplate("status dashboard for prod").id).toBe(
      "status-dashboard",
    );
  });

  test("прежние владельцы спорных ключей не изменились", () => {
    for (const k of ["data", "analytics", "statistics", "metrics"]) {
      expect(selectTemplate(`нужен ${k} блок`).id).toBe("infographic");
    }
  });

  test("ключ внутри чужого слова больше не срабатывает", () => {
    // `app` (ui-mockup) внутри `happy`; social-post стоит в списке ПОЗЖЕ, то
    // есть до правки ui-mockup выигрывал этот запрос.
    expect(selectTemplate("happy new year post").id).toBe("social-post");
    // `ops` (status-dashboard) внутри `develops`; шаблон-победитель здесь —
    // presentation-slide по слову `business`.
    expect(selectTemplate("how the business develops").id).toBe(
      "presentation-slide",
    );
  });

  test("множественное число по-прежнему попадает", () => {
    expect(selectTemplate("нужны charts").id).toBe("simple-chart");
    expect(selectTemplate("статус services").id).toBe("status-dashboard");
  });

  test("неизвестный запрос по-прежнему падает в шаблон по умолчанию", () => {
    expect(selectTemplate("совершенно неизвестный сюжет")).toBe(
      SVG_TEMPLATES[0],
    );
  });
});
