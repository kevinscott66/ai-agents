/**
 * Аудит 2026-08-08: деплой затирал рантайм-память агентов.
 *
 * deploy.sh везёт `agent/` → `/opt/agent-team` через `rsync -az` (без --update,
 * без --delete). Всё, что процесс пишет ОТНОСИТЕЛЬНО cwd, приземляется внутрь
 * той же папки — и если такой каталог не исключён, репозиторная версия каждый
 * раз откатывает боевую. Ровно это и происходило с `memory/`: 27 заготовок из
 * бутстрап-коммита ложились поверх накопленных index.md/log.md всех 12 ролей.
 *
 * Тест — не про шелл, а про инвариант «рантайм-каталог не едет как код».
 * Держим его рядом с остальными: без него следующая уборка в списке исключений
 * выглядит безобидной.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEPLOY_SH = readFileSync(
  join(import.meta.dir, "..", "..", "deploy", "deploy.sh"),
  "utf8",
);

/** Тело массива RSYNC_EXCLUDES=( ... ). */
function excludesBlock(): string {
  const m = DEPLOY_SH.match(/RSYNC_EXCLUDES=\(([\s\S]*?)\)/);
  expect(m).not.toBeNull();
  return m![1];
}

/**
 * Каталоги, которые рантайм создаёт под своим cwd. Держим список здесь, а не
 * выводим из кода: тут важно человеческое решение «это состояние, а не код», а
 * оно принимается один раз на каталог.
 *
 *  - data    — SQLite (memory.db + WAL)
 *  - memory  — файловая вики (lib/memory.ts, MEMORY_DIR ?? "memory")
 *  - backups — дампы lib/backup.ts
 *
 * Имена БЕЗ хвостового слэша — это не косметика. `--exclude 'data/'` в rsync
 * совпадает только с каталогом; если `data` на хосте окажется симлинком на
 * отдельный том, шаблон со слэшем мимо, и рантайм уедет под код. `--exclude
 * 'data'` ловит и каталог, и симлинк, и файл. Слэши убраны в a80e9a07.
 */
const RUNTIME_DIRS = ["data", "memory", "backups"];

describe("deploy.sh: рантайм-состояние не перезаписывается кодом", () => {
  const block = excludesBlock();

  for (const dir of RUNTIME_DIRS) {
    test(`${dir} исключён из rsync`, () => {
      expect(block).toContain(`--exclude '${dir}'`);
    });
  }

  test("секреты тоже не едут из репозитория", () => {
    expect(block).toContain("--exclude '.env'");
    expect(block).toContain("--exclude '.env.*'");
  });

  test("rsync без --delete — исключённое на проде остаётся на месте", () => {
    // Если --delete когда-нибудь появится, одних --exclude станет мало:
    // rsync удаляет на приёмнике то, чего нет у источника.
    const rsyncLines = DEPLOY_SH.split("\n").filter(
      (l) => l.includes("rsync") && l.includes("RSYNC_EXCLUDES"),
    );
    expect(rsyncLines.length).toBeGreaterThan(0);
    for (const l of rsyncLines) {
      expect(l).not.toContain("--delete");
    }
  });
});
