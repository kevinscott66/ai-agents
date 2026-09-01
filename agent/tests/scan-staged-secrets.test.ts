/**
 * Аудит 2026-08-12: автономный цикл на VPS коммитил вслепую то, что написал
 * агент с включённым Bash.
 *
 * `deploy/vps-autonomous/autonomous-cycle.sh` делает `git add -A` сразу после
 * headless-claude, запущенного с `--permission-mode acceptEdits` и
 * `--allowedTools "Bash Edit Write …"` на машине, где рядом лежит
 * `/opt/agent-team/.env` — токены двенадцати ботов, ключ OpenAI, сессия
 * юзербота, ingest-токен. Единственное, что запрещало это трогать, — строка в
 * промпте («never read or print secrets»). Промпт не гейт: он и сам собирается
 * из TASKS.md и файлов памяти, то есть из текста, который агент же и правит.
 * А `git add -A` не различает заметку и дамп окружения — и следующий шаг
 * скрипта пушит ветку и открывает PR.
 *
 * Гейт должен стоять между staging и commit'ом и обязан закрываться при
 * собственной поломке: `git diff` вне репозитория возвращает 128, и это
 * «проверка не выполнена», а не «чисто» (тот же класс, что был в
 * check-conflict-markers.sh — см. tests/conflict-markers-gate.test.ts).
 *
 * Формы, которые ловим, — ровно те, что реально живут в .env этого проекта:
 * telegram bot token (`<digits>:<35 символов>`), `sk-ant-…`, `sk-…`, `ghp_…`,
 * `github_pat_…`, а также строка вида `SOMETHING_TOKEN=<непустое>` в добавленном
 * тексте. Значения в тесте выдуманы целиком.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = join(
  import.meta.dir,
  "..",
  "..",
  "deploy",
  "vps-autonomous",
  "scan-staged-secrets.sh",
);
const SERVICE = readFileSync(
  join(import.meta.dir, "..", "..", "deploy", "vps-autonomous", "agent-autonomous.service"),
  "utf8",
);
const LEGACY_LOOP = readFileSync(
  join(import.meta.dir, "..", "..", "deploy", "agents-loop.sh"),
  "utf8",
);

/** Временный git-репозиторий со стейджнутым файлом. Коммит не нужен. */
function repoWithStaged(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "scan-secrets-"));
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  git("add", "-A");
  return dir;
}

