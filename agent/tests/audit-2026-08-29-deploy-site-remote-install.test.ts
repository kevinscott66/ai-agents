/**
 * Аудит 2026-08-29 — `deploy/deploy-site.sh` перезапускал сайт, не поставив
 * зависимости.
 *
 * rsync везёт `site/server/package.json` и `site/server/bun.lock`, но
 * `node_modules/` стоит в `SERVER_EXCLUDES` — на проде он остаётся тем, каким
 * был. Шаг 3 сразу шёл в `systemctl restart`. Соседний `deploy/deploy.sh`
 * ровно в этом месте делает `bun install` и только потом рестарт.
 *
 * Сегодня в `site/server/package.json` одна devDependency (`@types/bun`), и
 * потому дефект ничего не ломает. Он сработает в день, когда у сайта появится
 * первая рантайм-зависимость: package.json на проде будет новый, node_modules —
 * старый, а рестарт произойдёт как ни в чём не бывало. Обратная сторона та же:
 * удалённую из package.json зависимость прод продолжает иметь в node_modules, и
 * код, который на чистой машине не собрался бы, там работает.
 *
 * `--frozen-lockfile` здесь не украшение: расхождение lock-файла с package.json
 * на выкатке — повод отказаться, а не молча переписать локфайл на проде и
 * разъехаться с репозиторием.
 *
 * Тест гоняет сам скрипт в песочнице. `ssh` не ходит по сети: он выполняет
 * «удалённую» команду локально через `sh -c`, а `bun`, `systemctl`, `rsync`,
 * `curl` и `sleep` подменены заглушками на PATH. Благодаря этому проверяется не
 * текст команды, а её реальный порядок: упавший install обязан не дойти до
 * рестарта. Живой прод и живой site/web не задействованы.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const SNAPSHOT = "/root/web3-puls-predeploy-20260829-010203";
const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void) => test(name, fn, SPAWN_TIMEOUT_MS);

let SANDBOX = "";
let BIN = "";
let CALLS = "";
let REPO_DIR = "";
let REMOTE_DIR = "";

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "deploy-site-install-"));
  BIN = join(SANDBOX, "bin");
  CALLS = join(SANDBOX, "calls.log");
  mkdirSync(BIN, { recursive: true });

  // «Удалённый» /opt/web3-puls: шаг 3 делает туда cd, поэтому каталог обязан
  // существовать — иначе `set -e` убьёт команду раньше, чем дело дойдёт до bun.
  REMOTE_DIR = join(SANDBOX, "remote");
  mkdirSync(join(REMOTE_DIR, "server"), { recursive: true });

  // Ветка `*"bun install"*` обязана стоять ВЫШЕ `*tail*`: внутри той же
  // команды есть `tail -20` на случай упавшего install.
  // `exit $?` обязателен: без него ветка case проваливается к `exit 0` в конце
  // заглушки, и упавшая «удалённая» команда выглядит успешной.
  writeFileSync(
    join(BIN, "ssh"),
    `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "${CALLS}"
case "$*" in
  *SNAP=*) echo "snapshot=${SNAPSHOT}"; exit 0 ;;
  *curl*) echo "\${HEALTH_CODE:-200}"; exit 0 ;;
  *"bun install"*) shift; sh -c "$*"; exit $? ;;
  *tail*) echo "prod log line"; exit 0 ;;
esac
exit 0
`,
  );
  writeFileSync(
    join(BIN, "systemctl"),
    `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "${CALLS}"
case "$1" in
  restart) exit "\${RESTART_RC:-0}" ;;
  is-active) echo active; exit 0 ;;
esac
exit 0
`,
  );
  writeFileSync(
    join(BIN, "bun"),
    `#!/bin/sh
printf 'bun %s\\n' "$*" >> "${CALLS}"
case "$1" in
  install) exit "\${INSTALL_RC:-0}" ;;
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
  for (const n of ["ssh", "systemctl", "bun", "rsync", "curl", "sleep"]) {
    chmodSync(join(BIN, n), 0o755);
  }

  REPO_DIR = join(SANDBOX, "repo");
  mkdirSync(join(REPO_DIR, "deploy"), { recursive: true });
  mkdirSync(join(REPO_DIR, "site", "server"), { recursive: true });
  mkdirSync(join(REPO_DIR, "site", "web", "dist"), { recursive: true });
  copyFileSync(
    join(REPO, "deploy", "deploy-site.sh"),
    join(REPO_DIR, "deploy", "deploy-site.sh"),
  );
  writeFileSync(join(REPO_DIR, "site", "server", "index.ts"), "// tracked\n");
  // Заглушка `bun` ничего не собирает — dist кладём заранее.
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

interface Run {
  code: number;
  out: string;
  calls: string;
}

function deploySite(extra: Record<string, string> = {}): Run {
  writeFileSync(CALLS, "");
  const r = spawnSync("bash", [join(REPO_DIR, "deploy", "deploy-site.sh")], {
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH ?? ""}`,
      DRY_RUN: "0",
      DEPLOY_HOST: "stub@invalid.example",
      DEPLOY_SITE_PATH: REMOTE_DIR,
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

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const rollbackLine = (out: string): string =>
  out.split("\n").map(stripAnsi).find((l) => l.includes("Rollback:")) ?? "";

/** Строки лога вызовов, относящиеся к «удалённой» установке и рестарту. */
function ordered(calls: string): string[] {
  return calls
    .split("\n")
    .filter((l) => l.startsWith("bun install") || l.startsWith("systemctl restart"));
}

