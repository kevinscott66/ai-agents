/**
 * AUD-20260921-036: игнорируемый гитом черновик уезжал в прод.
 *
 * Гейт deploy.sh исключал неотслеживаемое через `git ls-files --others
 * --exclude-standard`, а этот флаг как раз выбрасывает из списка всё, что
 * прячет `.gitignore`. Черновик под `.gitignore` не попадал ни туда, ни под
 * маски `debug-*`/`probe-*`/`smoke-*`, если имя не угадано, — и доставлялся.
 * Так на проде с мая лежат семь проб юзербота, в том числе `join-and-smoke.ts`.
 *
 * Тест смотрит не на текст скрипта, а на то, что реально доехало: заглушка
 * `rsync` запускает настоящий rsync с теми же аргументами, но в локальный
 * каталог вместо `host:/opt/agent-team`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dir, "..", "..");
const SPAWN_TIMEOUT_MS = 60_000;
const REAL_RSYNC = spawnSync("sh", ["-c", "command -v rsync"], { encoding: "utf8" }).stdout.trim();

let SANDBOX = "";
let DEST = "";
let OUT = "";
let CODE = -1;

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "deploy-ignored-"));
  DEST = join(SANDBOX, "prod");
  mkdirSync(DEST);
  const bin = join(SANDBOX, "bin");
  mkdirSync(bin);
  // Последний аргумент — `host:/remote/`; меняем его на локальный каталог,
  // `-e <ssh>` выкидываем, всё остальное отдаём настоящему rsync как есть.
  writeFileSync(
    join(bin, "rsync"),
    `#!/bin/bash
args=()
while [ $# -gt 1 ]; do
  if [ "$1" = "-e" ]; then shift 2; continue; fi
  args+=("$1"); shift
done
exec "${REAL_RSYNC}" "\${args[@]}" "${DEST}/"
`,
  );
  writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexit 0\n");
  for (const n of ["rsync", "ssh"]) chmodSync(join(bin, n), 0o755);

  const repo = join(SANDBOX, "repo");
  mkdirSync(join(repo, "deploy"), { recursive: true });
  mkdirSync(join(repo, "agent", "lib"), { recursive: true });
  copyFileSync(join(REPO, "deploy", "deploy.sh"), join(repo, "deploy", "deploy.sh"));
  writeFileSync(join(repo, ".gitignore"), "agent/join-and-smoke.ts\nagent/scratch/\n");
  writeFileSync(join(repo, "agent", "index.ts"), "// tracked\n");
  writeFileSync(join(repo, "agent", "lib", "util.ts"), "// tracked\n");
  const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", ".gitignore", "agent", "deploy/deploy.sh");
  git("commit", "-q", "-m", "init");

  // Игнорируемый черновик, чьё имя не подходит ни под одну маску.
  writeFileSync(join(repo, "agent", "join-and-smoke.ts"), "// draft\n");
  mkdirSync(join(repo, "agent", "scratch"));
  writeFileSync(join(repo, "agent", "scratch", "notes.ts"), "// draft\n");
  // Неотслеживаемый файл в корне с тем же именем, что у отслеживаемого в
  // lib/: без якоря `/` шаблон `util.ts` исключил бы и lib/util.ts.
  writeFileSync(join(repo, "agent", "util.ts"), "// untracked\n");

  const r = spawnSync("bash", [join(repo, "deploy", "deploy.sh")], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DRY_RUN: "1",
      DEPLOY_HOST: "stub@invalid.example",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  CODE = r.status ?? -1;
  OUT = `${r.stdout ?? ""}${r.stderr ?? ""}`;
}, SPAWN_TIMEOUT_MS);

afterAll(() => {
  if (SANDBOX && existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
});

describe("deploy.sh везёт только то, что в коммите", () => {
  test("скрипт доходит до rsync", () => {
    expect(CODE).toBe(0);
  });

  test("dry-run называет игнорируемый черновик в списке исключённого", () => {
    expect(OUT).toContain("/join-and-smoke.ts");
    expect(OUT).toContain("игнорируемый");
  });

  // Dry-run настоящего rsync печатает список к отправке через --itemize-changes.
  const sent = () => OUT.split("\n").filter((l) => /^[<>ch.][fdL]/.test(l)).map((l) => l.split(" ").pop());

  test("игнорируемые файл и каталог не отправляются", () => {
    expect(sent()).not.toContain("join-and-smoke.ts");
    expect(sent().some((p) => p?.startsWith("scratch"))).toBe(false);
  });

  test("неотслеживаемый файл не отправляется", () => {
    expect(sent()).not.toContain("util.ts");
  });

  test("отслеживаемые файлы с тем же именем отправляются", () => {
    expect(sent()).toContain("index.ts");
    expect(sent()).toContain("lib/util.ts");
  });
});
