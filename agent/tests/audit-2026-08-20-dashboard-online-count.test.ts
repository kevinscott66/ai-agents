/**
 * «Агенты онлайн 12/12» при двенадцати красных лампах ниже на том же экране.
 *
 * Сводка считала онлайн по `a.status === "running"`, а сервер выставляет это
 * поле одним выражением — `paused ? "paused" : "running"`
 * (`buildAgentsList` в lib/miniapp-server.ts). То есть счётчик мерил не живость, а «не на
 * паузе»: упавший, молчащий, отвалившийся по сети агент всё равно попадал в
 * числитель. Живость лежит отдельно, в `health` (`alive`,
 * `consecutiveFailures`), и ровно её читает `getAgentStatusIndicator` —
 * функция, которая тут же, ниже карточки, рисует лампы. Экран противоречил сам
 * себе: карточка «12/12», под ней двенадцать красных ламп «Агент не отвечает».
 *
 * Чинится не подкруткой условия, а общим источником: счётчик теперь считает то
 * же, что рисует лампа. Разойтись им больше нечем.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import {
  countOnline,
  getAgentStatusIndicator,
} from "../miniapp/src/pages/Dashboard.tsx";
import type { AgentInfo } from "../miniapp/src/lib/types.ts";

function agent(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    key: "backend",
    title: "Backend",
    status: "running",
    paused: false,
    health: { alive: true, lastOkAt: 1, consecutiveFailures: 0 },
    ...over,
  };
}

describe("countOnline", () => {
  test("живой непаузный агент считается", () => {
    expect(countOnline([agent()])).toBe(1);
  });

  test("не отвечающий агент не считается, хотя status = running", () => {
    // Ровно исходный дефект: сервер прислал running, health говорит обратное.
    const dead = agent({ health: { alive: false, lastOkAt: null, consecutiveFailures: 5 } });
    expect(dead.status).toBe("running");
    expect(countOnline([dead])).toBe(0);
  });

  test("не отвечающий без серии ошибок — тоже не онлайн", () => {
    // Стартовое состояние монитора: `alive: false, consecutiveFailures: 0`
    // (lib/health.ts:123-131). Живым агент становится только после первого
    // удачного getMe, а до тех пор — до минуты — он молчит. Проверка на
    // `alive` тут единственная, счётчик ошибок этот случай не ловит.
    const silent = agent({ health: { alive: false, lastOkAt: null, consecutiveFailures: 0 } });
    expect(countOnline([silent])).toBe(0);
    expect(getAgentStatusIndicator(silent).status).toBe("error");
  });

  test("пауза читается раньше живости", () => {
    // Приостановленный агент — это «idle», серая лампа с понятной подсказкой,
    // а не красная «не отвечает». Порядок проверок в лампе смысловой: пауза —
    // осознанное решение человека, и подменять её отчётом об отказе нельзя.
    const paused = agent({ paused: true, health: { alive: false, lastOkAt: null, consecutiveFailures: 7 } });
    const ind = getAgentStatusIndicator(paused);
    expect(ind.status).toBe("idle");
    expect(ind.tooltip).toContain("приостановлен");
    expect(countOnline([paused])).toBe(0);
  });

  test("агент без health не считается", () => {
    // health = null до первого тика монитора и когда монитор не поднят вовсе.
    // Лампа в этом случае красная — счётчик обязан говорить то же самое.
    expect(countOnline([agent({ health: null })])).toBe(0);
  });

  test("агент на паузе не считается", () => {
    expect(countOnline([agent({ paused: true, status: "paused" })])).toBe(0);
  });

  test("живой, но с серией ошибок — не онлайн", () => {
    // > 3 подряд лампа красит жёлтым («blocked»), а не зелёным.
    const flaky = agent({ health: { alive: true, lastOkAt: 1, consecutiveFailures: 4 } });
    expect(countOnline([flaky])).toBe(0);
    const ok = agent({ health: { alive: true, lastOkAt: 1, consecutiveFailures: 3 } });
    expect(countOnline([ok])).toBe(1);
  });

  test("счётчик совпадает с числом зелёных ламп на любом наборе", () => {
    const list = [
      agent({ key: "a" }),
      agent({ key: "b", paused: true, status: "paused" }),
      agent({ key: "c", health: { alive: false, lastOkAt: null, consecutiveFailures: 9 } }),
      agent({ key: "d", health: null }),
      agent({ key: "e", health: { alive: true, lastOkAt: 1, consecutiveFailures: 4 } }),
      agent({ key: "f" }),
    ];
    const green = list.filter((a) => getAgentStatusIndicator(a).status === "online").length;
    expect(countOnline(list)).toBe(green);
    expect(green).toBe(2);
  });

  test("пустой список — ноль, а не падение", () => {
    expect(countOnline([])).toBe(0);
  });
});

describe("проводка Dashboard.tsx", () => {
  const RAW = readFileSync(
    new URL("../miniapp/src/pages/Dashboard.tsx", import.meta.url),
    "utf8",
  );
  // Комментарии цитируют старый код (в том числе тот самый фильтр), поэтому
  // проверять надо исполняемый текст, иначе тест ловит собственную докстроку.
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("карточка считает через countOnline", () => {
    expect(SRC).toContain("countOnline(agents)");
  });

  test("своей копии условия «онлайн» в файле не осталось", () => {
    // Счётчик не имеет права фильтровать по `status` сам: это поле про паузу,
    // а не про живость.
    expect(SRC).not.toMatch(/agents\s*\.filter\([^)]*\.status\b/);
    // Само сравнение со "running" остаётся ровно одно — внутри лампы.
    expect(SRC.split('.status === "running"').length - 1).toBe(1);
  });
});
