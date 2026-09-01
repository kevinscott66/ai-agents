/**
 * Аудит 2026-08-28: строка аудита брала чат из payload, а не из контекста.
 *
 * `dispatchAndAudit` писала в `agent_actions.chat_id` результат
 * `resolveChatId(payload.chatId, ctx.chatId)` — то есть чат, НАЗВАННЫЙ в
 * payload, для всех действий вне `CHAT_PINNED_ACTIONS`. Пиннутые закрыли в
 * 2026-08-02/08-04 ровно потому, что «в логе оставался чат атакующего, а не
 * тот, куда сообщение реально ушло» (docstring `CHAT_PINNED_ACTIONS`);
 * дополнение к списку осталось нетронутым.
 *
 * Почему это не мёртвый код. Все 14 типов из `action-payload.ts`, которые
 * объявляют `chatId`, ровно и есть `CHAT_PINNED_ACTIONS` — на тулзовом пути
 * (`buildPayload`) посторонний `chatId` до строки аудита не доезжает. Но
 * `self-diag.ts` собирает payload ретрая из ответа модели, и `chatId` не
 * попадает ни в `TRUSTED_ONLY_PAYLOAD_FIELDS`, ни в `_`-контекстные поля —
 * см. «предпосылки» ниже. Гейт (`gateFor`), лимиты и сам хендлер работают по
 * `task.chat_id`, так что ДЕЙСТВИЕ уходит в правильный чат; врёт только след:
 * из ленты чата A действие пропадает (Mini App и GET_LOGS фильтруют по
 * `chat_id`), а в ленте чата B появляется чужое.
 *
 * Чинится не в self-diag: адресат аудита вообще не может приходить из
 * payload — ни один хендлер его оттуда не читает (это отдельный инвариант в
 * `chat-pinning-invariant.test.ts`). Значит `ctx.chatId` — единственный
 * правильный ответ для всех действий, а не только для пиннутых.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { dispatchAndAudit, type DispatchCtx } from "../lib/action-dispatch.ts";
import { getAction } from "../lib/audit.ts";
import { getTask } from "../lib/tasks.ts";
import {
  stripTrustedOnlyFields,
  TRUSTED_ONLY_PAYLOAD_FIELDS,
} from "../lib/self-diag.ts";
import { cleanupChat } from "./_helpers.ts";

const ORIGIN_CHAT = 999_828_101; // чат-источник: где действие реально произошло
const FOREIGN_CHAT = -100_828_999; // чат, названный в payload
const AGENT = "__audit828chat__";

function ctx(overrides: Partial<DispatchCtx> = {}): DispatchCtx {
  // Ни одно действие здесь не ходит в Telegram, поэтому telegram не нужен.
  return { agentKey: AGENT, chatId: ORIGIN_CHAT, ...overrides };
}

async function makeTask(title: string): Promise<string> {
  const res = await dispatchAndAudit(
    "CREATE_TASK",
    { title, description: "x", assignedTo: "backend" },
    ctx(),
  );
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("CREATE_TASK failed");
  return res.taskId!;
}

afterEach(() => {
  cleanupChat(ORIGIN_CHAT, AGENT);
  cleanupChat(FOREIGN_CHAT, AGENT);
});

describe("предпосылки", () => {
  test("chatId переживает оба фильтра self-diag — доезжает из ответа модели", () => {
    expect([...TRUSTED_ONLY_PAYLOAD_FIELDS]).not.toContain("chatId");
    // Второй фильтр режет только `_`-префиксные поля; chatId не такое.
    expect("chatId".startsWith("_")).toBe(false);
    const kept = stripTrustedOnlyFields({
      taskId: "T-1",
      status: "done",
      chatId: FOREIGN_CHAT,
    });
    expect(kept.payload.chatId).toBe(FOREIGN_CHAT);
    expect(kept.dropped).toEqual([]);
  });

  test("UPDATE_TASK_STATUS не пиннится: именно такие действия и брали чат из payload", async () => {
    const { CHAT_PINNED_ACTIONS } = await import("../lib/dispatch/helpers.ts");
    expect(CHAT_PINNED_ACTIONS.has("UPDATE_TASK_STATUS")).toBe(false);
  });
});

describe("chat_id строки аудита", () => {
  test("непиннутое действие: в аудите чат-источник, а не названный в payload", async () => {
    const taskId = await makeTask("аудит: чужой чат в payload");
    const res = await dispatchAndAudit(
      "UPDATE_TASK_STATUS",
      { taskId, status: "running", chatId: FOREIGN_CHAT } as never,
      ctx(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = getAction(res.actionId);
    expect(row).not.toBeNull();
    expect(row!.chat_id).toBe(ORIGIN_CHAT);
  });

  test("действие при этом реально исполнилось в чате-источнике", async () => {
    const taskId = await makeTask("аудит: исполнение не сдвинулось");
    const res = await dispatchAndAudit(
      "UPDATE_TASK_STATUS",
      { taskId, status: "running", chatId: FOREIGN_CHAT } as never,
      ctx(),
    );
    expect(res.ok).toBe(true);
    // Хендлер сверяет доску по ctx.chatId (ownTask) и payload.chatId не читает.
    const t = getTask(taskId);
    expect(t!.chat_id).toBe(ORIGIN_CHAT);
    expect(t!.status).toBe("running");
  });

  test("непиннутое действие без chatId в payload — тот же чат-источник", async () => {
    const taskId = await makeTask("аудит: без chatId");
    const res = await dispatchAndAudit(
      "UPDATE_TASK_STATUS",
      { taskId, status: "running" },
      ctx(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(getAction(res.actionId)!.chat_id).toBe(ORIGIN_CHAT);
  });

  test("пиннутое действие не изменилось: чат-источник, как и до правки", async () => {
    const res = await dispatchAndAudit(
      "CREATE_TASK",
      {
        title: "аудит: пиннутое",
        description: "x",
        assignedTo: "backend",
        chatId: FOREIGN_CHAT,
      } as never,
      ctx(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(getAction(res.actionId)!.chat_id).toBe(ORIGIN_CHAT);
  });

  test("строка ошибки тоже пишется в чат-источник", async () => {
    // Задачи нет — хендлер вернёт ok:false, но строка аудита всё равно есть.
    const res = await dispatchAndAudit(
      "UPDATE_TASK_STATUS",
      { taskId: "T-нет-такой", status: "done", chatId: FOREIGN_CHAT } as never,
      ctx(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(getAction(res.actionId!)!.chat_id).toBe(ORIGIN_CHAT);
  });
});

describe("применение", () => {
  const SRC = readFileSync(
    new URL("../lib/action-dispatch.ts", import.meta.url).pathname,
    "utf-8",
  );
  const HELPERS = readFileSync(
    new URL("../lib/dispatch/helpers.ts", import.meta.url).pathname,
    "utf-8",
  );

  test("адресат аудита берётся из контекста без развилки", () => {
    expect(SRC).toContain("const chatId = ctx.chatId;");
    expect(SRC).not.toContain("resolveChatId(");
  });

  test("помощник, бравший чат из payload, удалён целиком", () => {
    // Оставленный экспорт — приглашение позвать его снова; в проекте он больше
    // не нужен нигде (адресат всегда ctx.chatId либо pinnedChatId).
    expect(HELPERS).not.toContain("export function resolveChatId");
  });
});
