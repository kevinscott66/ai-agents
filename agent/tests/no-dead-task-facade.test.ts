/**
 * Аудит 2026-08-12: вторая, более слабая дверь к записи задач.
 *
 * В lib/actions.ts жил фасад `doCreateTask` / `doAssignTask` /
 * `doUpdateTaskStatus` / `doRequestReview` / `doCommentTask` — «чистые функции
 * бизнес-операций, гейт появится в C3». Гейт появился в другом месте: живой
 * путь идёт через action-dispatch → lib/dispatch/tasks.ts. Продакшен фасад не
 * звал ни разу (грепом — только tests/c2.test.ts), но выглядел он живым и был
 * заведомо слабее живого пути:
 *
 *  • без `pinnedChatId` — chatId брался из аргументов, то есть задача могла
 *    лечь на чужую доску (ровно та граница арендатора, которую живой хендлер
 *    пинит намеренно);
 *  • без `ownTask` — taskId принимался любой, включая чужой чат;
 *  • без `canonicalAssignee` — «Backend» и «бэкенд» ложились в `assigned_to`
 *    как есть, задача не совпадала ни с одной очередью и не была видна никому
 *    при ok:true (это чинили 2026-08-12 в живом хендлере);
 *  • без проверки, что родитель на той же доске.
 *
 * Прецедент тот же, что у `gatedAction()` (tests/single-gate-invariant.test.ts):
 * мёртвая копия опасна не тем, что исполняется, а тем, что читается как
 * рабочая и однажды будет подключена.
 *
 * Тест структурный намеренно: у мёртвого кода нет поведения, ловить надо
 * появление ВТОРОЙ двери.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LIB = new URL("../lib/", import.meta.url).pathname;

/** Имена мёртвого фасада. Возврат любого из них — возврат проблемы. */
const FACADE_RE =
  /export\s+(?:async\s+)?function\s+(doCreateTask|doAssignTask|doUpdateTaskStatus|doRequestReview|doCommentTask)\b/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("запись задач — одна дверь", () => {
  test("в lib/ нет фасада do*Task мимо dispatch/tasks.ts", () => {
    const offenders: string[] = [];
    for (const file of walk(LIB)) {
      const src = readFileSync(file, "utf8");
      const names = [...src.matchAll(FACADE_RE)].map((m) => m[1]);
      if (names.length) {
        offenders.push(`${file.slice(LIB.length)}: ${names.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("живой путь на месте", () => {
    // Страховка от «удалили лишнее вместе с нужным»: инвариант выше не должен
    // выполняться потому, что задач больше никто не создаёт.
    const src = readFileSync(join(LIB, "dispatch", "tasks.ts"), "utf8");
    expect(src).toContain("export function handleCreateTask");
    expect(src).toContain("export function handleAssignTask");
    expect(src).toContain("export function handleUpdateTaskStatus");
    expect(src).toContain("export function handleRequestReview");
    expect(src).toContain("pinnedChatId");
    expect(src).toContain("canonicalAssignee");
  });
});
