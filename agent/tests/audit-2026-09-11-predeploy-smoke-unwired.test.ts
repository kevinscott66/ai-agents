/**
 * Аудит 2026-09-11, круг 49: предеплойный смоук существовал, но не вызывался.
 *
 * Между чекаутом и `systemctl restart` на проде стоял ровно один гейт — шаг
 * «Pre-deploy smoke (local)» воркфлоу deploy.yml: bun install, полный прогон
 * тестов из agent/, сборка Mini App; провал любого шага отменял выкатку. Ради
 * него аудит 2026-08-20 вынес логику в .github/scripts/pre-deploy-smoke.sh и
 * накрыл её тестами (tests/audit-2026-08-20-pre-deploy-smoke.test.ts).
 *
 * При публичном релизе 2026-09-01 выкатка из CI была удалена целиком. Скрипт
 * остался: файл на месте, исполняемый бит на месте, тесты зелёные, шапка
 * называет его «единственным гейтом между чекаутом и рестартом». Вызывать его
 * при этом перестало быть некому — ни один воркфлоу в .github/workflows не
 * упоминает ни его, ни rsync, ни systemctl.
 *
 * А выкатка никуда не делась: с 2026-09-01 в прод ходит только
 * deploy/deploy.sh с Mac владельца, и его шаги — замок, снапшот, rsync,
 * `bun install` + сборка + рестарт, health-check. Тестов среди них нет ни
 * одного. То есть полторы недели любой запуск deploy.sh перезаписывал
 * /opt/agent-team и перезапускал юнит, не прогнав ни единого теста, — притом
 * что файл гейта лежал в двух шагах и выглядел работающим.
 *
 * Это тот же класс, что круг 48: мёртвый гейт, описанный в настоящем времени.
 * Разница в том, что там читателя обманывали про чужую подстраховку, а здесь
 * подстраховка была своя, готовая и просто отключённая переездом.
 *
 * Починка: deploy.sh зовёт смоук сам — до замка (тесты идут пару минут, прод
 * -замок всё это время держать незачем) и без обхода по переменной окружения,
 * как и у замка: аварийный путь — не выкатка, а откат по снапшоту.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const WF_DIR = join(REPO, ".github", "workflows");
const SMOKE_REL = ".github/scripts/pre-deploy-smoke.sh";
const SMOKE = join(REPO, SMOKE_REL);
const DEPLOY = readFileSync(join(REPO, "deploy", "deploy.sh"), "utf8");
const LOCK = readFileSync(join(REPO, "deploy", "deploy-lock.sh"), "utf8");

const workflows = readdirSync(WF_DIR)
  .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
  .map((n) => ({ name: n, text: readFileSync(join(WF_DIR, n), "utf8") }));

/** Строки кода воркфлоу без YAML- и shell-комментариев: цитата ≠ вызов. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

describe("в прод из CI не ходит ничто", () => {
  test("воркфлоу прочитались — иначе проверки ниже пустые", () => {
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows.map((w) => w.name)).toContain("checks.yml");
  });

  test("ни один воркфлоу не катит и не перезапускает прод", () => {
    const deployers = workflows
      .filter((w) => /\brsync\b|systemctl|agent-team-deploy-helper/.test(code(w.text)))
      .map((w) => w.name);
    // Когда падает: выкатка вернулась в CI — значит вернулись и два
    // независимых пути, и абзац про замок в deploy/deploy-lock.sh снова
    // описывает жизнь, а не историю. Сверить оба.
    expect(deployers).toEqual([]);
    expect(existsSync(join(WF_DIR, "deploy.yml"))).toBe(false);
  });

  test("смоук не зовёт ни один воркфлоу — на этом и стоит починка", () => {
    expect(workflows.filter((w) => w.text.includes("pre-deploy-smoke")).map((w) => w.name)).toEqual(
      [],
    );
  });
});

describe("единственный путь в прод прогоняет смоук сам", () => {
  test("файл гейта на месте и исполняемый", () => {
    // deploy.sh проверяет его через `-x` и без него не начинает выкатку:
    // потерянный бит остановил бы КАЖДЫЙ деплой, и узнать об этом надо здесь.
    expect(existsSync(SMOKE)).toBe(true);
    expect(statSync(SMOKE).mode & 0o111).toBeGreaterThan(0);
  });

  test("deploy.sh зовёт смоук", () => {
    expect(DEPLOY).toContain(SMOKE_REL);
  });

  test("зовёт до rsync и до рестарта, а не после", () => {
    const smoke = DEPLOY.indexOf(`"$REPO_ROOT/${SMOKE_REL}" "$REPO_ROOT"`);
    const rsync = DEPLOY.indexOf("== 2. rsync");
    const restart = DEPLOY.indexOf("== 3. bun install");
    expect(smoke).toBeGreaterThan(-1);
    expect(rsync).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(rsync);
    expect(smoke).toBeLessThan(restart);
  });

  test("зовёт до замка — чужая выкатка не ждёт наших тестов", () => {
    const smoke = DEPLOY.indexOf(`"$REPO_ROOT/${SMOKE_REL}" "$REPO_ROOT"`);
    expect(smoke).toBeLessThan(DEPLOY.indexOf("== 0. замок выкатки"));
  });

  test("провал смоука останавливает выкатку", () => {
    // Вызов стоит под `if ! …` и в теле — exit. Без этого `set -e` тут не
    // спасает: в условии `if` он как раз отключается.
    const i = DEPLOY.indexOf(`if ! "$REPO_ROOT/${SMOKE_REL}" "$REPO_ROOT"; then`);
    expect(i).toBeGreaterThan(-1);
    expect(DEPLOY.slice(i, i + 300)).toContain("exit 1");
  });

  test("обхода по переменной окружения нет", () => {
    // Фраза «гейт можно пропустить» — это фраза «гейта нет»: пропускают его
    // ровно в тот вечер, когда он бы и сработал.
    const i = DEPLOY.indexOf("--- смоук перед выкаткой");
    const block = DEPLOY.slice(i, DEPLOY.indexOf("== 0. замок выкатки"));
    expect(i).toBeGreaterThan(-1);
    expect(block).not.toMatch(/SKIP_SMOKE|NO_SMOKE|SKIP_TESTS/);
  });
});

describe("шапки не обещают выкатки из CI", () => {
  const SH = readFileSync(SMOKE, "utf8");

  test("смоук называет того, кто его зовёт", () => {
    expect(SH).toContain("deploy/deploy.sh");
    expect(SH).toContain("2026-09-01");
  });

  test("замок описывает выкатку из CI прошедшим временем", () => {
    // Здесь стояло «Выкатывать умеют ДВА независимых пути … workflow
    // .github/workflows/deploy.yml в CI (свой rsync и свой рестарт)».
    // Читатель мог ждать, что push в main доедет до прода сам.
    const flat = LOCK.replace(/«[^»]*»/g, "«»");
    expect(flat).not.toMatch(/умеют ДВА независимых пути/);
    expect(LOCK).toContain("удалён при публичном релизе 2026-09-01");
  });

  test("deploy.sh тоже", () => {
    expect(DEPLOY).not.toMatch(/умеют два независимых пути/);
    expect(DEPLOY).toContain("удалён 2026-09-01");
  });
});
