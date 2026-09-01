/**
 * Аудит 2026-08-13: `COLD_STORAGE_DAYS` разбирался как `n > 0`, поэтому ноль
 * отбрасывался вместе с мусором и молча превращался в 365. Ноль — это
 * документированная ручка: `tools/export-archive.ts` в шапке обещает
 * «COLD_STORAGE_DAYS=0 … export+prune ALL archive rows». Владелец получал
 * ровно обратное — выгрузку старше года — и без предупреждения.
 *
 * Всё гоняется с `prune: false`: БД у тестов общая, а выгрузка идёт по всем
 * архивным таблицам сразу, так что удалять здесь нельзя ничего. Проверяем по
 * содержимому дампа и только про свои id.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { rmSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { db } from "../lib/db.ts";
import { exportColdStorage } from "../lib/cold-storage.ts";

const TMP = `/tmp/cold-days-${Math.floor(performance.now())}`;
const NOW = 1_900_000_000_000;
const DAY = 86_400_000;
const FRESH = 991001; // сутки — заведомо внутри года
const ANCIENT = 991002; // 400 суток — заведомо снаружи
const IDS = [FRESH, ANCIENT];

function seed(id: number, archivedAt: number) {
  db.prepare(
    `INSERT OR IGNORE INTO messages_archive
       (id, chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, archived_at)
     VALUES (${id}, '-778', NULL, 0, 'u1', 'tester', 'hi', ${archivedAt}, ${archivedAt})`,
  ).run();
}

/** Экспортирует с заданным значением env и возвращает текст дампа сообщений. */
function dumpWith(value: string | undefined): string {
  const saved = process.env.COLD_STORAGE_DAYS;
  try {
    if (value === undefined) delete process.env.COLD_STORAGE_DAYS;
    else process.env.COLD_STORAGE_DAYS = value;
    const res = exportColdStorage({ now: NOW, dir: TMP, prune: false });
    const msgs = res.find((r) => r.table === "messages_archive")!;
    return msgs.file ? gunzipSync(readFileSync(msgs.file)).toString("utf8") : "";
  } finally {
    if (saved === undefined) delete process.env.COLD_STORAGE_DAYS;
    else process.env.COLD_STORAGE_DAYS = saved;
  }
}

afterEach(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {}
  for (const id of IDS) db.prepare(`DELETE FROM messages_archive WHERE id=${id}`).run();
});

describe("COLD_STORAGE_DAYS", () => {
  test("ноль выгребает архив целиком, как обещает справка export-archive", () => {
    seed(FRESH, NOW - DAY);
    seed(ANCIENT, NOW - 400 * DAY);

    const dump = dumpWith("0");

    // До фикса суточная строка не попадала в выгрузку вовсе: ноль тихо
    // становился годом, и «выгрести всё» выгребало только старьё.
    expect(dump).toContain(String(FRESH));
    expect(dump).toContain(String(ANCIENT));
  });

  test("непрочитанное значение — по-прежнему год, а не «всё»", () => {
    seed(FRESH, NOW - DAY);
    seed(ANCIENT, NOW - 400 * DAY);

    const dump = dumpWith("не-число");

    expect(dump).not.toContain(String(FRESH));
    expect(dump).toContain(String(ANCIENT));
  });

  test("переменной нет — год", () => {
    seed(FRESH, NOW - DAY);
    seed(ANCIENT, NOW - 400 * DAY);

    const dump = dumpWith(undefined);

    expect(dump).not.toContain(String(FRESH));
    expect(dump).toContain(String(ANCIENT));
  });

  test("отрицательное не уводит cutoff в будущее, а падает в год", () => {
    // `-1` дало бы cutoff = now + сутки, то есть под выгрузку и прунинг попали
    // бы даже свежие строки. Это опечатка, а не ручка — отбиваем.
    seed(FRESH, NOW - DAY);
    seed(ANCIENT, NOW - 400 * DAY);

    const dump = dumpWith("-1");

    expect(dump).not.toContain(String(FRESH));
    expect(dump).toContain(String(ANCIENT));
  });
});
