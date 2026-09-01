/**
 * Одно решение — одна durability-единица (аудит 2026-08-29).
 *
 * Три обработчика, которые запускаются ТОЛЬКО после одобрения человеком,
 * раскладывали последствия этого решения на несколько независимых
 * автокоммитов:
 *
 *  - `handleChangeAgentStatus` — статус агента, режим автономии и строка
 *    аудита;
 *  - `handleUpdateAgentPromptApproved` — отметка «применено» и строка аудита
 *    (а запасная ветка вдобавок делала INSERT и UPDATE двумя записями);
 *  - `handleUpdateAgentPromptRejected` — отметка отказа и запись решения в
 *    журнал.
 *
 * Обрыв между ними оставлял ровно ту половину решения, до которой успели
 * дойти. Худшая из половин — версия промпта с `applied_at = NULL` после
 * применения: она неотличима от живого предложения, ждущего владельца, и
 * следующее одобрение того же текста нашло бы её выборкой по содержимому и
 * проштамповало во второй раз.
 *
 * Тесты воспроизводят обрыв детерминированно: `spyOn(db, "prepare")` роняет
 * ПОСЛЕДНЮЮ запись цепочки, и проверяется, что предыдущие не остались в базе.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { db } from "../lib/db.ts";
import {
  handleChangeAgentStatus,
  getAgentStatus,
} from "../lib/dispatch/agent-status.ts";
import {
  handleUpdateAgentPromptApproved,
  handleUpdateAgentPromptRejected,
  insertPendingAgentPrompt,
} from "../lib/dispatch/agent-prompt.ts";
import { setAutonomy, getAutonomy } from "../lib/permissions.ts";
import { saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const CHAT = 999_703_829;
const TARGET = "smm";
const PROMPT =
  "Ты — SMM DeLabs. Пиши короче, без восклицаний и без эмодзи в заголовках. (проверка атомарности записи)";
const REASON = "проверка атомарности записи";

let saved = saveAutonomy();

/** Роняет первую же подготовку statement'а, попавшего под предикат. */
function breakOn(match: (sql: string) => boolean) {
  const orig = db.prepare.bind(db);
  const spy = spyOn(db, "prepare");
  let fired = false;
  spy.mockImplementation(((sql: string) => {
    if (!fired && match(sql)) {
      fired = true;
      throw new Error("обрыв: последняя запись цепочки не состоялась");
    }
    return orig(sql);
  }) as never);
  return {
    get fired() {
      return fired;
    },
    restore: () => spy.mockRestore(),
  };
}

function cleanup(): void {
  db.prepare(`DELETE FROM agent_states WHERE agent_key = ?`).run(TARGET);
  db.prepare(
    `DELETE FROM autonomy_modes WHERE scope = 'agent' AND scope_id = ?`,
  ).run(TARGET);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT);
  db.prepare(`DELETE FROM audit_logs WHERE chat_id = ?`).run(CHAT);
  db.prepare(`DELETE FROM agent_prompts WHERE agent_key = ? AND reason = ?`).run(
    TARGET,
    REASON,
  );
}

beforeEach(() => {
  saved = saveAutonomy();
  cleanup();
});
afterEach(() => {
  cleanup();
  restoreAutonomy(saved);
});

