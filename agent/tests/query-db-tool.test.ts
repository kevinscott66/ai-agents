/**
 * T-714 (2026-06-10): QUERY_DB — read-only SQL для backend, безопасно.
 * SELECT-only, денилист приватных таблиц (messages/wiki/audit/...), авто-LIMIT.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { validateQueryDbSql, runQueryDbSandboxed } from "../lib/query-db.ts";

const CTX = { agentKey: "backend", chatId: -1_000_714 };
const run = async (sql: string, extra: Record<string, unknown> = {}) =>
  JSON.parse(await executeTool("QUERY_DB", { sql, ...extra }, CTX));

describe("QUERY_DB", () => {
  test("SELECT по операционной таблице — ok", async () => {
    const out = await run("SELECT name FROM schema_migrations");
    expect(out.ok).toBe(true);
    expect(Array.isArray(out.rows)).toBe(true);
  });

  test("PRAGMA table_info — ok (валидация схемы)", async () => {
    const out = await run("PRAGMA table_info(tasks)");
    expect(out.ok).toBe(true);
  });

  test("приватная messages — ЗАКРЫТА", async () => {
    const out = await run("SELECT text FROM messages");
    expect(out.ok).toBe(false);
    expect(out.error).toContain("messages");
  });

  test("wiki_fts — ЗАКРЫТА", async () => {
    const out = await run("SELECT * FROM wiki_fts");
    expect(out.ok).toBe(false);
  });

  test("не-SELECT (DELETE) — отклонён", async () => {
    const out = await run("DELETE FROM tasks");
    expect(out.ok).toBe(false);
  });

  test("multi-statement (;) — отклонён", async () => {
    const out = await run("SELECT 1; DROP TABLE tasks");
    expect(out.ok).toBe(false);
  });

  test("UPDATE замаскированный — отклонён (не начинается с select)", async () => {
    const out = await run("UPDATE permissions SET allowed=1");
    expect(out.ok).toBe(false);
  });

  test("авто-LIMIT применяется", async () => {
    const out = await run("SELECT 1 AS x UNION SELECT 2 UNION SELECT 3", { limit: 2 });
    expect(out.ok).toBe(true);
    expect(out.rows.length).toBeLessThanOrEqual(2);
  });
});

/**
 * 2026-08-02: проверка префикса — НЕ граница безопасности. SQLite разрешает
 * CTE перед DML, поэтому `WITH … UPDATE/DELETE/INSERT` начинается с `with`,
 * не содержит ';' и может не упоминать ни одной таблицы из денилиста. До фикса
 * такой запрос переписывал таблицу `permissions` — то есть сам гейт прав —
 * молча, без строки в agent_actions (QUERY_DB идёт мимо gateOrDispatch).
 * Границей сделано read-only соединение: отказывает сам SQLite.
 */
