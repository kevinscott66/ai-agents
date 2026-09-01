import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..", "..");
/*
 * Аудит 2026-08-29: тесты этого файла поднимают временный git-репозиторий и
 * запускают shell-скрипт — в одиночку это ~2.6 с, но под полным прогоном
 * (786 файлов в одном процессе) те же вызовы растягивались до 7–22 с и
 * упирались в дефолтные 5000 мс bun. Падал не код, а таймер: гейт краснел
 * случайно, от нагрузки соседей. Отсюда явный запас, а не надежда на дефолт —
 * тот же приём, что в tests/scan-staged-secrets.test.ts.
 */
const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, fn, SPAWN_TIMEOUT_MS);

const SCRIPT = join(ROOT, ".github", "scripts", "check-secret-hygiene.sh");
const WORKFLOW = join(ROOT, ".github", "workflows", "checks.yml");

function git(dir: string, ...args: string[]) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function repoWithRange(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "secret-hygiene-ci-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(join(dir, "note.md"), "safe\n");
  git(dir, "add", "note.md");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(dir, "note.md"), body);
  git(dir, "add", "note.md");
  git(dir, "commit", "-qm", "head");
  const head = git(dir, "rev-parse", "HEAD").stdout.trim();
  return { dir, base, head };
}

function scan(dir: string, base: string, head: string) {
  return spawnSync("bash", [SCRIPT, base, head], {
    cwd: dir,
    encoding: "utf8",
  });
}

describe("PR secret hygiene gate", () => {
  slowTest("не исключает собственный скрипт из diff-проверки", async () => {
    const script = await Bun.file(SCRIPT).text();
    expect(script).not.toContain(":!.github/scripts/check-secret-hygiene.sh");
  });

  slowTest("scans the gate's own file instead of creating a blind spot", () => {
    const repo = mkdtempSync(join(tmpdir(), "secret-hygiene-self-scan-"));
    const path = join(repo, ".github", "scripts");
    const token = "1234567890:" + "B".repeat(35);
    try {
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "test");
      writeFileSync(join(repo, "note.md"), "safe\n");
      git(repo, "add", "note.md");
      git(repo, "commit", "-qm", "base");
      const base = git(repo, "rev-parse", "HEAD").stdout.trim();
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "check-secret-hygiene.sh"), `TG_TOKEN=${token}\n`);
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "bad scanner change");
      const head = git(repo, "rev-parse", "HEAD").stdout.trim();
      const result = scan(repo, base, head);
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
      expect(`${result.stdout}${result.stderr}`).toContain("telegram-bot-token");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  slowTest("manual dispatch resolves a base commit without pull_request context", async () => {
    const workflow = await Bun.file(WORKFLOW).text();
    expect(workflow).toContain("DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
    expect(workflow).toContain('if [ -z "$BASE_SHA" ]; then');
    expect(workflow).toContain('git rev-parse "origin/${DEFAULT_BRANCH}"');
    expect(workflow).toContain('bash .github/scripts/check-secret-hygiene.sh "$BASE_SHA" "$PR_HEAD_SHA"');
  });

  slowTest("allows ordinary additions", () => {
    const repo = repoWithRange("safe note\n");
    try {
      expect(scan(repo.dir, repo.base, repo.head).status).toBe(0);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  slowTest("allows explicit synthetic test fixtures", () => {
    const synthetic = ["miniapp", "replay", "test", "token"].join("-");
    const repo = repoWithRange(`TOKEN = "${synthetic}"\n`);
    try {
      expect(scan(repo.dir, repo.base, repo.head).status).toBe(0);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  slowTest("rejects credential-shaped additions without echoing the value", () => {
    const token = "1234567890:" + "A".repeat(35);
    const repo = repoWithRange(`TG_TOKEN=${token}\n`);
    try {
      const result = scan(repo.dir, repo.base, repo.head);
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
      expect(`${result.stdout}${result.stderr}`).toContain("telegram-bot-token");
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  slowTest("fails closed when the git range is unavailable", () => {
    const repo = mkdtempSync(join(tmpdir(), "secret-hygiene-notgit-"));
    try {
      const result = scan(repo, "missing-base", "missing-head");
      expect(result.status).toBe(2);
      expect(`${result.stdout}${result.stderr}`).not.toContain("no credential-shaped");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
