/**
 * Сторож времени вокруг `bun test` в CI (.github/scripts/run-bun-tests.sh).
 *
 * Зачем этот тест. С 19.09.2026 джоба «Test suite baseline» пять раз за сутки
 * упиралась в потолок в 15 минут: bun --isolate замолкал на произвольном файле
 * (conflict-markers-gate трижды, svg-render-dimensions, backup-native-db) и
 * стоял так до конца. В логе при этом НЕТ ни одного упавшего теста — зависание
 * выглядит как «набор красный», и разбирать его каждый раз начинали заново.
 *
 * Скрипт ставит такому молчанию свой срок и перезапускает прогон. Ровно это
 * здесь и проверяется — на подменённом `bun`, а не на настоящем наборе:
 * зависание, красный прогон и два зависания подряд различаются кодом выхода,
 * а повтор случается ТОЛЬКО на зависании.
 *
 * Почему это важнее, чем кажется. Ошибиться здесь можно в обе стороны, и обе
 * дорогие: повтор красного прогона прячет флаки-тест (гейт начинает врать),
 * а отсутствие повтора возвращает 15 минут молчания на каждый третий PR.
 *
 * ЧЕГО ЭТОТ ТЕСТ НЕ ДЕЛАЕТ. Он не чинит сам баг рантайма (он в bun 1.3.14) и
 * не проверяет, что настоящий набор зелёный, — это делает сам прогон.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dir, "..", "..", ".github", "scripts", "run-bun-tests.sh");
const WORKFLOW = join(import.meta.dir, "..", "..", ".github", "workflows", "checks.yml");

/** Каждое зависание стоит секунды реального времени — 5s по умолчанию мало. */
const slowTest = (name: string, fn: () => void) => test(name, fn, 60_000);

type Mode = "hang-then-pass" | "red" | "hang-twice" | "slow-alive";

/**
 * Песочница с поддельным `bun` первым в PATH. Заглушка считает вызовы,
 * записывает свой argv и ведёт себя по режиму; «зависание» — это `exec sleep`,
 * чтобы сторож убивал именно тот pid, за которым следит, и в системе не
 * оставалось сирот.
 */
function sandbox(mode: Mode) {
  const root = mkdtempSync(join(tmpdir(), "bun-watchdog-"));
  const bin = join(root, "bin");
  const out = join(root, "out.txt");
  Bun.spawnSync({ cmd: ["mkdir", "-p", bin] });
  const stub = `#!/usr/bin/env bash
N=$(cat "${root}/count" 2>/dev/null || echo 0); N=$((N + 1)); echo "$N" > "${root}/count"
echo "$@" >> "${root}/argv"
echo "##[group]tests/prelude.test.ts:"
# Без перевода строки перед последней группой: убитый прогон обрывается на
# полуслове, и в реальном логе CI группа приехала приклеенной к предыдущей
# строке — отчёт тогда не назвал файл.
printf '(pass) что-то раньше, без перевода##[group]tests/stuck-here.test.ts:\n'
case "${mode}" in
  hang-then-pass) if [ "$N" = "1" ]; then exec sleep 20; fi; echo "8329 pass 0 fail"; exit 0 ;;
  red)            echo "1 fail"; exit 1 ;;
  hang-twice)     exec sleep 20 ;;
  slow-alive)     for i in $(seq 1 16); do echo "(pass) тик $i"; sleep 0.5; done; echo "8329 pass 0 fail"; exit 0 ;;
esac
`;
  writeFileSync(join(bin, "bun"), stub);
  chmodSync(join(bin, "bun"), 0o755);
  return { root, bin, out };
}

function run(sb: ReturnType<typeof sandbox>) {
  const r = Bun.spawnSync({
    cmd: ["bash", SCRIPT, sb.out],
    env: {
      ...process.env,
      PATH: `${sb.bin}:${process.env.PATH ?? ""}`,
      // Срок не меньше четырёх секунд: тишина считается с рождения процесса,
      // а на загруженной машине заглушка стартует не мгновенно — убитая ДО
      // первой своей строки, она не увеличит счётчик вызовов, и тест начнёт
      // врать про число попыток (ловил это на полном прогоне файла).
      BUN_TEST_TIMEOUT_SEC: "4",
      BUN_TEST_POLL_SEC: "0.2",
      BUN_TEST_ATTEMPTS: "2",
    },
  });
  const calls = existsSync(join(sb.root, "count"))
    ? Number(readFileSync(join(sb.root, "count"), "utf8").trim())
    : 0;
  return {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
    calls,
    argv: existsSync(join(sb.root, "argv")) ? readFileSync(join(sb.root, "argv"), "utf8") : "",
    output: existsSync(sb.out) ? readFileSync(sb.out, "utf8") : "",
  };
}

