/**
 * Аудит 2026-08-20: гейт «в прод не уедет то, чего нет в коммите» умел молча
 * выключаться.
 *
 * Оба деплой-скрипта строят список исключений так:
 *
 *   git ls-files --others --exclude-standard -- agent/ | sed … > "$FILE" || true
 *
 * `|| true` здесь относится ко ВСЕЙ пайплайне. Если `git ls-files` не отработал
 * — каталог без `.git` (распакованный архив, копия без истории), git не на PATH,
 * занятый index — то `>` уже усёк файл, пайплайна вернула ненулевой код, а
 * `|| true` его съел. На выходе ПУСТОЙ список исключений: `UNTRACKED_COUNT` = 0,
 * ветка `!= 0` не срабатывает, в выводе об этом нет ни строчки. Гейт
 * деградирует до одних масок `probe-*`/`debug-*`/`smoke-*` — ровно до того
 * состояния, из-за которого `send-test-trigger.ts` и `test-banner.ts` уехали в
 * прод и лежали там, пока их не заметили (rsync без `--delete` не убирает).
 *
 * Тест не читает исходник глазами, а гоняет сам скрипт: дерево БЕЗ `.git`,
 * `rsync`/`ssh` подменены заглушками на PATH, `DRY_RUN=1`. Правильное поведение
 * — остановиться, не вызвав rsync ни разу. До фикса скрипт доходил до rsync и
 * выходил с нулём, а черновик из рабочего каталога попадал в список к отправке.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dir, "..", "..");
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


let SANDBOX = "";
let BIN = "";
let RSYNC_CALLS = "";

/** Заглушки, чтобы ничего никуда не поехало и было видно, звали ли rsync. */
function makeStubs(dir: string, callLog: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ["rsync", "ssh"]) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${callLog}"\nexit 0\n`);
    chmodSync(p, 0o755);
  }
}

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "deploy-gate-"));
  BIN = join(SANDBOX, "bin");
  RSYNC_CALLS = join(SANDBOX, "calls.log");
  makeStubs(BIN, RSYNC_CALLS);
  writeFileSync(RSYNC_CALLS, "");

  // Дерево-двойник репозитория: те же относительные пути, но БЕЗ .git.
  mkdirSync(join(SANDBOX, "repo", "deploy"), { recursive: true });
  mkdirSync(join(SANDBOX, "repo", "agent"), { recursive: true });
  mkdirSync(join(SANDBOX, "repo", "site", "server"), { recursive: true });
  mkdirSync(join(SANDBOX, "repo", "site", "web"), { recursive: true });
  for (const s of ["deploy.sh", "deploy-site.sh"]) {
    copyFileSync(join(REPO, "deploy", s), join(SANDBOX, "repo", "deploy", s));
  }
  // Черновик, которого нет ни в одном коммите: именно он не должен уехать.
  writeFileSync(join(SANDBOX, "repo", "agent", "chernovik-vladeltsa.ts"), "// draft\n");
  writeFileSync(join(SANDBOX, "repo", "site", "server", "chernovik-vladeltsa.ts"), "// draft\n");
});

afterAll(() => {
  if (SANDBOX && existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
});

function runDeploy(script: string): { code: number; out: string; rsyncCalls: string } {
  writeFileSync(RSYNC_CALLS, "");
  const r = spawnSync("bash", [join(SANDBOX, "repo", "deploy", script)], {
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH ?? ""}`,
      DRY_RUN: "1",
      DEPLOY_HOST: "stub@invalid.example",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    code: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    rsyncCalls: existsSync(RSYNC_CALLS) ? readFileSync(RSYNC_CALLS, "utf8") : "",
  };
}

describe("деплой без git не выкатывает", () => {
  slowTest("deploy.sh останавливается, а не едет с пустым списком исключений", () => {
    const r = runDeploy("deploy.sh");
    // Главное утверждение: rsync не позвали ВООБЩЕ. Ненулевой код без этого
    // ничего не доказывает — упасть можно и после отправки файлов.
    expect(r.rsyncCalls).toBe("");
    expect(r.code).not.toBe(0);
  });

  slowTest("deploy-site.sh останавливается так же", () => {
    const r = runDeploy("deploy-site.sh");
    expect(r.rsyncCalls).toBe("");
    expect(r.code).not.toBe(0);
  });

  slowTest("в выводе названа причина, а не просто ненулевой код", () => {
    const r = runDeploy("deploy.sh");
    // Тишина здесь и была сутью дефекта: гейт отключался, не сказав ни слова.
    expect(r.out).toContain("ls-files");
  });
});

describe("нормальный случай не задет", () => {
  /**
   * Симметричная проверка: «падать всегда» прошло бы тесты выше, но сломало бы
   * выкатку. В настоящем репозитории скрипт обязан доехать до rsync и передать
   * ему непустой --exclude-from, где лежит незакоммиченный черновик.
   */
  slowTest("в git-репозитории deploy.sh доходит до rsync и исключает черновик", () => {
    const repo = join(SANDBOX, "gitrepo");
    mkdirSync(join(repo, "deploy"), { recursive: true });
    mkdirSync(join(repo, "agent"), { recursive: true });
    copyFileSync(join(REPO, "deploy", "deploy.sh"), join(repo, "deploy", "deploy.sh"));
    writeFileSync(join(repo, "agent", "index.ts"), "// tracked\n");
    const git = (...a: string[]) =>
      spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("add", "agent/index.ts", "deploy/deploy.sh");
    git("commit", "-q", "-m", "init");
    // Черновик появляется ПОСЛЕ коммита — его и должен поймать гейт.
    writeFileSync(join(repo, "agent", "chernovik-vladeltsa.ts"), "// draft\n");

    writeFileSync(RSYNC_CALLS, "");
    const r = spawnSync("bash", [join(repo, "deploy", "deploy.sh")], {
      env: {
        ...process.env,
        PATH: `${BIN}:${process.env.PATH ?? ""}`,
        DRY_RUN: "1",
        DEPLOY_HOST: "stub@invalid.example",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    const calls = readFileSync(RSYNC_CALLS, "utf8");
    expect(r.status).toBe(0);
    expect(calls).toContain("rsync ");

    // Заглушка rsync удаляет temp-файл вместе с собой, поэтому проверяем не его
    // содержимое, а то, что скрипт назвал черновик в своём же выводе.
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(out).toContain("chernovik-vladeltsa.ts");
    expect(out).toContain("не уедет в прод");
  });
});

describe("исходники не возвращают проглатывание ошибки", () => {
  const scripts = ["deploy.sh", "deploy-site.sh"];
  for (const s of scripts) {
    test(`${s}: пайплайна ls-files не оканчивается '|| true'`, () => {
      const text = readFileSync(join(REPO, "deploy", s), "utf8");
      const lines = text.split("\n");
      const bad: string[] = [];
      lines.forEach((line, i) => {
        if (!line.includes("ls-files")) return;
        // Пайплайна может быть перенесена на следующую строку через '\'.
        const chunk = [line, lines[i + 1] ?? "", lines[i + 2] ?? ""].join("\n");
        const upto = chunk.slice(0, chunk.indexOf("ls-files") + 400);
        if (/\|\|\s*true/.test(upto)) bad.push(line.trim());
      });
      expect(bad).toEqual([]);
    });
  }
});
