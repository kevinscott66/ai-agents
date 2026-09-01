/**
 * Аудит 2026-08-29: две поломки в autonomous-cycle.sh.
 *
 * 1. Ротация ролей была `(<день года>*24 + <час>) % 12`. Ролей двенадцать, 24
 *    кратно двенадцати — слагаемое с днём всегда даёт 0, и выражение сводится к
 *    `<час> % 12`. Таймер срабатывает раз в два часа, то есть всегда на часах
 *    одной чётности: шесть ролей из двенадцати не выбирались никогда. День в
 *    формуле создавал видимость перебора.
 *
 * 2. `log_event` собирал строку через `$( )`, которая срезает завершающий
 *    перевод, и печатала её двумя `printf '%s'`. Structured-лог .jsonl рос
 *    одной бесконечной строкой: не JSONL, а конкатенация, которую не читает ни
 *    `jq -s`, ни построчный парсер. Это единственный машинный след цикла.
 *
 * Скрипт целиком в тесте не гоняется — боевой путь требует токенов, сети и
 * девяти минут. Проверяются два режима, которые до них не доходят:
 * `--print-role` (диагностический) и ранний выход по AUTO_DISABLED.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dir, "..", "..", "deploy", "vps-autonomous", "autonomous-cycle.sh");
const SRC = readFileSync(SCRIPT, "utf8");

/** Порядок ролей — контракт скрипта, а не выдумка теста. */
const ROLES = (/^ROLES=\(([^)]*)\)/m.exec(SRC)?.[1] ?? "").split(/\s+/).filter(Boolean);

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "auto-cycle-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], extra: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      AUTO_STATE_DIR: join(dir, "state"),
      AUTO_LOG: join(dir, "log"),
      AUTO_STRUCTURED_LOG: join(dir, "events.jsonl"),
      AUTO_LOCK_DIR: join(dir, "lock"),
      AUTO_REPORT_DIR: join(dir, "reports"),
      AUTO_READINESS_FILE: join(dir, "readiness"),
      AUTO_DISABLE_FILE: join(dir, "disabled"),
      ...extra,
    },
  });
}

const nextRole = (mode?: string) => run(["--print-role", ...(mode ? [mode] : [])]).stdout.trim();

/**
 * Каждый кейс здесь поднимает `bash` через `spawnSync`, а у bun таймаут теста
 * по умолчанию 5000 мс. В одиночном прогоне файл укладывается в ~2.6 с целиком,
 * но полный набор гоняется одним процессом: под нагрузкой те же кейсы занимали
 * 7-22 с каждый и падали по таймауту — прогон 2026-08-29 дал пять «падений» на
 * дереве, где менялись только комментарии в чужих файлах.
 *
 * Это не «медленный тест, которому дали фору»: измеряемая работа тут — запуск
 * стороннего процесса, её длительность задаёт планировщик ОС, а не код. Верхняя
 * граница должна быть заведомо недостижимой, иначе красный цвет означает
 * занятость машины, а не поломку скрипта.
 */
const SLOW = 60_000;
const slowTest = (name: string, fn: () => void) => test(name, fn, SLOW);

describe("предпосылки: прежняя формула вырождалась", () => {
  slowTest("день выпадал из выражения полностью", () => {
    for (const day of [1, 5, 100, 366]) {
      for (const hour of [0, 7, 13, 23]) {
        expect((day * 24 + hour) % 12).toBe(hour % 12);
      }
    }
  });

  slowTest("двухчасовой таймер накрывал ровно половину ролей", () => {
    const even = new Set<number>();
    for (let h = 0; h < 24; h += 2) even.add((200 * 24 + h) % 12);
    expect(even.size).toBe(6);
    expect(ROLES.length).toBe(12);
  });
});

describe("ротация идёт по счётчику запусков", () => {
  slowTest("первый круг перебирает все двенадцать ролей по порядку", () => {
    const seen = Array.from({ length: ROLES.length }, () => nextRole("advance"));
    expect(seen).toEqual(ROLES);
    expect(new Set(seen).size).toBe(12);
  });

  slowTest("тринадцатый запуск возвращается к началу", () => {
    for (let i = 0; i < ROLES.length; i++) nextRole("advance");
    expect(nextRole("advance")).toBe(ROLES[0]);
  });

  slowTest("расписание таймера ни на что не влияет: важен только номер запуска", () => {
    // Три подряд запуска без единого «перескока часа» дают три разные роли —
    // ровно то, чего прежняя формула не давала за целые сутки.
    expect([nextRole("advance"), nextRole("advance"), nextRole("advance")]).toEqual(
      ROLES.slice(0, 3),
    );
  });
});

describe("состояние ротации", () => {
  slowTest("без файла состояния круг начинается с первой роли", () => {
    expect(nextRole()).toBe(ROLES[0]);
  });

  slowTest("мусор в файле состояния не роняет цикл и не ломает перебор", () => {
    mkdirSync(join(dir, "state"), { recursive: true });
    for (const junk of ["", "   ", "abc", "-3", "9e9"]) {
      writeFileSync(join(dir, "state", "role-index"), junk);
      const r = run(["--print-role", "advance"]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(ROLES[0]);
    }
  });

  slowTest("просмотр очереди её не сдвигает", () => {
    expect(nextRole()).toBe(ROLES[0]);
    expect(nextRole()).toBe(ROLES[0]);
    expect(nextRole("advance")).toBe(ROLES[0]);
    expect(nextRole()).toBe(ROLES[1]);
  });
});

describe("structured-лог остаётся JSONL", () => {
  slowTest("каждое событие — отдельная строка, разбираемая по отдельности", () => {
    for (let i = 0; i < 3; i++) expect(run([], { AUTO_DISABLED: "1" }).status).toBe(0);

    const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(3);
    for (const l of lines) {
      const o = JSON.parse(l);
      expect(o.event).toBe("disabled");
      expect(typeof o.pid).toBe("number");
      expect(typeof o.ts).toBe("string");
    }
  });

  slowTest("события разных запусков не слипаются в одну запись", () => {
    run([], { AUTO_DISABLED: "1" });
    run([], { AUTO_DISABLED: "1" });
    const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
    expect(raw).not.toMatch(/\}\{/);
  });
});

describe("источник", () => {
  slowTest("часовой формулы в скрипте больше нет", () => {
    expect(SRC).not.toContain("date -u +%j");
    expect(SRC).not.toContain("* 24 +");
  });

  slowTest("боевой путь двигает счётчик, а не подглядывает", () => {
    expect(SRC).toContain('ROLE="$(pick_role advance)"');
  });

  slowTest("оба printf в log_event пишут перевод строки", () => {
    const body = SRC.slice(SRC.indexOf("log_event()"), SRC.indexOf("\n}", SRC.indexOf("log_event()")));
    const prints = body.split("\n").filter((l) => l.trimStart().startsWith("printf"));
    expect(prints.length).toBe(2);
    for (const l of prints) expect(l).toContain("'%s\\n'");
  });
});
