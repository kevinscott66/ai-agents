export type Point = { x: number; z: number };
export type Obstacle = { x: number; z: number; w: number; d: number };
export const OBSTACLES: Obstacle[] = [
  { x: -1.65, z: -2.75, w: 2.7, d: 1.1 },
  { x: -5.35, z: -2, w: 0.75, d: 3 },
  { x: 3.7, z: -2.8, w: 2.5, d: 1.15 },
  { x: 4.75, z: 1.8, w: 1.4, d: 2.5 },
  { x: 2.7, z: 1.8, w: 0.8, d: 1.3 },
];
export function walkable(p: Point, radius = 0.25) {
  return (
    Math.abs(p.x) < 5.6 - radius &&
    Math.abs(p.z) < 4.6 - radius &&
    !OBSTACLES.some(
      (b) =>
        Math.abs(p.x - b.x) < b.w / 2 + radius &&
        Math.abs(p.z - b.z) < b.d / 2 + radius,
    )
  );
}
export function slide(position: Point, dx: number, dz: number): Point {
  const next = { ...position };
  if (walkable({ x: next.x + dx, z: next.z })) next.x += dx;
  if (walkable({ x: next.x, z: next.z + dz })) next.z += dz;
  return next;
}
// Bounded four-neighbour A*: office-local navigation, no path through furniture.
export function findPath(start: Point, end: Point): Point[] {
  const step = 0.35,
    key = (p: Point) => `${p.x},${p.z}`,
    cell = (p: Point) => ({
      x: Math.round(p.x / step),
      z: Math.round(p.z / step),
    });
  const s = cell(start),
    e = cell(end),
    open = [s],
    parents = new Map<string, Point>(),
    cost = new Map([[key(s), 0]]),
    closed = new Set<string>();
  for (let iterations = 0; open.length && iterations < 1400; iterations++) {
    open.sort(
      (a, b) =>
        cost.get(key(a))! +
        Math.abs(a.x - e.x) +
        Math.abs(a.z - e.z) -
        (cost.get(key(b))! + Math.abs(b.x - e.x) + Math.abs(b.z - e.z)),
    );
    const cur = open.shift()!,
      id = key(cur);
    if (closed.has(id)) continue;
    closed.add(id);
    if (cur.x === e.x && cur.z === e.z) {
      const path: Point[] = [end];
      let node = cur;
      while (key(node) !== key(s)) {
        path.unshift({ x: node.x * step, z: node.z * step });
        node = parents.get(key(node))!;
      }
      return path;
    }
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const n = { x: cur.x + dx, z: cur.z + dz },
        nk = key(n),
        nc = cost.get(id)! + 1;
      if (
        !walkable({ x: n.x * step, z: n.z * step }, 0.23) ||
        closed.has(nk) ||
        (cost.get(nk) ?? Infinity) <= nc
      )
        continue;
      parents.set(nk, cur);
      cost.set(nk, nc);
      open.push(n);
    }
  }
  return [];
}
