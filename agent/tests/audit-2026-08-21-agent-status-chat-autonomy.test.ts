/**
 * Аудит 2026-08-21 — CHANGE_AGENT_STATUS сообщал режим автономии, которого
 * не было ни в одной строке `autonomy_modes`.
 *
 * `handleChangeAgentStatus` читал прежний режим цели через
 * `getAutonomy(undefined, target)`, то есть выбрасывал chat-скоуп из
 * разрешения. Гейт (`permissions.ts:654`) и inline-тулзы
 * (`tools-schema.ts:845`) читают тот же режим ЧЕРЕЗ `getAutonomy(chatId,
 * agentKey)`, где приоритет agent → chat → global. Когда agent-строки нет, а
 * chat-строка есть (`/autonomy manual` в командном чате — основной
 * пользовательский переключатель, `commands.ts:348`), хендлер проваливался
 * сразу в global и печатал в отчёт и в аудит-строку значение, которое для этой
 * цели в этом чате не действовало.
 *
 * Это не косметика: `new_autonomy_mode` необязателен, и при смене одного
 * только статуса `new.autonomy_mode` берётся из того же неверного `old`. То
 * есть в журнале остаётся «autonomy_mode: semi_auto → semi_auto» ровно в тот
 * момент, когда в чате действует `manual`.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { handleChangeAgentStatus } from "../lib/dispatch/agent-status.ts";
import { setAutonomy, getAutonomy } from "../lib/permissions.ts";
import { db } from "../lib/db.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = 999_703_821;
const TARGET = "smm";

let savedGlobal = saveAutonomy();

function cleanup(): void {
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope = 'chat' AND scope_id = ?`,
  ).run(String(CHAT));
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope = 'agent' AND scope_id = ?`,
  ).run(TARGET);
  db.prepare(`DELETE FROM agent_states WHERE agent_key = ?`).run(TARGET);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT);
}

describe("CHANGE_AGENT_STATUS: прежний режим автономии читается с chat-скоупом", () => {
  beforeEach(() => {
    savedGlobal = saveAutonomy();
    cleanup();
  });
  afterEach(() => {
    cleanup();
    restoreAutonomy(savedGlobal);
  });

  test("chat-строка перекрывает global — и попадает в отчёт как прежнее значение", () => {
    setAutonomy("global", "*", "semi_auto");
    setAutonomy("chat", String(CHAT), "manual");
    // Контроль: именно так режим цели видит гейт.
    expect(getAutonomy(CHAT, TARGET)).toBe("manual");

    const r = handleChangeAgentStatus(
      { target_agent_key: TARGET, new_status: "disabled", reason: "проверка chat-скоупа в отчёте" },
      { agentKey: "perm", chatId: CHAT },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.old.autonomy_mode).toBe("manual");
    // new_autonomy_mode не передан → ничего не писали, значение то же.
    expect(r.result.new.autonomy_mode).toBe("manual");
  });

  test("аудит-строка с диффом несёт тот же режим, а не global", () => {
    setAutonomy("global", "*", "semi_auto");
    setAutonomy("chat", String(CHAT), "locked");

    handleChangeAgentStatus(
      { target_agent_key: TARGET, new_status: "disabled", reason: "проверка chat-скоупа в аудите" },
      { agentKey: "perm", chatId: CHAT },
    );
    const row = db
      .prepare(
        `SELECT payload FROM agent_actions
          WHERE chat_id = ? AND action_type = 'CHANGE_AGENT_STATUS'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(CHAT) as { payload: string } | undefined;
    expect(row).toBeTruthy();
    const p = JSON.parse(row!.payload) as {
      _diff?: boolean;
      old?: { autonomy_mode?: string };
    };
    expect(p._diff).toBe(true);
    expect(p.old?.autonomy_mode).toBe("locked");
  });

  test("agent-строка по-прежнему главнее chat-строки", () => {
    setAutonomy("global", "*", "semi_auto");
    setAutonomy("chat", String(CHAT), "manual");
    setAutonomy("agent", TARGET, "auto");

    const r = handleChangeAgentStatus(
      { target_agent_key: TARGET, new_autonomy_mode: "locked", reason: "приоритет agent над chat" },
      { agentKey: "perm", chatId: CHAT },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.old.autonomy_mode).toBe("auto");
    expect(r.result.new.autonomy_mode).toBe("locked");
  });

  test("без chat- и agent-строк остаётся global", () => {
    setAutonomy("global", "*", "semi_auto");

    const r = handleChangeAgentStatus(
      { target_agent_key: TARGET, new_status: "disabled", reason: "фолбэк на global остаётся" },
      { agentKey: "perm", chatId: CHAT },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.old.autonomy_mode).toBe("semi_auto");
  });
});
