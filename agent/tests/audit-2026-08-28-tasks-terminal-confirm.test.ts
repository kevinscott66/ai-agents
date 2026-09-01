/**
 * Аудит 2026-08-28: необратимое закрытие задачи шло с одного тапа.
 *
 * В FSM терминальны три статуса — `done: []`, `failed: []`, `cancelled: []`
 * (lib/task-fsm.ts). Обратной дороги нет ни из одного: попавшая туда задача
 * закрыта навсегда, `UPDATE_TASK_STATUS` из неё отвечает
 * `invalid status transition`.
 *
 * Подтверждение при этом стояло ровно на одном из трёх. `⊘` (cancelled) в
 * списке спрашивал, а соседние `✓` (done) и `✗` (failed) — нет, при том что
 * это три кнопки подряд в одной строке списка на телефоне. Промах пальцем в
 * `✓` закрывал чужую задачу выполненной без единого вопроса и без undo.
 *
 * В карточке не спрашивала ни одна кнопка: `onClick={() =>
 * changeStatus(selected.id, next)}` — то есть один и тот же переход
 * спрашивал в списке и молчал в карточке.
 *
 * Инвариант тот же, что вывел аудит 2026-08-10 на аппрувах
 * (`miniapp-approve-confirm.test.ts`): необратимое действие защищено не слабее
 * обратимого. Признак «нужно спросить» выводится из самой FSM
 * (`NEXT_STATUS[next].length === 0`), а не из флажка рядом с кнопкой: новый
 * терминальный статус подхватит защиту сам, а появившийся выход из `failed`
 * снимет её сам.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confirmStatusText, isTerminalStatus } from "../miniapp/src/pages/Tasks.tsx";
import { TASK_TRANSITIONS } from "../lib/task-fsm.ts";
import { ELLIPSIS } from "../miniapp/src/lib/text.ts";
import { TASK_STATUS_LABELS } from "../miniapp/src/lib/labels.ts";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Tasks.tsx"),
  "utf8",
);

describe("предпосылки", () => {
  test("все три исхода закрытия необратимы одинаково", () => {
    expect(TASK_TRANSITIONS.done).toEqual([]);
    expect(TASK_TRANSITIONS.failed).toEqual([]);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
  });

  test("быстрые кнопки стоят подряд в одной строке — промах реален", () => {
    const row = SRC.slice(SRC.indexOf("const QUICK_ACTIONS"), SRC.indexOf("export default function"));
    for (const s of ["done", "failed", "cancelled"]) expect(row).toContain(`status: "${s}"`);
    expect(SRC).toContain('<div className="task-actions">');
  });
});

describe("isTerminalStatus", () => {
  test("терминальные статусы опознаны", () => {
    for (const s of ["done", "failed", "cancelled"] as const) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  test("рабочие статусы — нет", () => {
    for (const s of ["pending", "running", "awaiting_approval", "awaiting_review"] as const) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });

  test("признак берётся из FSM, а не из копии списка", () => {
    // Иначе новый терминальный статус приедет без подтверждения.
    for (const [s, next] of Object.entries(TASK_TRANSITIONS)) {
      expect(isTerminalStatus(s as never)).toBe(next.length === 0);
    }
  });
});

describe("confirmStatusText", () => {
  test("необратимый переход спрашивает, и в вопросе названы задача и исход", () => {
    const text = confirmStatusText("Починить деплой", "done");
    expect(text).toContain("Починить деплой");
    expect(text).toContain(TASK_STATUS_LABELS.done);
  });

  test("вопрос говорит, что дороги назад нет", () => {
    // Иначе подтверждение вырождается в лишний тап, который жмут не глядя.
    const text = confirmStatusText("t", "failed") ?? "";
    expect(text.toLowerCase()).toContain("нельзя");
  });

  test("все три исхода закрытия спрашивают одинаково", () => {
    for (const s of ["done", "failed", "cancelled"] as const) {
      expect(confirmStatusText("t", s)).not.toBeNull();
    }
  });

  test("обратимый переход не спрашивает", () => {
    for (const s of ["running", "awaiting_approval", "awaiting_review", "pending"] as const) {
      expect(confirmStatusText("t", s)).toBeNull();
    }
  });

  test("длинное название режется общим ellipsize, а не руками", () => {
    const text = confirmStatusText("я".repeat(400), "done") ?? "";
    expect(text).toContain(ELLIPSIS);
    expect(text).not.toContain("я".repeat(200));
  });
});

describe("применение", () => {
  test("быстрые кнопки спрашивают по признаку статуса, а не по флажку", () => {
    expect(SRC).toContain("confirmStatusText(");
    expect(SRC).not.toContain("confirm: false");
    expect(SRC).not.toContain("qa.confirm");
  });

  test("кнопки карточки больше не зовут changeStatus напрямую", () => {
    // Прежняя форма: один и тот же переход спрашивал в списке и молчал тут.
    expect(SRC).not.toContain("onClick={() => changeStatus(selected.id, next)}");
    expect(SRC).toContain("requestStatus(selected, next)");
  });

  test("подтверждение — одно на обе точки входа", () => {
    // Две копии window.confirm разъедутся так же, как разъехались флажки.
    expect(SRC.split("window.confirm(").length - 1).toBe(1);
  });
});
