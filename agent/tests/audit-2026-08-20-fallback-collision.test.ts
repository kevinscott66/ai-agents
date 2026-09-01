/**
 * Аудит 2026-08-20 — фолбэк отдавал кандидата, которого вызывающий отвергнет.
 *
 * `pickAvailableAgent` возвращала ПЕРВОГО доступного, а два правила, решающие,
 * годится ли он («cannot delegate to self» и проверки цепочки), живут у
 * вызывающего и срабатывают ПОСЛЕ выбора. Второго шанса не было.
 *
 * Каждый список фолбэков собран из естественной пары, поэтому первый фолбэк —
 * ровно та роль, которая чаще всего и есть отправитель: copy↔smm, backend↔tgdev,
 * design↔frontend, pm↔product. Задача умирала с сообщением «делегировал сам
 * себе», которого агент не делал, а годный кандидат из того же списка не
 * пробовался никогда.
 */
import { describe, test, expect } from "bun:test";
import {
  pickAvailableAgent,
  ROLE_FALLBACKS,
  type AvailabilityDeps,
} from "../lib/role-skills.ts";

/** Доступны все, кроме перечисленных. Health не трогаем. */
function deps(down: string[]): AvailabilityDeps {
  const set = new Set(down);
  return { isStopped: (k) => set.has(k), getHealth: () => undefined };
}

describe("аудит 2026-08-20: фолбэк пропускает столкнувшегося кандидата", () => {
  test("отправитель — первый фолбэк цели: берём следующего", () => {
    // smm выполняет задачу и делегирует в copy; copy на паузе.
    // ROLE_FALLBACKS.copy = ["smm", "design"] — первый и есть отправитель.
    const picked = pickAvailableAgent("copy", deps(["copy"]), ["smm"]);
    expect(picked).toEqual({ role: "design", reroutedFrom: "copy" });
  });

  test("без списка avoid поведение прежнее — берётся первый доступный", () => {
    expect(pickAvailableAgent("copy", deps(["copy"]))).toEqual({
      role: "smm",
      reroutedFrom: "copy",
    });
  });

  test("все десять естественных пар перестали самоблокироваться", () => {
    // Для каждой цели, чей первый фолбэк сам может оказаться отправителем.
    const pairs: Array<[string, string]> = [];
    for (const [target, list] of Object.entries(ROLE_FALLBACKS)) {
      if (list.length >= 2) pairs.push([target, list[0]!]);
    }
    expect(pairs.length).toBeGreaterThanOrEqual(8);
    for (const [target, sender] of pairs) {
      const picked = pickAvailableAgent(target, deps([target]), [sender]);
      expect(picked).not.toBeNull();
      expect(picked!.role).not.toBe(sender);
      expect(picked!.reroutedFrom).toBe(target);
    }
  });

  test("роль из цепочки пропускается так же, как отправитель", () => {
    // Цепочка [backend, qa]; qa делегирует в tgdev, tgdev лежит.
    // ROLE_FALLBACKS.tgdev = ["backend", "aieng"] — backend уже в цепочке.
    const picked = pickAvailableAgent("tgdev", deps(["tgdev"]), ["qa", "backend"]);
    expect(picked).toEqual({ role: "aieng", reroutedFrom: "tgdev" });
  });

  test("чистых нет — возвращаем столкнувшегося, а не null", () => {
    // Иначе штатный отказ «cannot delegate to self» выродился бы в безликий
    // no_available_agent, который никем не классифицируется (diagnostic.ts).
    const picked = pickAvailableAgent("copy", deps(["copy", "design"]), ["smm"]);
    expect(picked).toEqual({ role: "smm", reroutedFrom: "copy" });
  });

  test("никого доступного вовсе — по-прежнему null", () => {
    expect(
      pickAvailableAgent("copy", deps(["copy", "smm", "design"]), ["smm"]),
    ).toBeNull();
  });

  test("цель доступна — avoid её не касается", () => {
    // Делегирование тому, кто уже в цепочке, — пинг-понг. Отказать на нём
    // правильно, объезжать фолбэком — нет: решение принимает вызывающий.
    expect(pickAvailableAgent("copy", deps([]), ["copy", "smm"])).toEqual({
      role: "copy",
    });
  });

  test("у роли без фолбэков ничего не меняется", () => {
    expect(ROLE_FALLBACKS.orchestrator).toEqual([]);
    expect(pickAvailableAgent("orchestrator", deps(["orchestrator"]), ["pm"])).toBeNull();
  });

  test("avoid не мутирует список фолбэков", () => {
    const before = [...ROLE_FALLBACKS.copy!];
    pickAvailableAgent("copy", deps(["copy"]), ["smm", "design"]);
    expect(ROLE_FALLBACKS.copy).toEqual(before);
  });

  test("порядок фолбэков сохраняется среди чистых кандидатов", () => {
    // aieng: ["backend", "tgdev"] — если исключён tgdev, всё равно backend.
    expect(pickAvailableAgent("aieng", deps(["aieng"]), ["tgdev"])).toEqual({
      role: "backend",
      reroutedFrom: "aieng",
    });
  });
});