describe("deploy-site: зависимости ставятся до рестарта", () => {
  slowTest("успешный деплой вызывает bun install", () => {
    const r = deploySite();
    expect(r.code).toBe(0);
    expect(r.calls).toContain("bun install");
  });

  slowTest("install идёт раньше рестарта, а не после", () => {
    const seq = ordered(deploySite().calls);
    expect(seq.length).toBeGreaterThanOrEqual(2);
    expect(seq[0]).toContain("bun install");
    expect(seq[1]).toContain("systemctl restart");
  });

  slowTest("install с --frozen-lockfile: разъехавшийся lock — повод отказаться", () => {
    const line = deploySite()
      .calls.split("\n")
      .find((l) => l.startsWith("bun install"));
    expect(line).toBeTruthy();
    expect(line!).toContain("--frozen-lockfile");
  });

  slowTest("ставим в каталоге сервера, где лежит package.json", () => {
    const ssh = deploySite()
      .calls.split("\n")
      .find((l) => l.includes("bun install"));
    expect(ssh!).toContain(`cd '${REMOTE_DIR}/server'`);
  });

  slowTest("bun ищется по /root/.bun/bin — в non-login ssh его нет на PATH", () => {
    const ssh = deploySite()
      .calls.split("\n")
      .find((l) => l.includes("bun install"));
    expect(ssh!).toContain("/root/.bun/bin");
  });
});

describe("deploy-site: упавший bun install", () => {
  slowTest("до рестарта дело не доходит", () => {
    const r = deploySite({ INSTALL_RC: "1" });
    expect(r.code).not.toBe(0);
    // Смотрим на фактические вызовы заглушек, а не на текст ssh-команды:
    // строка команды упоминает `systemctl restart` в любом случае.
    const seq = ordered(r.calls);
    expect(seq).toEqual(["bun install --frozen-lockfile"]);
    // Ровно то, ради чего install стоит ПЕРЕД рестартом: сервис не поднимают
    // на дереве, зависимости которого поставить не удалось.
  });

  slowTest("скрипт называет шаг и печатает исполнимую подсказку про откат", () => {
    const r = deploySite({ INSTALL_RC: "1" });
    expect(r.out).toContain("шаг 3");
    const line = rollbackLine(r.out);
    expect(line).toContain(SNAPSHOT);
    expect(line).not.toContain("<TS>");
  });

  slowTest("подсказка про откат тоже переставляет зависимости", () => {
    // Откат возвращает старый package.json — node_modules обязан сойтись с ним.
    const line = rollbackLine(deploySite({ INSTALL_RC: "1" }).out);
    expect(line).toContain("bun install");
    expect(line).toContain("systemctl restart");
    expect(line.indexOf("bun install")).toBeLessThan(line.indexOf("systemctl restart"));
  });
});

describe("deploy-site: прежние гарантии не сломаны", () => {
  slowTest("упавший рестарт по-прежнему даёт шаг 3 и откат", () => {
    const r = deploySite({ RESTART_RC: "1" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("шаг 3");
    expect(rollbackLine(r.out)).toContain(SNAPSHOT);
  });

  slowTest("DRY_RUN не ставит зависимости и не перезапускает", () => {
    const r = deploySite({ DRY_RUN: "1" });
    expect(r.code).toBe(0);
    expect(r.calls).not.toContain("bun install");
    expect(r.calls).not.toContain("systemctl restart");
  });

  slowTest("успешный деплой доходит до конца и не пугает откатом", () => {
    const r = deploySite();
    expect(r.code).toBe(0);
    expect(r.out).toContain("site deploy OK");
    expect(rollbackLine(r.out)).toBe("");
  });
});
