/**
 * Аудит 2026-08-29 — выкатка в /opt/agent-team не защищена от второй выкатки.
 *
 * Катить в прод умели два независимых пути: `deploy/deploy.sh` с Mac и
 * воркфлоу deploy.yml в CI. Между собой воркфлоу сериализовались общей
 * `concurrency: group: deploy-vps`, а Mac про неё не знал. Пересечение ломает
 * не только rsync: каждая выкатка снимает «снапшот прода до деплоя», и вторая
 * снимает его с уже наполовину перезаписанного дерева — откатываться
 * становится некуда.
 *
 * Второго пути нет с публичного релиза 2026-09-01: выкатка из CI удалена, в
 * прод ходит только deploy.sh (tests/audit-2026-09-11-predeploy-smoke-unwired
 * .test.ts). Замок остался нужен по первой причине — два запуска одного и того
 * же скрипта: две сессии, два воркри, повтор после Ctrl-C.
 *
 * Здесь проверяется deploy/deploy-lock.sh (атомарный mkdir на той стороне,
 * снятие протухшего замка, release только своего) и то, что путь в прод его
 * действительно берёт и отпускает. Блок про CI ниже включается сам, если
 * воркфлоу вернётся.
 *
 * Прод не задействован: ssh/rsync/curl/sleep подменены заглушками на PATH,
 * а «удалённый» скрипт замка выполняется локально во временном каталоге.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { writeSmokeStub } from "./helpers/deploy-smoke-stub.ts";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LOCK_SH = join(REPO_ROOT, "deploy", "deploy-lock.sh");
const DEPLOY_SH = join(REPO_ROOT, "deploy", "deploy.sh");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "deploy.yml");

/** spawnSync целого шелл-скрипта не укладывается в дефолтные 5s bun-теста. */
const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, fn, SPAWN_TIMEOUT_MS);

const nowSec = () => Math.floor(Date.now() / 1000);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

interface Sandbox {
  dir: string;
  bin: string;
  lockDir: string;
  calls: string;
}