function scan(dir: string) {
  const r = spawnSync("bash", [SCRIPT], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/**
 * Запас по времени на тесты, которые ходят в подпроцессы.
 *
 * Замер на этой машине (idle): `git init` 358 мс + два `git config` 173 мс +
 * `git add -A` 90 мс + сам сканер 818 мс ≈ 1.4 с на тест. Сканер дорог по
 * устройству: на каждый staged-файл он гоняет по два `grep` на КАЖДЫЙ паттерн.
 * Это настоящая работа, а не забытый таймер, — ускорить её здесь нечем.
 *
 * Под нагрузкой (полный прогон в 12 файлов параллельно) «anthropic key» доходил
 * до 6674 мс при дефолтном пределе bun в 5000 — то есть падал по таймауту, а не
 * по утверждению. Причём `spawnSync` держит event-loop, поэтому bun не может
 * прервать тест на середине: он сначала доработает и только потом отчитается о
 * превышении. Отсюда явный запас, а не надежда на дефолт.
 */
const SLOW = 30_000;

describe("гейт секретов перед автономным коммитом", () => {
  test("обычная заметка проходит", () => {
    const dir = repoWithStaged({
      "note.md": "# Итерация\n\nПочинил парсер, тесты зелёные.\n",
    });
    try {
      const { code } = scan(dir);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);

  for (const [label, line] of [
    ["telegram bot token", ["TG=1234567890", ":", "AAFakeFakeFakeFakeFakeFakeFakeFakeFa"].join("")],
    ["anthropic key", "key: sk-ant-api03-" + "F".repeat(40)],
    ["openai key", "OPENAI=sk-" + "F".repeat(44)],
    ["classic PAT", "token ghp_" + "F".repeat(36)],
    ["fine-grained PAT", "github_pat_" + "F".repeat(50)],
    ["присвоение токена", ["INGEST_TOKEN", "=", '"totally-made-up-value-here"'].join("")],
  ] as const) {
    test(`${label} — коммит запрещён`, () => {
      const dir = repoWithStaged({ "leak.md": `Заметка\n${line}\nконец\n` });
      try {
        const { code, out } = scan(dir);
        expect(code).not.toBe(0);
        // Гейт обязан назвать файл, иначе человеку нечего смотреть.
        expect(out).toContain("leak.md");
        // И не должен печатать само значение — иначе он же его и разгласит,
        // в лог /var/log/agent-autonomous.log.
        expect(out).not.toContain(line.slice(-12));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, SLOW);
  }

  test("пустой staged-набор — не находка, а просто нечего смотреть", () => {
    const dir = repoWithStaged({});
    try {
      expect(scan(dir).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);

  test("вне git-репозитория гейт закрывается, а не пропускает", () => {
    // git diff вернёт 128. «Проверка не выполнена» ≠ «чисто».
    const dir = mkdtempSync(join(tmpdir(), "scan-secrets-notgit-"));
    try {
      const { code, out } = scan(dir);
      expect(code).not.toBe(0);
      expect(out).not.toContain("секретов не найдено");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);
});

describe("autonomous-cycle.sh пользуется гейтом и не тащит лишнего в claude", () => {
  const src = readFileSync(
    join(import.meta.dir, "..", "..", "deploy", "vps-autonomous", "autonomous-cycle.sh"),
    "utf8",
  );

  test("сканер вызывается между `git add -A` и коммитом", () => {
    const add = src.indexOf("git add -A");
    const scanAt = src.indexOf("scan-staged-secrets.sh");
    const commit = src.indexOf("git commit -m");
    expect(add).toBeGreaterThan(-1);
    expect(scanAt).toBeGreaterThan(add);
    expect(commit).toBeGreaterThan(scanAt);
  });

  test("весь .env больше не экспортируется в окружение агента", () => {
    // `set -a; . /opt/agent-team/.env; set +a` в теле скрипта отдавал агенту с
    // Bash всё: токены 12 ботов, OpenAI, сессию юзербота, ingest-токен.
    expect(src).not.toMatch(/^\s*set -a;\s*\.\s+\S*\.env/m);
    expect(src).toContain("env_value");
  });

  test("у самого claude нет GH_TOKEN — коммитит и пушит обёртка", () => {
    // Промпт прямо говорит «Never git push/commit yourself», значит и токен с
    // правом записи в репозиторий процессу агента не нужен.
    const claudeCall = src.slice(src.indexOf("env -i"));
    expect(claudeCall).toContain("env -i");
    expect(claudeCall).toContain('timeout "$CLAUDE_TIMEOUT_SEC"');
    expect(claudeCall).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_/);
  });

  test("цикл не стартует без readiness или при активном lock", () => {
    const root = mkdtempSync(join(tmpdir(), "autonomous-cycle-gate-"));
    const env = {
      ...process.env,
      AUTO_LOG: join(root, "cycle.log"),
      AUTO_STRUCTURED_LOG: join(root, "cycle.jsonl"),
      AUTO_READINESS_FILE: join(root, "readiness"),
      AUTO_DISABLE_FILE: join(root, "disabled"),
      AUTO_LOCK_DIR: join(root, "lock"),
      AUTO_STATE_DIR: join(root, "state"),
      AUTO_REPORT_DIR: join(root, "reports"),
      AUTO_WORKDIR: join(root, "workdir"),
      AUTO_ENV_FILE: join(root, "empty.env"),
    };
    try {
      const missing = spawnSync("bash", [join(import.meta.dir, "..", "..", "deploy", "vps-autonomous", "autonomous-cycle.sh")], {
        env,
        encoding: "utf8",
      });
      expect(missing.status).toBe(0);
      expect(readFileSync(env.AUTO_LOG, "utf8")).toContain('"event":"readiness_missing_or_red"');

      writeFileSync(env.AUTO_READINESS_FILE, "green\n");
      mkdirSync(env.AUTO_LOCK_DIR, { recursive: true });
      const locked = spawnSync("bash", [join(import.meta.dir, "..", "..", "deploy", "vps-autonomous", "autonomous-cycle.sh")], {
        env,
        encoding: "utf8",
      });
      expect(locked.status).toBe(0);
      expect(readFileSync(env.AUTO_LOG, "utf8")).toContain('"event":"already_active"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("autonomous service hardening", () => {
  test("runs as a dedicated user with a narrow writable surface", () => {
    expect(SERVICE).toContain("User=agent-autonomous");
    expect(SERVICE).toContain("Group=agent-autonomous");
    expect(SERVICE).toContain("ExecStart=/bin/bash /opt/vps-autonomous/autonomous-cycle.sh");
    expect(SERVICE).not.toContain("/root/.local/bin/claude");
    expect(SERVICE).not.toContain("ExecStart=/usr/bin/env bash");
    expect(SERVICE).toContain("NoNewPrivileges=true");
    expect(SERVICE).toContain("CapabilityBoundingSet=\n");
    expect(SERVICE).toContain("ProtectSystem=strict");
    expect(SERVICE).toContain("ProtectHome=true");
    expect(SERVICE).toContain("InaccessiblePaths=/opt/agent-team/.env");
    expect(SERVICE).toContain("ReadWritePaths=/opt/agent-autonomous");
    expect(SERVICE).toContain("EnvironmentFile=-/etc/agent-autonomous/credentials");
  });

  test("retires the legacy Bash-capable runner", () => {
    expect(LEGACY_LOOP).toContain("is retired");
    expect(LEGACY_LOOP).toContain("exit 1");
    expect(LEGACY_LOOP).not.toContain("claude -p");
    expect(LEGACY_LOOP).not.toContain("--allowed-tools");
    expect(LEGACY_LOOP).not.toContain("--permission-mode");
  });
});
