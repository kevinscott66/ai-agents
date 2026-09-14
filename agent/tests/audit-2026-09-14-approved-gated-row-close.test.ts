/**
 * Аудит 2026-09-14: одобрено и исполнено — а строка действия «ждёт аппрув».
 *
 * Гейт, решивший «нужно согласование», заводит в `agent_actions` строку
 * `pending_approval`. Отказ человека, протухание заявки и отказы `executeApproved`
 * ДО диспатча её закрывают (`closeGatedActionRow` → `forbidden`, аудит
 * 2026-09-11). Оставался самый частый исход — одобрение, дошедшее до
 * диспатча. Замер на живом коде:
 *
 *   после decideApproval:      [pending_approval]
 *   после успешного исполнения: [pending_approval, ok]   ← первая так и висит
 *
 * То есть КАЖДОЕ одобренное действие навсегда оставляло в журнале ожидание
 * решения: `/audit`, лента Mini App, GET_LOGS у самой модели и ряд
 * `agent_actions_recent{status="pending_approval"}` в метрике, где он рос на
 * единицу за каждое одобрение и не убывал никогда.
 *
 * Оставлять строку открытой объяснялось так (докблок `failBeforeDispatch`):
 * у диспатча своя пара строк, и переписать ещё и первую в `ok`/`error` значило
 * бы посчитать один ход дважды. Довод верный — против `ok`/`error`. Поэтому
 * первая строка закрывается не исходом, а решением: статус `approved` —
 * «одобрено, исход — в строке исполнения». Это ровно пара к `forbidden` у
 * отказа, и ни один счётчик исходов его не читает.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { db } from "../lib/db.ts";
import { createApproval, getApproval } from "../lib/approvals.ts";
import { insertActionRow, ACTION_STATUSES } from "../lib/audit.ts";
import { cmdApprove } from "../lib/commands.ts";
import { setPermission } from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";
import { TOOLS } from "../lib/tools-schema.ts";
import { ACTION_STATUS_LABELS } from "../miniapp/src/lib/labels.ts";

const CHAT_ID = -100_914_001;
const AGENT = "smm";

const restorePerms = savePermissions([[AGENT, "SEND_MESSAGE"]]);
afterEach(() => {
  db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(CHAT_ID);
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT_ID);
  restorePerms();
});

function gated(): { actionId: string; approvalId: string } {
  setPermission(AGENT, "SEND_MESSAGE", { allowed: true, requires_approval: true });
  // `_diag: true` — ручной opt-out self-diag: провал диспатча ниже иначе
  // заводит задачу для aieng, и она доживает до чужих тестовых файлов.
  const payload = { chatId: CHAT_ID, text: "текст на согласование", _diag: true };
  const row = insertActionRow("SEND_MESSAGE", {
    agentKey: AGENT,
    chatId: CHAT_ID,
    payload,
    status: "pending_approval",
  });
  const a = createApproval({
    actionId: row.id,
    chatId: CHAT_ID,
    requestedBy: AGENT,
    actionType: "SEND_MESSAGE" as any,
    payload: payload as any,
  });
  return { actionId: row.id, approvalId: a.id };
}

function statuses(): Record<string, number> {
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS n FROM agent_actions WHERE chat_id = ? GROUP BY status`)
    .all(CHAT_ID) as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

function statusOf(id: string): string {
  return (db.prepare(`SELECT status FROM agent_actions WHERE id = ?`).get(id) as { status: string })
    .status;
}

describe("одобрение, дошедшее до диспатча, закрывает строку гейта", () => {
  test("успех: гейтовая строка — approved, исход ok записан один раз", async () => {
    const g = gated();
    const out = await cmdApprove({
      approvalId: g.approvalId,
      decidedBy: "tg:1",
      chatId: CHAT_ID,
      deps: { resolveTg: () => ({ sendMessage: async () => ({ message_id: 7 }) }) as any },
    });
    expect(out).toStartWith("OK:");
    expect(statusOf(g.actionId)).toBe("approved");
    // Один ход — один исход: закрытие не дублирует ok.
    expect(statuses()).toEqual({ approved: 1, ok: 1 });
  });

  test("провал диспатча: гейтовая строка — approved, исход error, заявка failed", async () => {
    const g = gated();
    const out = await cmdApprove({
      approvalId: g.approvalId,
      decidedBy: "tg:1",
      chatId: CHAT_ID,
      deps: {
        resolveTg: () =>
          ({
            sendMessage: async () => {
              throw new Error("telegram лёг");
            },
          }) as any,
      },
    });
    expect(out).toContain("выполнение упало");
    expect(statusOf(g.actionId)).toBe("approved");
    expect(statuses().pending_approval).toBeUndefined();
    expect(statuses().error).toBe(1);
    expect(getApproval(g.approvalId)?.status).toBe("failed");
  });

  test("строка закрыта уже ВО ВРЕМЯ исполнения — крах посреди вызова её не оставит", async () => {
    const g = gated();
    let seen = "";
    await cmdApprove({
      approvalId: g.approvalId,
      decidedBy: "tg:1",
      chatId: CHAT_ID,
      deps: {
        resolveTg: () =>
          ({
            sendMessage: async () => {
              seen = statusOf(g.actionId);
              return { message_id: 8 };
            },
          }) as any,
      },
    });
    expect(seen).toBe("approved");
  });

  test("отказ ДО диспатча по-прежнему forbidden, а не approved", async () => {
    const g = gated();
    // Протухшая заявка — один из ранних выходов `executeApproved`.
    db.prepare(`UPDATE approvals SET created_at = ? WHERE id = ?`).run(
      Date.now() - 400 * 24 * 60 * 60 * 1000,
      g.approvalId,
    );
    await cmdApprove({ approvalId: g.approvalId, decidedBy: "tg:1", chatId: CHAT_ID });
    expect(statusOf(g.actionId)).toBe("forbidden");
  });
});

describe("новый статус заведён везде, где вокабуляр перечислен", () => {
  test("ACTION_STATUSES знает approved", () => {
    expect(ACTION_STATUSES).toContain("approved");
  });

  test("enum фильтра GET_LOGS совпадает с ACTION_STATUSES", () => {
    const tool = TOOLS.find((t) => t.name === "GET_LOGS")!;
    const en = (tool.input_schema as any).properties.status.enum as string[];
    expect([...en].sort()).toEqual([...ACTION_STATUSES].sort());
  });

  test("у Mini App есть русская подпись на каждый статус", () => {
    for (const s of ACTION_STATUSES) expect(`${s}: ${s in ACTION_STATUS_LABELS}`).toBe(`${s}: true`);
  });

  test("Mac не рисует гейтовую строку отдельной сессией", () => {
    const mac = readFileSync(new URL("../miniapp/src/pages/Mac.tsx", import.meta.url), "utf8");
    const line = mac.slice(mac.indexOf("const NON_RUN"), mac.indexOf("\n", mac.indexOf("const NON_RUN")));
    expect(line).toContain('"approved"');
  });

  test("фильтр Logs предлагает каждый статус", () => {
    const logs = readFileSync(new URL("../miniapp/src/pages/Logs.tsx", import.meta.url), "utf8");
    const block = logs.slice(logs.indexOf("const STATUSES"), logs.indexOf("];", logs.indexOf("const STATUSES")));
    for (const s of ACTION_STATUSES) expect(`${s}: ${block.includes(`"${s}"`)}`).toBe(`${s}: true`);
  });

  test("число статусов нигде не записано прозой", () => {
    // Правило круга 20: число убрать и назвать символ. Седьмой статус иначе
    // оставил бы три «ровно шесть» врать.
    for (const rel of ["lib/miniapp-metrics.ts", "miniapp/src/pages/Mac.tsx"]) {
      const s = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
      expect(`${rel}: ${/шесть (литералов|значений)/.test(s)}`).toBe(`${rel}: false`);
    }
  });
});