/** ssh-заглушка: выкидывает хост и выполняет «удалённую» команду локально. */
function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "deploy-lock-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const calls = join(dir, "calls.txt");
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh\nprintf 'ssh %s\\n' "$*" >> ${JSON.stringify(calls)}\nshift\nexec "$@"\n`,
  );
  chmodSync(join(bin, "ssh"), 0o755);
  return { dir, bin, lockDir: join(dir, "lockroot", "agent-team-deploy"), calls };
}

function runLock(
  sb: Sandbox,
  action: string,
  env: Record<string, string> = {},
): { code: number; out: string } {
  const r = Bun.spawnSync({
    cmd: ["bash", LOCK_SH, action],
    cwd: sb.dir,
    env: {
      PATH: `${sb.bin}:${process.env.PATH ?? ""}`,
      HOME: sb.dir,
      DEPLOY_HOST: "agent-deploy@prod.invalid",
      DEPLOY_LOCK_DIR: sb.lockDir,
      ...env,
    },
  });
  return {
    code: r.exitCode ?? -1,
    out: `${r.stdout.toString()}${r.stderr.toString()}`,
  };
}

/** Замок, который держит кто-то другой, возрастом ageSec секунд. */
function plantLock(sb: Sandbox, owner: string, ageSec: number, token = "other-token") {
  mkdirSync(sb.lockDir, { recursive: true });
  writeFileSync(join(sb.lockDir, "token"), `${token}\n`);
  writeFileSync(join(sb.lockDir, "owner"), `${owner}\n`);
  writeFileSync(join(sb.lockDir, "started"), `${nowSec() - ageSec}\n`);
}

describe("deploy-lock.sh — атомарный замок на прод-хосте", () => {
  slowTest("свободный замок берётся и пишет владельца", () => {
    const sb = makeSandbox();
    try {
      const r = runLock(sb, "acquire", {
        DEPLOY_LOCK_TOKEN: "mac-1",
        DEPLOY_LOCK_OWNER: "mac dobropalm",
      });
      expect(r.code).toBe(0);
      expect(r.out).toContain("acquired");
      expect(readFileSync(join(sb.lockDir, "token"), "utf8").trim()).toBe("mac-1");
      expect(readFileSync(join(sb.lockDir, "owner"), "utf8").trim()).toBe("mac dobropalm");
      expect(Number(readFileSync(join(sb.lockDir, "started"), "utf8").trim())).toBeGreaterThan(0);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("занятый замок не отдаётся второму и называет держателя", () => {
    const sb = makeSandbox();
    try {
      plantLock(sb, "gha run 42", 30);
      const r = runLock(sb, "acquire", { DEPLOY_LOCK_TOKEN: "mac-1" });
      expect(r.code).toBe(3);
      expect(r.out).toContain("busy");
      expect(r.out).toContain("gha run 42");
      // чужой токен не перетёрт
      expect(readFileSync(join(sb.lockDir, "token"), "utf8").trim()).toBe("other-token");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("протухший замок снимается громко и достаётся новому", () => {
    const sb = makeSandbox();
    try {
      plantLock(sb, "gha run 42", 5000);
      const r = runLock(sb, "acquire", {
        DEPLOY_LOCK_TOKEN: "mac-1",
        DEPLOY_LOCK_STALE_SEC: "600",
      });
      expect(r.code).toBe(0);
      expect(r.out).toContain("stale");
      expect(r.out).toContain("acquired-after-stale");
      expect(readFileSync(join(sb.lockDir, "token"), "utf8").trim()).toBe("mac-1");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("release снимает только свой замок", () => {
    const sb = makeSandbox();
    try {
      plantLock(sb, "gha run 42", 30);
      const foreign = runLock(sb, "release", { DEPLOY_LOCK_TOKEN: "mac-1" });
      expect(foreign.code).toBe(4);
      expect(foreign.out).toContain("held-by-other");
      expect(existsSync(sb.lockDir)).toBe(true);

      const own = runLock(sb, "release", { DEPLOY_LOCK_TOKEN: "other-token" });
      expect(own.code).toBe(0);
      expect(own.out).toContain("released");
      expect(existsSync(sb.lockDir)).toBe(false);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("release на несуществующем замке не ошибка", () => {
    const sb = makeSandbox();
    try {
      const r = runLock(sb, "release", { DEPLOY_LOCK_TOKEN: "mac-1" });
      expect(r.code).toBe(0);
      expect(r.out).toContain("not-held");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("status показывает свободно/занято", () => {
    const sb = makeSandbox();
    try {
      expect(runLock(sb, "status").out).toContain("free");
      plantLock(sb, "gha run 42", 30);
      const held = runLock(sb, "status");
      expect(held.out).toContain("held");
      expect(held.out).toContain("gha run 42");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("без токена и с мусорным токеном скрипт отказывается работать", () => {
    const sb = makeSandbox();
    try {
      expect(runLock(sb, "acquire", { DEPLOY_LOCK_TOKEN: "" }).code).toBe(2);
      expect(runLock(sb, "acquire", { DEPLOY_LOCK_TOKEN: "   " }).code).toBe(2);
      expect(runLock(sb, "release", { DEPLOY_LOCK_TOKEN: "" }).code).toBe(2);
      const bad = runLock(sb, "acquire", { DEPLOY_LOCK_TOKEN: "a b; rm -rf /" });
      expect(bad.code).toBe(2);
      expect(bad.out).toContain("DEPLOY_LOCK_TOKEN");
      expect(runLock(sb, "wat").code).toBe(2);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("DEPLOY_LOCK_STALE_SEC читается по правилам EnvironmentFile", () => {
    const sb = makeSandbox();
    try {
      // Пустое/пробел/мусор/ноль → дефолт 1800: замок возрастом 900s ещё живой.
      for (const raw of ["", "   ", "abc", "0", "-5"]) {
        rmSync(sb.lockDir, { recursive: true, force: true });
        plantLock(sb, "gha run 42", 900);
        const r = runLock(sb, "acquire", {
          DEPLOY_LOCK_TOKEN: "mac-1",
          DEPLOY_LOCK_STALE_SEC: raw,
        });
        expect(`${raw}:${r.code}`).toBe(`${raw}:3`);
      }
      // Явное значение уважается.
      rmSync(sb.lockDir, { recursive: true, force: true });
      plantLock(sb, "gha run 42", 900);
      expect(
        runLock(sb, "acquire", { DEPLOY_LOCK_TOKEN: "mac-1", DEPLOY_LOCK_STALE_SEC: "300" }).code,
      ).toBe(0);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("замок без started оценивается по mtime каталога, а не считается протухшим", () => {
    const sb = makeSandbox();
    try {
      mkdirSync(sb.lockDir, { recursive: true });
      writeFileSync(join(sb.lockDir, "token"), "other-token\n");
      writeFileSync(join(sb.lockDir, "owner"), "gha run 42\n");
      const r = runLock(sb, "acquire", {
        DEPLOY_LOCK_TOKEN: "mac-1",
        DEPLOY_LOCK_STALE_SEC: "600",
      });
      expect(r.code).toBe(3);
      expect(r.out).toContain("busy");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});

// --- deploy.sh целиком: берёт замок и отпускает на любом исходе ---

interface DeploySandbox extends Sandbox {
  repo: string;
}

function makeDeploySandbox(): DeploySandbox {
  const sb = makeSandbox();
  const repo = join(sb.dir, "repo");
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(join(repo, "agent", "miniapp"), { recursive: true });
  writeFileSync(join(repo, "agent", "index.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, "deploy", "deploy.sh"), readFileSync(DEPLOY_SH, "utf8"));
  writeFileSync(join(repo, "deploy", "deploy-lock.sh"), readFileSync(LOCK_SH, "utf8"));
  chmodSync(join(repo, "deploy", "deploy.sh"), 0o755);
  chmodSync(join(repo, "deploy", "deploy-lock.sh"), 0o755);

  // Смоук — заглушка: настоящий делает `bun install` и полный прогон тестов.
  writeSmokeStub(repo, sb.calls);

  // ssh-заглушка с ветками: замок исполняем локально, остальное — сценарий.
  writeFileSync(
    join(sb.bin, "ssh"),
    `#!/bin/sh
