/**
 * Аудит 2026-08-28: исходы гейта считались поломкой делегирования.
 *
 * `DELEGATION_REFUSALS` перечислял отказы уровня самой воронки (цикл, сам
 * себе, остановленные политикой кандидаты, `delegate_skipped:`) — и ни одного
 * исхода ГЕЙТА. А фан-аут SPLIT_TASK ходит через `gateOrDispatch`, то есть
 * ровно эти исходы и получает: `gateRefusalText` (action-dispatch.ts)
 * склеивает `forbidden:`, `pending_approval:` и `rate_limited:`, а исход
 * делегирования с этим текстом уезжает в `foldFanoutOutcomes`
 * (lib/dispatch/split-fanout.ts), где и становится строкой `<role>: <текст>`.
 * Круг 31: сборка сегмента переехала туда из диспетчера, и сторож ниже
 * переехал за ней — сторож, отвечающий про НЕ ТОТ файл, хуже отсутствующего.
 *
 * Больнее всего `pending_approval:`. При `autonomy=manual` его возвращает
 * КАЖДОЕ делегирование: DELEGATE_TO_ROLE не входит в LOW_FRICTION_ACTIONS, а
 * ветка `manual` отвечает approval безусловно (permissions.ts:929). Значит
 * `childIds` остаётся пустым, сплит отвечает `split failed: no roles accepted
 * the task (…)`, `isByDesignRefusal` говорит «поломка» — и на КАЖДЫЙ сплит на
 * доску падали две задачи с просьбой починить сработавший гейт (C15 на роль +
 * `[diagnostic] unknown: SPLIT_TASK` на orchestrator). Обе висят до gc_stale.
 *
 * Под `semi_auto` то же самое с `forbidden:`, и там оно ещё и уезжало на perm:
 * `categorizeError` видит «forbidden» и раскладывает в permission_denied.
 *
 * Отдельно — прямое делегирование под отменённого родителя
 * (отказ `parent task is cancelled` в action-dispatch.ts). Текст сам
 * объясняет агенту, что делать вместо этого; чинить в нём нечего.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DELEGATION_REFUSALS,
  isByDesignRefusal,
  joinDelegationErrors,
  shouldSkipSelfDiag,
} from "../lib/diagnostic.ts";
import { LOW_FRICTION_ACTIONS } from "../lib/permissions.ts";

const DISPATCH_SRC = readFileSync(
  new URL("../lib/action-dispatch.ts", import.meta.url),
  "utf8",
);
const FANOUT_SRC = readFileSync(
  new URL("../lib/dispatch/split-fanout.ts", import.meta.url),
  "utf8",
);
const PERM_SRC = readFileSync(new URL("../lib/permissions.ts", import.meta.url), "utf8");

const split = (...reasons: string[]) =>
  `split failed: no roles accepted the task (${reasons.join("; ")})`;

describe("предпосылки: эти тексты действительно приезжают в errors", () => {
  test("gateRefusalText производит ровно три префикса исходов гейта", () => {
    expect(DISPATCH_SRC).toContain("return `forbidden: ${r.reason}`;");
    expect(DISPATCH_SRC).toContain("return `pending_approval: ${r.reason}`;");
    expect(DISPATCH_SRC).toContain("return `rate_limited: ${r.reason}`;");
  });

  test("фан-аут сплита кладёт их в errors как `<role>: <текст>`", () => {
    // Две половины одной дороги. Диспетчер отдаёт текст гейта исходом...
    expect(DISPATCH_SRC).toContain("{ role, refusal: gateRefusalText(r) }");
    // ...а сегмент из него собирает fold — там же, где живут остальные исходы.
    expect(FANOUT_SRC).toContain("errors.push(`${o.role}: ${o.refusal}`);");
  });

  test("под manual одобрения требует каждое делегирование", () => {
    // Две половины: DELEGATE_TO_ROLE не проскакивает мимо режимных веток...
    expect(LOW_FRICTION_ACTIONS.has("DELEGATE_TO_ROLE")).toBe(false);
    // ...а ветка manual отвечает approval без всяких условий.
    expect(PERM_SRC).toContain('if (mode === "manual") {\n    return { decision: "approval", reason: "manual mode" };');
  });

  test("отказ под отменённым родителем существует", () => {
    expect(DISPATCH_SRC).toContain("error: `parent task is cancelled: ${parentId}.");
  });
});

describe("исходы гейта — не поломка", () => {
  test("manual: сплит целиком ушёл на одобрение", () => {
    const err = split("backend: pending_approval: manual mode", "frontend: pending_approval: manual mode");
    expect(isByDesignRefusal(err)).toBe(true);
    expect(shouldSkipSelfDiag("SPLIT_TASK", err)).toBe(true);
  });

  test("semi_auto: роли отказано по правам", () => {
    const err = split("qa: forbidden: caller not allowed", "smm: forbidden: no permission row");
    expect(shouldSkipSelfDiag("SPLIT_TASK", err)).toBe(true);
  });

  test("упёрлись в лимит — тоже «не сейчас»", () => {
    const err = split("backend: rate_limited: per-chat limit");
    expect(shouldSkipSelfDiag("SPLIT_TASK", err)).toBe(true);
  });

  test("смесь исходов гейта со старыми отказами", () => {
    const err = split(
      "backend: pending_approval: manual mode",
      "aieng: cannot delegate to self",
      "qa: rate_limited: per-agent limit",
    );
    expect(shouldSkipSelfDiag("SPLIT_TASK", err)).toBe(true);
  });

  test("прямое делегирование под отменённого родителя", () => {
    const err =
      "parent task is cancelled: t-42. Отменённую задачу не переоткрывают подзадачей — создай новую задачу или попроси владельца снять отмену.";
    expect(shouldSkipSelfDiag("DELEGATE_TO_ROLE", err)).toBe(true);
  });
});

describe("настоящие поломки по-прежнему заводят диагностику", () => {
  test("одна поломка среди одобрений перевешивает", () => {
    const err = split(
      "backend: pending_approval: manual mode",
      "frontend: no resolveAgent in dispatch ctx",
    );
    expect(isByDesignRefusal(err)).toBe(false);
    expect(shouldSkipSelfDiag("SPLIT_TASK", err)).toBe(false);
  });

  test("висячая ссылка на родителя — это поломка, а не отказ", () => {
    // Соседний текст к «отменён», и разница принципиальная: отменённая задача
    // есть, а ненайденной нет.
    expect(shouldSkipSelfDiag("DELEGATE_TO_ROLE", "parent task not found: t-42")).toBe(false);
  });

  test("мёртвый бот и ошибки проводки", () => {
    for (const e of [
      "target agent not found: backend",
      "no handoffDeps in dispatch ctx",
      "backend: delegate_failed: timeout",
    ]) {
      expect(shouldSkipSelfDiag("DELEGATE_TO_ROLE", e)).toBe(false);
    }
  });

  test("недоступность по здоровью — без маркера политики — поломка", () => {
    expect(shouldSkipSelfDiag("SPLIT_TASK", split("backend: no_available_agent"))).toBe(false);
  });
});

describe("обрезка сводки", () => {
  test("поломка выживает среди двух десятков одобрений", () => {
    const segs = [
      ...Array.from({ length: 20 }, (_, i) => `role${i}: pending_approval: manual mode`),
      "frontend: no resolveAgent in dispatch ctx",
    ];
    const out = joinDelegationErrors(segs, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain("no resolveAgent in dispatch ctx");
    // Вердикт по обрезанному совпадает с вердиктом по полному — тот самый
    // инвариант, ради которого писалась обрезка по границам сегментов.
    expect(isByDesignRefusal(split(...segs))).toBe(false);
    expect(isByDesignRefusal(split(out))).toBe(false);
  });

  test("сводка из одних одобрений остаётся отказом и после обрезки", () => {
    const segs = Array.from({ length: 30 }, (_, i) => `role${i}: pending_approval: manual mode`);
    const out = joinDelegationErrors(segs, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(isByDesignRefusal(split(out))).toBe(true);
  });
});

describe("список", () => {
  test("исходы гейта перечислены явно", () => {
    for (const s of ["pending_approval:", "rate_limited:", "forbidden:", "parent task is cancelled:"]) {
      expect(DELEGATION_REFUSALS).toContain(s);
    }
  });
});
