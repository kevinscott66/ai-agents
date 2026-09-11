/**
 * Аудит 2026-08-20: `/autonomy locked` молча не действовал на агентов,
 * у которых есть своя строка автономии.
 *
 * `locked` — не «ещё один режим в лесенке», а стоп-кран владельца; так его
 * называют оба места, где он проверяется: `tools-schema.ts:845` («стоп-кран
 * владельца на чат») и `evaluateGate` в `permissions.ts`. Но `getAutonomy` был
 * first-match-wins: agent-строка возвращалась сразу, chat-строка читалась
 * только при её отсутствии, а правила «побеждает самое строгое» не было
 * нигде.
 *
 * Отсюда сценарий, в котором стоп-кран есть, а стопа нет:
 *
 *   1. владелец ставит `smm` режим `auto` — через Mini App
 *      (ручка `POST /api/autonomy` в miniapp-server.ts) или одобренный
 *      CHANGE_AGENT_STATUS (`dispatch/agent-status.ts`); оба пути боевые, не
 *      тестовые. Круг 51: у первой ссылки стоял номер строки, и он указывал
 *      не на ту ручку уже до того, как соседняя правка сдвинула файл ещё раз;
 *      правило прежнее — не подгонять номер, а назвать маршрут;
 *   2. в чате что-то идёт не так → `/autonomy locked`;
 *   3. `cmdAutonomy` умеет писать ТОЛЬКО chat-scope (см. `cmdAutonomy` в
 *      lib/commands.ts);
 *   4. для `smm` возвращается `auto`, и всё с `requires_approval = 0`
 *      продолжает исполняться в «заблокированном» чате без человека.
 *
 * Хуже всего обратная связь: `cmdAutonomy` без аргумента читает
 * `getAutonomy(chatId)` БЕЗ agentKey, то есть владельцу показывалось честное
 * «locked» — режим, которого для этого агента не существует.
 *
 * Инвариант: chat=`locked` не перекрывается agent-строкой. Остальной приоритет
 * (agent → chat → global) не меняется — agent-строка на то и заводится, чтобы
 * дать одному агенту режим мягче или строже чатового.
 *
 * Правило намеренно НЕ распространено на global=`locked`: глобальная строка —
 * это дефолт для чатов (сид миграции 003 — `semi_auto`), и её перекрываемость
 * записана и в `.claude/memory/procedures/autonomy-modes.md`, и в
 * `t200-autonomy-modes.test.ts` («global=locked but chat override=auto →
 * allow»). Разворачивать это решение аудит не вправе — здесь чинится ровно
 * та дыра, где стоп-кран владельца не срабатывал.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { getAutonomy, setAutonomy, evaluateGate } from "../lib/permissions.ts";
import { db } from "../lib/db.ts";

const AGENT = "autonomy_precedence_probe";
const CHAT = -100_880_201;
const OTHER_CHAT = -100_880_202;

/** Глобальный режим на время файла не трогаем — его чинит `restoreGlobal`. */
const savedGlobal = (
  db
    .prepare(`SELECT mode FROM autonomy_modes WHERE scope='global' AND scope_id='*'`)
    .get() as { mode: string } | undefined
)?.mode;

function clearScoped(): void {
  db.prepare(`DELETE FROM autonomy_modes WHERE scope='agent' AND scope_id=?`).run(AGENT);
  db.prepare(`DELETE FROM autonomy_modes WHERE scope='chat' AND scope_id IN (?,?)`).run(
    String(CHAT),
    String(OTHER_CHAT),
  );
}

function restoreGlobal(): void {
  if (savedGlobal) setAutonomy("global", "*", savedGlobal as never);
}

beforeEach(() => {
  clearScoped();
  restoreGlobal();
});

afterAll(() => {
  clearScoped();
  restoreGlobal();
});