describe("CHANGE_AGENT_STATUS не оставляет половину решения", () => {
  test("падение аудита откатывает и статус, и режим автономии", () => {
    setAutonomy("global", "*", "semi_auto");
    expect(getAgentStatus(TARGET)).toBe("active");

    const brk = breakOn((sql) => sql.includes("INSERT INTO agent_actions"));
    try {
      expect(() =>
        handleChangeAgentStatus(
          {
            target_agent_key: TARGET,
            new_status: "disabled",
            new_autonomy_mode: "manual",
            reason: REASON,
          },
          { agentKey: "perm", chatId: CHAT },
        ),
      ).toThrow(/обрыв/);
    } finally {
      brk.restore();
    }
    expect(brk.fired).toBe(true);
    expect(getAgentStatus(TARGET)).toBe("active");
    expect(getAutonomy(CHAT, TARGET)).toBe("semi_auto");
  });

  test("без обрыва обе записи и аудит на месте", () => {
    setAutonomy("global", "*", "semi_auto");
    const r = handleChangeAgentStatus(
      {
        target_agent_key: TARGET,
        new_status: "disabled",
        new_autonomy_mode: "manual",
        reason: REASON,
      },
      { agentKey: "perm", chatId: CHAT },
    );
    expect(r.ok).toBe(true);
    expect(getAgentStatus(TARGET)).toBe("disabled");
    expect(getAutonomy(CHAT, TARGET)).toBe("manual");
    const n = db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_actions
         WHERE chat_id = ? AND action_type = 'CHANGE_AGENT_STATUS'`,
      )
      .get(CHAT) as { c: number };
    expect(n.c).toBe(1);
  });
});

describe("UPDATE_AGENT_PROMPT: применение и его след неразделимы", () => {
  function pendingRow() {
    return db
      .prepare(
        `SELECT applied_at, rejected_at FROM agent_prompts
         WHERE agent_key = ? AND reason = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(TARGET, REASON) as
      | { applied_at: number | null; rejected_at: number | null }
      | undefined;
  }

  test("падение аудита не оставляет применённой строку без следа", () => {
    insertPendingAgentPrompt(
      { target_agent_key: TARGET, new_prompt: PROMPT, reason: REASON },
      "perm",
    );
    const brk = breakOn((sql) => sql.includes("INSERT INTO agent_actions"));
    try {
      expect(() =>
        handleUpdateAgentPromptApproved(
          { target_agent_key: TARGET, new_prompt: PROMPT, reason: REASON },
          { agentKey: "perm", chatId: CHAT },
        ),
      ).toThrow(/обрыв/);
    } finally {
      brk.restore();
    }
    expect(brk.fired).toBe(true);
    expect(pendingRow()?.applied_at).toBeNull();
  });

  test("запасная ветка не оставляет осиротевшего предложения", () => {
    // Строки версии нет вовсе — обработчик вставляет её сам и сразу
    // стамповал. Обрыв на аудите не должен оставить в очереди «ожидающую»
    // версию, которой никто не предлагал.
    const brk = breakOn((sql) => sql.includes("INSERT INTO agent_actions"));
    try {
      expect(() =>
        handleUpdateAgentPromptApproved(
          { target_agent_key: TARGET, new_prompt: PROMPT, reason: REASON },
          { agentKey: "perm", chatId: CHAT },
        ),
      ).toThrow(/обрыв/);
    } finally {
      brk.restore();
    }
    expect(brk.fired).toBe(true);
    const n = db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_prompts WHERE agent_key = ? AND reason = ?`,
      )
      .get(TARGET, REASON) as { c: number };
    expect(n.c).toBe(0);
  });

  test("без обрыва применение проходит и попадает в аудит", () => {
    insertPendingAgentPrompt(
      { target_agent_key: TARGET, new_prompt: PROMPT, reason: REASON },
      "perm",
    );
    const r = handleUpdateAgentPromptApproved(
      { target_agent_key: TARGET, new_prompt: PROMPT, reason: REASON },
      { agentKey: "perm", chatId: CHAT },
    );
    expect(r.ok).toBe(true);
    expect(pendingRow()?.applied_at).toBeGreaterThan(0);
    const n = db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_actions
         WHERE chat_id = ? AND action_type = 'UPDATE_AGENT_PROMPT'`,
      )
      .get(CHAT) as { c: number };
    expect(n.c).toBe(1);
  });

  test("падение журнала не оставляет отказ без объяснения", () => {
    insertPendingAgentPrompt(
      { target_agent_key: TARGET, new_prompt: PROMPT, reason: REASON },
      "perm",
    );
    const brk = breakOn((sql) => sql.includes("INSERT INTO audit_logs"));
    try {
      expect(() =>
        handleUpdateAgentPromptRejected({
          payload: {
            target_agent_key: TARGET,
            new_prompt: PROMPT,
            reason: REASON,
          },
          decidedBy: "owner",
          requestedBy: "perm",
          approvalId: "appr-atomicity",
          chatId: CHAT,
        }),
      ).toThrow(/обрыв/);
    } finally {
      brk.restore();
    }
    expect(brk.fired).toBe(true);
    expect(pendingRow()?.rejected_at).toBeNull();
  });

  test("без обрыва отказ помечает версию и пишет журнал", () => {
    insertPendingAgentPrompt(
      { target_agent_key: TARGET, new_prompt: PROMPT, reason: REASON },
      "perm",
    );
    handleUpdateAgentPromptRejected({
      payload: { target_agent_key: TARGET, new_prompt: PROMPT, reason: REASON },
      decidedBy: "owner",
      requestedBy: "perm",
      approvalId: "appr-atomicity",
      chatId: CHAT,
    });
    expect(pendingRow()?.rejected_at).toBeGreaterThan(0);
    const n = db
      .prepare(
        `SELECT COUNT(*) AS c FROM audit_logs
         WHERE chat_id = ? AND event_type = 'UPDATE_AGENT_PROMPT_REJECTED'`,
      )
      .get(CHAT) as { c: number };
    expect(n.c).toBe(1);
  });
});
