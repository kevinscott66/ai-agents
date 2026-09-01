/**
 * Аудит 2026-08-08: настройки шедулеров принимались через `??`, а приходят из env.
 *
 * orchestrator/services.ts читает их голым `Number(process.env.X)`. `??` ловит
 * только null/undefined, поэтому NaN от опечатки в env проезжал насквозь:
 *
 *  - digest: `now.getUTCHours() < NaN` всегда ложно — окно «не раньше hourUTC»
 *    исчезало, и дайджест уходил в первый тик после полуночи UTC вместо шести.
 *  - db-maint: `DB_MAINT_ARCHIVE_DAYS=0` — правдоподобный ввод оператора в
 *    смысле «не архивировать». Строка "0" истинна, Number("0") = 0, cutoff =
 *    now: за один проход в архив уезжали ВСЕ agent_actions, включая сегодняшние.
 *
 * Обе ветки тихие, поэтому тест смотрит на поведение, а не на лог.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDigestScheduler } from "../lib/digest.ts";
import { startMaintScheduler } from "../lib/db-maint.ts";
import { db } from "../lib/db.ts";
import { logAction } from "../lib/audit.ts";

const TEST_AGENT = "sanitize_probe";
const TEST_CHAT = -100777001;

afterEach(() => {
  db.prepare(`DELETE FROM agent_actions WHERE agent_key = ?`).run(TEST_AGENT);
  db.prepare(`DELETE FROM agent_actions_archive WHERE agent_key = ?`).run(
    TEST_AGENT,
  );
});

/** Один тик нефорсированного расписания: _runNow() форсит и час не проверяет. */
async function tickOnce(opts: { hourUTC: number; iso: string }) {
  const root = mkdtempSync(join(tmpdir(), "sched-opts-"));
  const sent: string[] = [];
  const handle = startDigestScheduler({
    sender: {
      sendMessage: async (_chatId: string | number, text: string) => {
        sent.push(text);
      },
    },
    chatIds: ["111"],
    hourUTC: opts.hourUTC,
    intervalMs: 5,
    markerPath: join(root, ".digest-last"),
    nowProvider: () => new Date(opts.iso),
  });
  await new Promise((r) => setTimeout(r, 60));
  handle.stop();
  rmSync(root, { recursive: true, force: true });
  return sent.length;
}

describe("digest: негодный hourUTC откатывается к дефолту", () => {
  test("NaN не отменяет утреннее окно — в 01:00 UTC ничего не уходит", async () => {
    // До фикса: NaN → сравнение ложно → дайджест уходил прямо здесь.
    expect(await tickOnce({ hourUTC: NaN, iso: "2026-05-20T01:00:00Z" })).toBe(0);
  });

  test("после дефолтных 06:00 UTC дайджест уходит — окно не сломано", async () => {
    expect(await tickOnce({ hourUTC: NaN, iso: "2026-05-20T07:00:00Z" })).toBe(1);
  });

  test("явный корректный час по-прежнему уважается", async () => {
    expect(await tickOnce({ hourUTC: 9, iso: "2026-05-20T08:00:00Z" })).toBe(0);
    expect(await tickOnce({ hourUTC: 9, iso: "2026-05-20T09:30:00Z" })).toBe(1);
  });
});

describe("db-maint: негодный archiveDays не сносит свежие строки", () => {
  function freshActionCount(): number {
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM agent_actions WHERE agent_key = ?`)
      .get(TEST_AGENT) as { n: number };
    return n;
  }

  test("archiveDays=0 не отправляет сегодняшние действия в архив", () => {
    logAction({
      agentKey: TEST_AGENT,
      actionType: "SEND_MESSAGE",
      chatId: TEST_CHAT,
      status: "ok",
    });
    expect(freshActionCount()).toBe(1);

    const h = startMaintScheduler({
      archiveDays: 0, // до фикса: cutoff = now → уезжает всё
      gcIntervalMs: 60_000,
      dailyPollMs: 60_000,
      nowProvider: () => new Date("2026-05-20T04:05:00Z"),
    });
    try {
      h._runDailyNow();
    } finally {
      h.stop();
    }

    expect(freshActionCount()).toBe(1);
  });

  test("NaN в dailyHourUTC не проходит дальше конструктора", () => {
    // Наблюдаемо косвенно: шедулер обязан подняться и не бросить.
    const h = startMaintScheduler({
      dailyHourUTC: NaN,
      archiveDays: NaN,
      gcIntervalMs: 60_000,
      dailyPollMs: 60_000,
    });
    h.stop();
  });
});
