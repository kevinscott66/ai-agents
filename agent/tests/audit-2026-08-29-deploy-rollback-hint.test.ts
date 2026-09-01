/**
 * Аудит 2026-08-29: подсказка про откат либо не печаталась, либо была пустой.
 *
 * Три дефекта в deploy/deploy.sh, все на пути «деплой пошёл не так»:
 *
 *   1. Шаг 3 (bun install → сборка Mini App → restart) не был обёрнут вовсе.
 *      При `set -euo pipefail` любой его отказ убивал скрипт прямо там: до
 *      health-gate и до подсказки про откат дело не доходило НИКОГДА. Прод к
 *      этому моменту уже перезапущен поверх нового кода.
 *   2. В подсказке стояло литеральное `/root/agent-team-predeploy-<TS>/` — имя
 *      снапшота считается на сервере и сюда не возвращалось. То есть строка
 *      печаталась, но выполнить её было нельзя.
 *   3. Откат шёл `rsync -a` без `--delete`: старые файлы возвращались, а
 *      новые, привезённые неудачным деплоем, оставались.
 *
 * Плюс снапшот копил прод-`.env` в /root без ротации и без прав.
 *
 * Тест гоняет сам скрипт в песочнице: `ssh`, `rsync`, `curl` и `sleep`
 * подменены заглушками на PATH, поэтому ни одна команда никуда не уходит.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  existsSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dir, "..", "..");
const SNAPSHOT = "/root/agent-team-predeploy-20260829-010203";

let SANDBOX = "";
let BIN = "";
let CALLS = "";
let REPO_DIR = "";

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "deploy-rollback-"));
  BIN = join(SANDBOX, "bin");
  CALLS = join(SANDBOX, "calls.log");
  mkdirSync(BIN, { recursive: true });

  // ssh отвечает по смыслу команды: снапшот печатает своё имя, шаг 3 может
  // упасть по STEP3_RC, health отдаёт HEALTH_CODE.
  writeFileSync(
    join(BIN, "ssh"),
    `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "${CALLS}"
case "$*" in
  *"sh -s --"*) shift; exec "$@" ;;
  *SNAP=*) echo "snapshot=${SNAPSHOT}"; exit 0 ;;
  *"bun install"*) exit "\${STEP3_RC:-0}" ;;
  *curl*) echo "\${HEALTH_CODE:-200}"; exit 0 ;;
  *tail*) echo "prod log line"; exit 0 ;;
esac
exit 0
`,
  );
  for (const [name, body] of [
    ["rsync", `#!/bin/sh\nprintf 'rsync %s\\n' "$*" >> "${CALLS}"\nexit 0\n`],
    ["curl", `#!/bin/sh\necho 200\nexit 0\n`],
    ["sleep", `#!/bin/sh\nexit 0\n`],
  ] as const) {
    writeFileSync(join(BIN, name), body);
  }
  for (const n of ["ssh", "rsync", "curl", "sleep"]) chmodSync(join(BIN, n), 0o755);

  REPO_DIR = join(SANDBOX, "repo");
  mkdirSync(join(REPO_DIR, "deploy"), { recursive: true });
  mkdirSync(join(REPO_DIR, "agent", "miniapp"), { recursive: true });
  copyFileSync(join(REPO, "deploy", "deploy.sh"), join(REPO_DIR, "deploy", "deploy.sh"));
  // Шаг 0 берёт замок через deploy-lock.sh; без него скрипт откажется катить.
  copyFileSync(join(REPO, "deploy", "deploy-lock.sh"), join(REPO_DIR, "deploy", "deploy-lock.sh"));
  writeFileSync(join(REPO_DIR, "agent", "index.ts"), "// tracked\n");
  const git = (...a: string[]) => spawnSync("git", ["-C", REPO_DIR, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", "agent/index.ts", "deploy/deploy.sh", "deploy/deploy-lock.sh");
  git("commit", "-q", "-m", "init");
});

afterAll(() => {
  if (SANDBOX && existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
});

function deploy(extra: Record<string, string> = {}) {
  writeFileSync(CALLS, "");
  const r = spawnSync("bash", [join(REPO_DIR, "deploy", "deploy.sh")], {
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH ?? ""}`,
      DRY_RUN: "0",
      DEPLOY_HOST: "stub@invalid.example",
      DEPLOY_LOCK_DIR: join(SANDBOX, "lock"),
      ...extra,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    code: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    calls: existsSync(CALLS) ? readFileSync(CALLS, "utf8") : "",
  };
}

/**
 * Каждый тест здесь поднимает настоящий bash-скрипт деплоя со стаб-бинарями:
 * один прогон — это `spawnSync` + `git`-песочница, сотни миллисекунд даже на
 * холостом ходу. Дефолтный дедлайн bun (5000 мс) это переживает только на
 * незанятой машине: на полном прогоне (776 файлов) «глубина хранения
 * настраивается» упиралась в 6048 мс и роняла гейт целиком, хотя в одиночку
 * файл проходит за 5.35 с. Утверждения не трогаем — двигаем только дедлайн,
 * с запасом на порядок, чтобы падение означало настоящую поломку, а не
 * загруженный ноутбук.
 */
