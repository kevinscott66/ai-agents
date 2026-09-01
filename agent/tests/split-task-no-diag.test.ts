/**
 * Провалившийся SPLIT_TASK не должен плодить диагностические задачи
 * (аудит 2026-08-02).
 *
 * SPLIT_TASK создаёт родительскую задачу ДО делегирования, поэтому его провал
 * уже оставляет на доске строку `[split] …` со статусом failed и текстом
 * причины. Сверху навешивались ещё две — C15 («Tool error: SPLIT_TASK» на
 * aieng) и T-704 («[diagnostic] unknown: SPLIT_TASK» на orchestrator), обе в
 * pending. Итого три строки на одно событие, две из которых просят починить
 * штатное поведение: доминирующая причина провала — `no roles accepted`, то
 * есть отказ по проверке цикла делегирования, а не runtime-ошибка.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { dispatchAndAudit } from "../lib/action-dispatch.ts";
import { handleCreateDiagnosticTask } from "../lib/dispatch/diagnostic-action.ts";
import { isByDesignRefusal, shouldSkipSelfDiag } from "../lib/diagnostic.ts";
import { logAction } from "../lib/audit.ts";
import { db } from "../lib/db.ts";

const TEST_CHAT = 999_806_021;

type Row = { title: string; status: string; assigned_to: string | null };

function tasksInChat(): Row[] {
  return db
    .prepare(
      `SELECT title, status, assigned_to FROM tasks WHERE chat_id = ? ORDER BY created_at`,
    )
    .all(TEST_CHAT) as Row[];
}

function cleanup(): void {
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(TEST_CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(TEST_CHAT);
}

afterEach(cleanup);

describe("SPLIT_TASK: провал не порождает диаг-задач", () => {
  test("ни одна роль не взялась → на доске ровно одна строка", async () => {
    // qa делегирует qa — отсекается проверкой самоделегирования (родня
    // проверке цикла), значит childIds пуст и сплит возвращает ok:false.
    // Это самый частый в проде способ получить нулевой сплит.
    const res = await dispatchAndAudit(
      "SPLIT_TASK",
      { title: "починить всё сразу", roles: ["qa"] } as never,
      { agentKey: "qa", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/no roles accepted/);

    const rows = tasksInChat();
    expect(rows.map((r) => r.title)).toEqual(["[split] починить всё сразу"]);
    expect(rows[0]!.status).toBe("failed");
  });

  test("нет ни C15-задачи для aieng, ни T-704-задачи для orchestrator", async () => {
    await dispatchAndAudit(
      "SPLIT_TASK",
      { title: "второй заход", roles: ["qa"] } as never,
      { agentKey: "qa", chatId: TEST_CHAT },
    );
    const titles = tasksInChat().map((r) => r.title);
    expect(titles.some((t) => t.startsWith("Tool error:"))).toBe(false);
    expect(titles.some((t) => t.startsWith("[diagnostic]"))).toBe(false);
  });

  test("прямое делегирование по кругу тоже не плодит диаг-задач", async () => {
    // Правило висело только на склейке (SPLIT_TASK), хотя производитель
    // отказов — DELEGATE_TO_ROLE. Прямое «делегирую сам себе» проходило тот же
    // аудит и заводило те же две строки с просьбой починить защиту.
    const res = await dispatchAndAudit(
      "DELEGATE_TO_ROLE",
      { role: "qa", task: "сам себе" } as never,
      { agentKey: "qa", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    const titles = tasksInChat().map((r) => r.title);
    expect(titles.some((t) => t.startsWith("Tool error:"))).toBe(false);
    expect(titles.some((t) => t.startsWith("[diagnostic]"))).toBe(false);
  });

  test("явный CREATE_DIAGNOSTIC_TASK по такому провалу тоже отбивается", () => {
    // Неявный и явный пути раньше держали списки-исключения раздельно
    // (литерал "CREATE_TASK" + комментарий «mirrors»). Теперь список общий,
    // и модель не может обойти правило, попросив диагностику вручную.
    const { id } = logAction({
      agentKey: "orchestrator",
      chatId: TEST_CHAT,
      actionType: "SPLIT_TASK" as never,
      payload: {},
      status: "error",
      error: "split failed: no roles accepted the task (qa: delegation cycle)",
    });
    const res = handleCreateDiagnosticTask(
      { failed_action_id: id, hypothesis: "просим разобраться с провалом сплита" },
      { agentKey: "qa", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.task_id).toBeNull();
    expect(res.result.skipped_reason).toBe("recursion_guard");
  });

  test("строка аудита о провале ссылается на созданного родителя", async () => {
    // DispatchResult давно умел отдавать taskId у провала, но dispatchAndAudit
    // его выбрасывал (`res.ok ? res.taskId : undefined`), и запись в
    // agent_actions уходила с task_id = NULL. Связать провал с осиротевшей
    // `[split] …` можно было только по времени.
    const res = await dispatchAndAudit(
      "SPLIT_TASK",
      { title: "аудит должен помнить родителя", roles: ["qa"] } as never,
      { agentKey: "qa", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.taskId).toBeTruthy();
    const row = db
      .prepare(`SELECT task_id FROM agent_actions WHERE id = ?`)
      .get(res.actionId) as { task_id: string | null } | undefined;
    expect(row?.task_id).toBe(res.taskId!);
  });

  test("поломка проводки внутри сплита диагностику ВСЁ ЖЕ заводит", async () => {
    // Первая редакция правила (2026-08-02) гасила SPLIT_TASK целиком по типу
    // действия. Но тот же текст `no roles accepted` дают и настоящие поломки:
    // `no resolveAgent in dispatch ctx`, `no handoffDeps in dispatch ctx` и
    // `target agent not found: <role>` (роль зарегистрирована, бот мёртв).
    // Их гасить нельзя — некому чинить.
    const { id } = logAction({
      agentKey: "orchestrator",
      chatId: TEST_CHAT,
      actionType: "SPLIT_TASK" as never,
      payload: {},
      status: "error",
      error:
        "split failed: no roles accepted the task (backend: target agent not found: backend)",
    });
    const res = handleCreateDiagnosticTask(
      { failed_action_id: id, hypothesis: "бот роли не поднялся" },
      { agentKey: "qa", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.skipped_reason).toBeUndefined();
    expect(res.result.task_id).toBeTruthy();
  });

  test("смесь отказа и поломки считается поломкой", () => {
    // Хватает одной настоящей причины среди отказов: иначе поломка прячется
    // за соседней ролью, отказавшей по циклу.
    expect(
      shouldSkipSelfDiag(
        "SPLIT_TASK",
        "split failed: no roles accepted the task (qa: cannot delegate to self; backend: no handoffDeps in dispatch ctx)",
      ),
    ).toBe(false);
    expect(
      shouldSkipSelfDiag(
        "SPLIT_TASK",
        "split failed: no roles accepted the task (qa: cannot delegate to self; pm: delegation cycle: 'pm' is already in chain [pm→qa])",
      ),
    ).toBe(true);
  });

  test("пустой список причин — это молча упавший createTask, не отказ", () => {
    // createTask ловится non-fatal и в errors не попадает, так что нулевой
    // сплит может дойти сюда вообще без причин. Гасить такое нельзя.
    expect(
      isByDesignRefusal("split failed: no roles accepted the task ()"),
    ).toBe(false);
    // CREATE_TASK гасится безусловно — там риск рекурсии, а не отказ.
    expect(shouldSkipSelfDiag("CREATE_TASK", "disk full")).toBe(true);
  });

  test("контроль: обычное провалившееся действие диаг-задачу по-прежнему создаёт", async () => {
    // Гарантия, что правило точечное. Без этой проверки «диаг-задач нет»
    // прошло бы и при полностью сломанной самодиагностике.
    const res = await dispatchAndAudit(
      "SET_REACTION",
      { messageId: 1, emoji: "👍" } as never,
      { agentKey: "qa", chatId: TEST_CHAT },
    );
    expect(res.ok).toBe(false);
    const titles = tasksInChat().map((r) => r.title);
    expect(titles.some((t) => t.startsWith("Tool error: SET_REACTION"))).toBe(
      true,
    );
  });
});
