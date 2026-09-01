/**
 * Аудит 2026-08-28: два шаблона delabs описаны как работающие, а вызовов нет.
 *
 * `buildActivityRunText` (T-740) — готовый пост «Отработка активностей»:
 * докблок в настоящем времени, 20 строк описания полей в `ActivityEntry`,
 * и ни одного вызова из прода — тулы, которая его печатает, не написали.
 * `lib/site-ingest.ts:256` при этом рассуждает о его выводе как о том, что
 * уходит на публичный сайт.
 *
 * `fitsOneMessage` — мерка «влезает в одно сообщение». Её единственный вызов
 * ушёл 2026-08-21 на `fitsWeeklyCaption`, потому что недельный пост идёт
 * подписью к баннеру. Последний абзац её докблока объясняет, почему НЕ надо
 * резать пункты под подпись в 1000 знаков — то есть спорит ровно с тем, что
 * теперь делает единственный публикатор.
 *
 * Само по себе это не падение: код рабочий и покрыт тестами. Ловушка в том,
 * что докблок читается как описание живого пути, и на нём строят решения.
 * Заметка о статусе — часть кода, поэтому она проверяется, а не подразумевается.
 *
 * Тест-сторож: как только появится продовый вызов, он упадёт — значит, пора
 * снять заметку из докблока (и этот тест).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const AGENT_DIR = join(import.meta.dir, "..");
const SELF = "lib/delabs-post-templates.ts";

/** Не прод: тесты, чужие деревья, сборка, рантайм-данные. */
const SKIP_DIRS = new Set(["node_modules", "dist", "data", "backups", "coverage", ".git", "tests"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Строки кода без комментариев. Обязательно: обе функции упомянуты именно в
 * комментариях (site-ingest.ts:256, weekly-draft.ts:231) — без вычистки тест
 * считал бы упоминание вызовом и молчал бы всегда.
 */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => {
      const s = l.trimStart();
      return !s.startsWith("//") && !s.startsWith("*") && !s.startsWith("/*");
    })
    .join("\n");
}

function prodCallSites(name: string): string[] {
  const re = new RegExp("\\b" + name + "\\s*\\(");
  return walk(AGENT_DIR)
    .map((p) => relative(AGENT_DIR, p))
    .filter((rel) => rel !== SELF && re.test(codeOf(join(AGENT_DIR, rel))))
    .sort();
}

const SRC = readFileSync(join(AGENT_DIR, SELF), "utf8");

describe("вызовов из прода нет", () => {
  test("buildActivityRunText никто не печатает", () => {
    expect(prodCallSites("buildActivityRunText")).toEqual([]);
  });

  test("fitsOneMessage никто не меряет", () => {
    expect(prodCallSites("fitsOneMessage")).toEqual([]);
  });

  test("обход видит прод-код и различает вызов от упоминания", () => {
    // Живая функция того же модуля — контроль, что метод поиска рабочий.
    expect(prodCallSites("buildWeeklyRecapText")).toContain("tools/weekly-draft.ts");
    // А упоминание в комментарии за вызов не считается.
    expect(readFileSync(join(AGENT_DIR, "lib/site-ingest.ts"), "utf8")).toContain(
      "buildActivityRunText",
    );
    expect(prodCallSites("buildActivityRunText")).not.toContain("lib/site-ingest.ts");
  });
});

describe("статус записан в докблоке", () => {
  test("у обеих функций есть заметка аудита 2026-08-28", () => {
    for (const anchor of [
      "T-740. Пост «Отработка активностей»",
      "Влезает ли пост в одно сообщение Telegram",
    ]) {
      const at = SRC.indexOf(anchor);
      expect(at).toBeGreaterThan(0);
      // Заметка идёт внутри того же докблока — до конца комментария.
      const block = SRC.slice(at, SRC.indexOf("*/", at));
      expect(block).toContain("Аудит 2026-08-28");
      expect(block).toContain("audit-2026-08-28-delabs-templates-unused.test.ts");
    }
  });

  test("заметка про мерку называет того, кто занял её место", () => {
    const at = SRC.indexOf("Влезает ли пост в одно сообщение Telegram");
    const block = SRC.slice(at, SRC.indexOf("*/", at));
    expect(block).toContain("fitsWeeklyCaption");
  });
});
