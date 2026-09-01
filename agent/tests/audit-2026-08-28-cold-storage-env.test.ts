/**
 * Аудит 2026-08-28: две ручки холодного хранилища разбирались небрежно, а
 * цена ошибки здесь необратима — из `.ndjson.gz` в БД в репозитории не ведёт
 * ничего: ни `tools/restore-from-backup.ts`, ни `lib/backup.ts` про cold
 * storage не знают вовсе. После прунинга дамп — единственная копия.
 *
 * 1. `BACKUP_DIR` читался через `??`, который ловит только null/undefined.
 *    Пустое значение уводило выгрузку в `./cold-storage` относительно cwd,
 *    значение с пробелами — в каталог с пробелами в имени; и то и другое мимо
 *    того `$BACKUP_DIR`, который владелец синкает наружу. Ровно этот разбор в
 *    `orchestrator/services.ts:280` уже починили — здесь он остался старым.
 *
 * 2. `COLD_STORAGE_DAYS` читался `Number.parseInt`, то есть обрезался:
 *    `0.5` → `0`, а ноль здесь — документированная ручка «выгрести и удалить
 *    ВЕСЬ архив». Владелец, написавший полсуток, получал полную зачистку пяти
 *    *_archive таблиц в ближайший месячный прогон.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { join } from "node:path";
import { _coldDir, _readColdDays } from "../lib/cold-storage.ts";

const SAVED_DIR = process.env.BACKUP_DIR;
const SAVED_DAYS = process.env.COLD_STORAGE_DAYS;

afterEach(() => {
  // Без восстановления env течёт в соседние файлы: bun гоняет каталог одним
  // процессом (CLAUDE.md §3.8 п.7).
  if (SAVED_DIR === undefined) delete process.env.BACKUP_DIR;
  else process.env.BACKUP_DIR = SAVED_DIR;
  if (SAVED_DAYS === undefined) delete process.env.COLD_STORAGE_DAYS;
  else process.env.COLD_STORAGE_DAYS = SAVED_DAYS;
});

describe("предпосылки", () => {
  test("прежние выражения давали ровно то, от чего уходим", () => {
    const empty: string | undefined = "";
    expect(empty ?? "./backups").toBe("");
    expect(Number.parseInt("0.5", 10)).toBe(0);
    expect(Number.parseInt("1e3", 10)).toBe(1);
    expect(Number.parseInt("30d", 10)).toBe(30);
  });
});

describe("BACKUP_DIR", () => {
  test("пустое значение — дефолт, а не каталог относительно cwd", () => {
    process.env.BACKUP_DIR = "";
    expect(_coldDir({})).toBe(join("./backups", "cold-storage"));
  });

  test("пробелы по краям срезаются", () => {
    process.env.BACKUP_DIR = "  /srv/backups  ";
    expect(_coldDir({})).toBe(join("/srv/backups", "cold-storage"));
  });

  test("одни пробелы — тоже дефолт", () => {
    process.env.BACKUP_DIR = "   ";
    expect(_coldDir({})).toBe(join("./backups", "cold-storage"));
  });

  test("нормальное значение и отсутствие переменной работают как раньше", () => {
    process.env.BACKUP_DIR = "/srv/backups";
    expect(_coldDir({})).toBe(join("/srv/backups", "cold-storage"));
    delete process.env.BACKUP_DIR;
    expect(_coldDir({})).toBe(join("./backups", "cold-storage"));
  });

  test("явный opts.dir сильнее env и тоже подрезается", () => {
    process.env.BACKUP_DIR = "/srv/backups";
    expect(_coldDir({ dir: "  /tmp/cold  " })).toBe(join("/tmp/cold", "cold-storage"));
    // Пустой opts.dir — не «корень», а «не задано»: падаем в env.
    expect(_coldDir({ dir: "   " })).toBe(join("/srv/backups", "cold-storage"));
  });
});

describe("COLD_STORAGE_DAYS", () => {
  test("дробное не обрезается в ноль — то есть не превращается в «удалить всё»", () => {
    for (const raw of ["0.5", "0.9", "364.9"]) {
      process.env.COLD_STORAGE_DAYS = raw;
      expect({ raw, days: _readColdDays({}) }).toEqual({ raw, days: 365 });
    }
  });

  test("экспоненциальная запись читается целиком, а не первой цифрой", () => {
    process.env.COLD_STORAGE_DAYS = "1e3";
    expect(_readColdDays({})).toBe(1000);
  });

  test("хвост из букв больше не проходит как число", () => {
    // `parseInt("30d")` возвращал 30 — молчаливое «мы поняли, что вы имели в виду».
    process.env.COLD_STORAGE_DAYS = "30d";
    expect(_readColdDays({})).toBe(365);
  });

  test("прежние договорённости не сдвинулись", () => {
    for (const [raw, want] of [
      ["0", 0],
      ["30", 30],
      ["  30  ", 30],
      ["-1", 365],
      ["не-число", 365],
      ["", 365],
    ] as const) {
      process.env.COLD_STORAGE_DAYS = raw;
      expect({ raw, days: _readColdDays({}) }).toEqual({ raw, days: want });
    }
    delete process.env.COLD_STORAGE_DAYS;
    expect(_readColdDays({})).toBe(365);
  });

  test("явный opts.coldDays по-прежнему сильнее env", () => {
    process.env.COLD_STORAGE_DAYS = "0.5";
    expect(_readColdDays({ coldDays: 7 })).toBe(7);
    expect(_readColdDays({ coldDays: 0 })).toBe(0);
  });
});
