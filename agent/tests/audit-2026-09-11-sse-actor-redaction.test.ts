/**
 * Аудит 2026-09-11: вторая дверь к утечке личности админа — поток событий.
 *
 * Правило «актор-человек укорачивается до последних четырёх цифр» жило только
 * в `redactContent` (miniapp-server.ts), то есть на REST-ответах. `GET
 * /api/events` пускает по аллоу-листу без admin-проверки — билет несёт только
 * id, — а подписчик шины сериализовал `e.payload` как есть.
 *
 * Достижимо тем же путём, что и утечка через `approvals.decided_by`, которую
 * закрыл предыдущий круг: `setPermission` пишет строку аудита
 * `logAction({ agentKey: audit.changedBy })` (permissions.ts), а `changedBy`
 * для `/grant` и `/revoke` — это `deciderIdentity` (admin-commands.ts), то
 * есть `tg:<id> (@username)`. `logAction` сразу шлёт `action.executed` с полем
 * `agent: agent_key`. Наблюдатель, которому список действий отдаёт ту же
 * строку уже укороченной, получал её целиком через открытый поток — и раньше
 * списка.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_sse_actor";

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { sseUrl } from "./_sse.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { startMiniappServer, type MiniappServerHandle } from "../lib/miniapp-server.ts";
import { emit } from "../lib/events-bus.ts";
import { setPermission } from "../lib/permissions.ts";
import { db } from "../lib/db.ts";

const BOT_TOKEN = "test_bot_token_sse_actor";
const VIEWER_ID = 5100200301;
const ADMIN_ID = 5100200302;
const OWNER_ID = 987654321;
const TG_ACTOR = `tg:${OWNER_ID} (@owner)`;
const MINIAPP_ACTOR = `miniapp:${OWNER_ID}`;
const TARGET = "audit0911sse";
// `/grant` приходит из чата команды — id чата и id человека это разные числа.
const TEAM_CHAT = -1002200330011;

let server: MiniappServerHandle;
let base: string;

function initFor(id: number, tag: string): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${tag}`,
    user: JSON.stringify({ id, username: tag, first_name: tag }),
  });
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [VIEWER_ID, ADMIN_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

afterEach(() => {
  db.prepare(`DELETE FROM permissions WHERE agent_key = ?`).run(TARGET);
  db.prepare(`DELETE FROM agent_actions WHERE agent_key IN (?, ?)`).run(
    TG_ACTOR,
    MINIAPP_ACTOR,
  );
});

interface Stream {
  next: (emitNow: () => void) => Promise<Record<string, unknown>>;
  close: () => void;
}

/**
 * Открытый поток с читателем. Событие бросается ТОЛЬКО из `emitNow`, уже после
 * того, как заголовки флашнуты первой записью (`:ok`): фан-аут шины
 * синхронный, и подписка должна существовать к моменту emit'а.
 */
async function openStream(userId: number, tag: string): Promise<Stream> {
  const ctrl = new AbortController();
  const r = await fetch(await sseUrl(base, initFor(userId, tag)), {
    signal: ctrl.signal,
  });
  expect(r.status).toBe(200);
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // Первая запись — `:ok`, по ней видно, что подписка уже стоит.
  while (!buf.includes(":ok")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("поток закрылся до :ok");
    buf += dec.decode(value, { stream: true });
  }
  return {
    async next(emitNow: () => void) {
      buf = "";
      emitNow();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const line = buf.split("\n").find((l) => l.startsWith("data: "));
        if (line) return JSON.parse(line.slice("data: ".length));
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      throw new Error(`события не дождались, буфер: ${JSON.stringify(buf)}`);
    },
    close() {
      ctrl.abort();
    },
  };
}

describe("SSE: актор-человек не уезжает наблюдателю целиком", () => {
  test("боевой путь /grant: наблюдатель видит только хвост id", async () => {
    const s = await openStream(VIEWER_ID, "viewer");
    try {
      const payload = await s.next(() =>
        setPermission(
          TARGET,
          "SEND_MESSAGE",
          { allowed: true, requires_approval: false },
          { changedBy: TG_ACTOR, chatId: TEAM_CHAT, source: "command" },
        ),
      );
      expect(payload.action_type).toBe("GRANT_PERMISSION");
      expect(payload.agent).toBe(`tg:…${String(OWNER_ID).slice(-4)}`);
      expect(JSON.stringify(payload)).not.toContain(String(OWNER_ID));
      expect(JSON.stringify(payload)).not.toContain("@owner");
    } finally {
      s.close();
    }
  });

  test("форма Mini App укорачивается тем же правилом", async () => {
    const s = await openStream(VIEWER_ID, "viewer2");
    try {
      const payload = await s.next(() =>
        emit("action.executed", {
          id: "a-1",
          agent: MINIAPP_ACTOR,
          action_type: "GRANT_PERMISSION",
          status: "ok",
          chat_id: OWNER_ID,
          request_id: null,
        }),
      );
      expect(payload.agent).toBe(`miniapp:…${String(OWNER_ID).slice(-4)}`);
    } finally {
      s.close();
    }
  });

  test("админу поток идёт как прежде", async () => {
    const s = await openStream(ADMIN_ID, "adm");
    try {
      const payload = await s.next(() =>
        emit("action.executed", {
          id: "a-2",
          agent: TG_ACTOR,
          action_type: "GRANT_PERMISSION",
          status: "ok",
          chat_id: OWNER_ID,
          request_id: null,
        }),
      );
      expect(payload.agent).toBe(TG_ACTOR);
    } finally {
      s.close();
    }
  });

  test("ключи ролей и прочие поля проходят нетронутыми", async () => {
    const s = await openStream(VIEWER_ID, "viewer3");
    try {
      const payload = await s.next(() =>
        emit("action.executed", {
          id: "a-3",
          agent: "smm",
          action_type: "SEND_MESSAGE",
          status: "ok",
          chat_id: -1002200330044,
          request_id: "req-7",
        }),
      );
      expect(payload).toEqual({
        id: "a-3",
        agent: "smm",
        action_type: "SEND_MESSAGE",
        status: "ok",
        chat_id: -1002200330044,
        request_id: "req-7",
      });
    } finally {
      s.close();
    }
  });
});
