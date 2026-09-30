import * as THREE from "three";
import { findPath, type Point } from "./movement";
import { ROSTER, type RoleId } from "./roster";
export function briefingTarget(
  id: RoleId,
  recipients: readonly RoleId[] = [],
): Point | undefined {
  const roles = ROSTER.filter(
    (m) => m.id !== "orchestrator" && recipients.includes(m.id),
  );
  if (!roles.length) return;
  if (id === "orchestrator") return { x: 0, z: 7.3 };
  const i = roles.findIndex((m) => m.id === id);
  if (i >= 0)
    return {
      x: ((i % 6) - Math.min(roles.length, 6) / 2 + 0.5) * 0.85,
      z: 8.35 + Math.floor(i / 6) * 0.85,
    };
}
export class BriefingMotion {
  active = false;
  private key = "";
  private path: Point[] = [];
  step(
    target: Point | undefined,
    home: Point,
    position: THREE.Vector3,
    sit: { current: number },
    yaw: { current: number },
    walking: { current: number },
    dt: number,
  ) {
    if (!target && !this.active) return false;
    this.active = true;
    const end = target ?? home,
      key = `${end.x}:${end.z}`;
    if (this.key !== key) {
      this.key = key;
      this.path = findPath(position, end);
    }
    const distance = Math.hypot(position.x - end.x, position.z - end.z);
    sit.current = THREE.MathUtils.damp(
      sit.current,
      !target && distance < 0.08 ? 1 : 0,
      5,
      dt,
    );
    walking.current = 0;
    if (sit.current < 0.03 && this.path.length) {
      const p = this.path[0],
        dx = p.x - position.x,
        dz = p.z - position.z,
        d = Math.hypot(dx, dz);
      const step = Math.min(d, dt * 1.5);
      if (d > 0.001) {
        position.x += (dx / d) * step;
        position.z += (dz / d) * step;
        yaw.current = Math.atan2(dx, dz);
        walking.current = 1;
      }
      if (d < 0.08) this.path.shift();
    } else if (distance < 0.08) {
      yaw.current = target
        ? Math.atan2(-position.x, 7.8 - position.z)
        : Math.PI;
      if (!target && sit.current > 0.98) {
        this.active = false;
        this.key = "";
      }
    }
    return true;
  }
}
