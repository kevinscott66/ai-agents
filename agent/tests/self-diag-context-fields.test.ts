/**
 * Аудит 2026-08-13: на пути self-diag модель назначала сама себе личность.
 *
 * `processDiagTask` собирал payload ретрая как `{...parsed.payload}` — то есть
 * из ответа модели целиком. А в payload'ах этого проекта `_`-префикс означает
 * «контекст, который подставляет вызывающий»: `_userId` (единственное, что
 * проверяет whitelist MAC_USER_IDS), `_delegation_path` (анти-луп C28/C13),
 * `_parent_task_id`, `_rerouted_from`, `_retry_count`, `_fix_chain`, `_diag`.
 *
 * Цена: упавший payload печатается модели в промпте вместе с `_userId`
 * владельца, так что подставить валидный id — не угадывание, а копирование. С
 * ним `MAC_RUN_CLAUDE` проходит whitelist и на личной машине владельца
 * исполняется промпт, которого не писал ни один человек. Пустой
 * `_delegation_path` в том же ответе выдаёт делегата на четвёртом хопе за
 * первого — то есть размыкает анти-луп.
 *
 * Аудит 2026-09-11: до этой даты здесь и в самой проверке ниже стояли _depth и
 * _delegation_chain — поля, которых в коде нет: счётчик глубины удалён 2026-08-10
 * (см. action-payload.ts у `_delegation_path`), а второго имени не было
 * никогда. Тест клал их в payload руками и там же их и находил, потому что
 * восстановление контекста работает по ПРЕФИКСУ, а не по списку имён: проходило
 * любое выдуманное `_`-поле. Проверка была верной, предмет — вымышленным, и
 * сторож протухших имён считал их живыми именно из-за этой строки.
 *
 * Инвариант: от модели — только содержательные поля; контекст восстанавливается
 * из упавшего payload, который пришёл из реального действия.
 *
 * Наблюдаем то, что РЕАЛЬНО доехало до диспатча: `agent_actions.payload` пишет
 * `dispatchAndAudit`. Проверять возвращаемое значение хендлера было бы
 * бессмысленно — оно не показывает, с какими полномочиями его позвали.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { processDiagTask, type SelfDiagDeps } from "../lib/self-diag.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -1_000_813;
const AUTHORITY = "orchestrator";
/** Id владельца — ровно то, что модель видит распечатанным в своём промпте. */
const OWNER = "100000001";

let saved = saveAutonomy();

afterEach(() => {
  restoreAutonomy(saved);
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT);
  cleanupChat(CHAT, "aieng");
  cleanupChat(CHAT, AUTHORITY);
});

function aiengProposes(action: string, payload: Record<string, unknown>) {
  return (async () => ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [
      { type: "text", text: JSON.stringify({ action, payload, reason: "fix" }) },
    ],
  })) as any;
}

/** Диаг-таск с заданным контекстом в УПАВШЕМ payload — доверенная сторона. */
function diagTask(failedPayload: Record<string, unknown>) {
  setAutonomy("chat", String(CHAT), "auto");
  return createTask({
    title: "diag",
    chatId: CHAT,
    createdBy: AUTHORITY,
    assignedTo: "aieng",
    inputPayload: {
      _diag: true,
      actionType: "SEND_MESSAGE",
      payload: failedPayload,
      error: "no telegram context",
      _retry_count: 0,
    },
  });
}

const okCtx = (args: { agentKey: string; chatId: number }) =>
  ({
    agentKey: args.agentKey,
    chatId: args.chatId,
    telegram: { sendMessage: async () => ({ message_id: 1, date: 0 }) },
  }) as any;

async function runWith(
  failedPayload: Record<string, unknown>,
  modelPayload: Record<string, unknown>,
) {
  const task = diagTask(failedPayload);
  await processDiagTask(getTask(task.id)!, {
    anthropic: {} as any,
    model: "test",
    callAnthropicImpl: aiengProposes("SEND_MESSAGE", modelPayload),
    buildDispatchCtx: okCtx,
  } as unknown as SelfDiagDeps);
  const row = db
    .prepare(
      `SELECT payload FROM agent_actions WHERE chat_id = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(CHAT) as { payload: string | null } | undefined;
  return {
    task: getTask(task.id)!,
    dispatched: JSON.parse(row?.payload ?? "null") as Record<string, unknown>,
  };
}

describe("self-diag: контекстные поля не приходят от модели", () => {
  test("подставленный моделью _userId отбрасывается", async () => {
    // Ровно атака: в упавшем действии человека не было, модель дописывает id
    // владельца, который прочитала в своём же промпте.
    const { dispatched } = await runWith(
      { text: "привет" },
      { text: "привет", _userId: OWNER },
    );
    expect(dispatched.text).toBe("привет");
    expect(dispatched._userId).toBeUndefined();
  });

  // Личность не восстанавливается и из упавшего payload тоже: промпт разрешает
  // модели предложить ДРУГОЕ действие, и перенос `_userId` владельца с упавшего
  // SEND_MESSAGE на предложенный MAC_RUN_CLAUDE — это пропуск на его машину.
  // См. MODEL_FORBIDDEN_PAYLOAD_FIELDS и self-diag-authority-fields.test.ts.
  test("_userId не переносится даже из упавшего payload", async () => {
    // Легитимный ретрай не должен ломаться: личность переживает смену
    // действия — она отвечает на вопрос «какой человек это запустил».
    const { dispatched } = await runWith(
      { text: "привет", _userId: OWNER },
      { text: "привет исправленный", _userId: "999000111" },
    );
    expect(dispatched.text).toBe("привет исправленный");
    expect(dispatched._userId).toBeUndefined();
  });

  test("_delegation_path модель не обрезает", async () => {
    // Длина цепочки — единственный потолок глубины (action-dispatch.ts, ветка
    // DELEGATE_TO_ROLE): пустой список означает «я первый хоп» на любой
    // глубине, и каскад фиксов перестаёт размыкаться.
    const { dispatched } = await runWith(
      { text: "привет", _delegation_path: ["pm", "backend"], _parent_task_id: "t-7" },
      { text: "привет", _delegation_path: [], _parent_task_id: "t-подделка" },
    );
    expect(dispatched._delegation_path).toEqual(["pm", "backend"]);
    expect(dispatched._parent_task_id).toBe("t-7");
  });

  test("содержательные поля модели проходят полностью", async () => {
    // Страховка от «закрыли дыру и заодно сломали ретрай».
    const { task, dispatched } = await runWith(
      { text: "старый", parse_mode: "HTML" },
      { text: "новый", parse_mode: "Markdown", reply_to: 42 },
    );
    expect(task.status).toBe("done");
    expect(dispatched.text).toBe("новый");
    expect(dispatched.parse_mode).toBe("Markdown");
    expect(dispatched.reply_to).toBe(42);
  });

  test("_retry_count ставит код, а не модель", async () => {
    // Иначе `_retry_count: 0` в ответе снимает защиту от повторного диаг-таска
    // на сбой самого ретрая.
    const { dispatched } = await runWith(
      { text: "привет" },
      { text: "привет", _retry_count: 0 },
    );
    expect(dispatched._retry_count).toBe(1);
  });
});
