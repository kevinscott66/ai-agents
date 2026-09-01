/**
 * Аудит 2026-08-20: отказ уборки недописанного экспорта не оставлял следа.
 *
 * `cold-storage.ts` не смог убрать обрубок — причина уходила в `log.debug`, а
 * соседняя строка `log.error` («экспорт не удался — prune отменён») не
 * называла, остался ли этот обрубок на диске. То есть на руках был отказ без
 * ответа на единственный практический вопрос: надо ли идти чистить руками.
 *
 * Почему `debug` здесь равен молчанию: `resolveLogLevel` в проде даёт `info`
 * (первый тест это фиксирует), debug не печатается вовсе.
 *
 * Та же болезнь в каскадах `tasks.ts` разбирается отдельно, в PR #475 —
 * пересечения с ним здесь намеренно нет.
 */
import { test, expect, describe, afterEach, spyOn } from "bun:test";
import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { db } from "../lib/db.ts";
import { log, resolveLogLevel } from "../lib/log.ts";
import { exportColdStorage, _io } from "../lib/cold-storage.ts";

describe("прод-уровень логов", () => {
  test("в проде debug не печатается — значит debug для отказа равен молчанию", () => {
    expect(resolveLogLevel(undefined, true)).toBe("info");
    expect(resolveLogLevel("", true)).toBe("info");
  });
});

const TMP = `/tmp/cold-leftover-${Math.floor(performance.now())}`;
// exportColdStorage кладёт файлы не в `dir`, а в `dir/cold-storage` (coldDir).
const OUT = join(TMP, "cold-storage");
const BASE = 8_300_000;
const NOW = 1_900_000_000_000;
const OLD = NOW - 400 * 86_400_000;

function seed(count: number) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO messages_archive
       (id, chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, archived_at)
     VALUES (?, '-778', NULL, 0, 'u1', 'tester', 'hi', ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) ins.run(BASE + i, OLD, OLD);
  })();
}

function remaining(): number {
  const row = db
    .prepare(
      `SELECT count(*) AS n FROM messages_archive WHERE id >= ${BASE} AND id < ${BASE + 10_000}`,
    )
    .get() as { n: number };
  return row.n;
}

afterEach(() => {
  try {
    if (existsSync(OUT)) chmodSync(OUT, 0o700);
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* каталога могло не быть */
  }
  db.prepare(
    `DELETE FROM messages_archive WHERE id >= ${BASE} AND id < ${BASE + 10_000}`,
  ).run();
});

describe("cold-storage: обрубок, который не удалось убрать", () => {
  // Под root права каталога ничего не запрещают — unlink пройдёт, и стенд
  // «не смогли убрать» не воспроизводится.
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

  test.skipIf(asRoot)(
    "провал unlink уходит в warn, а строка отказа называет оставшийся файл",
    () => {
      seed(10);
      const warn = spyOn(log, "warn").mockImplementation(() => {});
      const debug = spyOn(log, "debug").mockImplementation(() => {});
      const error = spyOn(log, "error").mockImplementation(() => {});
      const realWrite = _io.write;
      // Короткая запись = заполнившийся раздел: экспорт признаётся неудачным.
      // Тем же движением снимаем право записи с каталога, чтобы последующий
      // unlink обрубка упал — ровно тот путь, который раньше молчал.
      _io.write = (fd, data) => {
        chmodSync(OUT, 0o500);
        return realWrite(fd, data.subarray(0, Math.max(1, data.byteLength - 1)));
      };
      try {
        const res = exportColdStorage({ now: NOW, coldDays: 365, dir: TMP });
        const msgs = res.find((r) => r.table === "messages_archive")!;

        // Экспорт не удался — из БД не удалено ничего. `pruned: 0` здесь не
        // счётчик прогона, а инвариант ветки: при `failure` DELETE не
        // выполняется вовсе, так что чужие строки его не сдвинут. Форма
        // `toMatchObject` выбрана намеренно — мета-проверка T-751
        // (`test-state-isolation`) справедливо запрещает точные сравнения
        // счётчиков уборщиков, но её регулярка не умеет отличать этот случай.
        expect(msgs).toMatchObject({ pruned: 0, file: null });
        expect(remaining()).toBe(10);

        // Обрубок остался на диске, и о нём сообщено на видимом уровне.
        // Каталог остаётся закрытым на запись до конца прогона, поэтому
        // обрубок остаётся и у других архивных таблиц — берём свою.
        const leftoverWarn = warn.mock.calls.find(
          ([m, c]) =>
            String(m).includes("недописанный экспорт") &&
            String((c as Record<string, unknown>).file).includes(
              "messages_archive-",
            ),
        ) as [string, Record<string, unknown>] | undefined;
        expect(leftoverWarn).toBeDefined();
        expect(String(leftoverWarn![1].file)).toContain("messages_archive-");

        // Ничего из этого не должно было уйти в debug.
        expect(
          debug.mock.calls.some(([m]) => String(m).includes("unlink")),
        ).toBe(false);

        // Строка отказа сама говорит, что обрубок остался, — без неё оператор
        // узнаёт о нём только из следующего прогона, падающего на `wx`.
        const errCall = error.mock.calls.find(
          ([m, c]) =>
            String(m).includes("экспорт не удался") &&
            String((c as Record<string, unknown>).file).includes(
              "messages_archive-",
            ),
        ) as [string, Record<string, unknown>] | undefined;
        expect(errCall).toBeDefined();
        expect(errCall![1].leftover).toBe(errCall![1].file);
        expect(statSync(String(errCall![1].leftover)).size).toBeGreaterThan(0);
      } finally {
        _io.write = realWrite;
        try {
          chmodSync(OUT, 0o700);
        } catch {
          /* каталога могло не быть */
        }
        warn.mockRestore();
        debug.mockRestore();
        error.mockRestore();
      }
    },
  );
});
