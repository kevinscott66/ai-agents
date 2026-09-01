/**
 * Аудит 2026-08-20 — джоба «Test suite baseline floor» в .github/workflows/checks.yml.
 *
 * Джоба задумана как страховка от массового исчезновения тестов: шаг с
 * `bun test` ловит падения, а счётчик — «а сколько их вообще осталось».
 * Порог был вкомпилирован прямо в YAML: `FLOOR=670`, с комментарием
 * «baseline 673 на 2026-06-06». К моменту аудита прогон даёт больше трёх
 * тысяч. То есть из набора могло испариться ~78% тестов, и гейт остался бы
 * зелёным — ровно тот же класс отказа, что у мёртвого условия предеплойного
 * смоука и у гейта на маркеры конфликтов без якорей.
 *
 * Причина не в самом числе, а в том, что число обязано было обновляться
 * вручную и не обновлялось. Поэтому проверка вынесена в скрипт с ДВУСТОРОННИМ
 * коридором: пол ловит удаление тестов, потолок ловит устаревание самого
 * файла базовой линии и требует его обновить. Односторонний порог тухнет
 * молча, двусторонний — громко.
 */
import { test, expect, describe, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, ".github", "scripts", "assert-test-baseline.sh");
const WORKFLOW = join(REPO, ".github", "workflows", "checks.yml");
const BASELINE_FILE = join(REPO, ".github", "test-baseline.txt");

/** Должны совпадать с константами внутри скрипта. */
const DOWN = 10;
const UP = 300;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function summary(pass: number): string {
  return [
    "",
    ` ${pass} pass`,
    " 4 skip",
    " 0 fail",
    " 10388 expect() calls",
    `Ran ${pass + 4} tests across 401 files. [157.58s]`,
    "",
  ].join("\n");
}

function run(
  output: string | Uint8Array,
  baseline: string | null,
): { code: number; out: string } {
  const d = mkdtempSync(join(tmpdir(), "baseline-"));
  dirs.push(d);
  const outFile = join(d, "bun-output.txt");
  writeFileSync(outFile, output);
  const baseFile = join(d, "baseline.txt");
  if (baseline !== null) writeFileSync(baseFile, baseline);
  const r = Bun.spawnSync(["bash", SCRIPT, outFile, baseFile]);
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
  };
}

describe("пол: тесты пропали из набора", () => {
  test("счёт равен базовой линии — зелено", () => {
    expect(run(summary(3000), "3000").code).toBe(0);
  });

  test("ровно на полу (базовая линия минус допуск) — зелено", () => {
    expect(run(summary(3000 - DOWN), "3000").code).toBe(0);
  });

  test("на один ниже пола — красно, с обоими числами в сообщении", () => {
    const r = run(summary(3000 - DOWN - 1), "3000");
    expect(r.code).toBe(1);
    expect(r.out).toContain(String(3000 - DOWN - 1));
    expect(r.out).toContain(String(3000 - DOWN));
  });

  test("массовое удаление — красно (при старом FLOOR=670 было бы зелено)", () => {
    const r = run(summary(700), "3000");
    expect(r.code).toBe(1);
    expect(r.out).toContain("700");
  });
});

describe("потолок: устарел сам файл базовой линии", () => {
  test("ровно на потолке — зелено", () => {
    expect(run(summary(3000 + UP), "3000").code).toBe(0);
  });

  test("выше потолка — красно и названы файл и новое число", () => {
    const r = run(summary(3000 + UP + 1), "3000");
    expect(r.code).toBe(1);
    expect(r.out).toContain("test-baseline.txt");
    expect(r.out).toContain(String(3000 + UP + 1));
  });
});

describe("разбор вывода bun test", () => {
  test("берётся последняя сводка, а не первое совпадение в чужом stdout", () => {
    const noise = "какой-то тест напечатал 9999 pass в свой stdout\n";
    expect(run(noise + summary(3000), "3000").code).toBe(0);
  });

  test("NUL-байт в выводе не ломает разбор", () => {
    const enc = new TextEncoder();
    const head = enc.encode("тест напечатал бинарь:");
    const tail = enc.encode(summary(3000));
    const buf = new Uint8Array(head.length + 3 + tail.length);
    buf.set(head, 0);
    buf.set([0x00, 0xff, 0xfe], head.length);
    buf.set(tail, head.length + 3);
    expect(run(buf, "3000").code).toBe(0);
  });

  // Аудит 2026-08-29: «замерить не вышло» и «тестов стало мало» — разные вещи,
  // и шапка скрипта резервирует под первое код 2. Оборвавшийся прогон и
  // пропавший файл замера отдавали 1, то есть врали ровно тем же способом, что
  // и вкомпилированный FLOOR=670 до этого коридора.
  test("сводки в выводе нет — код 2: замерить не вышло", () => {
    const r = run("bun упал до сводки\n", "3000");
    expect(r.code).toBe(2);
    expect(r.out).toContain("bun упал до сводки");
  });

  test("файла с выводом нет — код 2, и файл назван", () => {
    const r = Bun.spawnSync(["bash", SCRIPT, "/nope/missing.txt", BASELINE_FILE]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout.toString() + r.stderr.toString()).toContain("missing.txt");
  });
});

describe("файл базовой линии", () => {
  test("файла нет — гейт закрывается кодом 2, а не пропускает", () => {
    expect(run(summary(3000), null).code).toBe(2);
  });

  test("вместо числа мусор — код 2", () => {
    expect(run(summary(3000), "примерно три тысячи\n").code).toBe(2);
  });

  test("комментарии и пустые строки игнорируются", () => {
    expect(run(summary(3000), "# main, 2026-08-20\n\n3000\n").code).toBe(0);
  });

  // Аудит 2026-08-29: `tr -d '\n'` склеивал строки. Файл с двумя числами
  // (дописали новое, старое не стёрли) давал `30003100`, проходил проверку на
  // целое и разворачивался в пол на 30 миллионов — гейт падал с сообщением «из
  // набора пропали тесты», которого не было.
  test("два числа в файле — код 2, а не склеенное число", () => {
    const r = run(summary(3000), "3000\n3100\n");
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("30003100");
  });

  test("пустой файл — код 2", () => {
    expect(run(summary(3000), "# только комментарий\n").code).toBe(2);
  });
});

describe("checks.yml и файл в репозитории", () => {
  const wf = readFileSync(WORKFLOW, "utf8");
  const yaml = wf
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

  test("джоба зовёт скрипт", () => {
    expect(yaml).toContain("assert-test-baseline.sh");
  });

  test("вкомпилированного порога 670 в YAML больше нет", () => {
    // Guard: если стриппер комментариев вдруг съел код, предыдущая проверка
    // тоже прошла бы вхолостую — поэтому убеждаемся, что тело шага на месте.
    expect(yaml).toContain("bun-test-output.txt");
    expect(yaml).not.toContain("670");
    expect(yaml).not.toContain("FLOOR=");
  });

  test("код выхода bun по-прежнему берётся из PIPESTATUS, а не из tee", () => {
    expect(yaml).toContain("${PIPESTATUS[0]}");
  });

  test("у скрипта стоит бит запуска", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  test("базовая линия в репозитории — целое число далеко за устаревшим 670", () => {
    const raw = readFileSync(BASELINE_FILE, "utf8");
    const n = Number(
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#"))
        .join(""),
    );
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(2000);
  });
});
