/**
 * Аудит 2026-08-29: деплой-воркфлоу не мог стартовать, а неприпиненный экшен
 * выполнялся после записи прод-ключа.
 *
 * 1. `deploy.yml` пинил setup-bun строкой из 38 hex-символов. Actions
 *    резолвит ref как полный 40-символьный SHA, тег или ветку — 38 символов
 *    не являются ничем из этого, и прогон падает на этом шаге с «Unable to
 *    resolve action». Настоящий SHA тега v2 — тот же самый, но с двумя
 *    потерянными символами в середине (`…618aeaa5fe…` против `…618aa5fe…`),
 *    то есть это опечатка, а не другой коммит.
 *
 *    Отдельно неприятно, что `nightly-deploy.yml` ищет «последний успешный
 *    прогон с dry_run=false»: таких нет никогда, значит каждую ночь
 *    повторяется один и тот же красный прогон.
 *
 * 2. Шаг с пином назван «Setup pinned Bun BEFORE handling deploy
 *    credentials» — намерение автора записано прямо в имени. Но ниже, уже
 *    ПОСЛЕ записи `secrets.DEPLOY_SSH_KEY` в ~/.ssh/id_ed25519, стоял второй
 *    `oven-sh/setup-bun@v2` — мутабельный тег, который вдобавок перетирал
 *    пин `1.3.14` на `latest`. Переставленный тег означал бы исполнение
 *    чужого кода на раннере, где уже лежит ключ от прод-хоста.
 *
 * Любой action выполняет сторонний код в CI, поэтому все references должны
 * быть неизменяемыми полными SHA. Отдельно в deploy.yml сторонних actions
 * после записи прод-ключа быть не должно.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const WF_DIR = new URL("../../.github/workflows/", import.meta.url).pathname;
const FILES = readdirSync(WF_DIR).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"));

type Use = { file: string; line: number; action: string; ref: string };

function uses(file: string): Use[] {
  const src = readFileSync(WF_DIR + file, "utf-8");
  const out: Use[] = [];
  src.split("\n").forEach((l, i) => {
    const t = l.trimStart();
    if (t.startsWith("#")) return;
    const m = /^-?\s*uses:\s*([^\s@]+)@([^\s#]+)/.exec(t);
    if (m) out.push({ file, line: i + 1, action: m[1], ref: m[2] });
  });
  return out;
}

const ALL = FILES.flatMap(uses);

describe("предпосылки", () => {
  test("воркфлоу нашлись и в них есть uses:", () => {
    // Публичный релиз 2026-09-01 оставил в репо три воркфлоу вместо восьми:
    // порог сторожит теперь только пустой скан, а не прежнее их количество.
    expect(FILES.length).toBeGreaterThan(0);
    expect(ALL.length).toBeGreaterThan(0);
  });
});

describe("actions pinned immutably", () => {
  test("каждый action закреплён полным commit SHA", () => {
    const bad = ALL.filter((u) => !/^[0-9a-f]{40}$/.test(u.ref)).map(
      (u) => `${u.file}:${u.line} ${u.ref}`,
    );
    expect(bad).toEqual([]);
  });
});

// deploy.yml удалён при публичном релизе 2026-09-01, проверять нечего.
// Вернётся файл в .github/workflows/ — блок снова включится сам.
const HAS_DEPLOY = existsSync(WF_DIR + "deploy.yml");

describe.skipIf(!HAS_DEPLOY)("deploy.yml: сторонний код не выполняется после прод-ключа", () => {
  const SRC = HAS_DEPLOY ? readFileSync(WF_DIR + "deploy.yml", "utf-8") : "";
  const LINES = SRC.split("\n");
  // Именно подстановка секрета, а не упоминание имени: список требуемых
  // секретов перечислен в шапке файла комментарием, и он идёт первым.
  const keyLine =
    LINES.findIndex(
      (l) => l.includes("secrets.DEPLOY_SSH_KEY") && !l.trimStart().startsWith("#"),
    ) + 1;

  test("шаг с записью ключа в файле есть", () => {
    expect(keyLine).toBeGreaterThan(0);
    expect(SRC).toContain("~/.ssh/id_ed25519");
  });

  test("после записи ключа сторонних uses: нет", () => {
    const after = uses("deploy.yml")
      .filter((u) => u.line > keyLine && !u.action.startsWith("actions/"))
      .map((u) => `deploy.yml:${u.line} ${u.action}@${u.ref}`);
    expect(after).toEqual([]);
  });

  test("bun ставится один раз и остаётся на объявленной версии", () => {
    const bun = uses("deploy.yml").filter((u) => u.action === "oven-sh/setup-bun");
    expect(bun.length).toBe(1);
    expect(bun[0].ref).toMatch(/^[0-9a-f]{40}$/);
    expect(SRC).toContain("bun-version: 1.3.14");
    expect(SRC).not.toContain("bun-version: latest");
  });

  test("пин стоит там, где обещает его имя — до работы с секретами", () => {
    const bun = uses("deploy.yml").find((u) => u.action === "oven-sh/setup-bun");
    expect(bun!.line).toBeLessThan(keyLine);
  });
});