printf 'ssh %s\\n' "$*" >> ${JSON.stringify(sb.calls)}
case "$*" in
  *"sh -s --"*) shift; exec "$@" ;;
  *SNAP=*) echo "snapshot=/root/agent-team-predeploy-20260829-010203"; exit 0 ;;
  *curl*) echo "\${HEALTH_CODE:-200}"; exit 0 ;;
  *"agent-team-deploy restart"*) exit "\${STEP3_RC:-0}" ;;
  *tail*) echo "log line from prod"; exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(join(sb.bin, "ssh"), 0o755);

  for (const [name, body] of [
    ["rsync", `printf 'rsync %s\\n' "$*" >> ${JSON.stringify(sb.calls)}\nexit "\${RSYNC_RC:-0}"\n`],
    ["curl", `printf 'curl %s\\n' "$*" >> ${JSON.stringify(sb.calls)}\necho 200\n`],
    ["sleep", "exit 0\n"],
  ] as const) {
    writeFileSync(join(sb.bin, name), `#!/bin/sh\n${body}`);
    chmodSync(join(sb.bin, name), 0o755);
  }

  for (const cmd of [
    ["git", "init", "-q"],
    ["git", "add", "-A"],
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
  ]) {
    Bun.spawnSync({ cmd, cwd: repo });
  }
  return { ...sb, repo };
}