describe("QUERY_DB — запись невозможна ни в каком виде", () => {
  const writes: Array<[string, string]> = [
    ["CTE + UPDATE", "WITH x AS (SELECT 1) UPDATE permissions SET allowed = 1 WHERE agent_key IN (SELECT agent_key FROM permissions LIMIT 99)"],
    ["CTE + DELETE", "WITH x AS (SELECT 1) DELETE FROM permissions WHERE allowed IN (SELECT 1 LIMIT 5)"],
    ["CTE + INSERT", "WITH x AS (SELECT 1) INSERT INTO permissions(agent_key, action_type, allowed) SELECT 'qa','MAC_RUN_CLAUDE',1 LIMIT 1"],
  ];
  for (const [label, sql] of writes) {
    test(`${label} — отклонён`, async () => {
      const out = await run(sql);
      expect(out.ok).toBe(false);
    });
  }

  test("права не изменились после попытки записи", async () => {
    const before = await run("SELECT count(*) AS n FROM permissions WHERE allowed = 1");
    await run(writes[0][1]);
    const after = await run("SELECT count(*) AS n FROM permissions WHERE allowed = 1");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test("обычный SELECT продолжает работать через read-only соединение", async () => {
    const out = await run("SELECT name FROM schema_migrations LIMIT 1");
    expect(out.ok).toBe(true);
  });
});

/**
 * DoS-вектор (найден при аудите 2026-08-02). Префикс и денилист его не ловят
 * принципиально: рекурсивный CTE начинается с `with` и не упоминает ни одной
 * закрытой таблицы, а авто-LIMIT приписывается снаружи агрегата. Замеры до
 * фикса: 200k строк — 40мс, 2M — 400мс, линейно → 1e9 ≈ 200 секунд полностью
 * синхронной блокировки процесса (все 12 ботов, Mini App, планировщики).
 */
describe("QUERY_DB — бюджет ресурсов", () => {
  const HOSTILE =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000000000) SELECT count(*) AS n FROM c";

  test("валидатор такой запрос НЕ ловит — защита обязана быть на исполнении", () => {
    const v = validateQueryDbSql(HOSTILE);
    expect(v.ok).toBe(true);
  });

  test("враждебный запрос прерывается по таймауту, а не висит", async () => {
    const v = validateQueryDbSql(HOSTILE);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const t0 = performance.now();
    const r = await runQueryDbSandboxed(v.sql, v.limit, { timeoutMs: 1200 });
    const elapsed = performance.now() - t0;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/прерван/);
    expect(elapsed).toBeLessThan(6000);
  });

  test("основной процесс остаётся отзывчивым, пока запрос молотит", async () => {
    const v = validateQueryDbSql(HOSTILE);
    if (!v.ok) throw new Error("validator changed");
    let ticks = 0;
    const iv = setInterval(() => ticks++, 100);
    await runQueryDbSandboxed(v.sql, v.limit, { timeoutMs: 1200 });
    clearInterval(iv);
    // Синхронный запрос внутри процесса дал бы 0 тиков.
    expect(ticks).toBeGreaterThan(5);
  });

  test("нормальный запрос по-прежнему возвращает строки", async () => {
    const r = await runQueryDbSandboxed("SELECT 1+1 AS n", 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.rows[0] as { n: number }).n).toBe(2);
  });
});

/**
 * Таймаут закрывает только процессорный вектор. Отдельно нужен бюджет на
 * ОБЪЁМ: limit считает строки, а не байты, и `hex(zeroblob(N))` даёт одну
 * быструю строку произвольного веса. Замер 2026-08-02: 50 МБ blob поднимал
 * RSS основного процесса с 34 до 425 МБ, двадцать строк по 10 МБ — до 1.5 ГБ,
 * то есть при limit=200 это OOM-kill юнита, а не фриз.
 */
