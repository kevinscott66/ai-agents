/**
 * Dependency-free side-effect module: pins MEMORY_DB_PATH and MEMORY_DIR to a
 * throwaway temp location BEFORE any module that opens the DB or the wiki is
 * imported.
 *
 * This MUST be imported first (and must not import anything that transitively
 * opens the DB), because ES module imports are evaluated depth-first in source
 * order: importing this before `lib/db.ts` guarantees the env var is set by the
 * time `db.ts` reads it at module-eval time.
 *
 * See tests/_setup.ts (the registered preload) for the lifecycle hooks.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdirSync } from "node:fs";

// Honour an explicit override so a developer can pin a path for debugging.
if (!process.env.MEMORY_DB_PATH) {
  const dir = join(tmpdir(), `agent-test-db-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  process.env.MEMORY_DB_PATH = join(dir, "memory.db");

  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort: temp dir is reclaimed by the OS anyway */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
}

// Аудит 2026-08-20: до сих пор пинилась только БД. Каталог markdown-страниц
// вики брался как `process.env.MEMORY_DIR ?? "memory"` (lib/memory.ts) на
// загрузке модуля, то есть относительно cwd прогона — а санкционированный
// гейт запускается из `agent/`, значит тесты работали в РЕАЛЬНОМ `agent/memory`,
// который лежит в гите.
//
// Наблюдаемое следствие: `tests/wiki-view.test.ts` в afterAll делает rmSync по
// `memory/_team/projects/wiki-view-test-page.md`, и после каждого прогона
// `git status` показывал ` D` на закоммиченный файл. Пункт 6 pre-push gate это
// не ловит, а `git add -A` утащил бы удаление в коммит.
//
// На VPS дороже: cwd юнита — /opt/agent-team, MEMORY_DIR по умолчанию
// "memory", то есть прогон набора там дописывал бы боевой `_team/log.md` и
// удалял страницы из `_team/projects/`.
//
// Пинится отдельным блоком (не внутри условия выше): явный MEMORY_DB_PATH для
// отладки не должен оставлять вики непринятой.
if (!process.env.MEMORY_DIR) {
  const wiki = join(
    tmpdir(),
    `agent-test-wiki-${process.pid}-${Date.now()}`,
    "memory",
  );
  mkdirSync(wiki, { recursive: true });
  process.env.MEMORY_DIR = wiki;

  const cleanupWiki = () => {
    try {
      rmSync(wiki, { recursive: true, force: true });
    } catch {
      /* best-effort: temp dir is reclaimed by the OS anyway */
    }
  };
  process.on("exit", cleanupWiki);
}
