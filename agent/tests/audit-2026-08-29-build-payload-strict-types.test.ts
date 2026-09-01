/**
 * Аудит 2026-08-29: buildPayload отвечал на поле НЕВЕРНОГО ТИПА догадкой,
 * а не отказом. Два сорта.
 *
 * 1) messageId. Подстановка `ctx.triggerMessageId` срабатывала не только на
 *    отсутствующем поле, но и на строке/объекте/null. `{"messageId": "8231"}`
 *    — рядовая осечка модели на числовом поле — молча означало «то сообщение,
 *    которым пользователь вызвал этот ход». `DELETE_MESSAGE` необратим и не
 *    входит в ALWAYS_APPROVE, то есть право на него флипается грантом; с
 *    `via_userbot: true` удаление идёт от лица владельца. Модель при этом
 *    получала ok:true за удаление НЕ ТОГО сообщения.
 *
 *    Задокументированное умолчание есть ровно у SET_REACTION и ровно для
 *    ОТСУТСТВУЮЩЕГО поля; у EDIT/PIN/DELETE/FORWARD схема объявляет messageId
 *    обязательным. Названное поле неверного типа — это ошибка вызова.
 *
 * 2) Свободный текст. `String(i.text ?? "")` с единственной проверкой на
 *    непустоту: `String({})` даёт непустое `"[object Object]"`, поэтому
 *    `{"text": {"ru": "…", "en": "…"}}` проходило валидацию и уезжало в чат
 *    и в вики буквально этой строкой, с ok:true в аудите.
 *
 * Оба пути к модели вели себя по-разному: SDK-путь отбивает такое сам
 * (propToZod → z.string()/z.number()), сырой tool-loop кастует input без
 * проверки. В проде включён SDK — потому дыру и не было видно.
 */
import { test, expect, describe } from "bun:test";
import { buildPayload } from "../lib/dispatch/build-payload.ts";

const ctx = { agentKey: "orchestrator", triggerMessageId: 555 };

/** Действия, у которых схема объявляет messageId обязательным. */
const REQUIRED = ["EDIT_MESSAGE", "PIN_MESSAGE", "DELETE_MESSAGE", "FORWARD_MESSAGE"] as const;

/** Минимальный валидный инпут сверх messageId. */
const extra: Record<string, Record<string, unknown>> = {
  EDIT_MESSAGE: { text: "правка" },
  PIN_MESSAGE: {},
  DELETE_MESSAGE: {},
  FORWARD_MESSAGE: {},
  SET_REACTION: { emoji: "👍" },
};

describe("messageId неверного типа — отказ, а не сообщение-триггер", () => {
  for (const name of REQUIRED) {
    test(`${name}: строка вместо числа отвергается`, () => {
      const r = buildPayload(name, { ...extra[name], messageId: "8231" }, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("messageId");
    });
  }

  test("SET_REACTION тоже отказывает: умолчание — для отсутствующего поля", () => {
    const r = buildPayload("SET_REACTION", { emoji: "👍", messageId: "8231" }, ctx);
    expect(r.ok).toBe(false);
  });

  test("null отвергается: поле названо, значит его хотели указать", () => {
    const r = buildPayload("DELETE_MESSAGE", { messageId: null }, ctx);
    expect(r.ok).toBe(false);
  });

  test("объект отвергается", () => {
    const r = buildPayload("DELETE_MESSAGE", { messageId: { id: 1 } }, ctx);
    expect(r.ok).toBe(false);
  });

  test("дробное отвергается — до Bot API такое доезжать не должно", () => {
    const r = buildPayload("PIN_MESSAGE", { messageId: 1.5 }, ctx);
    expect(r.ok).toBe(false);
  });

  test("NaN отвергается, хотя typeof у него number", () => {
    const r = buildPayload("PIN_MESSAGE", { messageId: NaN }, ctx);
    expect(r.ok).toBe(false);
  });
});

describe("задокументированное поведение не изменилось", () => {
  test("целое число проходит как есть", () => {
    const r = buildPayload("DELETE_MESSAGE", { messageId: 8231 }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.messageId).toBe(8231);
  });

  test("отсутствующее поле по-прежнему берёт сообщение-триггер", () => {
    const r = buildPayload("SET_REACTION", { emoji: "👍" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.messageId).toBe(555);
  });

  test("без триггера и без поля — прежний отказ «required»", () => {
    const r = buildPayload("DELETE_MESSAGE", {}, { agentKey: "orchestrator" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("required");
  });
});

describe("свободный текст: объект — отказ, а не [object Object]", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["SEND_MESSAGE", { text: { ru: "привет", en: "hi" } }, "text"],
    ["EDIT_MESSAGE", { messageId: 8231, text: { ru: "привет" } }, "text"],
    ["COMMENT_TASK", { taskId: "t-1", text: ["строка"] }, "text"],
    [
      "WRITE_WIKI",
      { scope: "_team", slug: "s", title: "T", content: { a: 1 } },
      "content",
    ],
    [
      "SCHEDULE_POST",
      { channel: "delabs", content: { a: 1 }, scheduledAt: 4102444800 },
      "content",
    ],
    ["SPAWN_ROLE", { name: "newrole", system_prompt: { a: 1 } }, "system_prompt"],
    [
      "MAC_RUN_CLAUDE",
      { project: "ai_agents", prompt: { a: 1 }, mode: "ask" },
      "prompt",
    ],
  ];

  for (const [name, input, field] of cases) {
    test(`${name}: ${field} объектом отвергается`, () => {
      const r = buildPayload(name as any, input, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain(field);
        // Именно то, что раньше уезжало наружу под видом текста.
        expect(r.error).not.toContain("[object Object]");
      }
    });
  }

  test("число тоже отвергается: SDK-путь на z.string() ведёт себя так же", () => {
    const r = buildPayload("SEND_MESSAGE", { text: 42 }, ctx);
    expect(r.ok).toBe(false);
  });

  test("нормальная строка проходит без изменений", () => {
    const r = buildPayload("SEND_MESSAGE", { text: "  привет  " }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.text).toBe("привет");
  });

  test("отсутствующий текст даёт прежний отказ «required»", () => {
    const r = buildPayload("SEND_MESSAGE", {}, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("required");
  });

  test("скаляры оставлены снисходительными намеренно", () => {
    // taskId числом по-прежнему приводится к строке: свои проверки ниже по
    // течению дают внятный отказ сами, а ужесточать их — не предмет этого теста.
    const r = buildPayload("COMMENT_TASK", { taskId: 7, text: "ок" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.taskId).toBe("7");
  });
});
