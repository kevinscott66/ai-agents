/**
 * Аудит 2026-08-11: выключенный агент считался доступным для делегирования.
 *
 * `CHANGE_AGENT_STATUS` — действие только для `perm`, всегда под апрувом
 * владельца, и заявлено оно как «агент полностью инертен» (комментарий у
 * isAgentDisabled). Аудит 2026-08-09 свёл `paused` и `disabled` в один
 * предикат `agentStopReason` ровно затем, чтобы «почти везде проверяли только
 * первый флаг» больше не повторилось. Одну копию тогда не заметили:
 * `role-skills.ts` держал собственный предикат паузы, который читал только
 * колонку `paused` (сейчас это поле `isStopped` в `AvailabilityDeps`).
 *
 * А `setAgentStatus` намеренно сохраняет `paused` как есть — значит у
 * выключенного агента он почти всегда 0. Плюс сам процесс бота продолжает
 * поллиться (disabled — это флаг политики, не состояние процесса), поэтому и
 * health-снапшот у него живой. Итог: `pickAvailableAgent` возвращает
 * выключенную роль как доступную и НЕ уходит в фолбэк — тот самый фолбэк,
 * который заведён именно на случай «исполнитель недоступен».
 *
 * Что видел владелец: в чат уходит «🔀 orchestrator → backend: …»
 * (announce стоит до вызова делегата), дальше respondAs видит остановленную
 * цель и возвращает null, задача закрывается `failed / delegate returned empty
 * reply`. Работа не сделана, замена не позвана, доска засоряется — тот же
 * мусор, ради которого писался T-730.
 *
 * Инвариант: доступность спрашивает про ОБА флага, через общий предикат.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { isAgentAvailable, pickAvailableAgent } from "../lib/role-skills.ts";

const TARGET = "backend";
const FIRST_FALLBACK = "tgdev"; // ROLE_FALLBACKS.backend[0]

function setState(agentKey: string, paused: 0 | 1, status: string) {
  db.prepare(
    `INSERT INTO agent_states(agent_key, paused, updated_at, status)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_key) DO UPDATE SET
       paused = excluded.paused,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run(agentKey, paused, Date.now(), status);
}

function clearState(...keys: string[]) {
  for (const k of keys) {
    db.prepare(`DELETE FROM agent_states WHERE agent_key = ?`).run(k);
  }
}

describe("доступность для делегирования знает про disabled, а не только про paused", () => {
  beforeEach(() => clearState(TARGET, FIRST_FALLBACK));
  afterEach(() => clearState(TARGET, FIRST_FALLBACK));

  test("status=disabled при paused=0 → агент недоступен", () => {
    setState(TARGET, 0, "disabled");
    expect(isAgentAvailable(TARGET)).toBe(false);
  });

  test("выключенного не выбирают — уходим в фолбэк", () => {
    setState(TARGET, 0, "disabled");
    const picked = pickAvailableAgent(TARGET);
    expect(picked).not.toBeNull();
    expect(picked!.role).toBe(FIRST_FALLBACK);
    expect(picked!.reroutedFrom).toBe(TARGET);
  });

  test("выключенный фолбэк тоже пропускаем", () => {
    setState(TARGET, 0, "disabled");
    setState(FIRST_FALLBACK, 0, "disabled");
    const picked = pickAvailableAgent(TARGET);
    expect(picked).not.toBeNull();
    // ROLE_FALLBACKS.backend = ["tgdev", "aieng"] — остаётся второй.
    expect(picked!.role).toBe("aieng");
  });

  // Регрессия на исходное поведение: пауза как работала, так и работает.
  test("paused=1 при status=active → недоступен (как и было)", () => {
    setState(TARGET, 1, "active");
    expect(isAgentAvailable(TARGET)).toBe(false);
  });

  test("active и не на паузе → доступен", () => {
    setState(TARGET, 0, "active");
    expect(isAgentAvailable(TARGET)).toBe(true);
    expect(pickAvailableAgent(TARGET)?.role).toBe(TARGET);
    expect(pickAvailableAgent(TARGET)?.reroutedFrom).toBeUndefined();
  });

  test("строки нет вовсе → доступен", () => {
    expect(isAgentAvailable(TARGET)).toBe(true);
  });
});
