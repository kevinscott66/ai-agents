/**
 * Аудит 2026-08-20 — `/metrics` объявлял оконные величины монотонными счётчиками.
 *
 * `agent_actions_total` считает действия за последние 24 часа, `messages_total` —
 * строки в `messages`, которую db-maint каждую ночь подрезает в архив. Обе
 * величины УМЕНЬШАЮТСЯ, а объявлены были как `# TYPE … counter` и с суффиксом
 * `_total`. Для Prometheus падение counter'а — это рестарт процесса, и
 * `increase()` дорисовывает разницу от нуля: график активности показывал бы
 * всплеск ровно там, где активности стало меньше.
 *
 * Тест пинит и тип, и имя: суффикс `_total` — это и есть та пометка, по которой
 * человек строит `rate()`, поэтому одного `# TYPE gauge` мало.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_audit_0820_metrics";

import { describe, test, expect } from "bun:test";
import { renderMetrics } from "../lib/miniapp-metrics.ts";

/** Тип метрики из `# TYPE <name> <type>`. */
function typeOf(out: string, name: string): string | null {
  const m = out.match(new RegExp(`^# TYPE ${name} (\\w+)$`, "m"));
  return m ? m[1] : null;
}

/** Все имена метрик, встреченные в выводе. */
function names(out: string): string[] {
  return [...out.matchAll(/^# TYPE (\S+) /gmu)].map((m) => m[1]);
}

describe("аудит 2026-08-20: оконные метрики — gauge, не counter", () => {
  test("действия за 24ч — gauge", () => {
    expect(typeOf(renderMetrics(), "agent_actions_recent")).toBe("gauge");
  });

  test("строки в messages — gauge", () => {
    expect(typeOf(renderMetrics(), "messages_stored")).toBe("gauge");
  });

  test("старые имена с суффиксом _total больше не выдаются", () => {
    const out = renderMetrics();
    expect(out).not.toContain("agent_actions_total");
    expect(out).not.toContain("messages_total");
  });

  test("ни одна метрика с суффиксом _total не осталась counter'ом по ошибке", () => {
    const out = renderMetrics();
    for (const name of names(out)) {
      if (!name.endsWith("_total")) continue;
      // Суффикс `_total` в Prometheus зарезервирован за монотонными счётчиками.
      // Если такая метрика появится — она обязана быть counter'ом ПО СУЩЕСТВУ,
      // а не просто по объявлению; тест ловит новые оконные величины с этим
      // суффиксом на этапе ревью.
      expect(typeOf(out, name)).toBe("counter");
    }
  });

  test("HELP оконных метрик прямо говорит, что это не total", () => {
    const out = renderMetrics();
    expect(out).toMatch(/^# HELP agent_actions_recent .*(?:window|24h)/mu);
    expect(out).toMatch(/^# HELP messages_stored .*archive/mu);
  });

  test("остальные gauge на месте — переименование ничего не снесло", () => {
    const out = renderMetrics();
    expect(typeOf(out, "agent_team_build_info")).toBe("gauge");
    expect(typeOf(out, "mac_bridge_connected")).toBe("gauge");
    expect(typeOf(out, "tasks_open")).toBe("gauge");
    expect(typeOf(out, "approvals_pending")).toBe("gauge");
  });

  test("формат не сломан: у каждого TYPE есть HELP и хотя бы одна строка", () => {
    const out = renderMetrics();
    for (const name of names(out)) {
      expect(out).toContain(`# HELP ${name} `);
      expect(out).toMatch(new RegExp(`^${name}(\\{[^}]*\\})? -?\\d`, "m"));
    }
  });

  test("значения метрик — конечные числа, не NaN", () => {
    const out = renderMetrics();
    const vals = [...out.matchAll(/^\S+(?:\{[^}]*\})? (\S+)$/gmu)].map((m) => Number(m[1]));
    expect(vals.length).toBeGreaterThan(0);
    for (const v of vals) expect(Number.isFinite(v)).toBe(true);
  });
});
