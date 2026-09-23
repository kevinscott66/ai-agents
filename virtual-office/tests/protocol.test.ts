import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficeStore } from "../gateway/store";
import {
  CommandSchema,
  EventSchema,
  WorldSchema,
  reduceEvent,
  ResyncRequired,
  STATES,
  type OfficeEvent,
} from "../contracts/protocol";
import { findPath, walkable, slide } from "../web/src/movement";
const scenario = (state: (typeof STATES)[number] = "IDLE") => ({
  commandId: crypto.randomUUID(),
  agentId: "backend" as const,
  kind: "scenario.set" as const,
  state,
});
test("all states validate; unavailable telemetry stays null, not invented progress", () => {
  const s = new OfficeStore();
  for (const state of STATES) {
    s.execute(scenario(state));
    expect(WorldSchema.safeParse(s.snapshot()).success).toBe(true);
    expect(s.world.agent.progress).toBe(state === "DONE" ? 1 : null);
  }
  s.close();
});
test("cursor causality: duplicate is harmless, gap and epoch force resync", () => {
  const s = new OfficeStore(),
    before = s.snapshot();
  s.execute(scenario());
  s.execute(scenario("TESTING"));
  const [a, b] = s.replay(before.streamId, 0)!;
  expect(reduceEvent(before, a).seq).toBe(1);
  expect(reduceEvent(reduceEvent(before, a), a).seq).toBe(1);
  expect(() => reduceEvent(before, b)).toThrow(ResyncRequired);
  expect(() => reduceEvent(before, { ...a, streamId: "other" })).toThrow(
    ResyncRequired,
  );
  s.close();
});
test("retention requires snapshot; current cursor resumes empty; future cursor rejected", () => {
  const s = new OfficeStore(":memory:", 2);
  for (let i = 0; i < 4; i++) s.execute(scenario());
  expect(s.replay(s.world.streamId, 0)).toBeNull();
  expect(s.replay(s.world.streamId, 2)?.length).toBe(2);
  expect(s.replay(s.world.streamId, 4)).toEqual([]);
  expect(s.replay(s.world.streamId, 5)).toBeNull();
  s.close();
});
test("command idempotency: one execution; payload change conflicts", () => {
  const s = new OfficeStore(),
    cmd = scenario();
  const first = s.execute(cmd);
  expect(s.execute(cmd)).toEqual(first);
  expect(s.world.seq).toBe(1);
  expect(() => s.execute({ ...cmd, state: "CODING" })).toThrow(
    "idempotency_conflict",
  );
  expect(s.world.seq).toBe(1);
  s.close();
});
test("SQLite restart preserves projection, replay, command results and epoch", () => {
  const dir = mkdtempSync(join(tmpdir(), "office-"));
  try {
    let s = new OfficeStore(join(dir, "test.db"));
    const cmd = scenario("WAITING");
    s.execute(cmd);
    const before = s.snapshot();
    s.close();
    s = new OfficeStore(join(dir, "test.db"));
    expect(s.snapshot()).toEqual(before);
    expect(s.result(cmd.commandId)?.status).toBe("completed");
    s.execute(cmd);
    expect(s.world.seq).toBe(1);
    expect(s.replay(before.streamId, 0)?.length).toBe(1);
    s.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("chat targets backend, emits two ordered messages and does not alter work state", () => {
  const s = new OfficeStore(),
    a = s.world.agent;
  const events: OfficeEvent[] = [];
  s.listeners.add((e) => events.push(e));
  s.execute({
    commandId: crypto.randomUUID(),
    agentId: "backend",
    kind: "chat.send",
    text: "Привет",
  });
  expect(events.map((e) => e.seq)).toEqual([1, 2]);
  expect(s.world.messages.map((m) => m.speaker)).toEqual(["user", "agent"]);
  expect(s.world.agent).toEqual(a);
  expect(s.world.messages[1].source).toBe("mock");
  s.close();
});
test("unknown identities/privileged command/prompt fields rejected", () => {
  expect(
    CommandSchema.safeParse({ ...scenario(), agentId: "orchestrator" }).success,
  ).toBe(false);
  expect(
    CommandSchema.safeParse({ ...scenario(), kind: "deploy" }).success,
  ).toBe(false);
  expect(
    CommandSchema.safeParse({ ...scenario(), secret: "canary" }).success,
  ).toBe(false);
  const s = new OfficeStore();
  s.execute(scenario());
  const event = s.replay(s.world.streamId, 0)![0];
  expect(
    EventSchema.safeParse({ ...event, reasoning: "private" }).success,
  ).toBe(false);
  expect(EventSchema.safeParse({ ...event, source: "backend" }).success).toBe(
    false,
  );
  s.close();
});
test("subscriber failure does not roll back committed projection", () => {
  const s = new OfficeStore();
  s.listeners.add(() => {
    throw new Error("broken renderer");
  });
  s.execute(scenario());
  expect(s.world.seq).toBe(1);
  expect(s.replay(s.world.streamId, 0)?.length).toBe(1);
  s.close();
});
test("transaction failure restores in-memory and durable state; retry remains possible", () => {
  const s = new OfficeStore(),
    before = s.snapshot(),
    cmd = scenario();
  s.db.exec(
    "CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
  );
  expect(() => s.execute(cmd)).toThrow();
  expect(s.snapshot()).toEqual(before);
  expect(s.result(cmd.commandId)).toBeNull();
  s.db.exec("DROP TRIGGER reject_event");
  s.execute(cmd);
  expect(s.world.seq).toBe(1);
  s.close();
});
test("projection and chat histories bounded", () => {
  const s = new OfficeStore();
  for (let i = 0; i < 25; i++) {
    s.execute(scenario());
    s.execute({
      commandId: crypto.randomUUID(),
      agentId: "backend",
      kind: "chat.send",
      text: "message",
    });
  }
  expect(s.world.actions.length).toBe(20);
  expect(s.world.messages.length).toBe(40);
  s.close();
});
test("navigation routes around desk and respects room; sliding cannot pass through it", () => {
  const path = findPath({ x: -1.65, z: -1.7 }, { x: 0.9, z: -8.6 });
  expect(path.length).toBeGreaterThan(0);
  expect(path.every((p) => walkable(p, 0.23))).toBe(true);
  const blocked = slide({ x: -1.65, z: -1.8 }, 0, -0.3);
  expect(blocked.z).toBe(-1.8);
  expect(walkable({ x: 10, z: 0 })).toBe(false);
});
