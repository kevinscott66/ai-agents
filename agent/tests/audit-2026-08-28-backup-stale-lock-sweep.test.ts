/**
 * Аудит 2026-08-28: брошенный карантин замка не подбирал никто.
 *
 * `acquireBackupLock` переименовывает протухший `.backup.lock` в
 * `.backup.lock.stale-<pid>-<uuid>` и тут же удаляет. Если удаление бросило
 * (права, занятый дескриптор, кончились inode), обработчик пишет один
 * log.warn и идёт дальше — каталог остаётся в BACKUP_DIR навсегда.
 *
 * Подобрать его было некому: ретеншн в конце runBackup смотрит только на имена
 * с префиксами `db-` и `memory-`, а больше по каталогу бэкапов не ходит никто.
 * Каждая следующая протухшая блокировка добавляла ещё один каталог.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { runBackup, acquireBackupLock } from "../lib/backup.ts";

let dataDir = "";
let backupDir = "";

beforeEach(() => {
  const root = fs.mkdtempSync(join(os.tmpdir(), "backup-stale-lock-"));
  dataDir = join(root, "data");
  backupDir = join(root, "backups");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  // Пустой источник: снапшот не получится, ретеншн всё равно отрабатывает.
  fs.writeFileSync(join(dataDir, "memory.db"), "");
});

afterEach(() => {
  fs.rmSync(join(dataDir, ".."), { recursive: true, force: true });
});

function staleQuarantine(name: string): string {
  const p = join(backupDir, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(join(p, "owner"), JSON.stringify({ pid: 1, token: "x" }) + "\n");
  return p;
}

describe("карантины протухшего замка", () => {
  test("прогон подбирает все брошенные каталоги и считает их", async () => {
    const a = staleQuarantine(".backup.lock.stale-111-aaaa");
    const b = staleQuarantine(".backup.lock.stale-222-bbbb");

    const res = await runBackup(dataDir, backupDir);

    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(res.staleLocksCleaned).toBe(2);
  });

  test("чужие имена в каталоге бэкапов не трогаются", async () => {
    // Ни живой замок, ни копии, ни постороннее имя.
    const lock = join(backupDir, ".backup.lock");
    fs.mkdirSync(lock);
    const db = join(backupDir, "db-2026-08-28.sqlite");
    fs.writeFileSync(db, "x");
    const other = join(backupDir, ".backup.lock.notstale");
    fs.writeFileSync(other, "x");

    const res = await runBackup(dataDir, backupDir);

    // Живой замок снимает сам runBackup, поэтому проверяем то, что он не трогал.
    expect(fs.existsSync(db)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(res.staleLocksCleaned).toBe(0);
    void lock;
  });

  test("свежий бэкап без карантинов ставит счётчик в ноль, а не в undefined", async () => {
    const res = await runBackup(dataDir, backupDir);
    expect(res.staleLocksCleaned).toBe(0);
  });

  test("подбор не мешает: карантин не делает бэкап неудавшимся", async () => {
    staleQuarantine(".backup.lock.stale-333-cccc");
    const res = await runBackup(dataDir, backupDir);
    for (const e of res.errors) expect(e).not.toContain("stale");
  });
});

describe("карантин создаётся там же, где его ищут", () => {
  test("имя карантина начинается с префикса, который метёт ретеншн", () => {
    // Протухший замок: каталог без owner и с давним mtime — его владельца
    // определить нельзя, и acquireBackupLock обязан его отобрать.
    const lock = join(backupDir, ".backup.lock");
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 7 * 24 * 3600_000);
    fs.utimesSync(lock, old, old);

    const held = acquireBackupLock(backupDir);
    expect(held.path).toBe(lock);

    // Карантин уже удалён самим acquireBackupLock; важно, что он не уехал в
    // соседний каталог — иначе подбирающий ретеншн его не увидел бы.
    const strays = fs
      .readdirSync(join(backupDir, ".."))
      .filter((n) => n.startsWith(".backup.lock"));
    expect(strays).toEqual([]);
    fs.rmSync(lock, { recursive: true, force: true });
  });
});
