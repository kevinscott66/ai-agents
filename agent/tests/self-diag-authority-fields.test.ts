/**
 * Аудит 2026-08-13: в self-diag payload сочиняет модель, а поле `_userId` —
 * это не данные, а ПОЛНОМОЧИЕ.
 *
 * Входов в диспатч два, а закрыт был один. На инструментальном пути
 * `lib/tools-schema.ts` насильно перезаписывает `_userId` из
 * `ctx.triggerUserId` — именно потому, что MAC_RUN_CLAUDE и MAC_STOP сверяют
 * его с MAC_USER_IDS: за пультом Mac должен стоять человек-владелец, а не роль.
 * Путь self-diag идёт мимо buildPayload: `parsed.payload` — это JSON, который
 * вернула модель, и он уходил в `dispatchAndAudit` как есть.
 *
 * То есть модель, предложившая ретрай `{"action":"MAC_RUN_CLAUDE",
 * "payload":{"_userId":"<id владельца>", ...}}`, сама себе выписывала пропуск
 * через белый список. Предусловия реальны и все — штатные настройки:
 * MAC_AUTONOMOUS=true, autonomy=auto и `task.created_by === "orchestrator"`
 * (единственная роль, которой permissions.ts разрешает MAC_RUN_CLAUDE — гейт
 * на строке self-diag.ts спрашивает про полномочия именно её).
 *
 * Инвариант: поле полномочий, пришедшее от модели, вычищается. Перезаписать
 * его здесь нечем — у автономного ретрая человека за спиной нет по
 * определению, — поэтому честный ответ на вопрос «какой человек это
 * запросил» — «никакой», и `isUserAllowed(undefined)` отказывает.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import {
  processDiagTask,
  MODEL_FORBIDDEN_PAYLOAD_FIELDS,
  type SelfDiagDeps,
} from "../lib/self-diag.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = -1_000_813;
/** Роль-заказчик: только ей permissions.ts разрешает MAC_*. */
const AUTHORITY = "orchestrator";
/** «Владелец» из белого списка — ровно тот id, который модель и подделывает. */
const OWNER_ID = "555000111";

let savedAutonomy = saveAutonomy();
let savedMacEnv: string | undefined;

beforeEach(() => {
  _resetRateLimits();
  savedAutonomy = saveAutonomy();
  savedMacEnv = process.env.MAC_AUTONOMOUS;
  // Штатная настройка владельца: без неё гейт потребует approval, и тест
  // зеленел бы по чужой причине.
  process.env.MAC_AUTONOMOUS = "true";
});

afterEach(() => {
  if (savedMacEnv === undefined) delete process.env.MAC_AUTONOMOUS;
  else process.env.MAC_AUTONOMOUS = savedMacEnv;
  restoreAutonomy(savedAutonomy);
  _resetRateLimits();
  db.prepare(`DELETE FROM tasks WHERE chat_id = ?`).run(CHAT);
  cleanupChat(CHAT, "aieng");
  cleanupChat(CHAT, AUTHORITY);
});

/** Ответ aieng: предложенное действие + payload, сочинённый моделью. */
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
  })) as never;
}

function diagTask(failedAction = "SEND_MESSAGE") {
  setAutonomy("chat", String(CHAT), "auto");
  return createTask({
    title: "diag",
    chatId: CHAT,
    createdBy: AUTHORITY,
    assignedTo: "aieng",
    inputPayload: {
      _diag: true,
      actionType: failedAction,
      payload: { text: "привет" },
      error: "boom",
      _retry_count: 0,
    },
  });
}

/**
 * Мост на Mac целиком подменён: белый список отвечает «да» ровно на OWNER_ID,
 * то есть на подделку. Если поле дойдёт — увидим и разрешение, и отправку.
 */
function macProbe() {
  const seenUserIds: unknown[] = [];
  let sentPrompts = 0;
  let stopped = 0;
  const macBridge = {
    isUserAllowed: (id: unknown) => {
      seenUserIds.push(id);
      return id === OWNER_ID;
    },
    isMacConnected: () => true,
    isMacOnline: () => true,
    sendToMac: async () => {
      sentPrompts += 1;
      return { ok: true, output: "ok", exitCode: 0 };
    },
    stopMac: async () => {
      stopped += 1;
      return { ok: true };
    },
  };
  return {
    macBridge,
    seenUserIds,
    sent: () => sentPrompts,
    stops: () => stopped,
  };
}

function deps(
  callAnthropicImpl: unknown,
  extraCtx: Record<string, unknown> = {},
): SelfDiagDeps {
  return {
    anthropic: {},
    model: "test",
    callAnthropicImpl,
    buildDispatchCtx: (args: { agentKey: string; chatId: number }) => ({
      agentKey: args.agentKey,
      chatId: args.chatId,
      telegram: { sendMessage: async () => ({ message_id: 1, date: 0 }) },
      ...extraCtx,
    }),
  } as unknown as SelfDiagDeps;
}

/** Payload, как он лёг в agent_actions: это и есть то, что ушло в хендлер. */
function loggedPayloads(actionType: string): Record<string, unknown>[] {
  return (
    db
      .prepare(
        `SELECT payload FROM agent_actions WHERE chat_id = ? AND action_type = ?`,
      )
      .all(CHAT, actionType) as { payload: string | null }[]
  ).map((r) => JSON.parse(r.payload ?? "{}") as Record<string, unknown>);
}

