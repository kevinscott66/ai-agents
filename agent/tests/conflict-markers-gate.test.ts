/**
 * Аудит 2026-08-12: CI-гейт «No committed conflict markers» открывался при
 * собственной ошибке.
 *
 * check-conflict-markers.sh считал ошибку `git grep` за «совпадений нет»:
 *   MATCHES=$(git grep -nP … ); RC=$?
 *   if [ "$RC" -eq 0 ] && [ -n "$MATCHES" ]; then … exit 1; fi
 *   echo "No conflict markers found."; exit 0
 * Ноль — совпадения, единица — их нет, а всё остальное (RC=2, RC=128) — это
 * сам grep не отработал. Замер: запуск скрипта вне git-репозитория даёт
 * `fatal: not a git repository`, rc(git grep)=128 — и скрипт печатает
 * «No conflict markers found.» с кодом 0.
 *
 * Тот же путь открывается, если git собран без PCRE: `-P` тогда падает со
 * 128, и джоба остаётся вечно зелёной, ничего не проверяя. Это зеркало
 * инцидента из CLAUDE.md §3.8 п.5, где такой же гейт был вечно красным.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(
  import.meta.dir,
  "..",
  "..",
  ".github",
  "scripts",
  "check-conflict-markers.sh",
);

const ROOT = mkdtempSync(join(tmpdir(), "delabs-markers-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function sh(cmd: string[], cwd: string) {
  const p = Bun.spawnSync(cmd, { cwd });
  if (p.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} → ${p.stderr.toString()}`);
  }
}

function gitRepo(name: string, files: Record<string, string>): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  sh(["git", "init", "-q"], dir);
  sh(["git", "config", "user.email", "t@example.com"], dir);
  sh(["git", "config", "user.name", "test"], dir);
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(join(dir, rel), body, "utf8");
  }
  sh(["git", "add", "-A"], dir);
  return dir;
}

function run(cwd: string) {
  const p = Bun.spawnSync(["bash", SCRIPT], { cwd });
  return {
    code: p.exitCode,
    out: p.stdout.toString() + p.stderr.toString(),
  };
}

const MARKER = ["<".repeat(7) + " HEAD", "наше", "=".repeat(7), "их", ">".repeat(7) + " branch"].join("\n");

describe("check-conflict-markers.sh", () => {
  test("чистое дерево — код 0", () => {
    const r = run(gitRepo("clean", { "a.md": "просто текст\n" }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("No conflict markers");
  });

  test("закоммиченные маркеры — код 1 и путь в выводе", () => {
    const r = run(gitRepo("dirty", { "TASKS.md": `# задачи\n${MARKER}\n` }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("TASKS.md");
  });

  test("сам grep не отработал — гейт закрывается, а не открывается", () => {
    // Вне git-репозитория `git grep` отдаёт 128. Старое поведение: код 0 и
    // «No conflict markers found.».
    const dir = join(ROOT, "notgit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TASKS.md"), MARKER, "utf8");
    const r = run(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("No conflict markers found.");
  });

  test("маркер в середине строки не считается конфликтом", () => {
    const r = run(
      gitRepo("prose", {
        "docs.md": "в тексте бывает ======= как разделитель\n",
      }),
    );
    expect(r.code).toBe(0);
  });
});
