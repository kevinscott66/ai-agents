/**
 * Аудит 2026-08-29 — аргументы staged-deploy.sh.
 *
 * Было два дефекта в шести строках разбора.
 *
 * 1. `--dry-run` печатал «DRY RUN MODE - no changes will be made» и выходил 0,
 *    не проверив ровно ничего: ни одноюнитовый прод, ни снапшот, ни наличие
 *    юнит-файлов. Зелёный прогон, который не смотрел на систему, — это хуже
 *    отсутствия режима: он выдаёт мнение за проверку.
 * 2. Любой другой аргумент молча игнорировался и запускалась НАСТОЯЩАЯ
 *    выкатка. Опечатка в флаге (`--dryrun`, `--dry_run`) означала прод.
 *
 * Проверяется, что dry-run действительно проверяет и ничего не трогает, а
 * неизвестный аргумент отказывает вместо выкатки.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "deploy", "staged-deploy.sh");
const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, fn, SPAWN_TIMEOUT_MS);

interface Sandbox {
  dir: string;
  bin: string;
  state: string;
  calls: string;
  deployPath: string;
  snapshot: string;
  systemdDir: string;
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "staged-dry-"));
  const sb: Sandbox = {
    dir,
    bin: join(dir, "bin"),
    state: join(dir, "state"),
    calls: join(dir, "calls.log"),
    deployPath: join(dir, "opt", "agent-team"),
    snapshot: join(dir, "snap"),
    systemdDir: join(dir, "systemd"),
  };
  for (const d of [sb.bin, sb.state, sb.deployPath, sb.snapshot, sb.systemdDir]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(sb.snapshot, "marker.txt"), "OLD-SNAPSHOT\n");
  for (const svc of ["agent-team-blue", "agent-team-green"]) {
    writeFileSync(join(sb.systemdDir, `${svc}.service`), "[Service]\n");
  }
  const C = JSON.stringify(sb.calls);
  const S = JSON.stringify(sb.state);
  const stubs: Array<[string, string]> = [
    [
      "systemctl",
      `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> ${C}
CMD=$1; shift
N=""
for a in "$@"; do case "$a" in -*) ;; *) N="$a" ;; esac; done
case "$CMD" in
  is-active) [ "$(cat ${S}/"$N" 2>/dev/null)" = "active" ] && exit 0 || exit 3 ;;
  start) echo active > ${S}/"$N"; exit 0 ;;
  stop) echo inactive > ${S}/"$N"; exit 0 ;;
esac
exit 0
`,
    ],
    ["curl", `#!/bin/sh\nprintf 'curl %s\\n' "$*" >> ${C}\necho '{"ok":true}'\n`],
    ["jq", `#!/bin/sh\nif grep -q '"ok":true'; then echo true; else echo false; fi\n`],
    ["timeout", `#!/bin/sh\nshift\nexec "$@"\n`],
    ["sleep", `#!/bin/sh\nexit 0\n`],
    ["rsync", `#!/bin/sh\nprintf 'rsync %s\\n' "$*" >> ${C}\nexit 0\n`],
  ];
  for (const [name, body] of stubs) {
    writeFileSync(join(sb.bin, name), body);
    chmodSync(join(sb.bin, name), 0o755);
  }
  return sb;
}

function run(
  sb: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): { code: number; out: string; calls: string } {
  const r = Bun.spawnSync({
    cmd: ["bash", SCRIPT, ...args],
    cwd: sb.dir,
    env: {
      PATH: `${sb.bin}:${process.env.PATH ?? ""}`,
      HOME: sb.dir,
      DEPLOY_PATH: sb.deployPath,
      SYSTEMD_UNIT_DIR: sb.systemdDir,
      STAGED_DEPLOY_SNAPSHOT: sb.snapshot,
      STAGED_DEPLOY_EXPERIMENTAL: "1",
      ...env,
    },
  });
  let calls = "";
  try {
    calls = readFileSync(sb.calls, "utf8");
  } catch {
    calls = "";
  }
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}`, calls };
}

const mutating = (calls: string) =>
  calls
    .split("\n")
    .filter(
      (l) =>
        l.startsWith("rsync ") ||
        l.startsWith("systemctl start") ||
        l.startsWith("systemctl stop") ||
        l.startsWith("systemctl daemon-reload"),
    );

describe("--dry-run действительно проверяет и ничего не трогает", () => {
  slowTest("на здоровой системе — проверки пройдены и ни одной мутации", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, ["--dry-run"]);
      expect(r.code).toBe(0);
      expect(mutating(r.calls)).toEqual([]);
      // План должен быть виден: какой цвет активен и куда поедет staging.
      expect(r.out).toContain("agent-team-blue");
      expect(r.out).toContain("agent-team-green");
      expect(r.out).toContain("8789");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("активный одноюнитовый прод ловится и в dry-run", () => {
    const sb = makeSandbox();
    try {
      writeFileSync(join(sb.state, "agent-team.service"), "active\n");
      const r = run(sb, ["--dry-run"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("ОТКАЗ");
      expect(mutating(r.calls)).toEqual([]);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("отсутствие снапшота ловится до выкатки, а не во время аварии", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, ["--dry-run"], { STAGED_DEPLOY_SNAPSHOT: "" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("STAGED_DEPLOY_SNAPSHOT");
      expect(mutating(r.calls)).toEqual([]);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("пропавший юнит-файл цвета — это провал проверки, а не зелёный прогон", () => {
    const sb = makeSandbox();
    try {
      rmSync(join(sb.systemdDir, "agent-team-green.service"));
      const r = run(sb, ["--dry-run"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("agent-team-green.service");
      expect(mutating(r.calls)).toEqual([]);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("пропавшее дерево кода тоже валит проверку", () => {
    const sb = makeSandbox();
    try {
      rmSync(sb.deployPath, { recursive: true, force: true });
      const r = run(sb, ["--dry-run"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(sb.deployPath);
      expect(mutating(r.calls)).toEqual([]);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});

describe("неизвестный аргумент не превращается в боевую выкатку", () => {
  for (const arg of ["--dryrun", "--dry_run", "-n", "dry-run"]) {
    slowTest(`«${arg}» — отказ с подсказкой, ни одной мутации`, () => {
      const sb = makeSandbox();
      try {
        const r = run(sb, [arg]);
        expect(r.code).toBe(2);
        expect(r.out).toContain("--dry-run");
        expect(mutating(r.calls)).toEqual([]);
      } finally {
        rmSync(sb.dir, { recursive: true, force: true });
      }
    });
  }

  slowTest("лишний аргумент после --dry-run тоже отказ", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, ["--dry-run", "green"]);
      expect(r.code).toBe(2);
      expect(mutating(r.calls)).toEqual([]);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("--help печатает использование и выходит 0", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, ["--help"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("--dry-run");
      expect(r.out).toContain("STAGED_DEPLOY_SNAPSHOT");
      expect(mutating(r.calls)).toEqual([]);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("без аргументов по-прежнему идёт настоящая выкатка", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, []);
      expect(r.code).toBe(0);
      expect(r.out).toContain("DEPLOYMENT SUCCESS");
      expect(r.calls).toContain("systemctl start");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});

describe("экспериментальный blue/green запуск требует явного opt-in", () => {
  slowTest("без флага отказывается до запуска systemd", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, [], { STAGED_DEPLOY_EXPERIMENTAL: "" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("экспериментальный blue/green");
      expect(mutating(r.calls)).toEqual([]);
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});
