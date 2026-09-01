/**
 * P1 (2026-06-09): live-видимость прогресса — logAction эмитит «action.executed»
 * в events-bus, чтобы Mini App показывал реальные действия агентов в реальном времени.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { logAction } from "../lib/audit.ts";
import { subscribe, type BusEvent } from "../lib/events-bus.ts";

describe("logAction → action.executed", () => {
  let unsub: (() => void) | null = null;
  afterEach(() => {
    if (unsub) unsub();
    unsub = null;
  });

  test("эмитит событие с agent/action_type/status/chat_id", () => {
    const seen: BusEvent[] = [];
    unsub = subscribe((e) => {
      if (e.name === "action.executed") seen.push(e);
    });

    logAction({
      agentKey: "qa",
      actionType: "SEND_MESSAGE",
      status: "ok",
      chatId: -123456,
      requestId: "req-test-1",
    });

    expect(seen.length).toBe(1);
    const p = seen[0].payload as Record<string, unknown>;
    expect(p.agent).toBe("qa");
    expect(p.action_type).toBe("SEND_MESSAGE");
    expect(p.status).toBe("ok");
    expect(p.chat_id).toBe(-123456);
    expect(p.request_id).toBe("req-test-1");
    expect(typeof p.id).toBe("string");
  });

  test("статус ошибки тоже стримится (видно, что НЕ выполнено)", () => {
    const seen: BusEvent[] = [];
    unsub = subscribe((e) => {
      if (e.name === "action.executed") seen.push(e);
    });

    logAction({
      agentKey: "backend",
      actionType: "DELETE_MESSAGE",
      status: "error",
      chatId: -999,
      error: "boom",
    });

    expect(seen.length).toBe(1);
    const p = seen[0].payload as Record<string, unknown>;
    expect(p.status).toBe("error");
    expect(p.action_type).toBe("DELETE_MESSAGE");
  });
});
