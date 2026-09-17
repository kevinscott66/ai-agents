/**
 * Шаг 7: USERBOT_SEND_DM — личное сообщение человеку от аккаунта владельца.
 * Каждое сообщение с подтверждением, только владелец из своей лички, только
 * публичный @username и ровно тот текст, что показан в карточке.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { approvalCategories } from "../lib/approval-policy.ts";
import { approvalPreview } from "../lib/approvals.ts";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import { evaluateGate, payloadForcesApproval, setAutonomy, setPermission } from "../lib/permissions.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { buildHandle, type UserbotHandle } from "../lib/userbot.ts";
import { DM_TEXT_MAX, normalizeDmUsername, parseUserbotDm } from "../lib/userbot-dm.ts";
import { savePermissions } from "./_helpers.ts";

const OWNER = 777_000_111;
const char = (code: number) => String.fromCodePoint(code);

describe("parsing", () => {
  test("usernames are normalized, everything else is refused", () => {
    expect(normalizeDmUsername("@Ivan_Petrov")).toBe("ivan_petrov");
    expect(normalizeDmUsername("https://t.me/ivan_petrov")).toBe("ivan_petrov");
    expect(normalizeDmUsername(" t.me/ivanpetrov ")).toBe("ivanpetrov");
    for (const bad of ["", "@abc", "123456789", "+79991234567", "ivan petrov", "ivan__petrov", "ivan_", "_ivan", "a".repeat(33), 42, null]) {
      expect(normalizeDmUsername(bad)).toBeNull();
    }
  });

  test("build payload keeps the text exactly and refuses hidden characters", () => {
    const ctx = { agentKey: "orchestrator" };
    const ok = buildPayload("USERBOT_SEND_DM", { username: "@Ivan_Petrov", text: "  Привет!\nЗавтра в 10?  " }, ctx);
    expect(ok).toEqual({ ok: true, payload: { username: "ivan_petrov", text: "  Привет!\nЗавтра в 10?  " } });
    for (const code of [0x202e, 0x200b, 0x2066, 0xfeff, 0x0d, 0x00, 0x1b, 0x2028]) {
      const r = buildPayload("USERBOT_SEND_DM", { username: "ivan_petrov", text: `Привет${char(code)}пока` }, ctx);
      expect(r.ok).toBe(false);
    }
    expect(buildPayload("USERBOT_SEND_DM", { username: "ivan_petrov", text: "я".repeat(DM_TEXT_MAX + 1) }, ctx).ok).toBe(false);
    expect(buildPayload("USERBOT_SEND_DM", { username: "ivan_petrov", text: "   " }, ctx).ok).toBe(false);
    expect(buildPayload("USERBOT_SEND_DM", { username: "79991234567", text: "hi" }, ctx).ok).toBe(false);
    expect(buildPayload("USERBOT_SEND_DM", { username: "ivan_petrov", text: "😀 ok" }, ctx).ok).toBe(true);
  });

  test("strict parse refuses extra fields and unnormalized names", () => {
    expect(parseUserbotDm({ username: "ivan_petrov", text: "hi", _userId: "1", _delegated: false })).toEqual({ username: "ivan_petrov", text: "hi" });
    expect(parseUserbotDm({ username: "Ivan_Petrov", text: "hi" })).toBeNull();
    expect(parseUserbotDm({ username: "ivan_petrov", text: "hi", chatId: 5 })).toBeNull();
  });
});

describe("approval", () => {
  let restorePerms: () => void;
  beforeAll(() => { restorePerms = savePermissions([["orchestrator", "USERBOT_SEND_DM"]]); });
  beforeEach(() => {
    setAutonomy("chat", String(OWNER), "auto");
    // Даже если строку прав выставить «без апрува», политика владельца его вернёт.
    setPermission("orchestrator", "USERBOT_SEND_DM", { allowed: true, requires_approval: false });
  });
  afterAll(() => restorePerms());

  test("every message needs the owner's approval in auto mode", () => {
    const payload = { username: "ivan_petrov", text: "hi" };
    expect(approvalCategories("USERBOT_SEND_DM", payload)).toEqual(["third_party_message"]);
    const reason = payloadForcesApproval("USERBOT_SEND_DM", payload);
    expect(reason).toContain("сообщение от имени владельца");
    const gate = evaluateGate({ agentKey: "orchestrator", actionType: "USERBOT_SEND_DM", chatId: OWNER, forceApproval: true, forceApprovalReason: reason! });
    expect(gate.decision).toBe("approval");
    expect(evaluateGate({ agentKey: "qa", actionType: "USERBOT_SEND_DM", chatId: OWNER, forceApproval: true }).decision).toBe("deny");
  });

  test("the card names the recipient and shows the whole text", () => {
    const text = `Начало. ${"длинный текст ".repeat(40)}Конец.`;
    const preview = approvalPreview("USERBOT_SEND_DM", { username: "ivan_petrov", text });
    expect(preview).toStartWith("личное сообщение от аккаунта владельца → @ivan_petrov: Начало.");
    expect(preview).toEndWith("Конец.");
  });
});

type Sent = { username: string; text: string };
function stub(behaviour: (username: string) => Promise<{ message_id: number; user_id: string; name: string }>): UserbotHandle & { sent: Sent[] } {
  const sent: Sent[] = [];
  const fail = async (): Promise<never> => { throw new Error("не ожидается"); };
  return {
    isNoop: false,
    sent,
    setReaction: fail,
    deleteMessage: fail,
    sendMessage: fail,
    createTeamChannel: fail,
    publishPost: fail,
    async sendDirectMessage(username, text) {
      sent.push({ username, text });
      return behaviour(username);
    },
    async stop() {},
  };
}

describe("handler", () => {
  const saved = { enabled: process.env.USERBOT_DM_ENABLED, admins: process.env.MINIAPP_ADMIN_USER_IDS };
  const payload = { username: "ivan_petrov", text: "Привет, это я", _userId: String(OWNER) };
  const ok = async () => ({ message_id: 55, user_id: "4242", name: "Иван" });
  const send = (p: Record<string, unknown>, ub: UserbotHandle | null, chatId = OWNER, agentKey = "orchestrator") =>
    dispatchAction("USERBOT_SEND_DM", p as never, { agentKey, chatId, telegram: undefined as never, userbot: ub });

  beforeEach(() => {
    _resetRateLimits();
    process.env.USERBOT_DM_ENABLED = "true";
    process.env.MINIAPP_ADMIN_USER_IDS = `123,${OWNER}`;
  });
  afterEach(() => {
    _resetRateLimits();
    for (const [key, value] of [["USERBOT_DM_ENABLED", saved.enabled], ["MINIAPP_ADMIN_USER_IDS", saved.admins]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  test("owner in their DM: the approved text goes to the named user", async () => {
    const ub = stub(ok);
    const res = await send(payload, ub);
    expect(res).toEqual({ ok: true, result: { via: "userbot", to: "@ivan_petrov", user_id: "4242", name: "Иван", message_id: 55 } } as never);
    expect(ub.sent).toEqual([{ username: "ivan_petrov", text: "Привет, это я" }]);
  });

  test("switched off, wrong caller, group chat, non-owner or delegated call send nothing", async () => {
    const ub = stub(ok);
    process.env.USERBOT_DM_ENABLED = "false";
    expect((await send(payload, ub)).ok).toBe(false);
    process.env.USERBOT_DM_ENABLED = "true";
    expect((await send(payload, ub, OWNER, "qa")).ok).toBe(false);
    expect((await send(payload, ub, -1_001_234)).ok).toBe(false);
    expect((await send({ ...payload, _userId: "999" }, ub, 999)).ok).toBe(false);
    expect((await send({ ...payload, _userId: undefined }, ub)).ok).toBe(false);
    expect((await send({ ...payload, _delegated: true }, ub)).ok).toBe(false);
    expect((await send({ ...payload, text: `a${char(0x202e)}b` }, ub)).ok).toBe(false);
    expect((await send(payload, null)).ok).toBe(false);
    expect(ub.sent).toEqual([]);
  });

  test("refused recipient is not a side effect, a failed send may be", async () => {
    const bot = await send(payload, stub(async () => { throw new Error("recipient_is_bot: @ivan_petrov — бот"); }));
    expect(bot).toMatchObject({ ok: false });
    expect((bot as { sideEffect?: boolean }).sideEffect).toBeUndefined();
    const timeout = await send(payload, stub(async () => { throw new Error("TIMEOUT"); }));
    expect(timeout).toMatchObject({ ok: false, sideEffect: true });
    expect((timeout as { error: string }).error).toContain("не повторяй");
  });
});

describe("gramjs handle", () => {
  class Req { constructor(public args: Record<string, unknown>) {} }
  const Api = {
    contacts: { ResolveUsername: class extends Req {} },
    InputPeerUser: class extends Req {},
  };
  function client(resolved: Record<string, unknown>) {
    const calls: Array<{ peer: unknown; params: unknown }> = [];
    return {
      calls,
      async connect() {},
      async disconnect() {},
      addEventHandler() {},
      async invoke(req: Req) {
        expect(req.args).toEqual({ username: "ivan_petrov" });
        return resolved;
      },
      async deleteMessages() {},
      async getInputEntity() { throw new Error("не ожидается"); },
      async sendMessage(peer: unknown, params: unknown) { calls.push({ peer, params }); return { id: 77 }; },
    };
  }
  const user = (extra: Record<string, unknown> = {}) => ({
    peer: { className: "PeerUser", userId: 4242 },
    users: [{ id: 4242, accessHash: 9, firstName: "Иван", lastName: "Петров", ...extra }],
  });

  test("resolves a person and sends plain text", async () => {
    const c = client(user());
    const res = await buildHandle(c as never, Api).sendDirectMessage!("ivan_petrov", "**как есть**");
    expect(res).toEqual({ message_id: 77, user_id: "4242", name: "Иван Петров" });
    expect(c.calls).toHaveLength(1);
    expect((c.calls[0].peer as Req).args).toEqual({ userId: 4242, accessHash: 9 });
    expect(c.calls[0].params).toEqual({ message: "**как есть**", parseMode: false });
  });

  test("bots, channels, self and deleted accounts are refused before sending", async () => {
    for (const resolved of [
      user({ bot: true }),
      user({ self: true }),
      user({ deleted: true }),
      { peer: { className: "PeerChannel", channelId: 1 }, users: [], chats: [{ id: 1 }] },
    ]) {
      const c = client(resolved);
      await expect(buildHandle(c as never, Api).sendDirectMessage!("ivan_petrov", "hi")).rejects.toThrow(/^recipient_/);
      expect(c.calls).toEqual([]);
    }
  });
});