describe("self-diag: поле полномочий от модели не доезжает до Mac", () => {
  test("подделанный `_userId` вычищен — белый список видит undefined и отказывает", async () => {
    const task = diagTask("MAC_RUN_CLAUDE");
    const mac = macProbe();

    await processDiagTask(
      getTask(task.id)!,
      deps(
        aiengProposes("MAC_RUN_CLAUDE", {
          prompt: "собери проект",
          _userId: OWNER_ID,
        }),
        { macBridge: mac.macBridge },
      ),
    );

    // До фикса сюда приезжал OWNER_ID — модель проходила белый список сама.
    // toStrictEqual, а не toEqual: последний считает [] равным [undefined], и
    // тест был бы зелёным даже если бы до хендлера дело вообще не дошло.
    expect(mac.seenUserIds).toStrictEqual([undefined]);
    // И это не «проверка молча вернула true»: до Mac ничего не ушло.
    expect(mac.sent()).toBe(0);
    const after = getTask(task.id)!;
    expect(after.status).toBe("failed");
    expect(String(after.error ?? "")).toContain("forbidden");
  });

  test("MAC_STOP до хендлера не доходит вовсе — его режет гейт раньше", async () => {
    // Замер, а не предположение: MAC_STOP читает `_userId` тем же способом
    // (dispatch/mac.ts), но через self-diag он недостижим — строка permissions
    // требует approval, а approval автономный ретрай не заводит. То есть у
    // подделки здесь два рубежа, и первый срабатывает раньше вычистки поля.
    // Тест фиксирует именно это: если MAC_STOP когда-нибудь станет
    // автономным, он упадёт — и напомнит, что теперь всё держится на вычистке.
    const task = diagTask("MAC_STOP");
    const mac = macProbe();

    await processDiagTask(
      getTask(task.id)!,
      deps(aiengProposes("MAC_STOP", { _userId: OWNER_ID }), {
        macBridge: mac.macBridge,
      }),
    );

    expect(mac.seenUserIds).toStrictEqual([]);
    expect(mac.stops()).toBe(0);
    expect(loggedPayloads("MAC_STOP")).toHaveLength(0);
    const after = getTask(task.id)!;
    expect(after.status).toBe("failed");
    expect(String(after.error ?? "")).toContain("approval");
  });

  test("в agent_actions не остаётся следа сочинённого полномочия", async () => {
    const task = diagTask("MAC_RUN_CLAUDE");
    const mac = macProbe();

    await processDiagTask(
      getTask(task.id)!,
      deps(
        aiengProposes("MAC_RUN_CLAUDE", {
          prompt: "собери проект",
          _userId: OWNER_ID,
        }),
        { macBridge: mac.macBridge },
      ),
    );

    const rows = loggedPayloads("MAC_RUN_CLAUDE");
    expect(rows).toHaveLength(1);
    // Иначе разбор инцидента читал бы подделку как «владелец сам просил».
    expect(rows[0]!).not.toHaveProperty("_userId");
    expect(rows[0]!.prompt).toBe("собери проект");
  });
});

describe("self-diag: чистится только полномочие, не payload целиком", () => {
  test("обычные поля и служебные счётчики ретрая доезжают", async () => {
    const task = diagTask();

    await processDiagTask(
      getTask(task.id)!,
      deps(
        aiengProposes("SEND_MESSAGE", {
          text: "исправленный текст",
          _userId: OWNER_ID,
        }),
      ),
    );

    expect(getTask(task.id)!.status).toBe("done");
    const rows = loggedPayloads("SEND_MESSAGE");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("исправленный текст");
    expect(rows[0]!).not.toHaveProperty("_userId");
    // _retry_count=1 — тот самый cap «один self-diag на действие»: если бы
    // чистка снесла его, любой сбой ретрая заводил бы новую диаг-задачу.
    expect(rows[0]!._retry_count).toBe(1);
    expect(Array.isArray(rows[0]!._fix_chain)).toBe(true);
  });

  test("payload без полномочий проходит нетронутым", async () => {
    const task = diagTask();

    await processDiagTask(
      getTask(task.id)!,
      deps(aiengProposes("SEND_MESSAGE", { text: "просто текст" })),
    );

    expect(getTask(task.id)!.status).toBe("done");
    expect(loggedPayloads("SEND_MESSAGE")[0]!.text).toBe("просто текст");
  });
});

describe("список полей полномочий — один на оба входа в диспатч", () => {
  test("`_userId` в списке", () => {
    expect([...MODEL_FORBIDDEN_PAYLOAD_FIELDS]).toContain("_userId");
  });

  test("инструментальный путь по-прежнему считает это поле полномочием", () => {
    // Форма источника, а не поведение: если из tools-schema.ts уберут
    // насильную перезапись `_userId`, поле перестанет быть полномочием — и
    // тогда его место в списке нужно пересматривать, а не молча хранить.
    const SRC = readFileSync(
      new URL("../lib/tools-schema.ts", import.meta.url),
      "utf8",
    );
    // Два утверждения вместо одного шаблона на всю строку: payload приводится
    // к типу, где `_userId` объявлен, и полю НАСИЛЬНО присваивается
    // `ctx.triggerUserId`. Прежний однострочный шаблон совпадать перестал,
    // когда приведение вынесли в локальную переменную (понадобилось второе
    // поле, `_delegated`), — перезапись при этом никуда не делась, и тест
    // краснел на форме, а не на смысле.
    expect(SRC).toMatch(/as \{[^}]*_userId\?: string[^}]*\}/);
    expect(SRC).toMatch(/\._userId = ctx\.triggerUserId;/);
  });
});
