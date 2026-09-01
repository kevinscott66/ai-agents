/**
 * Аудит-фиксы сессии 2026-06-10 (рефактор + security):
 *  - S4: pinnedChatId игнорирует кросс-чат target (exfil-guard).
 *  - R10: action.executed эмитится только на терминальных статусах (ok/error).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { pinnedChatId } from "../lib/dispatch/helpers.ts";
import { logAction } from "../lib/audit.ts";
import { subscribe, type BusEvent } from "../lib/events-bus.ts";

describe("S4 pinnedChatId exfil-guard", () => {
  test("без payload.chatId → исходный чат", () => {
    expect(pinnedChatId(undefined, -100, "SEND_DOCUMENT")).toBe(-100);
  });
  test("payload.chatId совпадает → исходный чат", () => {
    expect(pinnedChatId(-100, -100, "SEND_DOCUMENT")).toBe(-100);
  });
  test("кросс-чат payload.chatId ИГНОРИРУЕТСЯ → пин к исходному", () => {
    // попытка увести в чужой чат -999 → всё равно исходный -100
    expect(pinnedChatId(-999, -100, "SEND_DOCUMENT")).toBe(-100);
  });
});

describe("R10 action.executed — только терминальные статусы", () => {
  let unsub: (() => void) | null = null;
  afterEach(() => {
    if (unsub) unsub();
    unsub = null;
  });

  test('status "ok" эмитит', () => {
    const seen: BusEvent[] = [];
    unsub = subscribe((e) => {
      if (e.name === "action.executed") seen.push(e);
    });
    logAction({ agentKey: "qa", actionType: "SEND_MESSAGE", status: "ok", chatId: -1 });
    expect(seen.length).toBe(1);
  });

  test('status "attempted" НЕ эмитит', () => {
    const seen: BusEvent[] = [];
    unsub = subscribe((e) => {
      if (e.name === "action.executed") seen.push(e);
    });
    logAction({ agentKey: "qa", actionType: "SEND_MESSAGE", status: "attempted", chatId: -1 });
    expect(seen.length).toBe(0);
  });

  test('status "forbidden" НЕ эмитит', () => {
    const seen: BusEvent[] = [];
    unsub = subscribe((e) => {
      if (e.name === "action.executed") seen.push(e);
    });
    logAction({ agentKey: "qa", actionType: "SEND_MESSAGE", status: "forbidden", chatId: -1 });
    expect(seen.length).toBe(0);
  });
});
