#!/usr/bin/env bun
/**
 * T-350: Backup verification tool
 * 
 * Performs a complete restore drill to verify backup integrity:
 * 1. Finds latest backup files in specified backup directory
 * 2. Restores database snapshot to test location (/tmp/restore-test/)
 * 3. Extracts memory wiki backup to test location
 * 4. Verifies data integrity by comparing row counts and file structure
 * 5. Cleans up test data after verification
 * 
 * Usage: bun run agent/tools/restore-from-backup.ts [backup-dir] [--verify-only]
 */

import { Database } from "bun:sqlite";
import fs from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";

export interface RestoreOptions {
  backupDir: string;
  testDir?: string;
  verifyOnly?: boolean;
  cleanup?: boolean;
}

export interface RestoreResult {
  success: boolean;
  dbRestored: boolean;
  wikiRestored: boolean;
  originalRowCounts: Record<string, number>;
  restoredRowCounts: Record<string, number>;
  missingTables: string[];
  wikiFiles: { original: string[], restored: string[] };
  errors: string[];
  testDir: string;
}

export interface BackupFiles {
  dbBackup: string | null;
  wikiBackup: string | null;
}

export function findLatestBackups(backupDir: string): BackupFiles {
  if (!fs.existsSync(backupDir)) {
    throw new Error(`Backup directory does not exist: ${backupDir}`);
  }

  const entries = fs.readdirSync(backupDir);
  
  // Find latest database backup
  const dbBackups = entries
    .filter(name => name.startsWith('db-') && name.endsWith('.sqlite'))
    .sort()
    .reverse();
  
  // Find latest wiki backup  
  const wikiBackups = entries
    .filter(name => name.startsWith('memory-') && name.endsWith('.tgz'))
    .sort()
    .reverse();

  return {
    dbBackup: dbBackups.length > 0 ? join(backupDir, dbBackups[0]) : null,
    wikiBackup: wikiBackups.length > 0 ? join(backupDir, wikiBackups[0]) : null
  };
}

