/**
 * Архивация переносит строку целиком и удаляет только скопированное
 * (аудит 2026-08-04).
 *
 * Две дыры в одном месте:
 *
 * 1. Колонки терялись. `*_archive` создавались по схеме источника того времени,
 *    а источник потом оброс полями (миграции 026, 030). INSERT...SELECT
 *    перечисляет колонки явно — новые в список никто не дописал, и следом шёл
 *    DELETE источника. Не гонка, а гарантированная потеря на каждом суточном
 *    прогоне: `request_id` — ключ корреляции действий одного хода, `transport`
 *    отличает bot_api от userbot.
 *
 * 2. DELETE не был связан с INSERT'ом. `INSERT OR IGNORE` на конфликте PK не
 *    бросает — молча пропускает строку, а DELETE по тому же предикату времени
 *    сносил её всё равно. Транзакция не спасает: сбоя не было, откатывать
 *    нечего. Наружу при этом уходил COUNT отобранных строк, а не число вставок,
 *    так что пропуск выглядел в логе успешной архивацией.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import { gcMessages, archiveOldRows } from "../lib/db-maint.ts";
import { DAY_MS } from "../lib/time-constants.ts";

const CHAT = "-1009004040";
const CHAT_NUM = -1009004040;
const NOW = 1_800_000_000_000;
const OLD = NOW - 200 * DAY_MS;

function cleanup(): void {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT);
  db.prepare(`DELETE FROM messages_archive WHERE chat_id = ?`).run(CHAT);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT_NUM);
  db.prepare(`DELETE FROM agent_actions_archive WHERE chat_id = ?`).run(CHAT_NUM);
}

beforeEach(cleanup);
afterEach(cleanup);

describe("колонки доезжают до архива", () => {
  test("messages: tg_message_id/transport не теряются", () => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO messages
             (chat_id, agent_key, is_bot, from_user_id, from_name, text, ts,
              tg_message_id, transport)
           VALUES (?, 'smm', 1, '42', 'alice', 'привет', ?, 777, 'userbot')`,
        )
        .run(CHAT, OLD).lastInsertRowid,
    );

    // Счётчики тут глобальные (gcMessages чистит всю таблицу, а в общем прогоне
    // в ней лежат фикстуры соседних файлов), поэтому проверяем свою строку.
    const res = gcMessages({ retentionDays: 90, now: NOW });
    expect(res.archived).toBeGreaterThanOrEqual(1);

    const row = db
      .prepare(`SELECT * FROM messages_archive WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    // Оба поля молча обрезались до миграции 040: transport — единственное, что
    // отличает bot_api от userbot, то есть «кто на самом деле отправил».
    expect(row.tg_message_id).toBe(777);
    expect(row.transport).toBe("userbot");
    // Контроль: остальное как было.
    expect(row.text).toBe("привет");
    expect(row.agent_key).toBe("smm");
    expect(row.archived_at).toBe(NOW);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE id = ?`).get(id),
    ).toEqual({ n: 0 });
  });

  test("agent_actions: request_id/tg_message_id не теряются", () => {
    db.prepare(
      `INSERT INTO agent_actions
         (id, agent_key, task_id, chat_id, action_type, payload, status,
          result, error, created_at, tg_message_id, request_id)
       VALUES ('aa-040', 'qa', NULL, ?, 'SEND_MESSAGE', '{}', 'done',
               NULL, NULL, ?, 555, 'req-040')`,
    ).run(CHAT_NUM, OLD);

    archiveOldRows({ olderThanDays: 30, now: NOW });

    const row = db
      .prepare(`SELECT * FROM agent_actions_archive WHERE id = 'aa-040'`)
      .get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    // Без request_id архивный след перестаёт группироваться по ходу — ровно то,
    // ради чего колонка и заводилась (миграция 026).
    expect(row.request_id).toBe("req-040");
    expect(row.tg_message_id).toBe(555);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM agent_actions WHERE id = 'aa-040'`).get(),
    ).toEqual({ n: 0 });
  });
});

describe("удаляется только скопированное", () => {
  test("строка, уже лежащая в архиве, не архивируется повторно", () => {
    // INSERT OR IGNORE её пропустит. Удалить источник при этом законно (в архиве
    // она есть) — а вот считать её заархивированной этим прогоном нельзя.
    // Признак пропуска — archived_at остался прежним, а не стал NOW.
    const id = Number(
      db
        .prepare(
          `INSERT INTO messages (chat_id, agent_key, is_bot, from_user_id, from_name, text, ts)
           VALUES (?, NULL, 0, '42', 'alice', 'dup', ?)`,
        )
        .run(CHAT, OLD).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO messages_archive
         (id, chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, archived_at)
       VALUES (?, ?, NULL, 0, '42', 'alice', 'dup', ?, ?)`,
    ).run(id, CHAT, OLD, OLD);

    gcMessages({ retentionDays: 90, now: NOW });

    const row = db
      .prepare(`SELECT archived_at, text FROM messages_archive WHERE id = ?`)
      .get(id) as { archived_at: number; text: string };
    expect(row.archived_at).toBe(OLD); // вставки не было — иначе стало бы NOW
    expect(row.text).toBe("dup");
    // При этом источник всё равно убран: строка доказуемо есть в архиве.
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE id = ?`).get(id),
    ).toEqual({ n: 0 });
  });

  test("свежие строки не трогаются", () => {
    db.prepare(
      `INSERT INTO messages (chat_id, agent_key, is_bot, from_user_id, from_name, text, ts)
       VALUES (?, NULL, 0, '42', 'alice', 'fresh', ?)`,
    ).run(CHAT, NOW - DAY_MS);

    gcMessages({ retentionDays: 90, now: NOW });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?`).get(CHAT),
    ).toEqual({ n: 1 });
  });
});

describe("структура решения", () => {
  const SRC = readFileSync(new URL("../lib/db-maint.ts", import.meta.url), "utf8");

  test("DELETE привязан к наличию строки в архиве", () => {
    // Поведенческого теста на «не удалили неархивированное» нет: единственная
    // причина пропуска у OR IGNORE — конфликт PK, а он как раз означает, что
    // строка в архиве есть. Поэтому инвариант закрепляем по тексту запроса.
    const del = SRC.slice(SRC.indexOf("DELETE FROM ${spec.source}"));
    expect(del.slice(0, 200)).toMatch(/EXISTS \(SELECT 1 FROM \$\{spec\.archive\}/);
  });

  test("наружу отдаётся число вставок, а не отобранных строк", () => {
    expect(SRC).toMatch(/archived: res\.inserted/);
  });
});
