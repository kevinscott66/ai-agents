/**
 * Аудит 2026-09-11: сторож координат отвечал «указывает хоть на что-то», и
 * этого не хватило.
 *
 * `audit-2026-09-11-stale-line-coordinates` проверяет, что строка по
 * координате не пуста, и честно пишет в своей докстроке: «Проверить
 * "координата указывает на то, что имел в виду автор" машина не может».
 * Цена этой честности — четыре ссылки, зелёные у того сторожа и при этом
 * протухшие все четыре:
 *
 * - `miniapp/src/lib/admin.ts` посылал за отказом «admin only» при создании
 *   задачи в строку, где стоит рассылка событий подписчикам SSE;
 * - `miniapp/src/lib/labels.ts` посылал за `REQUEST_REVIEW` в абзац про
 *   префикс `dispatch/audit failed:`;
 * - `miniapp/src/pages/Logs.tsx` посылал за шиной `action.executed` внутрь
 *   объявления типа;
 * - `tools/restore-from-backup.ts` обещал по координате текст «в снапшоте нет
 *   таблиц», а там середина докблока `verifySnapshot`.
 *
 * Все четыре теперь называют символ. После этого в боевых деревьях (`lib`,
 * `miniapp/src`, `tools`, `orchestrator`, `mac-daemon`) не осталось НИ ОДНОЙ
 * координаты — значит правило круга 20 («не подгонять номер, убрать номер и
 * назвать символ») можно не только объявить, но и удержать.
 *
 * Что этот сторож НЕ покрывает и покрывать не должен: `tests/**`. Там
 * координат больше сотни, они цитируют место дефекта в разборе аудита, и
 * массовая правка их ради зелёного цвета — это подгонка, а не починка. За
 * ними по-прежнему следит сторож «указывает хоть на что-то», и только он.
 *
 * Он же не проверяет, что названный символ существует: имя символа ломается
 * переименованием, а не вставкой выше по файлу, и ловится обычным
 * grep-сторожем — четыре таких проверки стоят ниже, по одной на каждый
 * исправленный комментарий.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Только боевые деревья: tests/** намеренно вне проверки, см. докстроку. */
const SOURCE_ROOTS = ["lib", "miniapp/src", "tools", "orchestrator", "mac-daemon"];

/** Та же форма ссылки, что у сторожа «указывает хоть на что-то». */
const COORD = /([A-Za-z0-9_./-]+\.(?:tsx?|sh|service|timer|md|example|ya?ml|sql)):(\d+)(?:-(\d+))?/;

/** Только комментарии: в коде такая строка — обычно фикстура стека. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === "fixtures" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");

describe("в боевом коде координат строк не осталось", () => {
  test("ни один комментарий не ссылается номером строки", () => {
    const found: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of walk(root)) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (!COMMENT_LINE.test(line)) return;
          const m = COORD.exec(line);
          if (m) found.push(`${file}:${i + 1} → ${m[0]}`);
        });
      }
    }
    // Починка — назвать символ, а НЕ подогнать номер (правило круга 20).
    expect(found).toEqual([]);
  });

  test("проверка смотрит на живое дерево, а не в пустоту", () => {
    const files = SOURCE_ROOTS.flatMap((r) => walk(r));
    expect(files.length).toBeGreaterThan(100);
  });
});

describe("четыре исправленных комментария называют существующие символы", () => {
  test("admin.ts: отказ обеих ручек идёт через requireAdmin", () => {
    expect(read("miniapp/src/lib/admin.ts")).toContain("`requireAdmin(user)`");
    const server = read("lib/miniapp-server.ts");
    expect(server).toContain("function requireAdmin(user: MiniAppUser)");
    expect(server).toContain('json({ error: "admin only" }, 403)');
  });

  test("labels.ts: awaiting_review выставляет handleRequestReview", () => {
    expect(read("miniapp/src/lib/labels.ts")).toContain("`handleRequestReview`");
    const tasks = read("lib/dispatch/tasks.ts");
    expect(tasks).toContain("export function handleRequestReview(");
    expect(tasks).toContain('updateTaskStatus(payload.taskId, "awaiting_review")');
  });

  test("Logs.tsx: action.executed шлёт emitActionEvents", () => {
    expect(read("miniapp/src/pages/Logs.tsx")).toContain("`emitActionEvents`");
    const audit = read("lib/audit.ts");
    expect(audit).toContain("export function emitActionEvents(");
    expect(audit).toContain('busEmit("action.executed"');
  });

  test("restore-from-backup.ts: verifySnapshot бросает названный текст", () => {
    expect(read("tools/restore-from-backup.ts")).toContain(
      "`verifySnapshot` в\n        // lib/backup.ts бросает «в снапшоте нет таблиц»",
    );
    const backup = read("lib/backup.ts");
    expect(backup).toContain("function verifySnapshot(");
    expect(backup).toContain('throw new Error("в снапшоте нет таблиц")');
  });
});
