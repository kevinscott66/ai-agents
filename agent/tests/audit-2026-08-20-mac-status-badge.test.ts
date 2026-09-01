// Аудит 2026-08-20: значок статуса на вкладке Mac.
//
// Два дефекта в одной функции `getStatusBadge` (miniapp/src/pages/Mac.tsx):
//
// 1. Подпись — сырой английский ключ (`running` / `completed` / `failed`)
//    посреди полностью русского интерфейса. Файл при этом импортировал
//    `ACTION_STATUS_LABELS` и `label` и НЕ вызывал их ни разу: локализацию
//    начали и бросили. Тот же класс, что чинил PR #543.
//
// 2. `styles[status] || styles.running` — неизвестный статус красился в синий
//    «выполняется». Цвет говорил одно, текст другое, причём цвет утверждал
//    самое дорогое: что сессия ещё жива.
//
// Попутно — контраст. Все три цвета стояли под белым текстом и ни один не брал
// порог WCAG AA 4.5:1 для обычного текста (12px/500): синий 3.15, красный
// 3.82, зелёный вообще 2.10. Порог проверяется здесь, а не подбирается на
// глаз, — иначе следующая правка палитры молча вернёт то же самое.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import {
  macStatusBadge,
  toMacSession,
  type MacSession,
} from "../miniapp/src/lib/mac-session.ts";
import type { AgentAction } from "../lib/audit.ts";

const RAW = readFileSync(
  new URL("../miniapp/src/pages/Mac.tsx", import.meta.url),
  "utf8",
);
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ALL: MacSession["status"][] = ["running", "completed", "failed"];

/** Относительная яркость по WCAG 2.1 (§ relative luminance). */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("macStatusBadge — подпись", () => {
  test("все подписи по-русски, без латиницы", () => {
    for (const s of ALL) {
      expect(macStatusBadge(s).text).not.toMatch(/[A-Za-z]/);
      expect(macStatusBadge(s).text.length).toBeGreaterThan(0);
    }
  });

  test("три статуса — три разные подписи", () => {
    const texts = ALL.map((s) => macStatusBadge(s).text);
    expect(new Set(texts).size).toBe(ALL.length);
  });

  test("подписи закреплены", () => {
    expect(macStatusBadge("running").text).toBe("выполняется");
    expect(macStatusBadge("completed").text).toBe("завершена");
    expect(macStatusBadge("failed").text).toBe("ошибка");
  });
});

describe("macStatusBadge — цвет", () => {
  test("каждый вариант берёт порог WCAG AA 4.5:1", () => {
    for (const s of ALL) {
      const b = macStatusBadge(s);
      expect(contrast(b.background, b.color)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("три статуса — три разных фона", () => {
    const bgs = ALL.map((s) => macStatusBadge(s).background);
    expect(new Set(bgs).size).toBe(ALL.length);
  });

  test("цвета — валидный шестизначный hex", () => {
    for (const s of ALL) {
      const b = macStatusBadge(s);
      expect(b.background).toMatch(/^#[0-9a-f]{6}$/);
      expect(b.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("macStatusBadge — неизвестный статус", () => {
  const unknown = macStatusBadge("weird" as MacSession["status"]);

  test("не выдаётся за «выполняется» — ни цветом, ни текстом", () => {
    expect(unknown.background).not.toBe(macStatusBadge("running").background);
    expect(unknown.text).not.toBe(macStatusBadge("running").text);
  });

  test("показывает сам ключ, а не выдумывает статус", () => {
    expect(unknown.text).toBe("weird");
  });

  test("контраст держит и он", () => {
    expect(contrast(unknown.background, unknown.color)).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});

describe("покрытие вокабуляра", () => {
  // Шесть значений ActionStatus (lib/audit.ts). Mac.tsx отсеивает три
  // «не-исполнения», остальные проходят через toMacSession — и каждый
  // получившийся статус обязан иметь русскую подпись.
  const ACTION_STATUSES = [
    "attempted",
    "ok",
    "error",
    "forbidden",
    "pending_approval",
    "rate_limited",
  ];

  test("любой статус действия даёт значок с русской подписью", () => {
    for (const status of ACTION_STATUSES) {
      const action = {
        id: "a1",
        status,
        created_at: 0,
        payload: { project: "p", mode: "ask", prompt: "x" },
        result: null,
      } as unknown as AgentAction;
      const badge = macStatusBadge(toMacSession(action).status);
      expect(badge.text).not.toMatch(/[A-Za-z]/);
      expect(contrast(badge.background, badge.color)).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});

describe("Mac.tsx — разметка", () => {
  test("значок берёт вид из macStatusBadge", () => {
    expect(SRC).toMatch(/macStatusBadge\(\s*status\s*\)/);
  });

  test("подставного фолбэка на «running» не осталось", () => {
    expect(SRC).not.toMatch(/\|\|\s*styles\.running/);
    expect(SRC).not.toMatch(/const\s+styles\s*=\s*\{/);
  });

  test("в значок печатается подпись, а не сырой ключ", () => {
    const badge = SRC.match(/<span[\s\S]*?<\/span>/);
    expect(badge).not.toBeNull();
    expect(badge![0]).toMatch(/\{\s*badge\.text\s*\}/);
    expect(badge![0]).not.toMatch(/\{\s*status\s*\}/);
  });

  test("брошенный импорт локализации убран", () => {
    expect(SRC).not.toMatch(/ACTION_STATUS_LABELS/);
  });
});
