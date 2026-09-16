/**
 * Аудит 2026-09-11, круг 25: доктрину «проза неверного типа — отказ» применили
 * к семи полям из двадцати, и самое наружное осталось за бортом.
 *
 * Аудит 2026-08-29 завёл `proseField` и объяснил, зачем: `String(v)` на
 * объекте даёт непустое `[object Object]`, эта строка уезжает наружу как
 * текст, и восстановить настоящий её уже неоткуда. Тогда же перечислено, что
 * считается прозой — «идущая наружу или в долгое хранение», — и выведено
 * главное основание: SDK-путь (`propToZod` → z.string()) такой вход отбивает
 * сам, сырой tool-loop кастует `input` без проверки, то есть два пути на
 * ОДНОМ инпуте ведут себя по-разному, а в проде включён SDK и дыры не видно.
 *
 * Правка закрыла семь полей и остановилась. Остальные тринадцать собирались
 * по-старому, и хуже всех — `PUBLISH_TO_CHANNEL.text`: единственная проза,
 * уходящая в ПУБЛИЧНЫЙ канал. Там `typeof i.text === "string" ? i.text : ""`,
 * а проверка «пусто — откажи» пропускает пустой текст, если задано фото.
 * `{"text": 12345, "photoUrl": "…"}` давал пост с картинкой и без подписи и
 * `ok:true` в аудите: расхождение «просили / получилось» до вызывающего не
 * доезжало, чего прямо требует шапка `handlePublishToChannel`.
 *
 * Рядом тем же способом терялись подпись к фото и документу, описание
 * создаваемого канала (создание необратимо), вопрос и варианты опроса,
 * заголовок и описание задачи, причина провала, комментарий к ревью,
 * контекст делегирования. Ниже закрыт весь класс разом, а грепом по
 * исходнику — способ, которым он заводится.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPayload } from "../lib/dispatch/build-payload.ts";

const ctx = { agentKey: "orchestrator", triggerMessageId: 555 };
const CHAT = -1002222333;
const PHOTO = "https://example.com/a.png";

/** Действие, минимальный валидный инпут, имя поля — в поле кладём не строку. */
const CASES: Array<[string, Record<string, unknown>, string]> = [
  ["PUBLISH_TO_CHANNEL", { channelId: CHAT, photoUrl: PHOTO }, "text"],
  ["CREATE_POLL", { chatId: CHAT, options: ["да", "нет"] }, "question"],
  ["CREATE_TASK", { chatId: CHAT, title: "заголовок" }, "description"],
  ["CREATE_TASK", { chatId: CHAT }, "title"],
  ["UPDATE_TASK_STATUS", { taskId: "t-1", status: "failed" }, "error"],
  ["REQUEST_REVIEW", { taskId: "t-1" }, "comment"],
  ["SEND_PHOTO", { chatId: CHAT, url: PHOTO }, "caption"],
  ["SEND_DOCUMENT", { chatId: CHAT, filename: "a.txt" }, "content"],
  ["SEND_DOCUMENT", { chatId: CHAT, filename: "a.txt", content: "тело" }, "caption"],
  ["CREATE_TEAM_CHANNEL", { title: "канал" }, "about"],
  ["CREATE_TEAM_CHANNEL", {}, "title"],
  ["WRITE_WIKI", { scope: "_team", slug: "s", content: "тело" }, "title"],
  ["SPLIT_TASK", { chatId: CHAT, roles: ["smm"], title: "з" }, "description"],
  ["SPLIT_TASK", { chatId: CHAT, roles: ["smm"], title: "з" }, "context"],
  ["SPLIT_TASK", { chatId: CHAT, roles: ["smm"] }, "title"],
  ["DELEGATE_TO_ROLE", { role: "smm", task: "сделай" }, "context"],
  ["DELEGATE_TO_ROLE", { role: "smm" }, "task"],
  ["SPAWN_ROLE", { name: "newrole", system_prompt: "ты роль" }, "task_hint"],
];

/** Три формы одной осечки: объект, массив, число. */
const WRONG: unknown[] = [{ ru: "текст", en: "text" }, ["строка"], 12345];

describe("проза неверного типа — отказ на всех действиях", () => {
  for (const [action, base, field] of CASES) {
    test(`${action}.${field}`, () => {
      for (const bad of WRONG) {
        const r = buildPayload(action as never, { ...base, [field]: bad }, ctx);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error).toContain(field);
          // Ровно то, что раньше уезжало наружу под видом текста.
          expect(r.error).not.toContain("[object Object]");
        }
      }
    });
  }

  test("вариант опроса объектом тоже отвергается", () => {
    const r = buildPayload("CREATE_POLL", { chatId: CHAT, question: "?", options: [{ a: 1 }, "нет"] }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("options");
  });
});

describe("законные входы не задеты", () => {
  test("строка проходит как есть", () => {
    const r = buildPayload("PUBLISH_TO_CHANNEL", { channelId: CHAT, text: "  пост  " }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.text).toBe("  пост  ");
  });

  test("отсутствующее поле по-прежнему законно при фото", () => {
    const r = buildPayload("PUBLISH_TO_CHANNEL", { channelId: CHAT, photoUrl: PHOTO }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.text).toBe("");
  });

  test("необязательная проза без значения остаётся undefined", () => {
    const r = buildPayload("REQUEST_REVIEW", { taskId: "t-1" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.comment).toBeUndefined();
  });
});

describe("способ, которым класс заводится, закрыт в исходнике", () => {
  const SRC = readFileSync(
    join(import.meta.dir, "..", "lib", "dispatch", "build-payload.ts"),
    "utf8",
  );
  const PROSE = [
    "text", "content", "caption", "about", "question", "description",
    "comment", "context", "task_hint", "system_prompt", "prompt", "task",
  ];

  test("прозаическое поле не приводится к строке через String(i.поле)", () => {
    const found = PROSE.filter((f) => new RegExp(`String\\(i\\.${f}\\b`).test(SRC));
    expect(found).toEqual([]);
  });

  test("и не подменяется пустой строкой через typeof", () => {
    const found = PROSE.filter((f) =>
      new RegExp(`typeof i\\.${f} === "string" \\? i\\.${f}`).test(SRC),
    );
    expect(found).toEqual([]);
  });
});
