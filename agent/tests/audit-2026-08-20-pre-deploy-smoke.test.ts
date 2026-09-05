/**
 * Аудит 2026-08-20: предеплойный смоук в deploy.yml не запускался никогда.
 *
 * Шаг «Pre-deploy smoke (local)» — единственный гейт между чекаутом и
 * `systemctl restart` на проде. Он был обёрнут в
 *
 *     if [ -f bun.lockb ] || [ -f package.json ]; then
 *
 * В корне репозитория нет ни того, ни другого и никогда не было: манифестов
 * два, `agent/package.json` и `agent/miniapp/package.json`, а лок-файл —
 * `agent/bun.lock` (текстовый; `bun.lockb` bun не пишет уже давно). Условие
 * ложно всегда, тело шага целиком пропускалось, шаг завершался зелёным, и
 * дальше сразу шли rsync `--delete` и рестарт юнита.
 *
 * Даже если бы условие сработало, гейт всё равно ничего не решал:
 *
 *   1. `bun test 2>&1 | tail -20` — статус пайплайна это статус `tail`, то
 *      есть 0 при любом провале. `set -o pipefail` в шаге нет, только `set -e`.
 *   2. Прогон шёл из корня репозитория, а `bunfig.toml` с
 *      `preload = ["./tests/_setup.ts"]` лежит в `agent/` и читается из рабочего
 *      каталога. Без preload тесты идут по живой `data/memory.db` и дают
 *      десятки ложных падений — то есть даже честный код выхода был бы шумом.
 *
 * Логика вынесена в .github/scripts/pre-deploy-smoke.sh (как automerge-filter),
 * чтобы её можно было прогнать здесь настоящим bash с подставным `bun`.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, ".github", "scripts", "pre-deploy-smoke.sh");
const WORKFLOW = join(REPO, ".github", "workflows", "deploy.yml");

const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void) => test(name, fn, SPAWN_TIMEOUT_MS);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Дерево-обманка: корень репозитория с манифестами там, где они на самом деле. */
function fixture(opts: { agentManifest?: boolean } = {}): {
  root: string;
  binDir: string;
  log: string;
} {
  const base = mkdtempSync(join(tmpdir(), "smoke-"));
  dirs.push(base);
  const root = join(base, "repo");
  mkdirSync(join(root, "agent", "miniapp"), { recursive: true });
  if (opts.agentManifest !== false) {
    writeFileSync(join(root, "agent", "package.json"), "{}");
  }
  writeFileSync(join(root, "agent", "miniapp", "package.json"), "{}");

  // Подставной `bun`: пишет в лог рабочий каталог и аргументы, падает на той
  // команде, которую называет SMOKE_TEST_FAIL.
  const binDir = join(base, "bin");
  mkdirSync(binDir);
  const log = join(base, "calls.log");
  const stub = join(binDir, "bun");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      'echo "$PWD|$*" >> "$SMOKE_TEST_LOG"',
      'if [ "${SMOKE_TEST_FAIL:-}" = "$*" ]; then exit 7; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return { root, binDir, log };
}

function run(
  f: ReturnType<typeof fixture>,
  fail?: string,
): { code: number | null; out: string; err: string; calls: string[] } {
  const p = Bun.spawnSync(["bash", SCRIPT, f.root], {
    env: {
      ...process.env,
      PATH: `${f.binDir}:${process.env.PATH ?? ""}`,
      SMOKE_TEST_LOG: f.log,
      ...(fail ? { SMOKE_TEST_FAIL: fail } : {}),
    },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(f.log, "utf-8").split("\n").filter(Boolean);
  } catch {
    calls = [];
  }
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
    calls,
  };
}

/** `<cwd>|<args>` → относительный путь от корня фикстуры, чтобы читалось. */
function rel(root: string, call: string): string {
  const [cwd, args] = call.split("|");
  const r = cwd!.startsWith(root) ? cwd!.slice(root.length) || "/" : cwd!;
  return `${r}|${args}`;
}

