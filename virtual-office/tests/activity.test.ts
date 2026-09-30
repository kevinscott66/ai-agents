import { expect, test } from "bun:test";
import { activityFor } from "../web/src/activity";
import { typingContact, DESK, KEYBOARD } from "../web/src/workstation";
import { ROSTER } from "../web/src/roster";
test("live chat processing drives typing; waiting and disconnected states never type", () => {
  expect(activityFor("THINKING")).toBe("working");
  for (const state of [
    "WAITING",
    "OFFLINE",
    "IDLE",
    "DONE",
    "ERROR",
    undefined,
  ])
    expect(activityFor(state)).not.toBe("working");
});
test("each role's fingertips target its own keyboard, not Backend's desk", () => {
  for (const member of ROSTER) {
    const [x, y, z] = typingContact(1, 0, member);
    expect(x).toBeCloseTo(member.x + KEYBOARD.x + 0.1);
    expect(z).toBeCloseTo(member.z + KEYBOARD.z);
    expect(y).toBeGreaterThan(KEYBOARD.keyTop);
  }
  expect(typingContact(1, 0)).toEqual(typingContact(1, 0, DESK));
});