describe("сторож превращает зависание в повтор, а не в 15 минут молчания", () => {
  slowTest("зависшая попытка убивается по сроку, вторая доводит прогон до конца", () => {
    const r = run(sandbox("hang-then-pass"));
    expect(r.calls).toBe(2);
    expect(r.code).toBe(0);
    // Файл с выводом достаётся второй попытке целиком: именно из него потом
    // assert-test-baseline берёт «N pass», и остатки убитой попытки в нём
    // означали бы счёт по недобежавшему прогону.
    expect(r.output).toContain("8329 pass");
    expect(r.output).not.toContain("sleep");
  });

  slowTest("в отчёте названо, на каком файле встало", () => {
    const r = run(sandbox("hang-then-pass"));
    // Именно в строке отчёта, а не где-нибудь в приложенном хвосте вывода:
    // хвост содержит имя файла всегда, поэтому проверка «есть в stderr»
    // зелёная даже у сломанного отчёта — так и было поймано.
    const warn = r.stderr.split("\n").find((l) => l.includes("::warning::run-bun-tests"));
    expect(warn).toBeDefined();
    expect(warn).toContain("молчал");
    // Без имени файла зависание неотличимо от любого другого, и следующее
    // такое расследование начинается с нуля — как случилось в этот раз.
    expect(warn).toContain("tests/stuck-here.test.ts");
  });

  slowTest("два зависания подряд — это уже не шум: код 124 и внятная ошибка", () => {
    const r = run(sandbox("hang-twice"));
    expect(r.calls).toBe(2);
    expect(r.code).toBe(124);
    expect(r.stderr).toContain("::error::");
  });
});

describe("срок отмеряет тишину, а не длительность прогона", () => {
  slowTest("живой прогон длиннее срока доходит до конца и не перезапускается", () => {
    // Заглушка печатает ~8 секунд при сроке в 4: «срок от старта» убил бы её
    // на середине и перезапустил. Ровно этим сторож и был сломан в первой
    // редакции — здоровый набор идёт 5,5–9 минут, то есть под нож попадал бы
    // каждый прогон, а не только зависший.
    const r = run(sandbox("slow-alive"));
    expect(r.calls).toBe(1);
    expect(r.code).toBe(0);
    expect(r.output).toContain("8329 pass");
  });
});

describe("повтор лечит зависание, но не прячет красные тесты", () => {
  slowTest("дошедший до конца красный прогон отдаётся как есть, без второй попытки", () => {
    const r = run(sandbox("red"));
    // Повтор красного прогона — это гейт, который врёт: флаки-тест проходит
    // со второго раза и остаётся в наборе навсегда.
    expect(r.calls).toBe(1);
    expect(r.code).toBe(1);
  });

  slowTest("набор флагов не растерялся по дороге в скрипт", () => {
    const r = run(sandbox("red"));
    expect(r.argv.trim()).toBe("test --max-concurrency 1 --isolate");
  });
});

describe("отчёт читается одинаково всеми grep", () => {
  test("файл ищется фиксированной строкой, а не регуляркой со скобками", () => {
    // 20.09 сторож поймал настоящее зависание — и не смог назвать файл:
    // шаблон `##\\[group\\]` в CI молча не находил ничего, хотя группа
    // стояла в хвосте вывода рядом. Экранированную скобку реализации grep
    // читают по-разному, и локальный прогон этого не ловит в принципе —
    // поэтому запрет на такие шаблоны стоит здесь, а не в чьей-то памяти.
    const runner = readFileSync(SCRIPT, "utf8");
    const greps = runner
      .split("\n")
      .filter((l) => !l.trim().startsWith("#") && l.includes("grep "));
    expect(greps.length).toBeGreaterThan(0);
    for (const line of greps) {
      expect(line).toContain("-aF");
      expect(/\\[[\]]/.test(line)).toBe(false);
    }
  });
});

describe("джоба baseline и правда ходит через сторож", () => {
  test("шаг прогона зовёт скрипт и кладёт вывод туда, откуда его читает коридор", () => {
    const wf = readFileSync(WORKFLOW, "utf8");
    expect(wf).toContain(".github/scripts/run-bun-tests.sh");
    // Инлайн вернулся бы вместе с зависаниями и молча: джоба осталась бы
    // зелёной, а сторож — мёртвым кодом.
    expect(wf).not.toContain("bun test --max-concurrency 1 --isolate 2>&1 | tee");
    expect(wf).toContain('run-bun-tests.sh" /tmp/bun-test-output.txt');
    expect(wf).toContain("assert-test-baseline.sh /tmp/bun-test-output.txt");
  });

  test("потолок джобы вмещает зависание и следом целый здоровый прогон", () => {
    // 20.09 сторож сработал правильно, а джобу всё равно срезало: попытка 2
    // не влезла в оставшиеся минуты, и починка зависания упёрлась в потолок.
    // Поэтому потолок проверяется против срока, а не «на глаз».
    const wf = readFileSync(WORKFLOW, "utf8");
    const job = wf.slice(wf.indexOf("\n  test-baseline:"));
    const cap = Number(job.match(/timeout-minutes:\s*(\d+)/)?.[1]);
    const runner = readFileSync(SCRIPT, "utf8");
    const limit = Number(runner.match(/BUN_TEST_TIMEOUT_SEC-\}" "(\d+)"/)?.[1]);
    expect(Number.isFinite(cap)).toBe(true);
    expect(Number.isFinite(limit)).toBe(true);
    // Худший случай: одна попытка молчит весь срок, вторая идёт целиком
    // (здоровый набор — до 9 минут) поверх checkout и bun install.
    expect(cap * 60).toBeGreaterThanOrEqual(limit + 9 * 60 + 120);
  });
});
