/**
 * Аудит 2026-08-29: `deploy/deploy-site.sh` тащил те же три дефекта на пути
 * «деплой сайта пошёл не так», которые уже вычинены в `deploy/deploy.sh`
 * (см. `audit-2026-08-29-deploy-rollback-hint.test.ts`):
 *
 *   1. Шаг 3 (`systemctl restart web3-puls`) не был обёрнут. При
 *      `set -euo pipefail` его отказ убивал скрипт прямо там — до health-gate
 *      и до единственной подсказки про откат. Код на проде к этому моменту уже
 *      новый, а оператор не получал ничего.
 *   2. В подсказке стояло литеральное `/root/web3-puls-predeploy-<TS>/`: имя
 *      снапшота считается НА СЕРВЕРЕ и сюда не возвращалось. Строка
 *      печаталась, но выполнить её было нельзя.
 *   3. Откат шёл `rsync -a` без `--delete` — старые файлы возвращались, а
 *      новые, привезённые неудачным деплоем, оставались.
 *
 * Плюс сам снапшот: `mkdir -p` без `chmod 700` при том, что внутрь попадает
 * прод-`.env` сайта (там `SITE_INGEST_TOKEN`), и ни одной ротации — каталог с
 * секретами прибавлялся на каждый деплой и не удалялся никогда.
 *
 * Тест гоняет сам скрипт в песочнице: `ssh`, `rsync`, `curl`, `sleep` и `bun`
 * подменены заглушками на PATH, а сам скрипт скопирован в отдельный репозиторий
 * во временном каталоге. Ни одна команда никуда не уходит, живой site/web не
 * собирается и не трогается.
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
const SNAPSHOT = "/root/web3-puls-predeploy-20260829-010203";
const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void) => test(name, fn, SPAWN_TIMEOUT_MS);

let SANDBOX = "";
let BIN = "";
let CALLS = "";
let REPO_DIR = "";

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "deploy-site-"));
  BIN = join(SANDBOX, "bin");
  CALLS = join(SANDBOX, "calls.log");
  mkdirSync(BIN, { recursive: true });

  writeFileSync(
    join(BIN, "ssh"),
    `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "${CALLS}"
case "$*" in
  *SNAP=*) echo "snapshot=${SNAPSHOT}"; exit 0 ;;
  *curl*) echo "\${HEALTH_CODE:-200}"; exit 0 ;;
  *"systemctl restart"*) exit "\${STEP3_RC:-0}" ;;
  *tail*) echo "prod log line"; exit 0 ;;
esac
exit 0
`,
  );
  for (const [name, body] of [
    ["rsync", `#!/bin/sh\nprintf 'rsync %s\\n' "$*" >> "${CALLS}"\nexit 0\n`],
    ["curl", `#!/bin/sh\necho 200\nexit 0\n`],
    ["sleep", `#!/bin/sh\nexit 0\n`],
    ["bun", `#!/bin/sh\nprintf 'bun %s\\n' "$*" >> "${CALLS}"\nexit 0\n`],
  ] as const) {
    writeFileSync(join(BIN, name), body);
  }
  for (const n of ["ssh", "rsync", "curl", "sleep", "bun"]) chmodSync(join(BIN, n), 0o755);

  REPO_DIR = join(SANDBOX, "repo");
  mkdirSync(join(REPO_DIR, "deploy"), { recursive: true });
  mkdirSync(join(REPO_DIR, "site", "server"), { recursive: true });
  mkdirSync(join(REPO_DIR, "site", "web", "dist"), { recursive: true });
  copyFileSync(join(REPO, "deploy", "deploy-site.sh"), join(REPO_DIR, "deploy", "deploy-site.sh"));
  writeFileSync(join(REPO_DIR, "site", "server", "index.ts"), "// tracked\n");
  // Заглушка `bun` ничего не собирает, поэтому dist кладём заранее: скрипт
  // проверяет наличие index.html после сборки.
  writeFileSync(join(REPO_DIR, "site", "web", "dist", "index.html"), "<!doctype html>\n");
  const git = (...a: string[]) => spawnSync("git", ["-C", REPO_DIR, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});

afterAll(() => {
  if (SANDBOX && existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
});

function deploySite(extra: Record<string, string> = {}) {
  writeFileSync(CALLS, "");
  const r = spawnSync("bash", [join(REPO_DIR, "deploy", "deploy-site.sh")], {
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH ?? ""}`,
      DRY_RUN: "0",
      DEPLOY_HOST: "stub@invalid.example",
      ...extra,
    },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    code: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    calls: existsSync(CALLS) ? readFileSync(CALLS, "utf8") : "",
  };
}

/** Строка подсказки про откат целиком — по ней и проверяем содержимое. */
function rollbackLine(out: string): string {
  return (
    out
      .split("\n")
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
      .find((l) => l.includes("Rollback:")) ?? ""
  );
}

