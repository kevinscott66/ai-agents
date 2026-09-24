import { test, expect } from "bun:test";
import { BriefingMotion, briefingTarget } from "../web/src/briefing";
import { ROSTER } from "../web/src/roster";
import { walkable } from "../web/src/movement";
import { Vector3 } from "three";
test("every participant walks to a distinct reachable slot and returns to their own seat", () => {
  const roles = ROSTER.filter((m) => m.id !== "orchestrator").map((m) => m.id);
  const keys = new Set<string>();
  for (const member of ROSTER) {
    const target = briefingTarget(member.id, roles)!;
    expect(walkable(target)).toBe(true);
    keys.add(JSON.stringify(target));
    const home = { x: member.x, z: member.z + 1.05 },
      position = new Vector3(home.x, 0, home.z),
      sit = { current: 1 },
      yaw = { current: Math.PI },
      walking = { current: 0 },
      motion = new BriefingMotion();
    for (let i = 0; i < 2400; i++)
      motion.step(target, home, position, sit, yaw, walking, 1 / 60);
    expect(
      Math.hypot(position.x - target.x, position.z - target.z),
    ).toBeLessThan(0.1);
    expect(sit.current).toBeLessThan(0.03);
    for (let i = 0; i < 2400; i++)
      motion.step(undefined, home, position, sit, yaw, walking, 1 / 60);
    expect(Math.hypot(position.x - home.x, position.z - home.z)).toBeLessThan(
      0.1,
    );
    expect(sit.current).toBeGreaterThan(0.98);
  }
  expect(keys.size).toBe(12);
  expect(briefingTarget("backend", [])).toBeUndefined();
});
