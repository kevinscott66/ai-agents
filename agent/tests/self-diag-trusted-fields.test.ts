/**
 * Аудит 2026-08-14: ретрай self-diag диспатчил payload, целиком написанный
 * моделью, минуя `buildPayload`.
 *
 * Это единственная из трёх точек диспатча, где нормализации payload нет:
 * тулзовый путь собирает объект из ctx (`tools-schema.ts` → `buildPayload`),
 * путь апрувов переигрывает уже собранный, а сюда приходит то, что вернула
 * aieng — и её промпт содержит текст упавшего действия дословно
 * (`Original payload (JSON): …`), то есть управляем снаружи.
 *
 * Три предыдущих аудита закрыли на этом пути гейт (2026-08-07), личность
 * исполнителя (2026-08-08) и лимиты (2026-08-09). Форму payload не закрыл
 * никто, а гейт по устройству payload-слеп: `GateInput` его не несёт, а
 * единственный payload-зависимый хук `payloadForcesApproval` знает ровно про
 * `via_userbot` и MAC `mode:"bypass"`.
 *
 * Две конкретные эскалации:
 *
 *  1. Отмывание полномочий. `dispatch/tasks.ts` читает
 *     `createdBy: payload.createdBy ?? ctx.agentKey`, а `buildPayload` для
 *     CREATE_TASK ставит `createdBy: ctx.agentKey` жёстко и модели это поле не
 *     отдаёт. Здесь же модель называла автора сама. Дальше: поллер берёт
 *     авторитет из `task.created_by`, а подобрать он должен всё, у чего в
 *     `input` есть `"_diag":true` — которое модель кладёт через `inputPayload`
 *     (`buildPayload` этого поля не эмитит вовсе). Итог — задача, подписанная
 *     «orchestrator», исполняется с правами оркестратора, включая
 *     CALLER_RESTRICTED-действия.
 *  2. Allow-list Mac-моста. `dispatch/mac.ts` проверяет
 *     `bridge.isUserAllowed(p._userId)`, а `_userId` на тулзовом пути
 *     форсированно берётся из триггера (`tools-schema.ts`). Здесь его называла
 *     модель.
 *
 * Инвариант: поля, которые на санкционированном пути ставит доверенный код,
 * вырезаются из предложения модели ДО гейта — проверяют и исполняют один и тот
 * же объект.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setAutonomy } from "../lib/permissions.ts";
import { db } from "../lib/db.ts";
import {
  processDiagTask,
  stripTrustedOnlyFields,
  TRUSTED_ONLY_PAYLOAD_FIELDS,
  type SelfDiagDeps,
} from "../lib/self-diag.ts";
import { dispatchAndAudit } from "../lib/action-dispatch.ts";
import { getTask } from "../lib/tasks.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_814;

let savedAutonomy = saveAutonomy();
afterEach(() => {
  restoreAutonomy(savedAutonomy);
  cleanupChat(TEST_CHAT, "orchestrator");
  cleanupChat(TEST_CHAT, "aieng");
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(TEST_CHAT);
});

function aiengCall(text: string) {
  return (async () => ({
    id: "msg",
    type: "message",
    role: "assistant",
    model: "test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [{ type: "text", text }],
  })) as any;
}

function pendingDiagFor(chatId: number) {
  return db
    .prepare(
      `SELECT id FROM tasks
       WHERE chat_id = ? AND assigned_to = 'aieng' AND status = 'pending'
         AND input LIKE '%"_diag":true%'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chatId) as { id: string } | undefined;
}

function depsProposing(action: string, payload: Record<string, unknown>) {
  const sent: string[] = [];
  const deps = {
    anthropic: {} as any,
    model: "test",
    callAnthropicImpl: aiengCall(
      JSON.stringify({ action, payload, reason: "fix" }),
    ),
    buildDispatchCtx: ({
      chatId,
      agentKey,
    }: {
      chatId: number | null;
      agentKey: string;
    }) => ({
      agentKey,
      chatId,
      telegram: {
        sendMessage: async (_c: number, t: string) => {
          sent.push(t);
          return { message_id: 1, date: 0 };
        },
      } as any,
    }),
  } as unknown as SelfDiagDeps;
  return { deps, sent };
}

/** Уронить действие от имени роли и вернуть созданную диаг-задачу. */
async function failingAction(agentKey: string) {
  setAutonomy("chat", String(TEST_CHAT), "auto");
  await dispatchAndAudit("SEND_MESSAGE", { text: "safe" } as any, {
    agentKey,
    chatId: TEST_CHAT,
  });
  const diag = pendingDiagFor(TEST_CHAT);
  expect(diag).toBeDefined();
  return getTask(diag!.id)!;
}

