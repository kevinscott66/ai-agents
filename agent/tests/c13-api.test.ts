/**
 * C13a — Mini App REST API.
 *
 * Тесты делятся на три блока:
 *  1. verifyInitData / buildInitData — чистый HMAC.
 *  2. HTTP-сервер: auth wall, CORS, /api/health.
 *  3. Маршруты: agents, tasks, approvals, actions, permissions, autonomy.
 *
 * Сервер стартует на ephemeral-порту (0) с фиксированным фейковым токеном.
 */
process.env.MINIAPP_BOT_TOKEN = "c13-test-token";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  verifyInitData,
  buildInitData,
} from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { createTask, getTask } from "../lib/tasks.ts";
import { createApproval, getApproval } from "../lib/approvals.ts";
import { logAction } from "../lib/audit.ts";
import { setPermission, getAutonomy } from "../lib/permissions.ts";
import { savePermissions } from "./_helpers.ts";
import { db } from "../lib/db.ts";

const BOT_TOKEN = "c13-test-token";
const USER_ID = 12345;
const ADMIN_ID = 99999;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshInitData(userId = USER_ID, age = 0): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec() - age),
    query_id: "q1",
    user: JSON.stringify({ id: userId, username: "tester", first_name: "T" }),
  });
}

let server: MiniappServerHandle;
let base: string;

// Тест ручки /api/permissions пишет реальные строки прав живой роли. Без
// снимка `qa/SET_REACTION` оставался с requires_approval=true до конца
// прогона, и c6a.test.ts (сид миграции 007 + semi_auto overlay + executeTool)
// падал тремя тестами, если запускался после. T-751.
let restorePerms: () => void;

beforeAll(() => {
  restorePerms = savePermissions([
    ["qa", "SET_REACTION"],
    ["qa", "SEND_MESSAGE"],
  ]);
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID, ADMIN_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
    // T-547: approved actions now actually execute; provide a no-op Telegram
    // client so SEND_MESSAGE approvals dispatch successfully in tests.
    approvalDeps: {
      resolveTg: () =>
        ({ sendMessage: async () => ({ message_id: 1 }) }) as any,
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  restorePerms();
  server.stop();
});

async function api(
  path: string,
  init: RequestInit = {},
  initData?: string,
): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers);
  if (initData !== null && initData !== undefined) {
    headers.set("x-telegram-init-data", initData);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(`${base}${path}`, { ...init, headers });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

describe("C13a verifyInitData", () => {
  test("valid initData passes", () => {
    const raw = freshInitData();
    const r = verifyInitData(raw, BOT_TOKEN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.user.id).toBe(USER_ID);
  });

  test("tampered hash fails", () => {
    const raw = freshInitData();
    const tampered = raw.replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64));
    const r = verifyInitData(tampered, BOT_TOKEN);
    expect(r.ok).toBe(false);
  });

  test("wrong token fails", () => {
    const raw = freshInitData();
    const r = verifyInitData(raw, "different_token");
    expect(r.ok).toBe(false);
  });

  test("stale auth_date fails", () => {
    const raw = freshInitData(USER_ID, 86400 + 100);
    const r = verifyInitData(raw, BOT_TOKEN, 86400);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/stale/);
  });

  test("auth_date too far in the future fails", () => {
    const raw = freshInitData(USER_ID, -3600);
    const r = verifyInitData(raw, BOT_TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/future/);
  });

  test("missing hash fails", () => {
    const r = verifyInitData("auth_date=1&user=%7B%22id%22%3A1%7D", BOT_TOKEN);
    expect(r.ok).toBe(false);
  });
});