function getTableRowCounts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  const counts: Record<string, number> = {};

  try {
    // Get all table names
    const tables = db.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
    `).all();

    // Count rows in each table
    for (const table of tables) {
      try {
        const result = db.query(`SELECT COUNT(*) as count FROM "${table.name}"`).get() as { count: number };
        counts[table.name] = result.count;
      } catch (e) {
        console.warn(`[restore] Failed to count rows in table ${table.name}: ${e}`);
        counts[table.name] = -1; // Mark as error
      }
    }
  } finally {
    db.close();
  }

  return counts;
}

/**
 * Целостность снимка по мнению самой SQLite.
 *
 * `COUNT(*)` по каждой таблице обходит только b-tree ТАБЛИЦ: рассогласование
 * индекса с данными или битую страницу индекса он не заметит, а поднятая из
 * такого бэкапа база молча отдаёт неверные ответы на запросы с WHERE.
 * `integrity_check` — штатная проверка ровно на это. Предел в 8 сообщений
 * держит время на битом файле конечным: на целом это всё равно полный обход.
 */
function checkDbIntegrity(dbPath: string): string[] {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return db
      .query(`PRAGMA integrity_check(8)`)
      .all()
      .map((row) => String(Object.values(row as Record<string, unknown>)[0] ?? ''))
      .filter((v) => v && v !== 'ok');
  } catch (e: any) {
    // Файл настолько плох, что не открылся или уронил саму проверку. Это тоже
    // ответ, и молчать о нём нельзя.
    return [`integrity_check did not run: ${e?.message ?? e}`];
  } finally {
    try { db?.close(); } catch { /* already closed / never opened */ }
  }
}

function listFilesRecursive(dir: string, basePath: string = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  
  const files: string[] = [];
  const entries = fs.readdirSync(dir);
  
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relativePath = join(basePath, entry);
    
    if (fs.statSync(fullPath).isDirectory()) {
      files.push(...listFilesRecursive(fullPath, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  
  return files.sort();
}

/**
 * Оглавление архива вики: только файлы, без записей-каталогов.
 *
 * Аудит 2026-08-28: `tar -tzf` уже звался, но только в ветке --verify-only и
 * только чтобы проверить читаемость. Оглавление — это и есть «что бэкап
 * обещает», то самое `wikiFiles.original`, которое интерфейс объявлял, а код
 * не заполнял никогда.
 */
function listArchiveFiles(tarball: string): { files: string[], error?: string } {
  const res = Bun.spawnSync(['tar', '-tzf', tarball]);
  if (res.exitCode !== 0) {
    return { files: [], error: 'Wiki backup file is corrupted or unreadable' };
  }
  const stdout = res.stdout ? new TextDecoder().decode(res.stdout) : '';
  return {
    files: stdout.split('\n').map(l => l.trim()).filter(l => l && !l.endsWith('/')).sort(),
  };
}

/**
 * Файлы, которые архив обещает, но которых нет на диске после распаковки.
 *
 * `tar -czf ... -C parent base` кладёт всё под один верхний каталог, поэтому
 * записи архива выглядят как `memory/notes/x.md`, а `listFilesRecursive`
 * возвращает пути относительно найденного каталога (`notes/x.md`). Записи с
 * другим верхним каталогом сюда тоже попадают — и это правильно: значит,
 * найденный каталог покрывает архив не полностью.
 */
function missingAfterExtract(archive: string[], extracted: string[], base: string): string[] {
  const have = new Set(extracted);
  const missing: string[] = [];
  for (const entry of archive) {
    const parts = entry.split('/');
    const rel = parts[0] === base ? parts.slice(1).join('/') : entry;
    if (!have.has(rel)) missing.push(entry);
  }
  return missing;
}

export async function restoreFromBackup(options: RestoreOptions): Promise<RestoreResult> {
  const result: RestoreResult = {
    success: false,
    dbRestored: false,
    wikiRestored: false,
    originalRowCounts: {},
    restoredRowCounts: {},
    missingTables: [],
    wikiFiles: { original: [], restored: [] },
    errors: [],
    testDir: options.testDir || join(tmpdir(), `restore-test-${Date.now()}`)
  };

  try {
    // Find backup files
    const backups = findLatestBackups(options.backupDir);
    
    if (!backups.dbBackup && !backups.wikiBackup) {
      throw new Error('No backup files found in backup directory');
    }

    // Аудит 2026-08-28: конъюнкция выше ловит только «нет обоих». Каталог с
    // одними `memory-*.tgz` (снапшот БД перестал делаться) доходил до конца с
    // success: true — потому что success требовал `dbRestored || wikiRestored`.
    // Это ровно тот случай, на который сам бэкап поднимает `backup_partial`
    // (lib/backup.ts): учебный restore обязан говорить то же самое, иначе
    // он подтверждает наличие копии, которой нет.
    if (!backups.dbBackup) {
      result.errors.push(
        `No database snapshot (db-*.sqlite) in ${options.backupDir} — half of the backup is missing`,
      );
    }
    if (!backups.wikiBackup) {
      result.errors.push(
        `No wiki archive (memory-*.tgz) in ${options.backupDir} — half of the backup is missing`,
      );
    }

    // Аудит 2026-08-28: каталог создавался безусловно, а убирался только при
    // `!verifyOnly` (условие очистки ниже) — при том что --verify-only ничего
    // в него и не пишет, о чём прямо сказано в --help («don't extract to test
    // location»). Каждый прогон таймера оставлял пустой restore-test-*; на
    // машине аудита их накопилось 253. Создаём только когда есть что класть.
    if (!options.verifyOnly) {
      fs.mkdirSync(result.testDir, { recursive: true });
      console.log(`[restore] Created test directory: ${result.testDir}`);
    }

    // Restore database backup
    if (backups.dbBackup) {
      try {
        const restoredDbPath = join(result.testDir, 'memory.db');
        
        if (!options.verifyOnly) {
          // Copy the backup file to test location
          fs.copyFileSync(backups.dbBackup, restoredDbPath);
          console.log(`[restore] Database copied: ${backups.dbBackup} -> ${restoredDbPath}`);
        }
        
        // Get original backup row counts
        result.originalRowCounts = getTableRowCounts(backups.dbBackup);

        // Аудит 2026-08-20: `-1` — это сентинел «таблица не прочиталась», то
        // есть ровно то, ради чего учебный restore и существует. Но
        // единственное место, где счётчики сверялись, стоит ниже под охранником
        // `originalCount >= 0 && restoredCount >= 0` — и сентинел из проверки
        // исключался. Сверять там всё равно нечего: сравнивались файл бэкапа и
        // его же копия, сделанная `copyFileSync` строкой выше. Битый бэкап
        // доходил до конца с пустым `errors`, `success: true` и `exit 0` —
        // таймер видел зелёный, а бэкапа не было.
        for (const [table, count] of Object.entries(result.originalRowCounts)) {
          if (count < 0) {
            result.errors.push(
              `Table ${table}: unreadable in backup ${basename(backups.dbBackup)} — snapshot is corrupt`,
            );
          }
        }
        // Аудит 2026-08-28: цикл выше стережёт сентинел `-1` («таблица не
        // прочиталась»), но пустой объект по нему не проходит ни разу. Файл
        // нулевой длины — валидная пустая база для sqlite: quick_check
        // отвечает ok, таблиц ноль, счётчиков ноль. Учебный restore печатал
        // `Tables: 0`, `{"success":true,"errors":[]}` и выходил с кодом 0.
        // Сам бэкап такой снапшот считает битым (`verifySnapshot`,
        // lib/backup.ts:82: «в снапшоте нет таблиц») — расхождение означало,
        // что проверка копии слабее проверки при её создании.
        if (Object.keys(result.originalRowCounts).length === 0) {
          result.errors.push(
            `Snapshot ${basename(backups.dbBackup)} has no tables — nothing to restore`,
          );
        }
        for (const problem of checkDbIntegrity(backups.dbBackup)) {
          result.errors.push(`Database integrity_check: ${problem}`);
        }
        
        if (!options.verifyOnly) {
          // Verify restored database
          result.restoredRowCounts = getTableRowCounts(restoredDbPath);
          
          // Compare row counts
          for (const [table, originalCount] of Object.entries(result.originalRowCounts)) {
            const restoredCount = result.restoredRowCounts[table];
            if (restoredCount === undefined) {
              result.missingTables.push(table);
            } else if (originalCount !== restoredCount && originalCount >= 0 && restoredCount >= 0) {
              result.errors.push(`Table ${table}: row count mismatch (original: ${originalCount}, restored: ${restoredCount})`);
            }
          }
        } else {
          result.restoredRowCounts = result.originalRowCounts;
        }
        
        result.dbRestored = true;
        console.log(`[restore] Database verification complete. Tables: ${Object.keys(result.originalRowCounts).length}`);
      } catch (e: any) {
        result.errors.push(`Database restore failed: ${e.message}`);
      }
    }

    // Restore wiki backup
    if (backups.wikiBackup) {
      try {
        // Аудит 2026-08-28: `wikiFiles.original` объявлялся в интерфейсе,
        // инициализировался пустым массивом и не записывался НИКОГДА — при том
        // что --help тула обещает сверку «file structure». Сверять было не с
        // чем: единственный список брался после распаковки, то есть отвечал на
        // вопрос «что распаковалось», а не «всё ли из архива распаковалось».
        // Частичная распаковка (tar вышел нулём, но каталог найден не тот, или
        // архив кладёт файлы мимо него) проходила учебный restore зелёной.
        const listing = listArchiveFiles(backups.wikiBackup);
        if (listing.error) {
          result.errors.push(listing.error);
        }
        result.wikiFiles.original = listing.files;

        if (options.verifyOnly) {
          // Распаковки нет — сверять не с чем; отчёт показывает оглавление.
          result.wikiFiles.restored = result.wikiFiles.original;
          console.log(`[restore] Wiki backup verified: ${result.wikiFiles.restored.length} files`);
        } else {
          // Extract tarball
          const res = Bun.spawnSync(['tar', '-xzf', backups.wikiBackup, '-C', result.testDir]);
          if (res.exitCode !== 0) {
            const stderr = res.stderr ? new TextDecoder().decode(res.stderr) : '';
            throw new Error(`tar extract failed (exit ${res.exitCode}): ${stderr.trim()}`);
          }
          console.log(`[restore] Wiki extracted: ${backups.wikiBackup} -> ${result.testDir}`);

          // Find the extracted directory (it might be named differently)
          const extractedDirs = fs.readdirSync(result.testDir).filter(name => {
            const fullPath = join(result.testDir, name);
            return fs.statSync(fullPath).isDirectory() && name !== 'memory.db';
          });

          let wikiRestoreDir: string | null = null;

          // Look for 'memory' directory first, then any directory containing wiki files
          for (const dirName of ['memory', ...extractedDirs]) {
            const candidateDir = join(result.testDir, dirName);
            if (fs.existsSync(candidateDir) && fs.statSync(candidateDir).isDirectory()) {
              wikiRestoreDir = candidateDir;
              break;
            }
          }

          // Get file lists for comparison
          if (wikiRestoreDir && fs.existsSync(wikiRestoreDir)) {
            result.wikiFiles.restored = listFilesRecursive(wikiRestoreDir);
            console.log(`[restore] Found wiki directory: ${basename(wikiRestoreDir)}`);

            const missing = result.wikiFiles.original.length
              ? missingAfterExtract(
                  result.wikiFiles.original,
                  result.wikiFiles.restored,
                  basename(wikiRestoreDir),
                )
              : [];
            if (missing.length > 0) {
              const shown = missing.slice(0, 5).join(', ');
              result.errors.push(
                `Wiki archive lists ${missing.length} file(s) not found under ${basename(wikiRestoreDir)}/ after extraction: ${shown}${missing.length > 5 ? ', ...' : ''}`,
              );
            }
          } else {
            result.errors.push('Wiki restore directory not found after extraction');
          }
        }

        result.wikiRestored = true;
        console.log(`[restore] Wiki verification complete. Files: ${result.wikiFiles.restored.length}`);
      } catch (e: any) {
        result.errors.push(`Wiki restore failed: ${e.message}`);
      }
    }

    // Clean up if requested
    if (options.cleanup !== false && !options.verifyOnly) {
      try {
        fs.rmSync(result.testDir, { recursive: true, force: true });
        console.log(`[restore] Cleanup complete: ${result.testDir}`);
      } catch (e: any) {
        result.errors.push(`Cleanup failed: ${e.message}`);
      }
    }

    // Determine overall success
    // Аудит 2026-08-28: считалось ДО блока очистки, а очистка умеет писать в
    // errors. Получалось `{"success":true,"errors":["Cleanup failed: ..."]}` —
    // инвариант «success ⇔ errors пуст», на который опираются оба
    // существующих теста, ломался. Теперь итог подводится последним.
    result.success = result.errors.length === 0 &&
                    (result.dbRestored || result.wikiRestored) &&
                    result.missingTables.length === 0;

  } catch (e: any) {
    result.errors.push(`Restore process failed: ${e.message}`);
  }

  return result;
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: bun run agent/tools/restore-from-backup.ts [backup-dir] [options]

Arguments:
  backup-dir        Path to backup directory (default: ./backups)

Options:
  --verify-only     Only verify backup files, don't extract to test location
  --no-cleanup      Don't clean up test files after verification
  --help, -h        Show this help message

Examples:
  bun run agent/tools/restore-from-backup.ts
  bun run agent/tools/restore-from-backup.ts ./data/backups
  bun run agent/tools/restore-from-backup.ts --verify-only
`);
    process.exit(0);
  }

  const backupDir = args.find(arg => !arg.startsWith('--')) || './backups';
  const verifyOnly = args.includes('--verify-only');
  const cleanup = !args.includes('--no-cleanup');

  console.log(`[restore] Starting backup verification...`);
  console.log(`[restore] Backup directory: ${backupDir}`);
  console.log(`[restore] Verify only: ${verifyOnly}`);
  console.log(`[restore] Cleanup: ${cleanup}`);
  console.log('');

  try {
    const result = await restoreFromBackup({
      backupDir,
      verifyOnly,
      cleanup
    });

    // Print results
    console.log('\n=== RESTORE VERIFICATION RESULTS ===');
    console.log(`Success: ${result.success ? '✅' : '❌'}`);
    console.log(`Database restored: ${result.dbRestored ? '✅' : '❌'}`);
    console.log(`Wiki restored: ${result.wikiRestored ? '✅' : '❌'}`);
    console.log(`Test directory: ${result.testDir}`);
    console.log('');

    if (result.dbRestored) {
      console.log('Database Tables:');
      for (const [table, count] of Object.entries(result.originalRowCounts)) {
        const status = count >= 0 ? `${count} rows` : 'ERROR';
        console.log(`  ${table}: ${status}`);
      }
      console.log('');
    }

    if (result.wikiRestored) {
      console.log(`Wiki Files: ${result.wikiFiles.restored.length} files`);
      if (result.wikiFiles.restored.length > 0 && result.wikiFiles.restored.length <= 20) {
        result.wikiFiles.restored.forEach(file => console.log(`  ${file}`));
      }
      console.log('');
    }

    if (result.errors.length > 0) {
      console.log('Errors:');
      result.errors.forEach(error => console.log(`  ❌ ${error}`));
      console.log('');
    }

    if (result.missingTables.length > 0) {
      console.log('Missing Tables:');
      result.missingTables.forEach(table => console.log(`  ❌ ${table}`));
      console.log('');
    }

    process.exit(result.success ? 0 : 1);
  } catch (e: any) {
    console.error(`[restore] Fatal error: ${e.message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