describe("смоук вообще запускается", () => {
  slowTest("на здоровом дереве вызывает bun четыре раза и выходит нулём", () => {
    const f = fixture();
    const r = run(f);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(r.calls.map((c) => rel(f.root, c))).toEqual([
      "/agent|install --frozen-lockfile",
      "/agent|test tests",
      "/agent/miniapp|install --frozen-lockfile",
      "/agent/miniapp|run build",
    ]);
  });

  slowTest("тесты идут из agent/, где лежит bunfig.toml с preload", () => {
    const f = fixture();
    const testCall = run(f).calls.find((c) => c.endsWith("|test tests"));
    expect(testCall).toBeDefined();
    expect(testCall!.split("|")[0]).toBe(join(f.root, "agent"));
  });

  slowTest("неполный чекаут (нет agent/package.json) валит шаг, а не пропускает", () => {
    const f = fixture({ agentManifest: false });
    const r = run(f);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("::error::");
    expect(r.err).toContain("agent/package.json");
    expect(r.calls).toEqual([]);
  });
});

describe("падение любого шага останавливает деплой", () => {
  for (const [what, argv] of [
    ["bun test", "test tests"],
    ["bun install в agent", "install --frozen-lockfile"],
    ["vite build в miniapp", "run build"],
  ] as const) {
    slowTest(`${what} упал → скрипт не нулевой`, () => {
      const f = fixture();
      const r = run(f, argv);
      expect(r.code).not.toBe(0);
      // Иначе проверка проходит и когда скрипта просто нет (bash → 127):
      // требуем, чтобы упавшая команда действительно была вызвана.
      expect(r.calls.map((c) => c.split("|")[1])).toContain(argv);
    });
  }

  slowTest("провал тестов виден в выводе, а не проглатывается пайпом", () => {
    const f = fixture();
    const r = run(f, "test tests");
    expect(r.err).toContain("::error::");
    // Ровно два вызова: install прошёл, test упал, до miniapp не дошло.
    expect(r.calls.map((c) => c.split("|")[1])).toEqual([
      "install --frozen-lockfile",
      "test tests",
    ]);
  });
});

// deploy.yml удалён при публичном релизе 2026-09-01 — читать нечего; сам
// скрипт смоука на месте и проверяется выше. Вернётся файл — вернётся блок.
const HAS_WORKFLOW = existsSync(WORKFLOW);

describe.skipIf(!HAS_WORKFLOW)("сам deploy.yml", () => {
  const wf = HAS_WORKFLOW ? readFileSync(WORKFLOW, "utf-8") : "";
  // Комментарий шага цитирует прежнее условие целиком — по сырому тексту
  // «старого кода не осталось» не проверить. Срезаем строки-комментарии YAML;
  // shell-комментарии внутри `run:` начинаются с той же решётки и уходят тоже,
  // а строки с кодом не начинаются с неё никогда.
  const yaml = wf
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");

  test("шаг зовёт скрипт", () => {
    expect(yaml).toContain(".github/scripts/pre-deploy-smoke.sh");
  });

  test("мёртвой проверки корневых манифестов не осталось", () => {
    expect(yaml).not.toContain("bun.lockb");
    expect(yaml).not.toMatch(/if \[ -f .*package\.json \]/);
    // Стриппер не съел сам шаг — иначе проверки выше проходили бы впустую.
    expect(yaml).toContain("Pre-deploy smoke (local)");
  });

  test("пайпа, съедающего код выхода тестов, не осталось", () => {
    expect(yaml).not.toMatch(/bun test[^\n]*\|[^\n]*tail/);
  });

  test("bun ставится экшеном, а не curl | bash", () => {
    expect(yaml).toContain("oven-sh/setup-bun");
    expect(yaml).not.toContain("bun.sh/install");
  });

  test("скрипт исполняемый — воркфлоу зовёт его напрямую", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  // Сегодня в скрипте нет ни одного пайплайна, статус которого проверяется,
  // поэтому поведением `pipefail` не отличить — но исходный дефект был ровно
  // «пайп съел код выхода», и следующая правка вернёт его на ту же граблю.
  // Проверяем наличие защиты по исходнику, честно называя это защитой.
  test("скрипт стоит под set -euo pipefail", () => {
    expect(readFileSync(SCRIPT, "utf-8")).toContain("set -euo pipefail");
  });
});