describe("C13a auth wall", () => {
  test("/api/health is public", async () => {
    const r = await api("/api/health", {}, undefined);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test("missing initData → 401", async () => {
    const r = await api("/api/agents", {}, undefined);
    expect(r.status).toBe(401);
  });

  test("bad initData → 401", async () => {
    const r = await api("/api/agents", {}, "totally-bogus-data");
    expect(r.status).toBe(401);
  });

  test("user not in allowedUserIds → 403", async () => {
    const raw = freshInitData(777); // not in allowlist
    const r = await api("/api/agents", {}, raw);
    expect(r.status).toBe(403);
  });

  test("CORS preflight OPTIONS → 204", async () => {
    const res = await fetch(`${base}/api/tasks`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toMatch(
      /X-Telegram-Init-Data/i,
    );
  });
});

describe("C13a routes", () => {
  test("GET /api/agents returns 12 entries", async () => {
    const r = await api("/api/agents", {}, freshInitData());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.agents)).toBe(true);
    expect(r.body.agents.length).toBe(12);
    expect(r.body.agents[0]).toHaveProperty("key");
    expect(r.body.agents[0]).toMatchObject({
      provider: "internal",
      execution_state: "running",
    });
  });

  test("tasks: seed, GET by id, list by assignee, update status", async () => {
    // Изоляция от прошлых прогонов в общей SQLite нужна прежней (выдача
    // режется лимитом 50), но держаться она должна не на выдуманном
    // исполнителе: с аудита 2026-09-10 `?assignee=` сверяется с CHARACTERS и
    // на `qa-<uuid>` честно отвечает 400. Разводим по chat_id — это и так
    // граница арендатора в этом коде, и ветка assignee её учитывает
    // (аудит 2026-08-28), так что сужение вышло даже строже прежнего.
    const uniqueChatId = -1_000_000 - Math.floor(Math.random() * 1_000_000);
    const t = createTask({
      chatId: uniqueChatId,
      createdBy: "orchestrator",
      assignedTo: "qa",
      title: "c13 test task",
    });
    const got = await api(`/api/tasks/${t.id}`, {}, freshInitData());
    expect(got.status).toBe(200);
    expect(got.body.task.id).toBe(t.id);

    const list = await api(
      `/api/tasks?assignee=qa&chat_id=${uniqueChatId}`,
      {},
      freshInitData(),
    );
    expect(list.status).toBe(200);
    expect(list.body.tasks.some((x: any) => x.id === t.id)).toBe(true);

    const upd = await api(
      `/api/tasks/${t.id}/status`,
      {
        method: "POST",
        body: JSON.stringify({ status: "running" }),
      },
      freshInitData(ADMIN_ID), // task-status mutation now requires admin
    );
    expect(upd.status).toBe(200);
    expect(upd.body.task.status).toBe("running");

    expect(getTask(t.id)?.status).toBe("running");
  });

  test("tasks: 404 for missing id", async () => {
    const r = await api(`/api/tasks/does-not-exist`, {}, freshInitData());
    expect(r.status).toBe(404);
  });

  test("tasks: bad status transition → 400", async () => {
    const t = createTask({
      chatId: -123,
      createdBy: "orchestrator",
      assignedTo: "qa",
      title: "bad-fsm",
    });
    const r = await api(
      `/api/tasks/${t.id}/status`,
      { method: "POST", body: JSON.stringify({ status: "done" }) },
      freshInitData(ADMIN_ID), // task-status mutation now requires admin
    );
    expect(r.status).toBe(400);
  });

  test("approvals: list pending, decide approved", async () => {
    const uniqChat = -1_000_000 - Math.floor(Math.random() * 1_000_000);
    const a = createApproval({
      actionId: crypto.randomUUID(),
      chatId: uniqChat,
      requestedBy: "qa",
      actionType: "SEND_MESSAGE",
      payload: { text: "hi" },
    });

    const list = await api(`/api/approvals?status=pending&chat_id=${uniqChat}`, {}, freshInitData());
    expect(list.status).toBe(200);
    expect(list.body.approvals.some((x: any) => x.id === a.id)).toBe(true);

    const dec = await api(
      `/api/approvals/${a.id}/decide`,
      {
        method: "POST",
        body: JSON.stringify({ decision: "approved", reason: "ok" }),
      },
      freshInitData(ADMIN_ID),
    );
    expect(dec.status).toBe(200);
    expect(dec.body.approval.status).toBe("approved");
    expect(dec.body.approval.decided_by).toBe(`miniapp:${ADMIN_ID}`);

    expect(getApproval(a.id)?.status).toBe("approved");
  });

  test("approvals: decide requires admin — non-admin user is 403 (T-600)", async () => {
    const a = createApproval({
      actionId: crypto.randomUUID(),
      chatId: -321,
      requestedBy: "qa",
      actionType: "SEND_MESSAGE",
      payload: { text: "hi" },
    });
    const dec = await api(
      `/api/approvals/${a.id}/decide`,
      { method: "POST", body: JSON.stringify({ decision: "approved" }) },
      freshInitData(), // USER_ID — allowlisted but NOT admin
    );
    expect(dec.status).toBe(403);
    // The approval must remain pending — a non-admin could not execute it.
    expect(getApproval(a.id)?.status).toBe("pending");
  });

  test("approvals: rejected decision", async () => {
    const a = createApproval({
      actionId: crypto.randomUUID(),
      chatId: -123,
      requestedBy: "qa",
      actionType: "SEND_MESSAGE",
      payload: { text: "no" },
    });
    const dec = await api(
      `/api/approvals/${a.id}/decide`,
      {
        method: "POST",
        body: JSON.stringify({ decision: "rejected", reason: "spam" }),
      },
      freshInitData(ADMIN_ID),
    );
    expect(dec.status).toBe(200);
    expect(dec.body.approval.status).toBe("rejected");
  });

  test("approvals: bad decision → 400", async () => {
    const a = createApproval({
      actionId: crypto.randomUUID(),
      chatId: -123,
      requestedBy: "qa",
      actionType: "SEND_MESSAGE",
      payload: {},
    });
    const r = await api(
      `/api/approvals/${a.id}/decide`,
      { method: "POST", body: JSON.stringify({ decision: "maybe" }) },
      freshInitData(ADMIN_ID),
    );
    expect(r.status).toBe(400);
  });

  test("actions: filter by agent + before_id pagination", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = logAction({
        agentKey: "c13test-agent",
        chatId: -123,
        actionType: "SEND_MESSAGE",
        payload: { i },
        status: "ok",
      });
      ids.push(r.id);
      // ensure created_at differs
      const newCreated = Date.now() + i;
      db.prepare(
        `UPDATE agent_actions SET created_at = ? WHERE id = ?`,
      ).run(newCreated, r.id);
    }

    const list = await api(
      `/api/actions?agent=c13test-agent&limit=10`,
      {},
      freshInitData(),
    );
    expect(list.status).toBe(200);
    expect(list.body.actions.length).toBeGreaterThanOrEqual(4);

    // Pick a "before_id" — the second-newest — and ensure no newer entries come back.
    const sortedDesc = [...list.body.actions].sort(
      (a, b) => b.created_at - a.created_at,
    );
    const beforeId = sortedDesc[0].id;
    const beforeCreated = sortedDesc[0].created_at;
    const page = await api(
      `/api/actions?agent=c13test-agent&before_id=${beforeId}&limit=10`,
      {},
      freshInitData(),
    );
    expect(page.status).toBe(200);
    // before_id — самая свежая запись, значит остальные три обязаны вернуться.
    // Без этой строки сломанная пагинация, отдающая пустую страницу, проходит:
    // непустоту проверял запрос ВЫШЕ, а не этот.
    expect(page.body.actions.length).toBeGreaterThanOrEqual(3);
    for (const a of page.body.actions) {
      expect(a.created_at).toBeLessThan(beforeCreated);
    }
  });

  test("permissions: non-admin GET → 403", async () => {
    const r = await api(`/api/permissions?agent=qa`, {}, freshInitData());
    expect(r.status).toBe(403);
  });

  // Тест мутирует РЕАЛЬНУЮ таблицу permissions (qa × SET_REACTION →
  // requires_approval=true) и до 2026-08-14 ничего не возвращал назад. Пока
  // порядок файлов на маке был такой, что c13 шёл последним, это не всплывало;
  // в CI после появления нового тест-файла (PR #395/#402) порядок сдвинулся, и
  // все, кто проверяет дефолтный сид (c3, migration 007, evaluateGate,
  // executeTool), падали на чужой единице. Снимок + finally, как в t701.
  test("permissions: admin GET + POST", async () => {
    // Снимок через хелпер, а не `getPermission` + `setPermission` руками:
    // на отсутствующей строке `getPermission` отдаёт `{allowed:false}`, и
    // «восстановление» СОЗДАЛО бы явный запрет там, где была тишина.
    const restore = savePermissions([
      ["qa", "SEND_MESSAGE"],
      ["qa", "SET_REACTION"],
    ]);
    try {
      setPermission("qa", "SEND_MESSAGE", {
        allowed: true,
        requires_approval: false,
      });
      const r = await api(
        `/api/permissions?agent=qa`,
        {},
        freshInitData(ADMIN_ID),
      );
      expect(r.status).toBe(200);
      expect(r.body.permissions.some((p: any) => p.actionType === "SEND_MESSAGE"))
        .toBe(true);

      const post = await api(
        `/api/permissions`,
        {
          method: "POST",
          body: JSON.stringify({
            // Было "c13-fake-agent". С аудита 2026-08-04 ручка сверяет ключ с
            // CHARACTERS: несуществующая роль → 400 (см.
            // tests/miniapp-agent-key-validation.test.ts), потому что запись под
            // чужим ключом evaluateGate не видит никогда.
            agentKey: "qa",
            actionType: "SET_REACTION",
            allowed: true,
            requires_approval: true,
          }),
        },
        freshInitData(ADMIN_ID),
      );
      expect(post.status).toBe(200);
      expect(post.body.permission.requires_approval).toBe(true);
    } finally {
      restore();
    }
  });

  test("permissions: POST unknown actionType → 400", async () => {
    const r = await api(
      `/api/permissions`,
      {
        method: "POST",
        body: JSON.stringify({
          agentKey: "qa",
          actionType: "FAKE_ACTION",
          allowed: true,
          requires_approval: false,
        }),
      },
      freshInitData(ADMIN_ID),
    );
    expect(r.status).toBe(400);
  });

  test("autonomy: GET returns mode; POST admin-only", async () => {
    const r = await api(`/api/autonomy`, {}, freshInitData());
    expect(r.status).toBe(200);
    expect(typeof r.body.mode).toBe("string");

    // Non-admin POST → 403
    const r2 = await api(
      `/api/autonomy`,
      { method: "POST", body: JSON.stringify({ mode: "auto" }) },
      freshInitData(),
    );
    expect(r2.status).toBe(403);

    // Admin POST per-chat
    const r3 = await api(
      `/api/autonomy`,
      {
        method: "POST",
        body: JSON.stringify({ mode: "auto", chat_id: -999 }),
      },
      freshInitData(ADMIN_ID),
    );
    expect(r3.status).toBe(200);
    expect(getAutonomy(-999)).toBe("auto");
  });

  test("autonomy: POST bad mode → 400", async () => {
    const r = await api(
      `/api/autonomy`,
      { method: "POST", body: JSON.stringify({ mode: "ludicrous" }) },
      freshInitData(ADMIN_ID),
    );
    expect(r.status).toBe(400);
  });

  test("unknown route → 404", async () => {
    const r = await api(`/api/does-not-exist`, {}, freshInitData());
    expect(r.status).toBe(404);
  });
});
