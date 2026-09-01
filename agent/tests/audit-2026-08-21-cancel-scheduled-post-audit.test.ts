/**
 * Аудит 2026-08-21: CANCEL_SCHEDULED_POST — единственная МУТАЦИЯ среди
 * инлайновых тулзов — не оставляла строки в `agent_actions`.
 *
 * Инлайновый блок в tools-schema.ts замыкается ДО `gateOrDispatch`, а все
 * записи в журнал делает диспатчер. Для читающего QUERY_DB эту дыру уже
 * закрыли отдельной функцией `logToolCall` (аудит 2026-08-04) — ровно с
 * формулировкой «любое другое действие с последствиями строку пишет».
 * Отмена запланированного поста строку не писала.
 *
 * Цена: пост исчезает из LIST_SCHEDULED_POSTS (тот фильтрует
 * `status='scheduled'`), владелец спрашивает «кто снял», идёт в GET_LOGS —
 * а GET_LOGS читает ровно `agent_actions` (listActions) и не показывает
 * ничего. Единственный след — `log.info` в stdout юнита, который ротируется
 * и в Mini App не виден. Асимметрия ещё и в том, что постановка в календарь
 * (SCHEDULE_POST) требует апрува, а снятие проходило молча.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { getAction, listActions } from "../lib/audit.ts";

const CHAT = -1_000_821;
const CTX = { agentKey: "smm", chatId: CHAT };

function seedPost(id: string, chatId: number | null = CHAT): void {
  db.prepare(
    `INSERT INTO content_calendar(id, channel, scheduled_at, payload, status, created_at, chat_id)
     VALUES (?, '@delabs', ?, '{"text":"x"}', 'scheduled', ?, ?)`,
  ).run(id, Date.now() + 3_600_000, Date.now(), chatId);
}

const cancels = () =>
  listActions({ chatId: CHAT, limit: 50 }).filter(
    (a) => a.action_type === "CANCEL_SCHEDULED_POST",
  );

// Аудит 2026-08-28: listActions отдаёт метаданные без тел (её потребители —
// `/audit` и GET_LOGS — их и не печатают). Сам payload берём точечно, тем же
// getAction, каким его читает diagnostic-action.
const cancelPayload = (i = 0) => getAction(cancels()[i].id)!.payload;

describe("CANCEL_SCHEDULED_POST оставляет след в agent_actions", () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM content_calendar WHERE chat_id = ?`).run(CHAT);
    db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT);
  });

  test("успешная отмена — строка в журнале, видна GET_LOGS", async () => {
    seedPost("p-ok");
    const out = JSON.parse(await executeTool("CANCEL_SCHEDULED_POST", { id: "p-ok" }, CTX));
    expect(out.ok).toBe(true);

    const rows = cancels();
    expect(rows.length).toBe(1);
    expect({ agent: rows[0].agent_key, status: rows[0].status }).toEqual({
      agent: "smm",
      status: "ok",
    });
    // id отменённого поста обязан быть в payload — иначе строка отвечает
    // «кто-то что-то отменил» и не отвечает «что именно».
    expect(JSON.stringify(getAction(rows[0].id)!.payload)).toContain("p-ok");
  });

  test("GET_LOGS показывает отмену", async () => {
    seedPost("p-log");
    await executeTool("CANCEL_SCHEDULED_POST", { id: "p-log" }, CTX);
    const logs = JSON.parse(await executeTool("GET_LOGS", { limit: 50 }, CTX));
    expect(logs.ok).toBe(true);
    expect(logs.logs.some((l: { action: string }) => l.action === "CANCEL_SCHEDULED_POST")).toBe(
      true,
    );
  });

  test("отказ «нет такого поста» тоже пишется, со статусом error", async () => {
    const out = JSON.parse(await executeTool("CANCEL_SCHEDULED_POST", { id: "нет" }, CTX));
    expect(out.ok).toBe(false);
    const rows = cancels();
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("error");
  });

  test("чужую роль отбивает exposure-гейт, до журналируемого блока не доходит", async () => {
    // Граница правки. ROLE_EXPOSED_TOOLS.CANCEL_SCHEDULED_POST — тот же список
    // ["smm","orchestrator"], поэтому отказ приходит РАНЬШЕ инлайнового блока и
    // с другим текстом. Строки в журнале тут нет, и это не регрессия: писать
    // отказы exposure-гейта — общий вопрос для всех тулзов, а не этой правки.
    seedPost("p-role");
    const out = JSON.parse(
      await executeTool("CANCEL_SCHEDULED_POST", { id: "p-role" }, { agentKey: "design", chatId: CHAT }),
    );
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("недоступен роли design");
    // Отказ должен быть отказом: пост остаётся запланированным.
    const row = db
      .prepare(`SELECT status FROM content_calendar WHERE id = ?`)
      .get("p-role") as { status: string };
    expect(row.status).toBe("scheduled");
  });

  test("пустой id у разрешённой роли — тоже строка в журнале", async () => {
    const out = JSON.parse(await executeTool("CANCEL_SCHEDULED_POST", { id: "  " }, CTX));
    expect(out.ok).toBe(false);
    expect(cancels().map((r) => r.status)).toEqual(["error"]);
  });

  test("журнал не становится копией поста: payload только id", async () => {
    seedPost("p-slim");
    await executeTool("CANCEL_SCHEDULED_POST", { id: "p-slim" }, CTX);
    // В content_calendar.payload лежит тело поста. В аудит его тащить не надо —
    // это второе хранилище содержимого, ровно то, чего избегает QUERY_DB.
    expect(JSON.stringify(cancelPayload())).not.toContain('"text"');
  });
});
