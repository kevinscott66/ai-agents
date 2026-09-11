/**
 * Аудит 2026-08-29 — «откат» в staged-deploy.sh не возвращает КОД.
 *
 * Оба цвета объявлены с `WorkingDirectory=/opt/agent-team` (см.
 * deploy/agent-team-blue.service и -green.service), то есть читают ОДНО и то же
 * дерево. К моменту запуска скрипта rsync туда уже положил новый код. Поэтому
 * blue/green здесь — это танец портами, а не изоляция кода: `rollback()`
 * поднимал прежний цвет на том же самом новом коде и писал в лог
 * «Successfully restored». Ложь в логе хуже отсутствия отката: оператор видит
 * «откатились» и идёт спать.
 *
 * Отдельно: активный цвет, переживший неудачный деплой, продолжает работать со
 * СТАРЫМ кодом в памяти, а на диске лежит новый. Любой Restart=always после
 * первого же падения поднимет то, что откатывали.
 *
 * Проверяется, что скрипт (а) требует снапшот кода — ровно такой, какой делает
 * шаг 1 deploy/deploy.sh, (б) на откате возвращает дерево из него и (в)
 * перезапускает активный цвет, чтобы «что работает» совпало с «что лежит».
 *
 * systemd/curl/jq не задействованы: заглушки на PATH, все пути — во временном
 * каталоге.
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

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "deploy", "staged-deploy.sh");

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
  const dir = mkdtempSync(join(tmpdir(), "staged-deploy-"));
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
  // На диске уже лежит новый (плохой) код — rsync отработал до скрипта.
  writeFileSync(join(sb.deployPath, "marker.txt"), "NEW\n");
  writeFileSync(join(sb.deployPath, "musor.ts"), "// приехало новым деплоем\n");
  // Размер намеренно отличается от нового marker.txt: rsync -a сравнивает
  // размер+mtime, а два файла одинаковой длины, созданные в одну секунду, он
  // сочтёт совпадающими и не тронет. Это артефакт песочницы, не поведение прода.
  writeFileSync(join(sb.snapshot, "marker.txt"), "OLD-SNAPSHOT\n");

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
  start) echo active > ${S}/"$N"; exit "\${START_RC:-0}" ;;
  stop) echo inactive > ${S}/"$N"; exit 0 ;;
esac
exit 0
`,
    ],
    [
      "curl",
      `#!/bin/sh
case "$*" in
  *8789*) V="\${STAGING_OK:-true}" ;;
  *) V="\${PROD_OK:-true}" ;;
esac
echo "{\\"ok\\":$V}"
`,
    ],
    ["jq", `#!/bin/sh\nif grep -q '"ok":true'; then echo true; else echo false; fi\n`],
    ["timeout", `#!/bin/sh\nshift\nexec "$@"\n`],
    ["sleep", `#!/bin/sh\nexit 0\n`],
    [
      "rsync",
      `#!/bin/sh
printf 'rsync %s\\n' "$*" >> ${C}
if [ "\${RSYNC_RC:-0}" != "0" ]; then exit "\${RSYNC_RC}"; fi
exec /usr/bin/rsync "$@"
`,
    ],
  ];
  for (const [name, body] of stubs) {
    writeFileSync(join(sb.bin, name), body);
    chmodSync(join(sb.bin, name), 0o755);
  }
  return sb;
}

function run(
  sb: Sandbox,
  env: Record<string, string> = {},
): { code: number; out: string; calls: string } {
  const r = Bun.spawnSync({
    cmd: ["bash", SCRIPT],
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

const marker = (sb: Sandbox) => readFileSync(join(sb.deployPath, "marker.txt"), "utf8").trim();

describe("предпосылки: оба цвета читают одно дерево", () => {
  test("blue и green объявлены с одним WorkingDirectory", () => {
    const blue = readFileSync(join(REPO_ROOT, "deploy", "agent-team-blue.service"), "utf8");
    const green = readFileSync(join(REPO_ROOT, "deploy", "agent-team-green.service"), "utf8");
    const wd = (s: string) => [...s.matchAll(/^WorkingDirectory=(.*)$/gm)].pop()?.[1];
    expect(wd(blue)).toBe("/opt/agent-team");
    expect(wd(green)).toBe(wd(blue));
  });
});

describe("скрипт не запускается без снапшота кода", () => {
  slowTest("переменная не задана — отказ до единого systemctl start", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, { STAGED_DEPLOY_SNAPSHOT: "" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("STAGED_DEPLOY_SNAPSHOT");
      // Подсказка должна вести к тому, кто такой снапшот делает.
      expect(r.out).toContain("deploy.sh");
      expect(r.calls).not.toContain("systemctl start");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("пробелы — это не путь (EnvironmentFile отдаёт именно такое)", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, { STAGED_DEPLOY_SNAPSHOT: "   " });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("STAGED_DEPLOY_SNAPSHOT");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("несуществующий каталог — отказ с внятной причиной", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, { STAGED_DEPLOY_SNAPSHOT: join(sb.dir, "нет-такого") });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("нет-такого");
      expect(r.calls).not.toContain("systemctl start");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});

describe("откат возвращает код, а не только процесс", () => {
  slowTest("упавший health staging'а откатывает дерево из снапшота", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, { STAGING_OK: "false" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("ROLLBACK");
      expect(marker(sb)).toBe("OLD-SNAPSHOT");
      // --delete обязан убрать файлы, приехавшие неудачным деплоем.
      expect(existsSync(join(sb.deployPath, "musor.ts"))).toBe(false);
      // --delete обязателен: иначе мусор неудачного деплоя остаётся лежать.
      const restore = r.calls.split("\n").find((l) => l.startsWith("rsync ")) ?? "";
      expect(restore).toContain("--delete");
      expect(restore).toContain(sb.snapshot);
      expect(restore).toContain(sb.deployPath);
      expect(restore).toContain("--exclude node_modules");
      expect(restore).toContain("--exclude data");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("активный цвет перезапускается, чтобы работать на восстановленном коде", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, { STAGING_OK: "false" });
      const idxRestore = r.calls.indexOf("rsync ");
      const idxStart = r.calls.indexOf("systemctl start agent-team-blue");
      expect(idxRestore).toBeGreaterThanOrEqual(0);
      expect(idxStart).toBeGreaterThan(idxRestore);
      expect(r.out).toContain("agent-team-blue");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("провал восстановления кода кричит CRITICAL, а не молчит", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb, { STAGING_OK: "false", RSYNC_RC: "23" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("CRITICAL");
      // Код остался новым — об этом обязаны сказать, а не отчитаться успехом.
      expect(marker(sb)).toBe("NEW");
      expect(r.out).not.toContain("Successfully restored code");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("успешный деплой снапшот не трогает", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb);
      expect(r.code).toBe(0);
      expect(r.out).toContain("DEPLOYMENT SUCCESS");
      expect(r.calls).not.toContain("rsync ");
      expect(marker(sb)).toBe("NEW");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});

describe("прежние гарантии не сломаны", () => {
  slowTest("активный одноюнитовый прод по-прежнему блокирует blue/green", () => {
    const sb = makeSandbox();
    try {
      writeFileSync(join(sb.state, "agent-team.service"), "active\n");
      const r = run(sb);
      expect(r.code).toBe(1);
      expect(r.out).toContain("ОТКАЗ");
      expect(r.calls).not.toContain("systemctl start");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });

  slowTest("порты выставляются drop-in'ом: staging 8789, прод 8787", () => {
    const sb = makeSandbox();
    try {
      const r = run(sb);
      expect(r.code).toBe(0);
      const green = readFileSync(
        join(sb.systemdDir, "agent-team-green.service.d", "10-deploy-port.conf"),
        "utf8",
      );
      expect(green).toContain("MINIAPP_PORT=8787");
      expect(r.out).toContain("8789");
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  });
});