function runDeploy(
  sb: DeploySandbox,
  env: Record<string, string> = {},
): { code: number; out: string; calls: string } {
  const r = Bun.spawnSync({
    cmd: ["bash", join(sb.repo, "deploy", "deploy.sh")],
    cwd: sb.repo,
    env: {
      PATH: `${sb.bin}:${process.env.PATH ?? ""}`,
      HOME: sb.dir,
      DEPLOY_HOST: "agent-deploy@prod.invalid",
      DEPLOY_PATH: "/opt/agent-team",
      DEPLOY_SERVICE: "agent-team",
      DEPLOY_LOCK_DIR: sb.lockDir,
      ...env,
    },
  });
  return {
    code: r.exitCode ?? -1,
    out: stripAnsi(`${r.stdout.toString()}${r.stderr.toString()}`),
    calls: existsSync(sb.calls) ? readFileSync(sb.calls, "utf8") : "",
  };
}

describe("deploy.sh — вторая выкатка не начинается, пока идёт первая", () => {
  slowTest("успешный деплой берёт замок и отпускает его", () => {
    const sb = makeDeploySandbox();
    try {
      const r = runDeploy(sb);
      expect(r.code).toBe(0);
      expect(r.out).toContain("deploy OK");
      expect(r.out.toLowerCase()).toContain("замок");
      expect(existsSync(sb.lockDir)).toBe(false);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("занятый замок останавливает выкатку ДО rsync и рестарта", () => {
    const sb = makeDeploySandbox();
    try {
      plantLock(sb, "gha run 42", 30);
      const r = runDeploy(sb);
      expect(r.code).toBe(1);
      expect(r.out).toContain("gha run 42");
      expect(r.calls).not.toContain("rsync ");
      expect(r.calls).not.toContain("systemctl restart");
      // чужой замок остался на месте
      expect(readFileSync(join(sb.lockDir, "token"), "utf8").trim()).toBe("other-token");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  // Круг 49 (tests/audit-2026-09-11-predeploy-smoke-unwired.test.ts): смоук
  // снова зовут, и звать его должен именно этот путь — других в прод нет.
  slowTest("смоук проходит до замка, а не после", () => {
    const sb = makeDeploySandbox();
    try {
      const r = runDeploy(sb);
      expect(r.code).toBe(0);
      const smoke = r.calls.indexOf("smoke ");
      expect(smoke).toBeGreaterThan(-1);
      // Замок берут через ssh («sh -s --» исполняет скрипт замка на той
      // стороне); смоук обязан быть раньше — иначе чужая выкатка ждёт наших
      // тестов.
      expect(smoke).toBeLessThan(r.calls.indexOf("sh -s --"));
      expect(smoke).toBeLessThan(r.calls.indexOf("rsync "));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("упавший смоук останавливает выкатку и замка не берёт", () => {
    const sb = makeDeploySandbox();
    try {
      const r = runDeploy(sb, { SMOKE_RC: "1" });
      expect(r.code).toBe(1);
      expect(r.calls).toContain("smoke ");
      expect(r.calls).not.toContain("rsync ");
      expect(r.calls).not.toContain("sh -s --");
      expect(existsSync(sb.lockDir)).toBe(false);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("DRY_RUN не гоняет смоук — выкатки-то нет", () => {
    const sb = makeDeploySandbox();
    try {
      const r = runDeploy(sb, { DRY_RUN: "1" });
      expect(r.code).toBe(0);
      expect(r.calls).not.toContain("smoke ");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("упавший шаг 3 тоже отпускает замок", () => {
    const sb = makeDeploySandbox();
    try {
      const r = runDeploy(sb, { STEP3_RC: "1" });
      expect(r.code).toBe(1);
      expect(r.out).toContain("шаг 3");
      expect(r.out).toContain("Rollback:");
      expect(existsSync(sb.lockDir)).toBe(false);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("DRY_RUN не трогает замок вовсе", () => {
    const sb = makeDeploySandbox();
    try {
      const r = runDeploy(sb, { DRY_RUN: "1" });
      expect(r.code).toBe(0);
      expect(r.out).toContain("DRY RUN");
      expect(existsSync(sb.lockDir)).toBe(false);
      expect(r.calls).not.toContain("sh -s --");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("временный файл исключений всё ещё удаляется на выходе", () => {
    const sb = makeDeploySandbox();
    try {
      const r = runDeploy(sb);
      expect(r.code).toBe(0);
      const src = readFileSync(join(sb.repo, "deploy", "deploy.sh"), "utf8");
      // trap на EXIT один; он обязан делать и rm, и release.
      const traps = src.split("\n").filter((l) => l.trimStart().startsWith("trap "));
      expect(traps.length).toBe(1);
      expect(traps[0]).toContain("UNTRACKED_EXCLUDES");
      expect(traps[0]).toContain("release_deploy_lock");
      expect(src).toContain("deploy-lock.sh\" release");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});

// deploy.yml удалён при публичном релизе 2026-09-01 — сверять замок не с чем.
// Вернётся воркфлоу в .github/workflows/ — блок включится сам, без правок.
const HAS_WORKFLOW = existsSync(WORKFLOW);

describe.skipIf(!HAS_WORKFLOW)("deploy.yml — CI берёт тот же замок", () => {
  const yml = HAS_WORKFLOW ? readFileSync(WORKFLOW, "utf8") : "";
  const stepNames = [...yml.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);
  const idxOf = (needle: string) => stepNames.findIndex((n) => n.includes(needle));

  test("замок берётся до rsync и отпускается после рестарта", () => {
    const acquire = idxOf("Acquire deploy lock");
    const release = idxOf("Release deploy lock");
    const rsync = idxOf("Rsync to VPS");
    const restart = idxOf("Remote install + restart");
    expect(acquire).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThanOrEqual(0);
    expect(acquire).toBeLessThan(rsync);
    expect(release).toBeGreaterThan(restart);
  });

  test("оба шага зовут deploy/deploy-lock.sh, release — всегда", () => {
    const steps = yml.split(/^ {6}- name: /m);
    const acquire = steps.find((s) => s.startsWith("Acquire deploy lock")) ?? "";
    const release = steps.find((s) => s.startsWith("Release deploy lock")) ?? "";
    expect(acquire).toContain("deploy/deploy-lock.sh acquire");
    expect(release).toContain("deploy/deploy-lock.sh release");
    // Иначе упавший деплой оставит прод заблокированным до протухания замка.
    expect(release).toContain("if: always()");
    // Один и тот же токен на оба шага — иначе release не узнает свой замок.
    expect(acquire).toContain("DEPLOY_LOCK_TOKEN");
    expect(release).toContain("DEPLOY_LOCK_TOKEN");
  });

  test("workflow всё ещё сериализуется сам с собой через concurrency", () => {
    expect(yml).toContain("group: deploy-vps");
  });
});

describe("локальные deploy-скрипты — адрес и пользователь заданы явно", () => {
  test("не содержат root-дефолта и требуют выделенного пользователя", () => {
    const deploy = readFileSync(DEPLOY_SH, "utf8");
    const site = readFileSync(join(REPO_ROOT, "deploy", "deploy-site.sh"), "utf8");
    const lock = readFileSync(LOCK_SH, "utf8");
    expect(deploy).not.toMatch(/HOST=.*root@/);
    expect(site).not.toMatch(/HOST=.*root@/);
    expect(lock).not.toMatch(/default root@/);
    expect(deploy).toContain("DEPLOY_HOST обязателен");
    expect(site).toContain("DEPLOY_HOST не может использовать root");
    expect(lock).toContain("DEPLOY_HOST обязателен и не может использовать root");
  });
});