describe("QUERY_DB — бюджет памяти", () => {
  const FAT_ONE = "SELECT hex(zeroblob(5000000)) AS blob";
  const FAT_MANY =
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 20) " +
    "SELECT hex(zeroblob(200000)) AS blob FROM c";

  test("валидатор жирный запрос НЕ ловит — как и в случае с CPU", () => {
    expect(validateQueryDbSql(FAT_ONE).ok).toBe(true);
    expect(validateQueryDbSql(FAT_MANY).ok).toBe(true);
  });

  test("одна строка сверх бюджета → отказ, а не 10 МБ в память", async () => {
    const v = validateQueryDbSql(FAT_ONE);
    if (!v.ok) throw new Error("validator changed");
    const r = await runQueryDbSandboxed(v.sql, v.limit, { maxBytes: 100_000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/100000 байт|превысил/);
  });

  test("много жирных строк → отдаём префикс и признак усечения", async () => {
    const v = validateQueryDbSql(FAT_MANY);
    if (!v.ok) throw new Error("validator changed");
    const r = await runQueryDbSandboxed(v.sql, v.limit, { maxBytes: 1_000_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    // Влезло сколько влезло, но заметно меньше двадцати.
    expect(r.count).toBeGreaterThan(0);
    expect(r.count).toBeLessThan(20);
    const bytes = Buffer.byteLength(JSON.stringify(r.rows), "utf8");
    expect(bytes).toBeLessThanOrEqual(1_000_000);
  });

  test("нормальный запрос усечённым не помечается", async () => {
    const r = await runQueryDbSandboxed("SELECT 1 AS n", 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBeUndefined();
  });

  test("после отказа по объёму воркеров не остаётся", async () => {
    // Единственным источником SIGKILL был таймер: если чтение stdout падало
    // (а самый вероятный триггер — как раз огромный ответ), воркер продолжал
    // жить и жечь ядро уже после того, как вызывающий получил ошибку.
    const v = validateQueryDbSql(FAT_ONE);
    if (!v.ok) throw new Error("validator changed");
    await runQueryDbSandboxed(v.sql, v.limit, { maxBytes: 50_000 });
    await Bun.sleep(300);
    const ps = Bun.spawnSync(["pgrep", "-f", "query-db-worker.ts"]);
    const alive = new TextDecoder()
      .decode(ps.stdout)
      .split("\n")
      .filter(Boolean);
    expect(alive).toEqual([]);
  });
});

/**
 * Аудит 2026-08-04: QUERY_DB не оставлял следа в agent_actions.
 *
 * Единственный тул, который читает операционную БД целиком (chat-скоупа у него
 * нет: переписка и аудит закрыты денилистом, но `tasks`, `permissions`,
 * `chat_settings` видны по всем чатам), не писал ни одной строки в журнал
 * действий. Кто, когда и какой SQL выполнил — узнать было неоткуда, кроме
 * текстового лога процесса, который ротируется. Любое действие с последствиями
 * строку пишет; читающий всю базу — не писал.
 */
describe("QUERY_DB — журнал действий", () => {
  const AUDIT_CHAT = -1_000_804;
  const auditCtx = { agentKey: "backend", chatId: AUDIT_CHAT };
  const runAudited = async (sql: string, extra: Record<string, unknown> = {}) =>
    JSON.parse(await executeTool("QUERY_DB", { sql, ...extra }, auditCtx));

  const rows = () =>
    db
      .prepare(
        `SELECT * FROM agent_actions WHERE chat_id = ? AND action_type = 'QUERY_DB'
         ORDER BY created_at DESC`,
      )
      .all(AUDIT_CHAT) as Array<{
      agent_key: string;
      status: string;
      payload: string | null;
      result: string | null;
      error: string | null;
    }>;

  beforeEach(() => {
    db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(AUDIT_CHAT);
  });
  afterEach(() => {
    db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(AUDIT_CHAT);
  });

  test("успешный запрос оставляет строку с SQL и числом строк", async () => {
    const out = await runAudited("SELECT name FROM schema_migrations", { limit: 3 });
    expect(out.ok).toBe(true);

    const all = rows();
    expect(all.length).toBe(1);
    expect(all[0].agent_key).toBe("backend");
    expect(all[0].status).toBe("ok");
    expect(JSON.parse(all[0].payload!).sql).toContain("schema_migrations");
    expect(typeof JSON.parse(all[0].result!).count).toBe("number");
  });

  test("сами строки ответа в аудит не кладутся", async () => {
    // Иначе журнал становится вторым хранилищем выгрузки — и переживает её на
    // 30 дней архивации.
    await runAudited("SELECT 'значение-из-выборки' AS v");
    const parsed = JSON.parse(rows()[0].result!);
    expect(JSON.stringify(parsed)).not.toContain("значение-из-выборки");
    expect(parsed.rows).toBeUndefined();
  });

  test("отклонённый запрос виден в журнале со статусом error", async () => {
    // Попытка прочитать закрытую таблицу — ровно то событие, ради которого
    // журнал и нужен: сам факт попытки важнее её результата.
    const out = await runAudited("SELECT text FROM messages");
    expect(out.ok).toBe(false);

    const all = rows();
    expect(all.length).toBe(1);
    expect(all[0].status).toBe("error");
    expect(all[0].error).toContain("messages");
    expect(JSON.parse(all[0].payload!).sql).toContain("messages");
  });
});
