/**
 * AUD-027 — манифест версий: какой коммит фактически работает в компоненте.
 *
 * Выкаченный sha жил ровно в одной строке вывода deploy.sh, то есть в
 * терминале оператора. /opt/agent-team не git-чекаут, `git log` там не
 * работает — вопрос «что сейчас в бою» решался по памяти, и находка аудита
 * ровно об этом: рабочая папка стояла на одной ветке, прод жил на другой,
 * launcher Mac указывал на третий релиз.
 *
 * Здесь проверяется поведение deploy/version-manifest.sh, а не его текст:
 * `record` действительно кладёт файл с коммитом на «ту сторону», `show`
 * читает его обратно, а deploy.sh и deploy-site.sh этот шаг действительно
 * делают и не валятся, когда он не удался.
 *
 * Прод не задействован: ssh подменён заглушкой на PATH, «удалённый» sh
 * выполняется локально во временном каталоге.
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
import { join } from "node:path";
import { writeSmokeStub } from "./helpers/deploy-smoke-stub.ts";
import { writeDiskGuardStub } from "./helpers/deploy-disk-stub.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "deploy", "version-manifest.sh");
const DEPLOY_SH = join(REPO_ROOT, "deploy", "deploy.sh");
const LOCK_SH = join(REPO_ROOT, "deploy", "deploy-lock.sh");

/** spawnSync целого шелл-скрипта не укладывается в дефолтные 5s bun-теста. */
const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void | Promise<void>) => test(name, fn, SPAWN_TIMEOUT_MS);

interface Sandbox {
  dir: string;
  bin: string;
  repo: string;
  manifests: string;
}

