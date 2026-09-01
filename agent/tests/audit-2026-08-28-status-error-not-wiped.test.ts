/**
 * Аудит 2026-08-28: смена статуса стирала записанную причину.
 *
 * `updateTaskStatus` намеренно не трогает поля, которых ей не дали — «Если
 * поле не передано — не затираем существующее». Отличает «не дали» от «дали
 * пусто» ровно `undefined`.
 *
 * На пути модели этого различия не существовало: `build-payload.ts` собирал
 * `error: i.error == null ? null : String(i.error)`, то есть поле было в
 * пейлоаде ВСЕГДА — при отсутствии как `null`. Хендлер видел «дали null» и
 * писал NULL в колонку. Охранная ветка не срабатывала ни разу.
 *
 * Соседнее поле в том же литерале собрано правильно (`output: i.output`), и
 * второй потребитель тоже (`miniapp-server.ts`, `error: body.error`) — то есть
 * это расхождение, а не решение.
 *
 * Что теряется: `error` — не только про провал. Модель вправе записать причину
 * на нетерминальном статусе («running: нет доступа к API»), а следующий же
 * перевод статуса без этого поля обнулял её. Читает колонку человек — карточка
 * задачи в Mini App показывает `selected.error` и больше нигде причины нет.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import type { PayloadByType } from "../lib/action-payload.ts";
import { handleUpdateTaskStatus } from "../lib/dispatch/tasks.ts";
import { createTask, getTask, updateTaskStatus } from "../lib/tasks.ts";
import { db } from "../lib/db.ts";

const CHAT = 557001;
const ctx = { agentKey: "backend", chatId: CHAT };

function build(i: Record<string, unknown>): PayloadByType["UPDATE_TASK_STATUS"] {
  const r = buildPayload("UPDATE_TASK_STATUS", i, { agentKey: "backend" });
  expect(r.ok).toBe(true);
  return (r as { ok: true; payload: PayloadByType["UPDATE_TASK_STATUS"] }).payload;
}

function task() {
  return createTask({ chatId: CHAT, createdBy: "backend", title: "задача" });
}

beforeEach(() => {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
});

describe("предпосылки", () => {
  test("сам updateTaskStatus причину сохраняет, если поля не дали", () => {
    const t = task();
    updateTaskStatus(t.id, "running", { error: "нет доступа к API" });
    updateTaskStatus(t.id, "awaiting_review");
    expect(getTask(t.id)!.error).toBe("нет доступа к API");
  });

  test("и затирает, если дали null явно", () => {
    const t = task();
    updateTaskStatus(t.id, "running", { error: "причина" });
    updateTaskStatus(t.id, "awaiting_review", { error: null });
    expect(getTask(t.id)!.error).toBeNull();
  });
});

describe("build-payload различает «не дали» и «дали пусто»", () => {
  test("без error поле не появляется в пейлоаде", () => {
    const p = build({ taskId: "t", status: "running" });
    expect(p.error).toBeUndefined();
  });

  test("с error поле доезжает строкой", () => {
    expect(build({ taskId: "t", status: "failed", error: "упало" }).error).toBe("упало");
  });

  test("нестроковая причина по-прежнему приводится к строке", () => {
    expect(build({ taskId: "t", status: "failed", error: 42 }).error).toBe("42");
  });

  test("output собран так же и остался таким", () => {
    expect(build({ taskId: "t", status: "running" }).output).toBeUndefined();
    expect(build({ taskId: "t", status: "done", output: "итог" }).output).toBe("итог");
  });
});

describe("сквозь хендлер", () => {
  test("перевод статуса без причины её не стирает", () => {
    const t = task();
    handleUpdateTaskStatus(
      build({ taskId: t.id, status: "running", error: "нет доступа к API" }) as never,
      ctx,
    );
    expect(getTask(t.id)!.error).toBe("нет доступа к API");

    handleUpdateTaskStatus(build({ taskId: t.id, status: "awaiting_review" }) as never, ctx);
    expect(getTask(t.id)!.error).toBe("нет доступа к API");
  });

  test("новая причина прежнюю перезаписывает", () => {
    const t = task();
    handleUpdateTaskStatus(
      build({ taskId: t.id, status: "running", error: "первая" }) as never,
      ctx,
    );
    handleUpdateTaskStatus(
      build({ taskId: t.id, status: "failed", error: "вторая" }) as never,
      ctx,
    );
    expect(getTask(t.id)!.error).toBe("вторая");
  });
});
