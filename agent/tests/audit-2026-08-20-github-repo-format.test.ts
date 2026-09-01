/**
 * Аудит 2026-08-20: шапка github.ts обещает «no SSRF/probing», но формат
 * GITHUB_REPO не проверялся, а значение шло в ПУТЬ URL как есть. `?` в нём
 * открывает query-строку и уводит запрос на другой эндпоинт; `..` схлопывает
 * путь вверх. Оба случая GitHub отдаёт с кодом 200, шейперы молча возвращают
 * [], и агент рапортует «CI чист» вместо ошибки.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { repo, shapeRuns, shapePRs, shapeCommits } from "../lib/github.ts";

const ORIG = process.env.GITHUB_REPO;

afterEach(() => {
  if (ORIG === undefined) delete process.env.GITHUB_REPO;
  else process.env.GITHUB_REPO = ORIG;
});

/** Как gh() собирает URL: `${GH_API}/repos/${repo()}${path}`. */
function url(r: string): string {
  return new URL(`https://api.github.com/repos/${r}/actions/runs?per_page=5`)
    .href;
}

describe("repo(): формат owner/repo", () => {
  it("пустой env даёт дефолтный репозиторий", () => {
    delete process.env.GITHUB_REPO;
    expect(repo()).toBe("kevinscott66/ai-agents");
    process.env.GITHUB_REPO = "   ";
    expect(repo()).toBe("kevinscott66/ai-agents");
  });

  it("валидное значение проходит и обрезается по краям", () => {
    process.env.GITHUB_REPO = "  acme/my-repo.js  ";
    expect(repo()).toBe("acme/my-repo.js");
  });

  it("owner/repo с точками и подчёркиваниями допустим", () => {
    process.env.GITHUB_REPO = "acme_org/foo.github.io";
    expect(repo()).toBe("acme_org/foo.github.io");
  });

  for (const bad of [
    "owner/repo?x=1",
    "owner/repo#frag",
    "../../user",
    "owner/../../user",
    "owner/repo/extra",
    // Эти два проходят по одной регулярке (сегменты состоят из разрешённых
    // символов) и требуют отдельного запрета "..": URL-парсер схлопывает их
    // вверх — "a/.." даёт /repos/actions/runs, "../a" даёт /a/actions/runs.
    "a/..",
    "../a",
    "ownerrepo",
    "/repo",
    "owner/",
    "owner/re po",
    "owner/repo\nX-Injected: 1",
    "https://evil.example/owner/repo",
  ]) {
    it(`отвергает ${JSON.stringify(bad)}`, () => {
      process.env.GITHUB_REPO = bad;
      expect(() => repo()).toThrow(/owner\/repo/);
    });
  }

  it("отказ, а не тихий фолбэк: дефолтный репо не подставляется", () => {
    process.env.GITHUB_REPO = "owner/repo?x=1";
    let got: string | null = null;
    try {
      got = repo();
    } catch {
      got = null;
    }
    expect(got).toBeNull();
  });

  it("значение длиннее 100 символов в сегменте отвергается", () => {
    process.env.GITHUB_REPO = `a/${"b".repeat(101)}`;
    expect(() => repo()).toThrow();
  });
});

describe("почему это важно: старое поведение молча ломало отчёт", () => {
  it("'?' в старом виде уводил запрос на /repos/owner/repo", () => {
    // Негативный контроль: так URL собирался бы без валидации.
    expect(url("owner/repo?x=1")).toBe(
      "https://api.github.com/repos/owner/repo?x=1/actions/runs?per_page=5",
    );
    expect(new URL(url("owner/repo?x=1")).pathname).toBe("/repos/owner/repo");
  });

  it("одиночный '..' в сегменте тоже уводил путь вверх", () => {
    // Оба значения состоят только из разрешённых символов и проходят
    // регулярку — их ловит именно явная проверка на "..".
    expect(new URL(url("a/..")).pathname).toBe("/repos/actions/runs");
    expect(new URL(url("../a")).pathname).toBe("/a/actions/runs");
  });

  it("'../..' в старом виде уводил запрос из-под /repos", () => {
    // Запрос ушёл бы на /user — личный эндпоинт токена, а не репозиторий.
    expect(new URL(url("../../user")).pathname).toBe("/user/actions/runs");
  });

  it("ответ не того типа шейперы отдают как пустой успех — потому нужен отказ", () => {
    // Объект репозитория вместо списка runs/pulls/commits.
    const repoObject = { id: 1, full_name: "owner/repo" };
    expect(shapeRuns(repoObject)).toEqual([]);
    expect(shapePRs(repoObject)).toEqual([]);
    expect(shapeCommits(repoObject)).toEqual([]);
  });

  it("валидный репозиторий по-прежнему даёт правильный путь", () => {
    process.env.GITHUB_REPO = "kevinscott66/ai-agents";
    expect(new URL(url(repo())).pathname).toBe(
      "/repos/kevinscott66/ai-agents/actions/runs",
    );
  });
});
