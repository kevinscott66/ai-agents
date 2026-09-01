/**
 * Проверка-и-запись по статусу задачи (аудит 2026-08-29).
 *
 * `updateTaskStatus` читает текущий статус, сверяет переход с FSM и только
 * потом пишет — а искал строку UPDATE по одному `id`. Между чтением и записью
 * статус успевает сменить кто угодно из пишущих в ту же БД мимо этой функции:
 * подметание брошенных аренд в `role-runtime`, восстановление `self-diag`,
 * `gcStaleTasks`, соседний диспетчер. Проигравший гонку накладывался поверх и
 * получал в ответ успех — то есть в истории задачи оставался переход, которого
 * её собственная машина не допускает (`failed → done`).
 *
 * Та же форма была у четырёх UPDATE'ов санитара в `self-diag`: он выбирает
 * строки `status='running'`, а пишет по `id`. Задача, которую за это время
 * успели закрыть штатно, откатывалась в `pending` или переписывалась на
 * `failed` поверх честного `done`.
 *
 * Тесты воспроизводят гонку детерминированно: `spyOn(db, "prepare")` ловит
 * момент, когда UPDATE уже собран, но ещё не выполнен, и вклинивает туда
 * чужую запись — ровно то окно, которое в проде занимает планировщик.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, getTask, updateTaskStatus } from "../lib/tasks.ts";
import {
  recoverStrandedDiagTasks,
  SELF_DIAG_STRANDED_MS,
} from "../lib/self-diag.ts";

const CHAT = -99884;

/** Сажает чужую запись ровно между сборкой UPDATE'а и его выполнением. */
function raceOn(
  match: (sql: string) => boolean,
  intruder: (orig: typeof db.prepare) => void,
) {
  const orig = db.prepare.bind(db);
  const spy = spyOn(db, "prepare");
  let fired = false;
  spy.mockImplementation(((sql: string) => {
    if (!fired && match(sql)) {
      fired = true;
      intruder(orig as typeof db.prepare);
    }
    return orig(sql);
  }) as never);
  return {
    get fired() {
      return fired;
    },
    restore: () => spy.mockRestore(),
  };
}

function mkTask(payload: unknown, assignedTo?: string) {
  return createTask({
    chatId: CHAT,
    createdBy: "orchestrator",
    assignedTo: assignedTo ?? null,
    title: "гонка по статусу",
    inputPayload: payload,
  });
}

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});
afterEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});

describe("updateTaskStatus не пишет поверх статуса, изменившегося после чтения", () => {
  test("гонка running → failed не даёт совершить failed → done", () => {
    const t = updateTaskStatus(mkTask({ kind: "race" }).id, "running");
    const race = raceOn(
      (sql) => sql.startsWith("UPDATE tasks SET status = ?"),
      (orig) => {
        orig(`UPDATE tasks SET status='failed', updated_at=? WHERE id=?`).run(
          Date.now(),
          t.id,
        );
      },
    );
    try {
      expect(() => updateTaskStatus(t.id, "done")).toThrow(
        /invalid status transition/,
      );
    } finally {
      race.restore();
    }
    expect(race.fired).toBe(true);
    // Терминальный статус, выставленный победителем гонки, уцелел.
    expect(getTask(t.id)?.status).toBe("failed");
  });

  test("текст ошибки называет статус, который на самом деле в строке", () => {
    const t = updateTaskStatus(mkTask({ kind: "race" }).id, "running");
    const race = raceOn(
      (sql) => sql.startsWith("UPDATE tasks SET status = ?"),
      (orig) => {
        orig(`UPDATE tasks SET status='done', updated_at=? WHERE id=?`).run(
          Date.now(),
          t.id,
        );
      },
    );
    try {
      expect(() => updateTaskStatus(t.id, "failed")).toThrow(/done → failed/);
    } finally {
      race.restore();
    }
    expect(getTask(t.id)?.status).toBe("done");
  });

  test("исчезнувшая строка тоже не молчит", () => {
    const t = updateTaskStatus(mkTask({ kind: "race" }).id, "running");
    const race = raceOn(
      (sql) => sql.startsWith("UPDATE tasks SET status = ?"),
      (orig) => {
        orig(`DELETE FROM tasks WHERE id=?`).run(t.id);
      },
    );
    try {
      expect(() => updateTaskStatus(t.id, "done")).toThrow(
        /invalid status transition/,
      );
    } finally {
      race.restore();
    }
    expect(getTask(t.id)).toBeNull();
  });

  test("без гонки переход проходит и статус меняется", () => {
    const t = updateTaskStatus(mkTask({ kind: "race" }).id, "running");
    const done = updateTaskStatus(t.id, "done", { output: { ok: true } });
    expect(done.status).toBe("done");
    expect(getTask(t.id)?.status).toBe("done");
  });
});

describe("санитар self-diag не откатывает статус, изменившийся после выборки", () => {
  const NOW = Date.now();
  const STALE = NOW - SELF_DIAG_STRANDED_MS - 60_000;

  function mkStranded(payload: Record<string, unknown>) {
    const t = updateTaskStatus(mkTask(payload, "aieng").id, "running");
    db.prepare(`UPDATE tasks SET updated_at=? WHERE id=?`).run(STALE, t.id);
    return t;
  }

  test("возврат в pending не перезаписывает уже закрытую задачу", () => {
    const t = mkStranded({ _diag: true, actionType: "SEND_MESSAGE" });
    const race = raceOn(
      (sql) => sql.includes("UPDATE tasks SET status='pending'"),
      (orig) => {
        orig(`UPDATE tasks SET status='done', updated_at=? WHERE id=?`).run(
          NOW,
          t.id,
        );
      },
    );
    try {
      recoverStrandedDiagTasks({ now: NOW });
    } finally {
      race.restore();
    }
    expect(race.fired).toBe(true);
    expect(getTask(t.id)?.status).toBe("done");
  });

  test("закрытие по счётчику рестартов не перезаписывает победителя гонки", () => {
    const t = mkStranded({
      _diag: true,
      actionType: "SEND_MESSAGE",
      _diag_restarts: 1,
    });
    const race = raceOn(
      (sql) => sql.includes("UPDATE tasks SET status='failed'"),
      (orig) => {
        orig(`UPDATE tasks SET status='done', updated_at=? WHERE id=?`).run(
          NOW,
          t.id,
        );
      },
    );
    try {
      recoverStrandedDiagTasks({ now: NOW });
    } finally {
      race.restore();
    }
    expect(race.fired).toBe(true);
    expect(getTask(t.id)?.status).toBe("done");
  });

  test("без гонки санитар по-прежнему возвращает задачу в pending", () => {
    const t = mkStranded({ _diag: true, actionType: "SEND_MESSAGE" });
    const out = recoverStrandedDiagTasks({ now: NOW });
    expect(out.requeued).toContain(t.id);
    expect(getTask(t.id)?.status).toBe("pending");
  });

  test("все UPDATE'ы санитара несут условие по наблюдённому статусу", () => {
    const src = require("node:fs").readFileSync(
      new URL("../lib/self-diag.ts", import.meta.url),
      "utf8",
    ) as string;
    const start = src.indexOf("export function recoverStrandedDiagTasks");
    const end = src.indexOf("function listPendingDiagTasks");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const updates: string[] = body.match(/UPDATE tasks SET [^`]*/g) ?? [];
    expect(updates.length).toBe(4);
    const unfenced = updates.filter((u) => !u.includes("status='running'"));
    expect(unfenced).toEqual([]);
  });
});
