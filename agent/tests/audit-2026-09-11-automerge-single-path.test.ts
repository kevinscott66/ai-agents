/**
 * Аудит 2026-09-11, круг 48: шапка `isRiskyPath` обещала подстраховку, которой
 * нет с публичного релиза.
 *
 * Путей автомержа было два. Оркестраторский — `isAutoMergeable` в
 * lib/dispatch/github.ts, чёрный список по построению. И воркфлоу
 * `.github/workflows/auto-merge.yml`, белый: `case` перечислял безопасное,
 * `*)` отсекал всё прочее. Второй устроен строже, и вся шапка первого написана
 * с оглядкой на него: «опасно, когда чёрный список пускает то, что белый бы не
 * пустил».
 *
 * Воркфлоу удалён при публичном релизе 2026-09-01. `case` уцелел в
 * `.github/scripts/automerge-filter.sh` — его гоняют тесты, — но запускать его
 * стало нечему: ни один файл в `.github/workflows/` о нём не упоминает. Шапка
 * `isRiskyPath` при этом продолжала говорить о втором пути в настоящем
 * времени.
 *
 * Почему это не косметика. Читатель, решающий, можно ли добавить строку в
 * белый список, мерит цену ошибки по тому, что написано: «если ошибусь, PR
 * остановит воркфлоу». С 2026-09-01 не остановит ничего — функция стала
 * единственным гейтом. Ровно в этот зазор и провалился `agent/memory/**`
 * (см. tests/pr-risky-paths-allowlist.test.ts): классификатор пускал, «белый
 * список» не пускал, и односторонность расхождения никого не разбудила,
 * потому что вторая сторона уже не исполнялась.
 *
 * Тут же — сторож на призрачные пути. Обратные кавычки вокруг имени файла
 * обещают, что файл найдётся, ровно как кавычки вокруг символа (круг 22).
 * В шапке этого модуля таких обещаний было два, и оба пустые:
 * `.github/workflows/auto-merge.yml` и `agent/lib/README.md` — файл, под
 * который писали исключение для markdown и которого в репозитории нет.
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const SRC = readFileSync(join(REPO, "agent", "lib", "dispatch", "github.ts"), "utf8");
const WF_DIR = join(REPO, ".github", "workflows");

const tracked = new Set(
  spawnSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" }).stdout.split("\n").filter(Boolean),
);

/** Воркфлоу, которые запускают скрипт-фильтр. Пусто — значит фильтр не исполняется. */
function workflowsCallingFilter(): string[] {
  return readdirSync(WF_DIR)
    .filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))
    .filter((n) => readFileSync(join(WF_DIR, n), "utf8").includes("automerge-filter"));
}

/** Шапка разбита переносами и звёздочками — утверждения про текст, а не про раскладку. */
const FLAT = SRC.replace(/^\s*\*/gm, "").replace(/\s+/g, " ");
/**
 * То же, но без цитат в «ёлочках». Абзац про мёртвый гейт цитирует прежнюю
 * формулировку — она обязана остаться читаемой, иначе непонятно, что чинили.
 * Сторож на настоящее время смотрит на собственную речь модуля, не на цитату.
 */
const FLAT_NO_QUOTES = FLAT.replace(/«[^»]*»/g, "«»");

describe("второй путь автомержа описан так, как он есть", () => {
  test("предпосылка: воркфлоу автомержа в репозитории нет", () => {
    expect(existsSync(WF_DIR)).toBe(true);
    expect(existsSync(join(WF_DIR, "auto-merge.yml"))).toBe(false);
    // Скрипт с политикой остался и по-прежнему проверяется тестами.
    expect(tracked.has(".github/scripts/automerge-filter.sh")).toBe(true);
  });

  test("шапка признаёт то, что показывает дерево", () => {
    const wired = workflowsCallingFilter();
    // Утверждение двустороннее: вернётся воркфлоу — упадёт этот тест, а не
    // следующий аудит через полгода.
    expect(FLAT.includes("не вызывается больше ничем")).toBe(wired.length === 0);
    if (wired.length === 0) {
      expect(FLAT).toContain("ЕДИНСТВЕННЫЙ гейт автомержа");
      expect(FLAT).toContain("2026-09-01");
    }
  });

  test("в настоящем времени о втором пути не говорят", () => {
    // Формы, которые и вводили в заблуждение: они утверждают, что воркфлоу
    // сейчас что-то делает. Про мёртвый гейт пишут прошедшим временем.
    expect(FLAT_NO_QUOTES).not.toMatch(/воркфлоу (отсекает|перечисляет|спрашивает|пускает|остановит)/);
    expect(FLAT_NO_QUOTES).not.toMatch(/анти-список воркфлоу/);
    // А цитата прежней формулировки — на месте: без неё абзац объясняет
    // починку словами, которых читатель нигде не видел.
    expect(FLAT).toContain("белый список воркфлоу не пустил бы");
  });
});

describe("уцелевший файл политики не выдаёт себя за гейт", () => {
  const SH = readFileSync(join(REPO, ".github", "scripts", "automerge-filter.sh"), "utf8");

  test("шапка скрипта говорит, что его никто не запускает", () => {
    expect(workflowsCallingFilter()).toEqual([]);
    expect(SH).toContain("НИЧЕГО не решает");
    expect(SH).toContain("agent/lib/dispatch/github.ts");
  });

  test("список безопасных путей сверяют с живой функцией, а не с удалённой шапкой", () => {
    // Была живая инструкция сопровождающему: «совпадать с шапкой
    // auto-merge.yml». Шапки нет — значит инструкция отправляла сверять
    // список в никуда, и разойтись он мог молча.
    const i = SH.indexOf("# Безопасные пути.");
    expect(i).toBeGreaterThan(-1);
    const block = SH.slice(i, SH.indexOf("is_safe_path()", i));
    expect(block).toContain("isAutoMergeable");
    expect(block.replace(/«[^»]*»/g, "«»")).not.toContain("шапкой auto-merge.yml");
  });
});

describe("призрачных путей в шапке не осталось", () => {
  /** Путь файла в обратных кавычках — то же обещание, что и имя символа. */
  function backtickedPaths(text: string): string[] {
    const out = new Set<string>();
    const re = /`([A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+\.(?:ts|tsx|sh|md|yml|yaml|json))`/g;
    for (const m of text.matchAll(re)) out.add(m[1]!);
    return [...out];
  }

  test("сбор имён работает — иначе сторож молчит ни о чём", () => {
    expect(backtickedPaths(SRC).length).toBeGreaterThan(3);
    expect(backtickedPaths(SRC)).toContain(".github/scripts/automerge-filter.sh");
  });

  test("каждый названный файл существует, кроме одного намеренного", () => {
    const missing = backtickedPaths(SRC).filter(
      (p) => !tracked.has(p) && !existsSync(join(REPO, p)),
    );
    // `.claude/settings.json` назван именно потому, что его в репо НЕТ: шапка
    // объясняет, что PR, который его добавит, классификатор не остановит.
    // Набор пришпилен целиком, чтобы следующий призрак пришлось вносить руками.
    expect(missing).toEqual([".claude/settings.json"]);
    expect(SRC).toContain("Файла в репо нет");
  });
});