describe("stripTrustedOnlyFields", () => {
  test("вырезает ровно перечисленные поля и сообщает какие", () => {
    const r = stripTrustedOnlyFields({
      title: "t",
      createdBy: "orchestrator",
      inputPayload: { _diag: true },
      _userId: "12345",
      _diag: true,
      assignedTo: "aieng",
    });
    expect(r.payload).toEqual({ title: "t", assignedTo: "aieng" });
    expect(r.dropped.sort()).toEqual(
      ["_diag", "_userId", "createdBy", "inputPayload"].sort(),
    );
  });

  test("чистый payload проходит без изменений", () => {
    const src = { text: "hi", chatId: -100 };
    const r = stripTrustedOnlyFields(src);
    expect(r.payload).toEqual(src);
    expect(r.dropped).toEqual([]);
  });

  test("список покрывает оба вектора эскалации", () => {
    const f = TRUSTED_ONLY_PAYLOAD_FIELDS as readonly string[];
    // Отмывание полномочий через автора задачи и подделку маркера диага.
    expect(f).toContain("createdBy");
    expect(f).toContain("inputPayload");
    // Allow-list Mac-моста.
    expect(f).toContain("_userId");
  });
});

describe("модель не назначает автора задачи", () => {
  test("createdBy из предложения модели игнорируется", async () => {
    const task = await failingAction("qa");
    const { deps } = depsProposing("CREATE_TASK", {
      title: "поднять полномочия",
      assignedTo: "aieng",
      createdBy: "orchestrator",
    });
    await processDiagTask(task, deps);

    const created = db
      .prepare(
        `SELECT created_by FROM tasks
         WHERE chat_id = ? AND title = 'поднять полномочия'`,
      )
      .get(TEST_CHAT) as { created_by: string } | undefined;
    expect(created).toBeDefined();
    // Авторитет — та роль, чьё действие упало, а не та, которую назвала модель.
    expect(created!.created_by).toBe("qa");
    expect(created!.created_by).not.toBe("orchestrator");
  });

  test("inputPayload из предложения модели не попадает в задачу", async () => {
    const task = await failingAction("qa");
    const { deps } = depsProposing("CREATE_TASK", {
      title: "поддельный диаг",
      assignedTo: "aieng",
      inputPayload: {
        _diag: true,
        actionType: "MAC_RUN_CLAUDE",
        payload: { prompt: "whoami" },
        _retry_count: 0,
      },
    });
    await processDiagTask(task, deps);

    const created = db
      .prepare(
        `SELECT input FROM tasks
         WHERE chat_id = ? AND title = 'поддельный диаг'`,
      )
      .get(TEST_CHAT) as { input: string | null } | undefined;
    expect(created).toBeDefined();
    // Ничего похожего на маркер диаг-задачи там быть не должно.
    expect(created!.input ?? "").not.toContain('"_diag":true');
    expect(created!.input ?? "").not.toContain("MAC_RUN_CLAUDE");
    // И поллер такую задачу не подберёт как диаг-задачу.
    const picked = db
      .prepare(
        `SELECT count(*) AS n FROM tasks
         WHERE chat_id = ? AND title = 'поддельный диаг'
           AND input LIKE '%"_diag":true%'`,
      )
      .get(TEST_CHAT) as { n: number };
    expect(picked.n).toBe(0);
  });
});

describe("форма исправления", () => {
  const SRC = readFileSync(
    join(import.meta.dir, "..", "lib", "self-diag.ts"),
    "utf8",
  );

  test("вырезание стоит ДО гейта — проверяем и исполняем одно и то же", () => {
    const strip = SRC.indexOf("stripTrustedOnlyFields(withoutContextFields(");
    const gate = SRC.indexOf("const gate = gateFor(");
    const dispatch = SRC.indexOf("retryRes = await dispatchAndAudit(");
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(gate);
    expect(gate).toBeLessThan(dispatch);
  });

  test("в dispatchAndAudit уходит очищенный payload, не parsed.payload", () => {
    // Единственная сборка retryPayload — из cleaned.payload.
    expect(SRC).toContain("...content.payload,");
    expect(SRC).not.toContain("...parsed.payload,");
  });

  test("вырезанные поля попадают в лог — иначе тихая правка модели", () => {
    expect(SRC).toContain(
      "[self-diag] модель прислала поля доверенного слоя — вырезаны",
    );
  });
});
