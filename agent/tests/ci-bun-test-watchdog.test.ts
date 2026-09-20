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

type Mode = "hang-then-pass" | "red" | "hang-twice";

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
echo "(pass) что-то раньше"
echo "##[group]tests/stuck-here.test.ts:"
case "${mode}" in
  hang-then-pass) if [ "$N" = "1" ]; then exec sleep 20; fi; echo "8329 pass 0 fail"; exit 0 ;;
  red)            echo "1 fail"; exit 1 ;;
  hang-twice)     exec sleep 20 ;;
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
      // Срок не меньше трёх секунд: на загруженной машине заглушка успевает
      // родиться не мгновенно, а убитая ДО первой своей строки не увеличит
      // счётчик вызовов — и тест начнёт врать про число попыток.
      BUN_TEST_TIMEOUT_SEC: "3",
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
    expect(r.stderr).toContain("молчал");
    // Без имени файла зависание неотличимо от любого другого, и следующее
    // такое расследование начинается с нуля — как случилось в этот раз.
    expect(r.stderr).toContain("tests/stuck-here.test.ts");
  });

  slowTest("два зависания подряд — это уже не шум: код 124 и внятная ошибка", () => {
    const r = run(sandbox("hang-twice"));
    expect(r.calls).toBe(2);
    expect(r.code).toBe(124);
    expect(r.stderr).toContain("::error::");
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
});