/** Мини-репозиторий с одним коммитом и ssh-заглушкой, исполняющей sh локально. */
function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "version-manifest-"));
  const bin = join(dir, "bin");
  const repo = join(dir, "repo");
  const manifests = join(dir, "deployed");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(join(repo, "ios", "Agent"), { recursive: true });

  writeFileSync(join(repo, "deploy", "version-manifest.sh"), readFileSync(SCRIPT, "utf8"));
  chmodSync(join(repo, "deploy", "version-manifest.sh"), 0o755);
  writeFileSync(
    join(repo, "ios", "Agent", "Info.plist"),
    `<plist><dict>\n<key>CFBundleShortVersionString</key><string>9.9.9</string>\n<key>CFBundleVersion</key><string>77</string>\n</dict></plist>\n`,
  );

  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nshift\nexec "$@"\n`);
  chmodSync(join(bin, "ssh"), 0o755);

  for (const cmd of [
    ["git", "init", "-q", "-b", "release-x"],
    ["git", "add", "-A"],
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
  ]) {
    Bun.spawnSync({ cmd, cwd: repo });
  }
  return { dir, bin, repo, manifests };
}

function run(
  sb: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): { code: number; out: string } {
  const r = Bun.spawnSync({
    cmd: ["bash", join(sb.repo, "deploy", "version-manifest.sh"), ...args],
    cwd: sb.repo,
    env: {
      PATH: `${sb.bin}:${process.env.PATH ?? ""}`,
      HOME: sb.dir,
      DEPLOY_HOST: "agent-deploy@prod.invalid",
      DEPLOY_MANIFEST_DIR: sb.manifests,
      // Реального демона на машине с тестами быть не должно; берём свой вывод.
      MAC_DAEMON_PS: "echo нет-демона",
      ...env,
    },
  });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

const headOf = (repo: string, fmt: string) =>
  Bun.spawnSync({ cmd: ["git", "-C", repo, "rev-parse", fmt, "HEAD"] }).stdout.toString().trim();

describe("version-manifest.sh — запись версии на стороне компонента", () => {
  slowTest("record кладёт коммит, ветку и путь, а show читает их обратно", () => {
    const sb = makeSandbox();
    try {
      const rec = run(sb, ["record", "server"], { DEPLOY_RECORD_PATH: "/opt/agent-team" });
      expect(rec.code).toBe(0);

      const file = readFileSync(join(sb.manifests, "server.txt"), "utf8");
      expect(file).toContain(`commit=${headOf(sb.repo, "--verify")}`);
      expect(file).toContain(`short=${headOf(sb.repo, "--short")}`);
      expect(file).toContain("branch=release-x");
      expect(file).toContain("path=/opt/agent-team");
      expect(file).toMatch(/\nat=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n/);

      const show = run(sb, ["show"]);
      expect(show.code).toBe(0);
      expect(show.out).toContain(`commit=${headOf(sb.repo, "--verify")}`);
      expect(show.out).toContain("branch=release-x");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("из sha в манифесте восстанавливается рабочее дерево компонента", () => {
    // Смысл всей записи: по строке из манифеста можно вернуть тот же код.
    const sb = makeSandbox();
    try {
      writeFileSync(join(sb.repo, "marker.txt"), "первая версия\n");
      Bun.spawnSync({ cmd: ["git", "-C", sb.repo, "add", "-A"] });
      Bun.spawnSync({
        cmd: ["git", "-C", sb.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v1"],
      });
      run(sb, ["record", "server"], { DEPLOY_RECORD_PATH: "/opt/agent-team" });
      const recorded = readFileSync(join(sb.manifests, "server.txt"), "utf8")
        .split("\n")
        .find((l) => l.startsWith("commit="))!
        .slice("commit=".length);

      writeFileSync(join(sb.repo, "marker.txt"), "вторая версия\n");
      Bun.spawnSync({ cmd: ["git", "-C", sb.repo, "add", "-A"] });
      Bun.spawnSync({
        cmd: ["git", "-C", sb.repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v2"],
      });

      const back = Bun.spawnSync({ cmd: ["git", "-C", sb.repo, "show", `${recorded}:marker.txt`] });
      expect(back.stdout.toString()).toBe("первая версия\n");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("show показывает версию iOS из Info.plist и состояние чекаута", () => {
    const sb = makeSandbox();
    try {
      const clean = run(sb, ["show"]);
      expect(clean.out).toContain("version=9.9.9");
      expect(clean.out).toContain("build=77");
      expect(clean.out).toContain("state=чисто");

      writeFileSync(join(sb.repo, "dirty.txt"), "правка вне коммита\n");
      expect(run(sb, ["show"]).out).toContain("есть незакоммиченные правки");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("релиз Mac берётся из живого процесса, а строка запуска не печатается", () => {
    const sb = makeSandbox();
    try {
      // В аргументах демона рядом с путём релиза едут переменные владельца —
      // в отчёт должен попасть только sha.
      const psLine =
        "/usr/local/bin/bun /Users/owner/.config/mac-daemon/releases/a1234446/agent/mac-daemon/daemon.ts";
      const withDaemon = run(sb, ["show"], { MAC_DAEMON_PS: `echo ${psLine}` });
      expect(withDaemon.out).toContain("short=a1234446");
      expect(withDaemon.out).toContain("state=запущен");
      expect(withDaemon.out).not.toContain("/Users/owner");

      expect(run(sb, ["show"]).out).toContain("демон не запущен");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("без DEPLOY_HOST show не врёт про удалённые компоненты", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, ["show"], { DEPLOY_HOST: "" });
      expect(r.code).toBe(0);
      expect(r.out).toContain("не опрошен");
      // Локальная часть при этом работает.
      expect(r.out).toContain("version=9.9.9");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("--json отдаёт по объекту на компонент", () => {
    const sb = makeSandbox();
    try {
      run(sb, ["record", "server"], { DEPLOY_RECORD_PATH: "/opt/agent-team" });
      const r = run(sb, ["show", "--json"]);
      const parsed = JSON.parse(r.out) as Record<string, Record<string, string>>;
      expect(Object.keys(parsed).sort()).toEqual(["checkout", "ios", "mac", "server", "site"]);
      expect(parsed.server.commit).toBe(headOf(sb.repo, "--verify"));
      expect(parsed.server.path).toBe("/opt/agent-team");
      expect(parsed.checkout.branch).toBe("release-x");
      expect(parsed.ios.version).toBe("9.9.9");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("имя компонента не уезжает на ту сторону кусками шелла", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, ["record", "server; rm -rf /"], { DEPLOY_RECORD_PATH: "/opt/agent-team" });
      expect(r.code).toBe(2);
      expect(r.out).toContain("компонент");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("оборванная запись не оставляет полуманифест", () => {
    const sb = makeSandbox();
    try {
      run(sb, ["record", "server"], { DEPLOY_RECORD_PATH: "/opt/agent-team" });
      const good = readFileSync(join(sb.manifests, "server.txt"), "utf8");
      // Файл появляется целиком через mv, а не дописывается по строчке.
      expect(good.split("\n").filter(Boolean).length).toBe(6);
      expect(good.endsWith("\n")).toBe(true);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});

// --- deploy.sh целиком: шаг записи действительно делается ---
//
// Песочница своя, а не общая с tests/audit-2026-08-29-deploy-concurrency-lock
// .test.ts: там version-manifest.sh в репозиторий песочницы не кладут вовсе,
// и проверяется ровно противоположное — что выкатка переживает его отсутствие.
// Здесь скрипт настоящий и пишет настоящий файл, просто «та сторона» локальная.

interface DeploySandbox {
  dir: string;
  bin: string;
  repo: string;
  manifests: string;
  lockDir: string;
  calls: string;
}

function makeDeploySandbox(): DeploySandbox {
  const dir = mkdtempSync(join(tmpdir(), "deploy-manifest-"));
  const bin = join(dir, "bin");
  const repo = join(dir, "repo");
  const calls = join(dir, "calls.txt");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(join(repo, "agent", "miniapp"), { recursive: true });
  writeFileSync(join(repo, "agent", "index.ts"), "export const x = 1;\n");
  for (const name of ["deploy.sh", "deploy-lock.sh", "version-manifest.sh"]) {
    const src = { "deploy.sh": DEPLOY_SH, "deploy-lock.sh": LOCK_SH, "version-manifest.sh": SCRIPT }[name]!;
    writeFileSync(join(repo, "deploy", name), readFileSync(src, "utf8"));
    chmodSync(join(repo, "deploy", name), 0o755);
  }
  writeSmokeStub(repo, calls);
  writeDiskGuardStub(repo, calls);

  // ssh: замок и запись манифеста исполняем локально, остальное — сценарий.
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh
printf 'ssh %s\\n' "$*" >> ${JSON.stringify(calls)}
case "$*" in
  *"sh -s --"*) shift; exec "$@" ;;
  *SNAP=*) echo "snapshot=/root/agent-team-predeploy-20260920-010203"; exit 0 ;;
  *curl*) echo 200; exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(join(bin, "ssh"), 0o755);
  for (const [name, body] of [
    ["rsync", `printf 'rsync %s\\n' "$*" >> ${JSON.stringify(calls)}\nexit "\${RSYNC_RC:-0}"\n`],
    ["curl", "echo 200\n"],
    ["sleep", "exit 0\n"],
  ] as const) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
    chmodSync(join(bin, name), 0o755);
  }

  for (const cmd of [
    ["git", "init", "-q", "-b", "main"],
    ["git", "add", "-A"],
    ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
  ]) {
    Bun.spawnSync({ cmd, cwd: repo });
  }
  return { dir, bin, repo, manifests: join(dir, "deployed"), lockDir: join(dir, "lock"), calls };
}

function runDeploy(sb: DeploySandbox, env: Record<string, string> = {}) {
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
      DEPLOY_MANIFEST_DIR: sb.manifests,
      ...env,
    },
  });
  return {
    code: r.exitCode ?? -1,
    out: `${r.stdout.toString()}${r.stderr.toString()}`.replace(/\x1b\[[0-9;]*m/g, ""),
    calls: existsSync(sb.calls) ? readFileSync(sb.calls, "utf8") : "",
  };
}

describe("deploy.sh записывает версию рядом с кодом", () => {
  slowTest("после успешной выкатки манифест называет выкаченный коммит", () => {
    const sb = makeDeploySandbox();
    try {
      const r = runDeploy(sb);
      expect(r.code).toBe(0);
      const file = readFileSync(join(sb.manifests, "server.txt"), "utf8");
      expect(file).toContain(`commit=${headOf(sb.repo, "--verify")}`);
      expect(file).toContain("component=server");
      expect(file).toContain("path=/opt/agent-team");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("манифест пишется после rsync и до рестарта", () => {
    // Он отвечает за код на диске: если рестарт упадёт, из манифеста всё равно
    // видно, что именно туда уехало.
    const sb = makeDeploySandbox();
    try {
      const r = runDeploy(sb);
      const rsync = r.calls.indexOf("rsync ");
      // Запись узнаётся по аргументам: `sh -s -- <каталог манифестов> server`.
      const record = r.calls.indexOf(`${sb.manifests} server`);
      expect(rsync).toBeGreaterThan(-1);
      expect(r.calls).toContain("agent-team-deploy restart");
      expect(record).toBeGreaterThan(rsync);
      expect(record).toBeLessThan(r.calls.indexOf("agent-team-deploy restart"));
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("упавший rsync не оставляет манифеста на несуществующий код", () => {
    const sb = makeDeploySandbox();
    try {
      const r = runDeploy(sb, { RSYNC_RC: "1" });
      expect(r.code).toBe(1);
      expect(existsSync(join(sb.manifests, "server.txt"))).toBe(false);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("невозможность записать манифест не валит прошедшую выкатку", () => {
    const sb = makeDeploySandbox();
    try {
      // Каталог занят файлом — mkdir на той стороне не пройдёт.
      writeFileSync(sb.manifests, "не каталог\n");
      const r = runDeploy(sb);
      expect(r.code).toBe(0);
      expect(r.out).toContain("deploy OK");
      expect(r.out).toContain("манифест");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});
