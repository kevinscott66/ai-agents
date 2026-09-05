/**
 * Аудит 2026-08-29: auto-merge не спрашивал, КТО прислал PR, и считал
 * `.gitignore` безопасным файлом.
 *
 * 1) Личность автора не проверялась вообще. `gh pr list --json` в
 *    auto-merge.yml не запрашивал ни `author`, ни `isCrossRepository`, и
 *    фильтр их не смотрел. Единственное, что стояло на пути постороннего PR из
 *    форка, — требование зелёного CI: у первого PR от нового контрибьютора
 *    воркфлоу ждут ручного одобрения, поэтому чеков нет и срабатывает
 *    `no_checks`. То есть дыру закрывала настройка GitHub, а не наш код: при
 *    втором PR того же автора (одобрения уже не нужны) фильтр пропускал бы его
 *    наравне с владельцем. Замер на живых данных (`gh pr list --json
 *    author,isCrossRepository`, 2026-08-29): все PR репозитория — от
 *    `kevinscott66` и `isCrossRepository:false`, так что аллоу-лист из одного
 *    имени ничего не ломает.
 *
 * 2) `.gitignore` лежал в безопасном списке. Это ровно тот файл, который
 *    держит вне git рантайм-БД (`agent/data/*.db`) и StringSession
 *    Telegram-юзербота (`*.session` — это учётные данные, а не артефакт). PR,
 *    удаляющий эти строки, трогает ТОЛЬКО `.gitignore`, то есть проходил все
 *    остальные гейты и вливался в main сквошем без единого человеческого
 *    взгляда. Дальше любой `git add -A` (а CLAUDE.md §4.5 фиксирует, что
 *    автономный цикл так уже делал — коммит af94f80f) утаскивает сессию в
 *    историю приватного, но живого репозитория.
 *
 * Оба гейта fail-closed: PR без поля `author` считается PR неизвестного автора,
 * а не «автор не важен». Это жёстко связывает скрипт с воркфлоу — если из
 * `--json` уберут `author`, перестанет мёрджиться всё, а не «всё подряд».
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, ".github", "scripts", "automerge-filter.sh");
const WORKFLOW = join(ROOT, ".github", "workflows", "auto-merge.yml");
const GITIGNORE = join(ROOT, ".gitignore");

const OWNER = "kevinscott66";

interface PrFixture {
  number: number;
  headRefName?: string;
  author?: { login: string } | null;
  isCrossRepository?: boolean;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  labels?: { name: string }[];
  files?: { path: string }[];
  statusCheckRollup?: Record<string, unknown>[];
}

function pr(over: Partial<PrFixture> & { number: number }): PrFixture {
  return {
    headRefName: `agent/pr-${over.number}`,
    author: { login: OWNER },
    isCrossRepository: false,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    labels: [],
    files: [{ path: "docs/README.md" }],
    statusCheckRollup: [{ name: "checks", conclusion: "SUCCESS" }],
    ...over,
  };
}

/** См. automerge-filter.test.ts: под полным прогоном спавн дорожает, 5000 мс мало. */
const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void) =>
  test(name, fn, SPAWN_TIMEOUT_MS);

function decision(prs: PrFixture[], env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(["bash", SCRIPT], {
    stdin: Buffer.from(JSON.stringify(prs)),
    env: { ...process.env, ...env },
  });
  const err = p.stderr.toString().trim();
  expect({ code: p.exitCode, err }).toEqual({ code: 0, err: "" });
  const out = p.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  expect(out).toHaveLength(1);
  return out[0]!;
}

describe("предпосылки: что именно защищает .gitignore", () => {
  const IGNORE = readFileSync(GITIGNORE, "utf8").split("\n");

  test("рантайм-БД и session-файлы держатся вне git именно им", () => {
    for (const line of ["agent/data/*.db", "*.session", "agent/data/*.session"]) {
      expect(IGNORE).toContain(line);
    }
  });

  test("PR, вычёркивающий их, трогает ровно один файл", () => {
    // Ровно та форма, что раньше проходила фильтр: один безопасный путь.
    expect([".gitignore"]).toHaveLength(1);
  });
});