describe("deploy-site: снапшот прода", () => {
  slowTest("каталог снапшота закрывается chmod 700 — внутри прод .env сайта", () => {
    const snap = deploySite()
      .calls.split("\n")
      .find((l) => l.includes("SNAP="));
    expect(snap).toBeTruthy();
    expect(snap!).toContain("chmod 700");
  });

  slowTest("снапшоты ротируются, а не копятся вечно", () => {
    const snap = deploySite()
      .calls.split("\n")
      .find((l) => l.includes("SNAP="))!;
    expect(snap).toContain("/root/web3-puls-predeploy-*");
    expect(snap).toContain("xargs -r rm -rf");
  });

  slowTest("глубину ротации можно задать переменной", () => {
    const snap = deploySite({ DEPLOY_SITE_SNAPSHOT_KEEP: "2" })
      .calls.split("\n")
      .find((l) => l.includes("SNAP="))!;
    // tail -n +3 = «всё, кроме двух самых свежих».
    expect(snap).toContain("tail -n +3");
  });

  slowTest("DRY_RUN не делает на проде ничего", () => {
    const r = deploySite({ DRY_RUN: "1" });
    expect(r.code).toBe(0);
    expect(r.calls).not.toContain("SNAP=");
    expect(r.calls).not.toContain("systemctl restart");
  });
});

describe("deploy-site: шаг 3 упал", () => {
  slowTest("скрипт не умирает молча, а называет шаг", () => {
    const r = deploySite({ STEP3_RC: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("шаг 3");
  });

  slowTest("подсказка про откат вообще печатается", () => {
    // Именно этого и не было: set -e убивал скрипт до шага 4.
    expect(rollbackLine(deploySite({ STEP3_RC: "1" }).out)).toContain("Rollback:");
  });

  slowTest("в подсказке настоящее имя снапшота, а не <TS>", () => {
    const line = rollbackLine(deploySite({ STEP3_RC: "1" }).out);
    expect(line).toContain(SNAPSHOT);
    expect(line).not.toContain("<TS>");
  });
});

describe("deploy-site: подсказка про откат исполнима", () => {
  const failed = () => rollbackLine(deploySite({ HEALTH_CODE: "500" }).out);

  slowTest("красный health-gate печатает подсказку с именем снапшота", () => {
    const line = failed();
    expect(line).toContain(SNAPSHOT);
    expect(line).not.toContain("<TS>");
  });

  slowTest("откат идёт с --delete, иначе новые файлы переживут откат", () => {
    expect(failed()).toContain("--delete");
  });

  slowTest("откат не сносит node_modules и боевой SQLite", () => {
    const line = failed();
    expect(line).toContain("--exclude node_modules");
    expect(line).toContain("--exclude server/data");
  });

  slowTest("откат перезапускает сервис", () => {
    expect(failed()).toContain("systemctl restart web3-puls");
  });
});

describe("deploy-site: успешный деплой", () => {
  slowTest("доходит до конца и не пугает откатом", () => {
    const r = deploySite();
    expect(r.code).toBe(0);
    expect(r.out).toContain("site deploy OK");
    expect(rollbackLine(r.out)).toBe("");
  });
});
