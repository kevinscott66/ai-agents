/**
 * Аудит 2026-09-19 (AUD-20260919-026) — малый запас диска на проде.
 *
 * Корневой раздел VPS — 9.6 ГБ, и на нём живёт всё сразу: код агента с
 * node_modules, каталоги релизов сайта, ночные снапшоты SQLite, журнал
 * systemd, кэш apt. Аудит застал раздел на 85%. ENOSPC в середине выкатки —
 * худший из отказов: rsync обрывается на половине, `bun install` оставляет
 * node_modules в состоянии, из которого сервис не поднимается, и на откат
 * место тоже нужно.
 *
 * Приёмка требовала двух вещей: порога, который предупреждает заранее, и
 * гарантии, что НИЧЕГО не удаляется автоматически. Здесь проверяется и то, и
 * другое:
 *   * disk-guard.sh считает остаток ПОСЛЕ гипотетической выкатки (--need), а
 *     не просто «сколько свободно», и раскладывает его по трём состояниям с
 *     разными кодами возврата;
 *   * ни в сторожe, ни в юните нет ни одной команды удаления — это свойство
 *     легко потерять при первой же правке «а давайте заодно чистить кэш»;
 *   * deploy.sh зовёт сторож ДО смоука и ДО замка и останавливается на rc=2,
 *     а на rc=1 катит дальше — предупреждение не должно блокировать выкатку.
 *
 * Прод не задействован: df подменён заглушкой на PATH, ssh в тесте выкатки не
 * вызывается вовсе — до него дело не доходит.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const GUARD_SH = join(REPO_ROOT, "deploy", "disk-guard.sh");
const DEPLOY_SH = join(REPO_ROOT, "deploy", "deploy.sh");
const UNIT = join(REPO_ROOT, "deploy", "systemd", "disk-guard.service");
const TIMER = join(REPO_ROOT, "deploy", "systemd", "disk-guard.timer");

const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, fn, SPAWN_TIMEOUT_MS);

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  out: string;
}

/**
 * Заглушка df: отдаёт POSIX-строку (`df -Pk`) с заданным свободным местом.
 * Именно в этом формате сторож и читает — одна строка на файловую систему,
 * килобайты, без переносов длинных имён устройств.
 */
