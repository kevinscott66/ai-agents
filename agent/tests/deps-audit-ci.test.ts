/**
 * Аудит 2026-09-29: в CI не было ни одной проверки зависимостей, и `bun audit`
 * показывал 41 предупреждение (26 в agent, 8 в agent/miniapp, 7 в site/web;
 * 13 high суммарно). Сами версии поднимаются через "overrides", но версии
 * стареют снова — держит их гейт .github/scripts/check-dependency-audit.sh.
 *
 * Здесь проверяется именно поведение гейта, а не текущее состояние
 * зависимостей: настоящий `bun audit` ходит в сеть, а тест обязан быть
 * детерминированным. Поэтому в PATH подкладывается заглушка `bun`, которая
 * печатает заранее заданный JSON.
 *
 * Ключевой случай — четвёртый: сеть мигнула, аудит не состоялся. Отличить это
 * от «уязвимостей нет» нельзя по коду возврата (bun отдаёт 1 и на находки, и
 * на отсутствие lockfile), поэтому гейт смотрит на разбираемость JSON и в
 * сомнительном случае краснеет с exit 2 — как остальные гейты репозитория.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, ".github", "scripts", "check-dependency-audit.sh");
const FLATTEN = join(ROOT, ".github", "scripts", "dependency-audit-flatten.mjs");
const ALLOWLIST = join(ROOT, ".github", "dependency-audit-allowlist.txt");
const WORKFLOW = join(ROOT, ".github", "workflows", "checks.yml");

// Те же 60 с, что в secret-hygiene-ci.test.ts: под полным прогоном spawnSync
// растягивается далеко за дефолтные 5000 мс, и падал бы таймер, а не код.
const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, fn, SPAWN_TIMEOUT_MS);

const FINDING = JSON.stringify({
  postcss: [
    {
      id: 1139510,
      url: "https://github.com/advisories/GHSA-r28c-9q8g-f849",
      title: "PostCSS: Path Traversal in Previous Source Map Auto-Loading",
      severity: "high",
      vulnerable_versions: "<=8.5.17",
      cwe: ["CWE-22"],
      cvss: { score: 7.5, vectorString: null },
    },
  ],
});

type Stub = { out?: string; err?: string; rc?: number; lockfile?: boolean };

function sandbox(stub: Stub) {
  const dir = mkdtempSync(join(tmpdir(), "deps-audit-ci-"));
  const bin = join(dir, "bin");
  const pkg = join(dir, "pkg");
  mkdirSync(bin);
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), '{"name":"probe","private":true}\n');
  if (stub.lockfile !== false) writeFileSync(join(pkg, "bun.lock"), "{}\n");

  const stubPath = join(bin, "bun");
  writeFileSync(
    stubPath,
    [
      "#!/usr/bin/env bash",
      `printf '%s' ${JSON.stringify(stub.out ?? "{}")}`,
      `printf '%s\\n' ${JSON.stringify(stub.err ?? "bun audit v1.3.14")} >&2`,
      `exit ${stub.rc ?? 0}`,
      "",
    ].join("\n"),
  );
  chmodSync(stubPath, 0o755);
  return { dir, bin, pkg };
}

function runGate(stub: Stub, allowlistBody: string) {
  const { dir, bin, pkg } = sandbox(stub);
  const allow = join(dir, "allowlist.txt");
  writeFileSync(allow, allowlistBody);
  const res = spawnSync("bash", [SCRIPT, allow, pkg], {
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  return { ...res, pkg, allow };
}

describe("гейт аудита зависимостей", () => {
  slowTest("чистый аудит и пустой список исключений — зелено", () => {
    const res = runGate({ out: "{}" }, "# пусто\n");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("чисто");
  });

  slowTest("непризнанная находка краснеет и называет пакет с id", () => {
    const res = runGate({ out: FINDING, rc: 1 }, "");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("postcss");
    expect(res.stderr).toContain("1139510");
    expect(res.stderr).toContain("high");
    // Подсказка про overrides: голый `bun update` не двигает транзитивные,
    // а `bun update <name>` записывает пакет в прямые зависимости.
    expect(res.stderr).toContain("overrides");
  });

  slowTest("признанная в списке находка пропускается", () => {
    const { dir, bin, pkg } = sandbox({ out: FINDING, rc: 1 });
    const allow = join(dir, "allowlist.txt");
    writeFileSync(allow, `${pkg} postcss 1139510 # проба\n`);
    const res = spawnSync("bash", [SCRIPT, allow, pkg], {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(res.status).toBe(0);
  });

  slowTest("неразбираемый вывод аудита — exit 2, а не мнимая чистота", () => {
    const res = runGate(
      { out: "error: failed to resolve registry\n", err: "network error", rc: 1 },
      "",
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("refusing to pass");
  });

  slowTest("пустой вывод аудита тоже exit 2", () => {
    const res = runGate({ out: "", rc: 0 }, "");
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("refusing to pass");
  });

  slowTest("JSON-массив вместо объекта — exit 2 (формат вывода сменился)", () => {
    const res = runGate({ out: "[]", rc: 0 }, "");
    expect(res.status).toBe(2);
  });

  slowTest("исключение, которое больше ничего не ловит, краснеет", () => {
    const res = runGate({ out: "{}" }, "some/pkg postcss 1139510 # давно закрыто\n");
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("больше ничего не ловят");
  });

  slowTest("битая строка исключений — exit 2", () => {
    const res = runGate({ out: "{}" }, "agent postcss\n");
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("refusing to pass");
  });

  slowTest("каталог без bun.lock — аудит не состоялся, exit 2", () => {
    const res = runGate({ out: "{}", lockfile: false }, "");
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("refusing to pass");
  });

  slowTest("без аргументов — usage и exit 2", () => {
    const res = spawnSync("bash", [SCRIPT], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage");
  });
});

describe("подключение гейта в CI", () => {
  test("джоба deps-audit есть и проверяет все четыре пакета", () => {
    const wf = readFileSync(WORKFLOW, "utf8");
    expect(wf).toContain("deps-audit:");
    expect(wf).toContain("check-dependency-audit.sh");
    expect(wf).toContain("dependency-audit-allowlist.txt");
    expect(wf).toContain("agent agent/miniapp site/server site/web");
  });

  test("каждый пакет репозитория с bun.lock попадает под аудит", () => {
    const wf = readFileSync(WORKFLOW, "utf8");
    const step = wf.slice(wf.indexOf("deps-audit:"));
    const args = step.slice(0, step.indexOf("site-tests:"));
    // Список каталогов в шаге — ровно те пакеты, у которых есть свой lockfile.
    const packages = ["agent", "agent/miniapp", "site/server", "site/web"];
    for (const pkg of packages) {
      expect(Bun.file(join(ROOT, pkg, "bun.lock")).size).toBeGreaterThan(0);
      expect(args).toContain(pkg);
    }
  });

  test("файл исключений существует и объясняет формат", () => {
    const body = readFileSync(ALLOWLIST, "utf8");
    expect(body).toContain("advisory-id");
    // Ни одной непустой строки-записи: на момент коммита все находки закрыты.
    const entries = body
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim())
      .filter(Boolean);
    expect(entries).toEqual([]);
  });

  test("разборщик JSON лежит рядом со скриптом", () => {
    expect(readFileSync(FLATTEN, "utf8")).toContain("severity");
  });
});
