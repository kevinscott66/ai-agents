/**
 * Аудит 2026-08-27 — `return handleX(...)` без `await` уносит отказ мимо аудита.
 *
 * В `dispatchAction` большой switch завёрнут в try/catch, и этот catch —
 * единственное место, где отказ обработчика превращается в `{ok:false,error}`,
 * то есть в строку `agent_actions` со статусом `error`. Но `return promise`
 * внутри `try` завершает блок синхронно: к моменту, когда промис отклонится,
 * try уже закрыт. Отказ уходит наверх, в `dispatchAndAudit` (там `await` стоит
 * ВНЕ try) и дальше в catch `gateOrDispatch`, который пишет в чат
 * «dispatch/audit failed», но в `agent_actions` не пишет НИЧЕГО.
 *
 * Последствие: действие, упавшее по такому пути, невидимо для аудита, для
 * GET_LOGS, для стрима действий в Mini App и для self-diag (оба его блока
 * живут в `dispatchAndAudit`, до которого исполнение не доходит).
 *
 * Дефект уже чинили точечно — для PUBLISH_TO_CHANNEL. Оставались четыре:
 * WRITE_WIKI, LIST_RECENT_MESSAGES, MAC_RUN_CLAUDE, MAC_STOP.
 *
 * Тест статический намеренно. Поведенческий повтор требует отказа ВНЕ
 * внутреннего try конкретного обработчика — своя точка отказа у каждого из
 * четырёх, и такой тест закрывал бы четыре частных случая вместо инварианта.
 * Здесь же проверяется сам инвариант: любой async-обработчик, возвращаемый из
 * switch, возвращается через `await`. Новый обработчик, добавленный без него,
 * упадёт здесь же.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LIB = join(import.meta.dir, "..", "lib");

/** Имена всех `export async function handleX` в `lib/dispatch/**`. */
function asyncHandlerNames(): Set<string> {
  const names = new Set<string>();
  const dir = join(LIB, "dispatch");
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, entry.name), "utf8");
    for (const m of src.matchAll(/export async function (handle\w+)/g)) {
      names.add(m[1]!);
    }
  }
  return names;
}

describe("dispatchAction: async-обработчики возвращаются через await", () => {
  test("ни один `return handleX(` не остался без await", () => {
    const asyncHandlers = asyncHandlerNames();
    expect(asyncHandlers.size).toBeGreaterThan(5);

    const src = readFileSync(join(LIB, "action-dispatch.ts"), "utf8");
    const offenders: string[] = [];
    for (const m of src.matchAll(/return (await )?(handle\w+)\(/g)) {
      const [, awaited, name] = m;
      if (!asyncHandlers.has(name!)) continue; // синхронный обработчик — ок
      if (!awaited) offenders.push(name!);
    }
    expect(offenders).toEqual([]);
  });

  test("четыре обработчика из находки действительно async и действительно await", () => {
    const asyncHandlers = asyncHandlerNames();
    const src = readFileSync(join(LIB, "action-dispatch.ts"), "utf8");
    for (const name of [
      "handleWriteWiki",
      "handleListRecentMessages",
      "handleMacRunClaude",
      "handleMacStop",
      "handlePublishToChannel",
    ]) {
      expect(asyncHandlers.has(name)).toBe(true);
      expect(src.includes(`return await ${name}(`)).toBe(true);
      expect(src.includes(`return ${name}(`)).toBe(false);
    }
  });
});
