/**
 * Аудит 2026-09-29 (AUD-042): ночной детектор нестабильности был красным пять
 * ночей подряд — 25, 26, 27, 28 и 29.09 — и всё это время об этом не знал
 * никто. Механика молчания: обязательный гейт гоняет набор один раз и зелёный
 * (падения из AUD-040 воспроизводятся только с `--rerun-each`), вывод ночного
 * прогона лежит в артефакте, который надо открыть руками, а письмо о падении
 * крона приходит владельцу репозитория и тонет.
 *
 * Отказ теперь заводит задачу, следующий отказ дописывает в неё комментарий, а
 * первый зелёный прогон её закрывает. Проверяется поведение скрипта, а не
 * настоящий GitHub: в PATH подкладывается заглушка `gh`, которая пишет свои
 * аргументы в файл и отдаёт заранее заданный список открытых задач.
 *
 * Отдельно проверяется проводка в workflow: оба шага должны стоять под
 * `github.ref == 'refs/heads/main'`, иначе ручной прогон на ветке — штатный
 * способ проверять правки ночного прогона — заводил бы задачи о самом себе.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, ".github", "scripts", "nightly-red-issue.sh");
const WORKFLOW = join(ROOT, ".github", "workflows", "tests-nightly.yml");
const TITLE = "Ночной прогон с повторами красный";

// Те же 60 с, что в deps-audit-ci.test.ts: под полным прогоном spawnSync
// растягивается далеко за дефолтные 5000 мс, и падал бы таймер, а не код.
const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void | Promise<void>) => test(name, fn, SPAWN_TIMEOUT_MS);

const OUTPUT_SAMPLE = [
  "tests/a.test.ts:",
  "(fail) фильтры и порядок не изменились > фильтр по чату работает как раньше [2.21ms]",
  "(fail) фильтры и порядок не изменились > фильтр по чату работает как раньше [1.90ms]",
  "(fail) автономия > глобальный дефолт [0.50ms]",
  " 43150 pass",
  " 195 skip",
  " 5 fail",
  "Ran 43350 tests across 993 files. [603.08s]",
  "",
].join("\n");

/** Заглушка `gh`: печатает заданный список задач и протоколирует вызовы. */
function sandbox(openIssues: { number: number; title: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), "nightly-red-issue-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "gh-calls.txt");
  const stub = join(bin, "gh");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'if [ "$1" = issue ] && [ "$2" = list ]; then',
      // --jq заглушка не исполняет: отдаёт номер первой задачи с тем же заголовком.
      `  printf '%s' ${JSON.stringify(
        openIssues.find((i) => i.title === TITLE)?.number?.toString() ?? "",
      )}`,
      "fi",
      'if [ "$1" = issue ] && [ "$2" = comment ] || [ "$2" = create ]; then',
      '  for a in "$@"; do',
      '    if [ -f "$a" ]; then cp "$a" ' + JSON.stringify(join(dir, "body.md")) + "; fi",
      "  done",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return { dir, bin, log };
}

function run(mode: string, openIssues: { number: number; title: string }[], withOutput = true) {
  const { dir, bin, log } = sandbox(openIssues);
  const args = [SCRIPT, mode];
  if (withOutput && mode === "fail") {
    const out = join(dir, "bun-flaky-output.txt");
    writeFileSync(out, OUTPUT_SAMPLE);
    args.push(out);
  } else if (mode === "fail") {
    args.push(join(dir, "missing.txt"));
  }
  const res = spawnSync("bash", args, {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUN_URL: "https://example/run/1" },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  const body = existsSync(join(dir, "body.md")) ? readFileSync(join(dir, "body.md"), "utf8") : "";
  return { ...res, calls, body };
}

describe("AUD-042: красный ночной прогон виден без ручного захода в артефакт", () => {
  slowTest("отказ без открытой задачи — задача заводится, с телом из вывода прогона", () => {
    const r = run("fail", []);
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`issue create --title ${TITLE}`);
    expect(r.calls).not.toContain("issue comment");
    // Упавшие проверки — без повторов: пять одинаковых строк ночного прогона
    // не должны превращаться в пять пунктов.
    expect(r.body).toContain("(fail) фильтры и порядок не изменились > фильтр по чату работает как раньше");
    expect(r.body.match(/фильтр по чату работает как раньше/g)?.length).toBe(1);
    expect(r.body).toContain("(fail) автономия > глобальный дефолт");
    expect(r.body).toContain("Ran 43350 tests across 993 files.");
    expect(r.body).toContain("https://example/run/1");
  });

  slowTest("второй отказ подряд — комментарий в ту же задачу, а не второй дубль", () => {
    const r = run("fail", [{ number: 42, title: TITLE }]);
    expect(r.status).toBe(0);
    expect(r.calls).toContain("issue comment 42");
    expect(r.calls).not.toContain("issue create");
  });

  slowTest("зелёный прогон закрывает открытую задачу", () => {
    const r = run("ok", [{ number: 42, title: TITLE }]);
    expect(r.status).toBe(0);
    expect(r.calls).toContain("issue comment 42");
    expect(r.calls).toContain("issue close 42");
  });

  slowTest("зелёный прогон без открытой задачи ничего не пишет", () => {
    const r = run("ok", []);
    expect(r.status).toBe(0);
    expect(r.calls).not.toContain("issue comment");
    expect(r.calls).not.toContain("issue close");
    expect(r.calls).not.toContain("issue create");
  });

  slowTest("чужая открытая задача за свою не принимается", () => {
    const r = run("fail", [{ number: 7, title: "Совсем другая задача" }]);
    expect(r.status).toBe(0);
    expect(r.calls).toContain("issue create");
    expect(r.calls).not.toContain("issue comment 7");
  });

  slowTest("вывод прогона не сохранился — задача всё равно заводится", () => {
    const r = run("fail", [], false);
    expect(r.status).toBe(0);
    expect(r.calls).toContain("issue create");
    expect(r.body).toContain("Вывод прогона не сохранился");
  });

  slowTest("режим обязателен: без аргумента скрипт краснеет, а не молчит", () => {
    const { bin } = sandbox([]);
    const res = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage:");
  });
});

describe("AUD-042: проводка в workflow", () => {
  const yml = readFileSync(WORKFLOW, "utf8");

  test("оба шага вызывают скрипт и только на main", () => {
    expect(yml).toContain("bash .github/scripts/nightly-red-issue.sh fail /tmp/bun-flaky-output.txt");
    expect(yml).toContain("bash .github/scripts/nightly-red-issue.sh ok");
    const guards = yml.match(/if: (failure|success)\(\) && github\.ref == 'refs\/heads\/main'/g);
    expect(guards?.length).toBe(2);
  });

  test("задачи писать нечем без issues: write", () => {
    expect(yml).toMatch(/permissions:[\s\S]*issues: write/);
  });

  test("путь к выводу тот же, что у шага загрузки артефакта", () => {
    expect(yml).toContain("path: /tmp/bun-flaky-output.txt");
    expect(yml).toContain("tee /tmp/bun-flaky-output.txt");
  });
});
