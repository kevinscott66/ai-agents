/**
 * Аудит 2026-09-11, круг 30: CHANGE_AGENT_STATUS писал в журнал переход,
 * которого не было.
 *
 * `old.autonomy_mode` снимался с РАЗРЕШЕНИЯ области — `getAutonomy(chatId,
 * target)`, — а `new.autonomy_mode` считался как `payload.new_autonomy_mode ??
 * old`, то есть как намерение. В одной строке диффа сравнивались два разных
 * понятия.
 *
 * Расходятся они на стоп-кране чата: `getAutonomy` читает строку
 * `scope='chat', mode='locked'` РАНЬШЕ agent-строки и возвращает из неё, а
 * пишет хендлер именно agent-строку. Владелец дёрнул стоп-кран в чате, perm
 * перевёл роль в `auto` — карточка и `agent_actions` показывали `locked →
 * auto` со `status:"ok"`, а в этом чате роль оставалась `locked`.
 *
 * Отказывать в действии было бы неверно: agent-строка глобальна и в остальных
 * чатах действует. Поэтому проверяется отчётность — что дифф описывает
 * фактический эффект, а разошедшаяся просьба не замалчивается.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { handleChangeAgentStatus } from "../lib/dispatch/agent-status.ts";
import { getAutonomy, setAutonomy } from "../lib/permissions.ts";
import { db } from "../lib/db.ts";
import { cleanupChat } from "./_helpers.ts";

const CHAT = -1_000_9312;
const TARGET = "smm";

function clearModes(): void {
  db.prepare(`DELETE FROM autonomy_modes WHERE scope = 'chat' AND scope_id = ?`).run(
    String(CHAT),
  );
  db.prepare(`DELETE FROM autonomy_modes WHERE scope = 'agent' AND scope_id = ?`).run(
    TARGET,
  );
}

beforeEach(clearModes);
afterEach(() => {
  clearModes();
  cleanupChat(CHAT, "perm");
});

describe("дифф описывает эффект, а не намерение", () => {
  test("под стоп-краном чата `new` показывает действующий режим", () => {
    setAutonomy("chat", String(CHAT), "locked");

    const res = handleChangeAgentStatus(
      {
        target_agent_key: TARGET,
        new_autonomy_mode: "auto",
        reason: "проверка расхождения просьбы и эффекта",
      } as any,
      { agentKey: "perm", chatId: CHAT },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // До правки здесь было "auto" — при том что getAutonomy отдаёт "locked".
    expect(res.result.new.autonomy_mode).toBe(getAutonomy(CHAT, TARGET));
    expect(res.result.new.autonomy_mode).toBe("locked");
  });

  test("разошедшаяся просьба названа отдельно, а не потеряна", () => {
    setAutonomy("chat", String(CHAT), "locked");

    const res = handleChangeAgentStatus(
      {
        target_agent_key: TARGET,
        new_autonomy_mode: "auto",
        reason: "проверка расхождения просьбы и эффекта",
      } as any,
      { agentKey: "perm", chatId: CHAT },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.requested_autonomy_mode).toBe("auto");
  });

  test("запись всё-таки происходит: в незапертом чате режим тот, что просили", () => {
    // Это и есть довод против отказа в действии: agent-строка глобальна.
    setAutonomy("chat", String(CHAT), "locked");
    handleChangeAgentStatus(
      {
        target_agent_key: TARGET,
        new_autonomy_mode: "auto",
        reason: "проверка расхождения просьбы и эффекта",
      } as any,
      { agentKey: "perm", chatId: CHAT },
    );

    const OTHER = CHAT - 1;
    expect(getAutonomy(OTHER, TARGET)).toBe("auto");
  });

  test("без стоп-крана дифф прежний и лишнего поля нет", () => {
    const res = handleChangeAgentStatus(
      {
        target_agent_key: TARGET,
        new_autonomy_mode: "manual",
        reason: "обычный путь без стоп-крана",
      } as any,
      { agentKey: "perm", chatId: CHAT },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.new.autonomy_mode).toBe("manual");
    // Поле появляется только при расхождении — иначе оно было бы шумом в
    // каждой строке аудита.
    expect(res.result.requested_autonomy_mode).toBeUndefined();
  });

  test("строка аудита несёт тот же режим, что и ответ", () => {
    setAutonomy("chat", String(CHAT), "locked");
    handleChangeAgentStatus(
      {
        target_agent_key: TARGET,
        new_autonomy_mode: "auto",
        reason: "проверка расхождения просьбы и эффекта",
      } as any,
      { agentKey: "perm", chatId: CHAT },
    );

    const row = db
      .prepare(
        `SELECT payload FROM agent_actions
         WHERE chat_id = ? AND action_type = 'CHANGE_AGENT_STATUS'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(CHAT) as { payload: string } | undefined;
    expect(row).toBeDefined();
    const p = JSON.parse(row!.payload);
    expect(p.new.autonomy_mode).toBe("locked");
    expect(p.requested_autonomy_mode).toBe("auto");
  });
});
