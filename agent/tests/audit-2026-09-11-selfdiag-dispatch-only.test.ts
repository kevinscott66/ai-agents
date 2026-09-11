/**
 * Аудит 2026-09-11: self-diag-ретрай умел назвать dispatch-only действие.
 *
 * `DISPATCH_ONLY_ACTIONS` (lib/permissions.ts) — словарь действий, у которых
 * НЕТ тулы: модель не может позвать их напрямую, и про CREATE_DIAGNOSTIC_TASK
 * там написано «до ветки диспетчера не доходит никто». Это было неправдой.
 *
 * Путь в обход: ход упал → self-healing зовёт aieng → `parseAiengResponse`
 * принимает ЛЮБОЕ имя из `ACTION_TYPES` → ретрай уходит в динамический
 * `dispatchAndAudit(retryAction, …)`. То есть модель, у которой тулы нет,
 * получала её через отчёт о починке. Существующий инвариант
 * tests/audit-2026-08-28-diagnostic-action-unreachable.test.ts этого не ловит:
 * его регексп ищет строковый литерал первым аргументом dispatch*, а здесь
 * передаётся переменная.
 *
 * Дыра закрыта в разборе, а не в гейте: до гейта эта заявка вообще не должна
 * доходить — ретрай вправе называть только то, что модель могла позвать сама.
 */
import { describe, expect, test } from "bun:test";
import { parseAiengResponse } from "../lib/self-diag.ts";
import { ACTION_TYPES, DISPATCH_ONLY_ACTIONS } from "../lib/permissions.ts";

describe("self-diag: ретрай не называет dispatch-only действия", () => {
  test("каждый ключ DISPATCH_ONLY_ACTIONS отвергается разбором", () => {
    const keys = Object.keys(DISPATCH_ONLY_ACTIONS);
    expect(keys.length).toBeGreaterThan(0);
    for (const action of keys) {
      const json = JSON.stringify({ action, payload: { title: "x" }, reason: "r" });
      expect(parseAiengResponse(json)).toBeNull();
    }
  });

  test("CREATE_DIAGNOSTIC_TASK — та самая дыра — отвергается поимённо", () => {
    expect(
      parseAiengResponse(
        '{"action":"CREATE_DIAGNOSTIC_TASK","payload":{"title":"чинись"},"reason":"r"}',
      ),
    ).toBeNull();
  });

  test("все ключи словаря — настоящие ACTION_TYPES, иначе запрет ничего не значит", () => {
    const all = new Set<string>(ACTION_TYPES);
    for (const key of Object.keys(DISPATCH_ONLY_ACTIONS)) {
      expect(all.has(key)).toBe(true);
    }
  });

  test("обычное действие по-прежнему разбирается", () => {
    const r = parseAiengResponse(
      '{"action":"CREATE_TASK","payload":{"title":"почини"},"reason":"повтор"}',
    );
    expect(r).not.toBeNull();
    expect(r?.action).toBe("CREATE_TASK");
    expect(r?.payload).toEqual({ title: "почини" });
  });

  test("giveup не задет запретом", () => {
    const r = parseAiengResponse('{"giveup":true,"reason":"нет прав"}');
    expect(r?.giveup).toBe(true);
  });

  test("запрет не обходится оберткой в ```json и мусором вокруг", () => {
    const wrapped =
      'вот ответ:\n```json\n{"action":"GRANT_PERMISSION","payload":{"agentKey":"smm"}}\n```\n';
    expect(parseAiengResponse(wrapped)).toBeNull();
  });
});
