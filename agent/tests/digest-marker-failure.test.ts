/**
 * Аудит 2026-08-08: провал записи маркера превращал «раз в сутки» в «каждые 5 минут».
 *
 * writeMarker глотал исключение в log.warn, и другого состояния «сегодня уже
 * постили» не существовало: `running` защищает только от конкурентного входа.
 * Значит при неписуемом markerPath каждый тик заново проходил обе проверки
 * (час ≥ hourUTC, last !== today) и рассылал дайджест во все ALLOWED чаты —
 * до ~216 копий в чат за сутки.
 *
 * Путь к этому в проде был дефолтным, а не экзотическим: markerPath по
 * умолчанию был относительным `.digest-last`, то есть WorkingDirectory юнита
 * = /opt/agent-team, а юнит поднят с ProtectSystem=strict и ReadWritePaths
 * только на data/backups/tmp — корень read-only, запись даёт EROFS.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { startDigestScheduler, _defaultMarkerPath } from "../lib/digest.ts";
import { DB_PATH } from "../lib/db.ts";

const AT_6AM = () => new Date("2026-05-21T06:05:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* каталог мог не создаться */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function readOnlyDir(): string {
  const root = mkdtempSync(join(tmpdir(), "digest-ro-"));
  dirs.push(root);
  chmodSync(root, 0o555);
  return root;
}

describe("дайджест: неписуемый маркер не даёт storm", () => {
  test("пять тиков подряд — одна рассылка, а не пять", async () => {
    const sent: string[] = [];
    const handle = startDigestScheduler({
      sender: {
        sendMessage: async (chatId: string | number) => {
          sent.push(String(chatId));
        },
      },
      chatIds: ["111", "222"],
      hourUTC: 6,
      intervalMs: 60_000,
      markerPath: join(readOnlyDir(), ".digest-last"),
      nowProvider: AT_6AM,
    });

    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await handle._runNow());
    handle.stop();

    // Первый прогон состоялся, остальные — нет.
    expect(results).toEqual([true, false, false, false, false]);
    // Два чата × один дайджест. Без фикса было бы 10.
    expect(sent.length).toBe(2);
  });

  test("маркер записать не удалось — на диске его и нет (флаг живёт в памяти)", async () => {
    // Используем injectable _markerWriter, который бросает — это надёжнее
    // chmod 555, т.к. root на VPS пишет в read-only директории в обход прав.
    const root = mkdtempSync(join(tmpdir(), "digest-rw-fail-"));
    dirs.push(root);
    const markerPath = join(root, ".digest-last");
    const handle = startDigestScheduler({
      sender: { sendMessage: async () => {} },
      chatIds: ["111"],
      hourUTC: 6,
      intervalMs: 60_000,
      markerPath,
      nowProvider: AT_6AM,
      _markerWriter: () => {
        throw new Error("EROFS: read-only file system");
      },
    });
    expect(await handle._runNow()).toBe(true);
    // _markerWriter бросил — файла нет, флаг живёт только в памяти
    expect(existsSync(markerPath)).toBe(false);
    // Второй вызов всё равно отбит — postedYmd уже проставлен
    expect(await handle._runNow()).toBe(false);
    handle.stop();
  });

  test("писуемый маркер по-прежнему ложится на диск и переживает новый scheduler", async () => {
    const root = mkdtempSync(join(tmpdir(), "digest-rw-"));
    dirs.push(root);
    const markerPath = join(root, ".digest-last");
    const mk = () =>
      startDigestScheduler({
        sender: { sendMessage: async () => {} },
        chatIds: ["111"],
        hourUTC: 6,
        intervalMs: 60_000,
        markerPath,
        nowProvider: AT_6AM,
      });

    const first = mk();
    expect(await first._runNow()).toBe(true);
    first.stop();
    expect(existsSync(markerPath)).toBe(true);

    // Рестарт процесса: память пуста, маркер на диске должен удержать день.
    const second = mk();
    expect(await second._runNow()).toBe(false);
    second.stop();
  });

  test("дефолтный путь маркера лежит в каталоге БД, а не в cwd", () => {
    // Каталог БД юнит писать разрешает (ReadWritePaths=/opt/agent-team/data),
    // корень — нет. Раньше дефолт был относительным «.digest-last» и попадал
    // ровно в read-only корень.
    expect(_defaultMarkerPath()).toBe(join(dirname(DB_PATH), ".digest-last"));
    expect(_defaultMarkerPath().startsWith(".digest-last")).toBe(false);
  });
});