describe("стоп-кран чата не перекрывается agent-строкой", () => {
  test("chat=locked + agent=auto → locked", () => {
    setAutonomy("agent", AGENT, "auto");
    setAutonomy("chat", String(CHAT), "locked");
    expect(getAutonomy(CHAT, AGENT)).toBe("locked");
  });

  test("chat=locked + agent=semi_auto → locked", () => {
    setAutonomy("agent", AGENT, "semi_auto");
    setAutonomy("chat", String(CHAT), "locked");
    expect(getAutonomy(CHAT, AGENT)).toBe("locked");
  });

  test("chat=locked действует и без agent-строки (не регресс)", () => {
    setAutonomy("chat", String(CHAT), "locked");
    expect(getAutonomy(CHAT, AGENT)).toBe("locked");
  });

  test("agent=locked действует и при chat=auto (не регресс)", () => {
    setAutonomy("agent", AGENT, "locked");
    setAutonomy("chat", String(CHAT), "auto");
    expect(getAutonomy(CHAT, AGENT)).toBe("locked");
  });

  test("стоп-кран не расползается на соседний чат", () => {
    setAutonomy("chat", String(CHAT), "locked");
    setAutonomy("chat", String(OTHER_CHAT), "auto");
    expect(getAutonomy(OTHER_CHAT, AGENT)).toBe("auto");
  });
});

describe("документированный приоритет scope'ов не тронут", () => {
  test("global=locked остаётся перекрываемым чатом — решение T-200", () => {
    setAutonomy("global", "*", "locked");
    setAutonomy("chat", String(CHAT), "auto");
    expect(getAutonomy(CHAT)).toBe("auto");
  });

  test("agent=auto перекрывает chat=semi_auto — ради этого agent-строка и есть", () => {
    setAutonomy("agent", AGENT, "auto");
    setAutonomy("chat", String(CHAT), "semi_auto");
    expect(getAutonomy(CHAT, AGENT)).toBe("auto");
  });

  test("agent=manual перекрывает chat=auto", () => {
    setAutonomy("agent", AGENT, "manual");
    setAutonomy("chat", String(CHAT), "auto");
    expect(getAutonomy(CHAT, AGENT)).toBe("manual");
  });

  test("chat перекрывает global, когда agent-строки нет", () => {
    setAutonomy("chat", String(CHAT), "manual");
    setAutonomy("global", "*", "auto");
    expect(getAutonomy(CHAT, AGENT)).toBe("manual");
  });

  test("без строк вообще — глобальный дефолт", () => {
    setAutonomy("global", "*", "semi_auto");
    expect(getAutonomy(CHAT, AGENT)).toBe("semi_auto");
  });
});

/**
 * Гейт проверяется на НАСТОЯЩЕЙ роли: до автономии `evaluateGate` успевает
 * отсеять неизвестный ключ через `isToolExposedToRole`, так что синтетический
 * probe дал бы «deny» не по той причине и тест ничего бы не доказывал.
 * Строку `smm` сохраняем и возвращаем как была.
 */
const REAL = "smm";
const savedRealAgent = (
  db
    .prepare(`SELECT mode FROM autonomy_modes WHERE scope='agent' AND scope_id=?`)
    .get(REAL) as { mode: string } | undefined
)?.mode;

describe("гейт действий действительно отказывает", () => {
  test("agent=auto + chat=locked → deny, а не исполнение", () => {
    setAutonomy("agent", REAL, "auto");
    setAutonomy("chat", String(CHAT), "locked");
    try {
      const d = evaluateGate({
        agentKey: REAL,
        chatId: CHAT,
        actionType: "SEND_MESSAGE",
      });
      expect(d.decision).toBe("deny");
      // Сужение типа — `reason` есть только у deny/approval (как в t200).
      if (d.decision === "deny") expect(d.reason).toBe("autonomy locked");
    } finally {
      if (savedRealAgent) {
        setAutonomy("agent", REAL, savedRealAgent as never);
      } else {
        db.prepare(
          `DELETE FROM autonomy_modes WHERE scope='agent' AND scope_id=?`,
        ).run(REAL);
      }
    }
  });
});