const SLOW = 60_000;
const slowTest = (name: string, fn: () => void) => test(name, fn, SLOW);

describe("шаг 3 упал", () => {
  slowTest("скрипт не умирает молча, а называет шаг", () => {
    const r = deploy({ STEP3_RC: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("шаг 3");
  });

  slowTest("подсказка про откат вообще печатается", () => {
    // Именно этого и не было: set -e убивал скрипт до шага 4.
    expect(deploy({ STEP3_RC: "1" }).out).toContain("Rollback:");
  });

  slowTest("в подсказке настоящий путь снапшота, а не <TS>", () => {
    const out = deploy({ STEP3_RC: "1" }).out;
    expect(out).toContain(SNAPSHOT);
    expect(out).not.toContain("<TS>");
  });

  slowTest("прод-лог показывается рядом с подсказкой", () => {
    expect(deploy({ STEP3_RC: "1" }).out).toContain("prod log line");
  });
});

describe("health-gate красный", () => {
  slowTest("подсказка та же и с тем же настоящим путём", () => {
    const r = deploy({ HEALTH_CODE: "500" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Rollback:");
    expect(r.out).toContain(SNAPSHOT);
    expect(r.out).not.toContain("<TS>");
  });
});

describe("сам откат", () => {
  slowTest("восстановление идёт с --delete", () => {
    // Без него откат возвращает старые файлы, но оставляет новые от неудачного
    // деплоя — состояние, которого не было ни до, ни после.
    const line = deploy({ STEP3_RC: "1" })
      .out.split("\n")
      .find((l) => l.includes("Rollback:"));
    expect(line).toBeDefined();
    expect(line).toContain("rsync -a --delete");
    expect(line).toContain("--exclude node_modules");
    expect(line).toContain("--exclude data");
  });
});

describe("снапшот", () => {
  slowTest("права ограничены и старые копии не копятся", () => {
    // В снапшот попадает прод .env; исключить его нельзя — без него откат не
    // поднимет сервис. Значит: закрыть права и не хранить бесконечно.
    const snap = deploy()
      .calls.split("\n")
      .find((l) => l.includes("SNAP="));
    expect(snap).toBeDefined();
    expect(snap).toContain("chmod 700");
    expect(snap).toContain("rm -rf");
    expect(snap).toContain("tail -n +6");
  });

  slowTest("глубина хранения настраивается", () => {
    const snap = deploy({ DEPLOY_SNAPSHOT_KEEP: "2" })
      .calls.split("\n")
      .find((l) => l.includes("SNAP="));
    expect(snap).toContain("tail -n +3");
  });
});

describe("удачный деплой не задет", () => {
  slowTest("проходит все четыре шага и выходит нулём", () => {
    const r = deploy();
    expect(r.code).toBe(0);
    expect(r.out).toContain("deploy OK");
    expect(r.out).not.toContain("Rollback:");
    expect(r.calls).toContain("rsync ");
  });
});
