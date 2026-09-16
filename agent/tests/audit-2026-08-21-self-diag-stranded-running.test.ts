/**
 * Аудит 2026-08-21: рестарт в окне «running → ответ aieng» хоронил
 * diag-задачу навсегда.
 *
 * `processDiagTask` (self-diag.ts) переводит задачу в `running` ДО вызова
 * модели, а `listPendingDiagTasks` (:242) выбирает строго `status='pending'`.
 * Пока процесс жив, дыры нет — тик сериализован флагом, каждый выход пишет
 * терминальный статус. Kill процесса ровно в этом окне (OOM, `systemctl
 * restart`) оставлял задачу в `running`, и её больше не забирал НИКТО.
 *
 * Замер до фикса (пробник, два тика подряд по задаче в `running`):
 *
 *   PROBE stranded: 0 вызовов aieng, статус running
 *   PROBE gc:       1 failed, error='gc_stale'
 *
 * То есть единственный разрешённый ретрай сгорал не состоявшись, а через
 * сутки `gcStaleTasks` штамповал причину «зависла по таймауту» — которой не
 * было. Ровно тот же подлог причины, что чинил мост статусов в
 * tasks.ts:400-415; там окно схлопнули транзакцией, здесь нельзя — между
 * `running` и терминалом стоит вызов модели.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { setAutonomy } from "../lib/permissions.ts";
import {
  recoverStrandedDiagTasks,
  startSelfDiagPoller,
  SELF_DIAG_STRANDED_MS,
  type SelfDiagDeps,
} from "../lib/self-diag.ts";

const CHAT = -100777;

function mkDiagTask(): string {
  return createTask({
    chatId: CHAT,
    createdBy: "backend",
    assignedTo: "aieng",
    title: "Tool error: SEND_MESSAGE",
    inputPayload: {
      actionType: "SEND_MESSAGE",
      payload: { chatId: CHAT, text: "x" },
      error: "boom",
      _diag: true,
      _retry_count: 0,
    },
  }).id;
}

/** Смерть процесса в окне: задача осталась в `running` и состарилась. */
function strand(id: string, ageMs: number): void {
  db.prepare(`UPDATE tasks SET status='running', updated_at=? WHERE id=?`).run(
    Date.now() - ageMs,
    id,
  );
}

function inputOf(id: string): Record<string, unknown> {
  const row = db.prepare(`SELECT input FROM tasks WHERE id=?`).get(id) as
    | { input: string | null }
    | undefined;
  return JSON.parse(row?.input ?? "{}") as Record<string, unknown>;
}

/** Поллер, который на каждый вызов aieng отвечает giveup — задача уйдёт в done. */
function poller(calls: string[]) {
  return startSelfDiagPoller({
    intervalMs: 999_999,
    deps: {
      runTextImpl: async () => {
        calls.push("llm");
        return JSON.stringify({ giveup: true, reason: "test" });
      },
      buildDispatchCtx: () => null,
    } as unknown as SelfDiagDeps,
  });
}

describe("подбор diag-задач, брошенных в running", () => {
  beforeEach(() => {
    // Гейт спрашивают ДО вызова модели: без auto задача закрывается
    // «skipped: gate says approval» и до aieng дело не доходит вовсе.
    setAutonomy("chat", String(CHAT), "auto");
    // Подбор ходит по всей таблице, а не по одной задаче: чужой хвост из
    // соседнего теста попадал бы в `requeued` и делал утверждения ниже
    // зависимыми от порядка. Чистим свои строки перед каждым тестом.
    db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
  });

  test("состарившаяся задача возвращается в pending и доезжает до aieng", async () => {
    const id = mkDiagTask();
    strand(id, SELF_DIAG_STRANDED_MS + 60_000);

    const calls: string[] = [];
    const h = poller(calls);
    await h.tick();
    h.stop();

    expect(calls.length).toBe(1);
    expect(getTask(id)?.status).toBe("done");
  });

  test("до порога задачу не трогаем — она может быть в работе", () => {
    const id = mkDiagTask();
    strand(id, SELF_DIAG_STRANDED_MS - 60_000);

    const res = recoverStrandedDiagTasks();

    expect(res.requeued).not.toContain(id);
    expect(res.failed).not.toContain(id);
    expect(getTask(id)?.status).toBe("running");
  });

  test("подбор ставит счётчик, и второй раз задача уже не воскресает", () => {
    const id = mkDiagTask();
    strand(id, SELF_DIAG_STRANDED_MS + 60_000);

    const first = recoverStrandedDiagTasks();
    expect(first.requeued).toContain(id);
    expect(getTask(id)?.status).toBe("pending");
    expect(inputOf(id)._diag_restarts).toBe(1);

    // Задача снова убила процесс — второй подбор её закрывает, а не крутит петлю.
    strand(id, SELF_DIAG_STRANDED_MS + 60_000);
    const second = recoverStrandedDiagTasks();

    expect(second.requeued).not.toContain(id);
    expect(second.failed).toContain(id);
    const t = getTask(id);
    expect(t?.status).toBe("failed");
    expect(t?.error).toContain("дважды осталась в running");
    // Причина названа честно, а не «зависла по таймауту».
    expect(t?.error).not.toContain("gc_stale");
  });

  test("подбор не трогает чужие running-задачи", () => {
    const alien = createTask({
      chatId: CHAT,
      createdBy: "backend",
      assignedTo: "aieng",
      title: "обычная задача aieng",
      inputPayload: { note: "не диагностика" },
    }).id;
    strand(alien, SELF_DIAG_STRANDED_MS + 60_000);

    const res = recoverStrandedDiagTasks();

    expect(res.requeued).not.toContain(alien);
    expect(res.failed).not.toContain(alien);
    expect(getTask(alien)?.status).toBe("running");
  });

  test("ретрай не сгорает: восстановленная задача сохраняет _retry_count=0", () => {
    // Смысл подбора именно в этом: единственная разрешённая попытка не
    // состоялась, значит она всё ещё должна быть доступна.
    const id = mkDiagTask();
    strand(id, SELF_DIAG_STRANDED_MS + 60_000);

    recoverStrandedDiagTasks();

    expect(inputOf(id)._retry_count).toBe(0);
    expect(inputOf(id)._diag).toBe(true);
  });
});
