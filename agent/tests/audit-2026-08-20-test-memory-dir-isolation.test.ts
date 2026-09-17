/**
 * Аудит 2026-08-20: прогон тестов правил живое git-tracked дерево вики.
 *
 * `tests/_db-path.ts` пинил только MEMORY_DB_PATH. Каталог markdown-страниц
 * читался как `process.env.MEMORY_DIR ?? "memory"` (lib/memory.ts) на
 * загрузке модуля, то есть относительно cwd — а санкционированный гейт
 * запускается из `agent/`. Значит все 22 теста, трогающие вики, работали в
 * реальном `agent/memory`, который лежит в гите: `wiki-view.test.ts` каждый
 * прогон удалял закоммиченный `_team/projects/wiki-view-test-page.md`, и
 * `git status` показывал ` D` перед каждым пушем. Пункт 6 pre-push gate такое
 * не ловит, а `git add -A` утащил бы удаление в коммит.
 *
 * На VPS цена выше: cwd юнита — /opt/agent-team, MEMORY_DIR по умолчанию
 * "memory", то есть прогон набора там дописывал бы боевой `_team/log.md`.
 *
 * Тест держит сам инвариант изоляции, а не его следствие.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { wikiWrite, wikiRead } from "../lib/memory.ts";

describe("изоляция вики в тестах", () => {
  test("MEMORY_DIR задан и указывает вне репозитория", () => {
    const dir = process.env.MEMORY_DIR;
    expect(dir).toBeTruthy();
    // Репозиторий — предок cwd прогона (`agent/`). Каталог вики не должен
    // лежать внутри него ни при каком раскладе.
    const repo = resolve(process.cwd(), "..");
    expect(resolve(dir!).startsWith(repo + "/")).toBe(false);
  });

  test("реальный agent/memory не используется под запись", () => {
    const slug = "audit-2026-08-20-isolation-probe";
    wikiWrite({
      scope: "_team",
      slug,
      title: "Isolation probe",
      content: "Страница обязана появиться во временном каталоге, не в репо.",
    });
    expect(wikiRead("_team", slug)).toContain("Isolation probe");
    // В рабочем дереве её быть не должно — иначе прогон гейта грязнит git.
    expect(
      existsSync(resolve(process.cwd(), "memory", "_team", "projects", `${slug}.md`)),
    ).toBe(false);
  });
});