describe("личность автора", () => {
  slowTest("PR из форка не мёрджится", () => {
    expect(decision([pr({ number: 101, isCrossRepository: true })])).toBe(
      "SKIP 101 fork_pr",
    );
  });

  slowTest("PR из форка не мёрджится даже от владельца", () => {
    expect(
      decision([
        pr({ number: 102, isCrossRepository: true, author: { login: OWNER } }),
      ]),
    ).toBe("SKIP 102 fork_pr");
  });

  slowTest("посторонний автор не мёрджится", () => {
    expect(decision([pr({ number: 103, author: { login: "mallory" } })])).toBe(
      "SKIP 103 untrusted_author:mallory",
    );
  });

  slowTest("автор, лишь СОДЕРЖАЩИЙ имя владельца, не проходит", () => {
    for (const login of [`${OWNER}x`, `x${OWNER}`, `${OWNER}-bot`]) {
      expect(decision([pr({ number: 104, author: { login } })])).toBe(
        `SKIP 104 untrusted_author:${login}`,
      );
    }
  });

  slowTest("отсутствующий author — это неизвестный автор, а не «не важно»", () => {
    // Fail-closed: если из `gh pr list --json` уберут поле, встанет весь мёрдж.
    expect(decision([pr({ number: 105, author: null })])).toBe(
      "SKIP 105 untrusted_author:<unknown>",
    );
  });

  slowTest("владелец из своего же репозитория мёрджится", () => {
    expect(decision([pr({ number: 106 })])).toBe("MERGE 106 agent/pr-106");
  });

  slowTest("аллоу-лист расширяется переменной окружения", () => {
    expect(
      decision([pr({ number: 107, author: { login: "release-bot" } })], {
        AUTOMERGE_ALLOWED_AUTHORS: `${OWNER},release-bot`,
      }),
    ).toBe("MERGE 107 agent/pr-107");
  });

  slowTest("пустая или пробельная переменная откатывается к владельцу", () => {
    // `KEY=` в окружении даёт "", а `KEY= ` даёт " " — оба означают «не задано».
    for (const value of ["", "   "]) {
      expect(
        decision([pr({ number: 108 })], { AUTOMERGE_ALLOWED_AUTHORS: value }),
      ).toBe("MERGE 108 agent/pr-108");
      expect(
        decision([pr({ number: 109, author: { login: "mallory" } })], {
          AUTOMERGE_ALLOWED_AUTHORS: value,
        }),
      ).toBe("SKIP 109 untrusted_author:mallory");
    }
  });
});

describe(".gitignore больше не безопасный путь", () => {
  slowTest("PR, состоящий из одного .gitignore, не мёрджится", () => {
    expect(
      decision([pr({ number: 201, files: [{ path: ".gitignore" }] })]),
    ).toBe("SKIP 201 unsafe_paths:.gitignore");
  });

  slowTest(".gitignore рядом с документацией тоже блокирует PR", () => {
    expect(
      decision([
        pr({
          number: 202,
          files: [{ path: "docs/guide.md" }, { path: ".gitignore" }],
        }),
      ]),
    ).toBe("SKIP 202 unsafe_paths:.gitignore");
  });

  slowTest("документация по-прежнему мёрджится", () => {
    for (const path of [
      "docs/guide.md",
      "docs/deep/nested.md",
      "README.md",
      ".github/workflows/README.md",
    ]) {
      expect(decision([pr({ number: 203, files: [{ path }] })])).toBe(
        "MERGE 203 agent/pr-203",
      );
    }
  });
});

// auto-merge.yml удалён при публичном релизе 2026-09-01 — половину сверки
// (шапка воркфлоу) читать неоткуда. Вернётся файл — блок включится сам.
const HAS_WORKFLOW = existsSync(WORKFLOW);

describe.skipIf(!HAS_WORKFLOW)("источник", () => {
  const YML = HAS_WORKFLOW ? readFileSync(WORKFLOW, "utf8") : "";
  const SH = readFileSync(SCRIPT, "utf8");

  test("воркфлоу запрашивает поля, по которым фильтр судит об авторе", () => {
    const jsonLine = YML.split("\n").find((l) => l.includes("--json number"));
    expect(jsonLine).toBeDefined();
    expect(jsonLine).toContain("author");
    expect(jsonLine).toContain("isCrossRepository");
  });

  test("ни шапка воркфлоу, ни case скрипта больше не обещают .gitignore", () => {
    // Только перечисление безопасных путей («#   - <путь>»), а не весь файл:
    // шапка теперь ОБЪЯСНЯЕТ, почему `.gitignore` оттуда убран, и упоминание
    // в объяснении — не обещание. Тем же граблям подвержен любой source-guard
    // на отсутствие токена.
    const header = YML.slice(0, YML.indexOf("on:"));
    const listed = [...header.matchAll(/^#\s+-\s+(.+)$/gm)].map((m) =>
      m[1]!.trim(),
    );
    expect(listed).not.toContain(".gitignore");
    expect(listed).toContain("docs/**, README*.md");
    const shLines = SH.split("\n").filter(
      (l) => l.trimStart().startsWith(".gitignore)"),
    );
    expect(shLines).toEqual([]);
  });
});
