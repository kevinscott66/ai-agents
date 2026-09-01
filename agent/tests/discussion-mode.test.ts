/**
 * P2 (2026-06-09): controlled discussion mode per chat.
 *  - chat-settings get/set roundtrip + default OFF
 *  - /discussion command (status / on / off / bad arg)
 */
import { describe, test, beforeEach, expect } from "bun:test";
import { db } from "../lib/db.ts";
import { getDiscussionMode, setDiscussionMode } from "../lib/chat-settings.ts";
import { cmdDiscussion } from "../lib/commands.ts";

describe("P2 discussion mode", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM chat_settings").run();
  });

  test("default is OFF for unknown chat", () => {
    expect(getDiscussionMode(-12345)).toBe(false);
  });

  test("set ON then OFF roundtrips", () => {
    setDiscussionMode(-12345, true);
    expect(getDiscussionMode(-12345)).toBe(true);
    setDiscussionMode(-12345, false);
    expect(getDiscussionMode(-12345)).toBe(false);
  });

  test("per-chat isolation", () => {
    setDiscussionMode(-1, true);
    expect(getDiscussionMode(-1)).toBe(true);
    expect(getDiscussionMode(-2)).toBe(false);
  });

  test("cmdDiscussion: status shows OFF by default", () => {
    expect(cmdDiscussion({ chatId: -7 })).toContain("OFF");
  });

  test("cmdDiscussion: on then status shows ON", () => {
    cmdDiscussion({ chatId: -7, on: true });
    expect(getDiscussionMode(-7)).toBe(true);
    expect(cmdDiscussion({ chatId: -7 })).toContain("ON");
  });

  test("cmdDiscussion: off turns it off", () => {
    setDiscussionMode(-7, true);
    cmdDiscussion({ chatId: -7, on: false });
    expect(getDiscussionMode(-7)).toBe(false);
  });
});
