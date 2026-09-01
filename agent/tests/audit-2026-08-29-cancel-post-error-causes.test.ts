/**
 * Аудит 2026-08-29: отмена поста отвечала одной фразой на три разные причины.
 *
 * `UPDATE ... WHERE id = ? AND status = 'scheduled' AND chat_id = ?` даёт
 * `changes === 0` в трёх несовместимых случаях, а наружу и в журнал уходило
 * одно и то же «no scheduled post with this id in this chat»:
 *
 *   1. id выдуман (модель сама его и сочинила) — надо перечитать
 *      LIST_SCHEDULED_POSTS;
 *   2. пост в этом же чате, но уже `cancelled`/`sent` — с точки зрения
 *      просившего цель ДОСТИГНУТА, повторять нечего, а по прежнему ответу
 *      («такого поста нет») агент делает вывод, что снять не удалось;
 *   3. пост существует и запланирован, но в ЧУЖОМ чате — это попытка выйти
 *      за границу, и оператору она интересна отдельно от опечатки.
 *
 * Разделять их наружу можно не везде: случай 3 наружу обязан выглядеть ровно
 * как случай 1, иначе перебором id можно выяснить, что соседний чат такой
 * пост планировал. Поэтому точная причина уезжает в `agent_actions`, а ответ
 * агенту остаётся неотличимым — это проверяется отдельным тестом ниже.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
// Порядок импортов значим: если первым в частичном прогоне вычисляется
// lib/tools-schema.ts, круговая зависимость роняет весь файл на
// `Cannot access 'INLINE_TOOL_NAMES' before initialization`
// (agent-sdk-runtime.ts:347). В полном гейте порядок задают другие файлы,
// в одиночном прогоне — этот импорт.
import "../lib/agent-sdk-runtime.ts";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { getAction, listActions } from "../lib/audit.ts";

const CHAT = -1_000_829;
const OTHER = -1_000_830;
const CTX = { agentKey: "smm", chatId: CHAT };

function seedPost(id: string, chatId: number, status = "scheduled"): void {
  db.prepare(
    `INSERT INTO content_calendar(id, channel, scheduled_at, payload, status, created_at, chat_id)
     VALUES (?, '@delabs', ?, '{"text":"x"}', ?, ?, ?)`,
  ).run(id, Date.now() + 3_600_000, status, Date.now(), chatId);
}

const cancels = () =>
  listActions({ chatId: CHAT, limit: 50 }).filter((a) => a.action_type === "CANCEL_SCHEDULED_POST");

const lastAuditError = (): string | null => {
  const rows = cancels();
  expect(rows.length).toBe(1);
  return getAction(rows[0].id)!.error;
};

function wipe(): void {
  for (const c of [CHAT, OTHER]) {
    db.prepare(`DELETE FROM content_calendar WHERE chat_id = ?`).run(c);
    db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(c);
  }
}

beforeEach(wipe);
afterEach(wipe);

describe("свой чат: уже снятый пост — это не «поста нет»", () => {
  test("повторная отмена сообщает текущий статус, а не отсутствие", async () => {
    seedPost("c-done", CHAT, "cancelled");
    const out = JSON.parse(await executeTool("CANCEL_SCHEDULED_POST", { id: "c-done" }, CTX));
    expect(out.ok).toBe(false);
    expect(out.status).toBe("cancelled");
    expect(out.error).toContain("already");
    expect(out.error).not.toContain("no scheduled post");
  });

  test("уже отправленный пост тоже назван своим статусом", async () => {
    // CHECK в content_calendar допускает ровно scheduled/sent/cancelled —
    // отсюда `sent`, а не `published`.
    seedPost("c-sent", CHAT, "sent");
    const out = JSON.parse(await executeTool("CANCEL_SCHEDULED_POST", { id: "c-sent" }, CTX));
    expect(out.status).toBe("sent");
    expect(out.error).toContain("sent");
  });

  test("причина уезжает и в журнал, не только в ответ", async () => {
    seedPost("c-log", CHAT, "cancelled");
    await executeTool("CANCEL_SCHEDULED_POST", { id: "c-log" }, CTX);
    expect(lastAuditError()).toContain("already");
  });

  test("запись в календаре не переписывается повторной отменой", async () => {
    seedPost("c-keep", CHAT, "sent");
    await executeTool("CANCEL_SCHEDULED_POST", { id: "c-keep" }, CTX);
    const row = db.prepare(`SELECT status FROM content_calendar WHERE id = ?`).get("c-keep") as {
      status: string;
    };
    expect(row.status).toBe("sent");
  });
});

describe("чужой чат: наружу молчим, в журнал пишем", () => {
  test("ответ на чужой пост побайтово равен ответу на выдуманный id", async () => {
    // Это и есть защита от перебора: разница в ответе выдала бы, что пост есть.
    seedPost("x-alien", OTHER);
    const alien = await executeTool("CANCEL_SCHEDULED_POST", { id: "x-alien" }, CTX);
    const ghost = await executeTool("CANCEL_SCHEDULED_POST", { id: "x-ghost" }, CTX);
    expect(alien).toBe(ghost);
    expect(JSON.parse(alien).ok).toBe(false);
  });

  test("журнал отличает чужой чат от опечатки", async () => {
    seedPost("x-alien2", OTHER);
    await executeTool("CANCEL_SCHEDULED_POST", { id: "x-alien2" }, CTX);
    expect(lastAuditError()).toContain("another chat");
  });

  test("выдуманный id в журнале назван выдуманным", async () => {
    await executeTool("CANCEL_SCHEDULED_POST", { id: "x-ghost2" }, CTX);
    const err = lastAuditError() ?? "";
    expect(err).toContain("no post with this id");
    expect(err).not.toContain("another chat");
  });

  test("чужой пост остаётся запланированным", async () => {
    seedPost("x-alien3", OTHER);
    await executeTool("CANCEL_SCHEDULED_POST", { id: "x-alien3" }, CTX);
    const row = db.prepare(`SELECT status FROM content_calendar WHERE id = ?`).get("x-alien3") as {
      status: string;
    };
    expect(row.status).toBe("scheduled");
  });
});

describe("рабочий путь не задет", () => {
  test("запланированный пост в своём чате снимается как раньше", async () => {
    seedPost("ok-1", CHAT);
    const out = JSON.parse(await executeTool("CANCEL_SCHEDULED_POST", { id: "ok-1" }, CTX));
    expect(out).toEqual({ ok: true, id: "ok-1", status: "cancelled" });
    expect(lastAuditError()).toBeNull();
  });

  test("пустой id по-прежнему отбивается до обращения к базе", async () => {
    const out = JSON.parse(await executeTool("CANCEL_SCHEDULED_POST", { id: "   " }, CTX));
    expect(out.ok).toBe(false);
    expect(out.error).toBe("id is required");
  });
});
