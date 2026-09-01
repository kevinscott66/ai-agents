// Аудит 2026-08-29: списки с потолком резались по неполному ключу сортировки.
//
// `ORDER BY created_at DESC LIMIT ?` (и `priority DESC, created_at ASC LIMIT ?`)
// не задаёт полного порядка: строки с одинаковым временем планировщик
// расставляет как ему удобнее. Пока потолка нет — это косметика, но с LIMIT
// именно тай-брейк решает, какие строки вообще попадут в выдачу. Совпадение
// времени здесь не гипотетика, а норма: SPLIT_TASK кладёт подзадачи пачкой,
// один ход агента пишет несколько строк аудита и несколько карточек
// согласования в ту же миллисекунду.
//
// Итог: два одинаковых запроса возвращали разные наборы, а в Mini App от этого
// плавал ещё и флаг `truncated` — лишняя строка probe бралась с плавающей
// границы. Ключ замкнут по `rowid` (для team_channels — по `channel_id`,
// который и есть rowid): это порядок вставки, то есть ровно то, что и так
// отдавалось на практике. Тот же приём уже стоял в listTasksByChat.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createTask, listTasksByAssignee } from "../lib/tasks.ts";
import { logAction, listActions } from "../lib/audit.ts";
import { cleanupChat } from "./_helpers.ts";

const CHAT = -1_000_992;
const AGENT = "qa";

/** Пишет строки одной пачкой и подменяет им время на общее. */
function sameInstant(table: string, ids: string[], ts: number) {
  const q = db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`);
  for (const id of ids) q.run(ts, id);
}

beforeEach(() => cleanupChat(CHAT, AGENT));
afterEach(() => cleanupChat(CHAT, AGENT));

describe("выдача с потолком не зависит от удачи планировщика", () => {
  test("задачи роли: одинаковые приоритет и время — порядок вставки", () => {
    const ids = ["в", "а", "б", "г", "д"].map(
      (t) =>
        createTask({
          chatId: CHAT,
          createdBy: "orchestrator",
          assignedTo: AGENT,
          title: `подзадача ${t}`,
          priority: 5,
        }).id,
    );
    sameInstant("tasks", ids, 1_700_000_000_000);

    const first = listTasksByAssignee(AGENT, undefined, 3, CHAT).map((t) => t.id);
    const second = listTasksByAssignee(AGENT, undefined, 3, CHAT).map((t) => t.id);
    expect(first).toHaveLength(3);
    // Порядок вставки, а не порядок заголовков и не порядок uuid.
    expect(first).toEqual(ids.slice(0, 3));
    expect(second).toEqual(first);
  });

  test("задачи роли: граница LIMIT устойчива при росте потолка", () => {
    const ids = Array.from({ length: 6 }, (_, i) =>
      createTask({
        chatId: CHAT,
        createdBy: "orchestrator",
        assignedTo: AGENT,
        title: `t${i}`,
        priority: 1,
      }).id,
    );
    sameInstant("tasks", ids, 1_700_000_001_000);
    // Верхние N не должны меняться от того, сколько строк попросили: иначе
    // «показать больше» перетасовывало бы уже показанное.
    const top2 = listTasksByAssignee(AGENT, undefined, 2, CHAT).map((t) => t.id);
    const top5 = listTasksByAssignee(AGENT, undefined, 5, CHAT).map((t) => t.id);
    expect(top5.slice(0, 2)).toEqual(top2);
  });

  test("аудит: строки одной миллисекунды идут новыми сверху и стабильно", () => {
    const ids = Array.from({ length: 5 }, (_, i) =>
      logAction({
        agentKey: AGENT,
        chatId: CHAT,
        actionType: "SEND_MESSAGE",
        status: "ok",
        payload: { text: `строка ${i}` },
      }).id,
    );
    sameInstant("agent_actions", ids, 1_700_000_002_000);

    const first = listActions({ agentKey: AGENT, limit: 3 }).map((a) => a.id);
    const second = listActions({ agentKey: AGENT, limit: 3 }).map((a) => a.id);
    // DESC по времени → DESC по rowid: сверху последняя вставленная.
    expect(first).toEqual([...ids].reverse().slice(0, 3));
    expect(second).toEqual(first);
  });

  test("аудит: индекс по created_at всё ещё используется", () => {
    // Тай-брейк стоит денег, только если планировщик перестанет опираться на
    // индекс и уйдёт в полный SCAN таблицы. Досортировка внутри группы с
    // одинаковым временем («LAST TERM OF ORDER BY») — не то же самое и дешева.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM agent_actions
         WHERE agent_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(AGENT, 20) as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(" | ");
    // Который из двух индексов по (agent_key, created_at) выберет планировщик,
    // зависит от статистики таблицы — на пустой БД это _agent_ts, на
    // наполненной _agent_created. Утверждается не выбор, а то, что индекс по
    // agent_key вообще идёт в дело и полного перебора таблицы нет.
    expect(detail).toContain("USING INDEX idx_agent_actions_agent");
    expect(detail).not.toContain("SCAN agent_actions ");
    expect(detail.endsWith("SCAN agent_actions")).toBe(false);
  });
});

describe("ключи сортировки замкнуты во всех списках с потолком", () => {
  // Источник правды — сам SQL: тест ловит возврат к неполному ключу в местах,
  // которые дорого разыгрывать данными (Mini App-ручки, каналы команды).
  const SITES: Array<[string, string]> = [
    ["lib/tasks.ts", "priority DESC, created_at ASC, rowid ASC"],
    ["lib/audit.ts", "created_at DESC, rowid DESC LIMIT ?"],
    ["lib/approvals.ts", "a.created_at ASC, a.rowid ASC LIMIT ?"],
    ["lib/self-diag.ts", "priority DESC, created_at ASC, rowid ASC"],
    ["lib/team-channels.ts", "created_at DESC, channel_id DESC LIMIT 50"],
  ];
  for (const [file, needle] of SITES) {
    test(`${file}: ${needle}`, async () => {
      const src = await Bun.file(
        new URL(`../${file}`, import.meta.url).pathname,
      ).text();
      expect(src).toContain(needle);
    });
  }

  test("lib/miniapp-server.ts: ни одного ORDER BY created_at без тай-брейка", () => {
    const src = require("node:fs").readFileSync(
      new URL("../lib/miniapp-server.ts", import.meta.url).pathname,
      "utf8",
    ) as string;
    const bare = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .filter((l) => /ORDER BY created_at (ASC|DESC)(?!,)/.test(l));
    expect(bare).toEqual([]);
  });
});
