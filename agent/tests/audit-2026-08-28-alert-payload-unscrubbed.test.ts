/**
 * Аудит 2026-08-28: одна и та же строка чистилась по дороге в лог и уезжала
 * сырой в базу.
 *
 * `emitAlert` делает две записи из одних и тех же данных:
 *   log.error(message, { severity, code, ...data });        // ← через скраббер
 *   INSERT INTO audit_logs(... JSON.stringify({ ...data })) // ← мимо него
 *
 * Шапка lib/log.ts про скраббер говорит прямо: «ALWAYS on (unlike PII
 * redaction) — secrets must never log». Второй сток это обещание не исполнял.
 *
 * Сток не внутренний: `audit_logs` отдаёт наружу `/api/audit` Mini App
 * (lib/miniapp-server.ts:1599) и забирает архив холодного хранения. А текст в
 * `data` — произвольный: `telegraf-patch.ts:140` кладёт туда message
 * необработанного исключения, `backup.ts:378` и db-maint — текст ошибки
 * стороннего вызова. Ровно те строки, ради которых скраббер и написан:
 * node-fetch на сетевой ошибке печатает `request to
 * https://api.telegram.org/bot<ТОКЕН>/... failed`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../lib/db.ts";
import { emitAlert } from "../lib/alerting.ts";

const CODE = "audit_scrub_probe";
// Форма настоящая, значение выдуманное: 10 цифр, двоеточие, 35 символов.
const FAKE_TOKEN = "7123456789:AAHwxyz0123456789abcdefghijklmnopqr";

function payloads(): string[] {
  return db
    .prepare(`SELECT payload FROM audit_logs WHERE event_type = ?`)
    .all(`alert.${CODE}`)
    .map((r: any) => String(r.payload));
}

function cleanup(): void {
  db.prepare(`DELETE FROM audit_logs WHERE event_type = ?`).run(`alert.${CODE}`);
}

beforeEach(cleanup);
afterEach(cleanup);

describe("audit_logs.payload проходит через тот же скраббер, что и лог", () => {
  test("токен бота внутри текста ошибки не доезжает до строки", () => {
    emitAlert("critical", CODE, "необработанное исключение", {
      error: `request to https://api.telegram.org/bot${FAKE_TOKEN}/getMe failed`,
    });
    const [row] = payloads();
    expect(row).toBeDefined();
    expect(row).not.toContain(FAKE_TOKEN);
    // Bot id — не секрет и нужен, чтобы понять, чей токен светился.
    expect(row).toContain("7123456789:***");
  });

  test("секрет в имени поля вычищается по ключу", () => {
    emitAlert("error", CODE, "сбой", { token: "s3cret-value-not-in-db" });
    const [row] = payloads();
    expect(row).not.toContain("s3cret-value-not-in-db");
    expect(row).toContain("***");
  });

  test("секрет во вложенном объекте тоже вычищается", () => {
    emitAlert("error", CODE, "сбой", {
      ctx: { url: `https://x-access-token:ghp_${"a".repeat(24)}@github.com/x` },
    });
    const [row] = payloads();
    expect(row).not.toContain("ghp_");
  });

  test("сам message тоже чистится, не только data", () => {
    emitAlert("error", CODE, `упало на bot${FAKE_TOKEN}`);
    const [row] = payloads();
    expect(row).not.toContain(FAKE_TOKEN);
  });
});

describe("несекретное содержимое остаётся читаемым", () => {
  test("обычный текст и severity доезжают как есть", () => {
    emitAlert("warn", CODE, "бэкап сделал только часть источников", {
      done: 2,
      total: 3,
      note: "memory.db пропущен",
    });
    const [row] = payloads();
    const parsed = JSON.parse(row);
    expect(parsed.severity).toBe("warn");
    expect(parsed.message).toBe("бэкап сделал только часть источников");
    expect(parsed.done).toBe(2);
    expect(parsed.note).toBe("memory.db пропущен");
  });

  test("skipAuditLog по-прежнему не пишет строку", () => {
    emitAlert("info", CODE, "тихо", { error: FAKE_TOKEN }, { skipAuditLog: true });
    expect(payloads()).toEqual([]);
  });
});