function makeDfStub(totalMib: number, freeMib: number): string {
  const dir = mkdtempSync(join(tmpdir(), "disk-guard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const totalK = totalMib * 1024;
  const freeK = freeMib * 1024;
  // used считается не как total-free: на ext4 около 5% блоков зарезервировано
  // за root, и used+free меньше total. Заглушка воспроизводит это, иначе тест
  // на процент проверял бы не ту арифметику, что живёт в сторожe.
  const usedK = totalK - freeK - Math.floor(totalK * 0.05);
  writeFileSync(
    join(bin, "df"),
    [
      "#!/bin/sh",
      "echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
      `echo '/dev/vda1 ${totalK} ${usedK} ${freeK} 85% /'`,
    ].join("\n") + "\n",
  );
  chmodSync(join(bin, "df"), 0o755);
  // ssh-заглушка: выкидывает хост и выполняет «удалённую» команду локально —
  // то есть на заглушке df выше. Тот же приём, что в тесте замка выкатки.
  writeFileSync(join(bin, "ssh"), '#!/bin/sh\nfor a; do last=$a; done\nexec sh -c "$last"\n');
  chmodSync(join(bin, "ssh"), 0o755);
  return dir;
}

function runGuard(stubDir: string, args: string[], env: Record<string, string> = {}): Run {
  const r = Bun.spawnSync({
    cmd: ["bash", GUARD_SH, ...args],
    cwd: stubDir,
    env: {
      PATH: `${join(stubDir, "bin")}:${process.env.PATH ?? ""}`,
      HOME: stubDir,
      ...env,
    },
  });
  const stdout = r.stdout.toString();
  const stderr = r.stderr.toString();
  return { code: r.exitCode ?? -1, stdout, stderr, out: stripAnsi(stdout + stderr) };
}

/** Прогон сторожа на разделе заданного размера; каталог убирается сам. */
function withDf<T>(totalMib: number, freeMib: number, fn: (dir: string) => T): T {
  const dir = makeDfStub(totalMib, freeMib);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("disk-guard.sh — порог запаса, три состояния", () => {
  slowTest("запас в норме: rc=0, отчёт в stdout", () => {
    withDf(9830, 2000, (dir) => {
      const r = runGuard(dir, ["--label", "prod"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("[prod]");
      expect(r.stdout).toContain("запас диска в норме");
      expect(r.stdout).toContain("2000");
      // Норма не пишет ни строчки в stderr: иначе таймер каждый час
      // подкрашивал бы журнал предупреждением ни о чём.
      expect(r.stderr).toBe("");
    });
  });

  slowTest("ниже порога предупреждения: rc=1 и текст в stderr", () => {
    withDf(9830, 800, (dir) => {
      const r = runGuard(dir, []);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("запас диска тает");
    });
  });

  slowTest("ниже критического порога: rc=2", () => {
    withDf(9830, 300, (dir) => {
      const r = runGuard(dir, []);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("запаса диска нет");
    });
  });

  slowTest("--need смотрит на остаток ПОСЛЕ выкатки, а не на текущий", () => {
    // 1400 МиБ свободно — само по себе это норма (порог предупреждения 1024).
    // Но выкатка, которой нужно 400, оставит после себя ровно 1000 — уже ниже
    // порога; а та, которой нужно 1000, оставит 400 — ниже критического.
    withDf(9830, 1400, (dir) => {
      expect(runGuard(dir, []).code).toBe(0);
      expect(runGuard(dir, ["--need", "300"]).code).toBe(0);
      expect(runGuard(dir, ["--need", "400"]).code).toBe(1);
      const crit = runGuard(dir, ["--need", "1000"]);
      expect(crit.code).toBe(2);
      expect(crit.stderr).toContain("ниже критического порога");
    });
  });

  slowTest("процент считается от total, а не от used+free", () => {
    withDf(9830, 2000, (dir) => {
      const r = runGuard(dir, ["--json"]);
      const j = JSON.parse(r.stdout);
      expect(j.total_mib).toBe(9830);
      expect(j.free_mib).toBe(2000);
      // used+free тут заведомо меньше total на зарезервированные 5%, и если
      // процент считать от суммы, он получится больше 80.
      expect(j.used_pct).toBeLessThan(80);
      expect(j.used_pct).toBe(Math.floor((j.used_mib * 100) / j.total_mib));
    });
  });

  slowTest("--json отдаёт разбор машине и тот же код возврата", () => {
    withDf(9830, 800, (dir) => {
      const r = runGuard(dir, ["--json", "--need", "100", "--label", "deploy"]);
      expect(r.code).toBe(1);
      const j = JSON.parse(r.stdout);
      expect(j.status).toBe("warn");
      expect(j.label).toBe("deploy");
      expect(j.need_mib).toBe(100);
      expect(j.free_after_mib).toBe(700);
      expect(j.warn_mib).toBe(1024);
      expect(j.crit_mib).toBe(512);
    });
  });

  slowTest("пороги можно задать, мусор в них отвергается", () => {
    withDf(9830, 800, (dir) => {
      expect(runGuard(dir, ["--warn", "700", "--crit", "300"]).code).toBe(0);
      const bad = runGuard(dir, ["--warn", "много"]);
      expect(bad.code).toBe(64);
      expect(bad.stderr).toContain("целым числом");
      expect(runGuard(dir, ["--чего-нибудь"]).code).toBe(64);
    });
  });

  slowTest("нечитаемый df — это отказ (rc=3), а не молчаливое «всё хорошо»", () => {
    const dir = mkdtempSync(join(tmpdir(), "disk-guard-"));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "df"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(bin, "df"), 0o755);
      const r = runGuard(dir, []);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("не удалось прочитать df");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AUD-026: сторож ничего не удаляет", () => {
  // Свойство теряется одной строкой «а давайте заодно чистить кэш». На
  // 9.6-гигабайтном разделе автоматический уборщик однажды снесёт то, что
  // окажется единственной копией, — в приёмке аудита это записано прямо.
  const dangerous = [
    /\brm\b/,
    /\bunlink\b/,
    /\bshred\b/,
    /\btruncate\b/,
    /journalctl[^\n]*--vacuum/,
    /apt[- ]get[^\n]*clean/,
    /\bdocker[^\n]*prune/,
  ];

  test("в disk-guard.sh нет ни одной команды удаления", () => {
    const body = readFileSync(GUARD_SH, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    for (const re of dangerous) expect(body).not.toMatch(re);
  });

  test("в юните нет ExecStart с удалением и он не пишет в систему", () => {
    const unit = readFileSync(UNIT, "utf8");
    for (const re of dangerous) expect(unit).not.toMatch(re);
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("NoNewPrivileges=yes");
  });

  test("предупреждение не красит systemctl --failed, критический — красит", () => {
    // SuccessExitStatus=1 ровно об этом: rc=1 попадает в журнал, но юнит не
    // считается упавшим. Индикатор, горящий за недели до беды, ничего не
    // значит; красным остаётся только rc=2.
    expect(readFileSync(UNIT, "utf8")).toContain("SuccessExitStatus=1");
  });

  test("таймер ежечасный и догоняет пропуск после перезагрузки", () => {
    const timer = readFileSync(TIMER, "utf8");
    expect(timer).toContain("OnCalendar=hourly");
    expect(timer).toContain("Persistent=true");
  });
});

describe("deploy.sh — предполётная проверка места", () => {
  slowTest("rc=2 от сторожа останавливает выкатку до смоука и до замка", () => {
    const dir = makeDfStub(9830, 300);
    try {
      const r = Bun.spawnSync({
        cmd: ["bash", DEPLOY_SH],
        cwd: REPO_ROOT,
        env: {
          PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
          HOME: dir,
          DEPLOY_HOST: "agent-deploy@prod.invalid",
          DEPLOY_DISK_NEED_MIB: "400",
        },
      });
      const out = stripAnsi(r.stdout.toString() + r.stderr.toString());
      expect(r.exitCode).toBe(1);
      expect(out).toContain("не хватает места под выкатку");
      expect(out).toContain("в прод не поехало ничего");
      // Смоук — это пара минут тестов; до него дело дойти не должно.
      expect(out).not.toContain("смоук:");
      // И замок не брался: отказ не должен требовать уборки за собой.
      expect(out).not.toContain("замок");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("порядок в скрипте: проверка диска раньше смоука и раньше замка", () => {
    const body = readFileSync(DEPLOY_SH, "utf8");
    const disk = body.indexOf('disk-guard.sh" --host');
    const smoke = body.indexOf("pre-deploy-smoke.sh\" ");
    const lock = body.indexOf('deploy-lock.sh" acquire');
    expect(disk).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(-1);
    expect(disk).toBeLessThan(smoke);
    expect(disk).toBeLessThan(lock);
  });

  test("предупреждение (rc=1) выкатку не блокирует", () => {
    // Порог блокировки — именно >=2. Если поставить >=1, любая выкатка при
    // тающем, но достаточном запасе перестанет идти вовсе.
    expect(readFileSync(DEPLOY_SH, "utf8")).toContain('if [ "$DISK_RC" -ge 2 ]');
  });

  test("отсутствие сторожа — отказ, а не тихий пропуск проверки", () => {
    const body = readFileSync(DEPLOY_SH, "utf8");
    expect(body).toContain('if [ ! -x "$SCRIPT_DIR/disk-guard.sh" ]');
  });
});
