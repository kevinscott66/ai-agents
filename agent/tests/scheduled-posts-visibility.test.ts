/**
 * Аудит 2026-08-13: календарь публикаций, две находки вокруг видимости.
 *
 * 1. `LIST_SCHEDULED_POSTS` не было ни в `CALLER_RESTRICTED`, ни в
 *    `ROLE_EXPOSED_TOOLS` — то есть перечислять план публикаций мог кто угодно
 *    из 12 ролей, при том что завести и отменить запись могут только
 *    smm/orchestrator. Соседний комментарий в permissions.ts прямо обещает
 *    «видеть и отменять — только эти двое».
 *
 * 2. Выдача была `ORDER BY scheduled_at ASC LIMIT 50` — пятьдесят самых СТАРЫХ.
 *    Из 'scheduled' строка не уходит никогда (публикатора нет, в ARCHIVE_SPECS
 *    таблицы нет), так что просроченные копятся в голове списка навсегда, а
 *    новая запись становится невидимой — и неотменяемой, потому что описание
 *    CANCEL_SCHEDULED_POST велит искать id именно через LIST.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { executeTool } from "../lib/tools-schema.ts";
import { ROLE_EXPOSED_TOOLS, isToolExposedToRole } from "../lib/permissions.ts";
import { db } from "../lib/db.ts";

const CHAT = -1_000_713;
const CHANNEL = "@cal_vis";
const HOUR = 3600_000;
const ctx = (agentKey: string) => ({ agentKey, chatId: CHAT });

function seed(id: string, offsetMs: number): void {
  db.prepare(
    `INSERT INTO content_calendar
       (id, channel, scheduled_at, payload, status, created_at, chat_id)
     VALUES (?, ?, ?, '{}', 'scheduled', ?, ?)`,
  ).run(id, CHANNEL, Date.now() + offsetMs, Date.now(), CHAT);
}

function clean(): void {
  db.prepare(`DELETE FROM content_calendar WHERE chat_id = ?`).run(CHAT);
}

async function list(agentKey = "smm"): Promise<any> {
  return JSON.parse(
    await executeTool("LIST_SCHEDULED_POSTS", { channel: CHANNEL }, ctx(agentKey)),
  );
}

beforeEach(clean);
afterAll(clean);

describe("календарь виден только своим", () => {
  test("LIST закреплён за той же парой, что SCHEDULE и CANCEL", () => {
    expect(ROLE_EXPOSED_TOOLS.LIST_SCHEDULED_POSTS).toEqual([
      "smm",
      "orchestrator",
    ]);
    // Та же пара, что у соседей по календарю — иначе комментарий рядом с ними
    // снова начнёт обещать больше, чем код делает.
    expect(ROLE_EXPOSED_TOOLS.LIST_SCHEDULED_POSTS).toEqual(
      ROLE_EXPOSED_TOOLS.CANCEL_SCHEDULED_POST,
    );
    expect(isToolExposedToRole("LIST_SCHEDULED_POSTS", "smm")).toBe(true);
    expect(isToolExposedToRole("LIST_SCHEDULED_POSTS", "orchestrator")).toBe(true);
    expect(isToolExposedToRole("LIST_SCHEDULED_POSTS", "backend")).toBe(false);
  });

  test("чужая роль получает отказ, а не список", async () => {
    seed("vis-secret", 24 * HOUR);
    const out = await list("backend");
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("LIST_SCHEDULED_POSTS");
    // Ни одной записи наружу.
    expect(JSON.stringify(out)).not.toContain("vis-secret");
  });

  test("smm по-прежнему видит свой календарь", async () => {
    seed("vis-own", 24 * HOUR);
    const out = await list();
    expect(out.ok).toBe(true);
    expect(out.posts.map((p: any) => p.id)).toContain("vis-own");
  });
});

describe("новая запись видна, даже когда просроченных много", () => {
  test("пятьдесят просроченных не вытесняют завтрашнюю", async () => {
    // Ровно потолок выдачи — то же число, на котором ловили очередь одобрений.
    for (let i = 0; i < 50; i++) seed(`vis-old-${i}`, -(i + 1) * 24 * HOUR);
    seed("vis-tomorrow", 24 * HOUR);

    const out = await list();
    expect(out.ok).toBe(true);
    const ids = out.posts.map((p: any) => p.id);
    // До фикса здесь были пятьдесят самых древних, а завтрашняя — 51-й строкой.
    expect(ids[0]).toBe("vis-tomorrow");
    expect(ids).toContain("vis-tomorrow");
  });

  test("будущее — по хронологии, прошлое — от свежего к древнему", async () => {
    seed("vis-f2", 48 * HOUR);
    seed("vis-f1", 2 * HOUR);
    seed("vis-p1", -2 * HOUR);
    seed("vis-p2", -48 * HOUR);

    const out = await list();
    expect(out.posts.map((p: any) => p.id)).toEqual([
      "vis-f1",
      "vis-f2",
      "vis-p1",
      "vis-p2",
    ]);
  });

  test("обрезка названа вслух, а не выглядит как «это всё»", async () => {
    for (let i = 0; i < 55; i++) seed(`vis-many-${i}`, (i + 1) * HOUR);
    const out = await list();
    expect(out.count).toBe(50);
    expect(out.total).toBe(55);
    expect(out.truncated).toBe(true);
  });

  test("без обрезки флаг не поднимается, просроченные посчитаны", async () => {
    seed("vis-a", 5 * HOUR);
    seed("vis-b", -5 * HOUR);
    const out = await list();
    expect(out.truncated).toBe(false);
    expect(out.total).toBe(2);
    expect(out.overdue_count).toBe(1);
  });
});
