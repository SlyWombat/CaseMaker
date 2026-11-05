/**
 * linkRoute.ts — A PATH FOR THE CUTTER'S CENTRE INSIDE A POCKET'S CLEARED AREA (#962, the manager's
 * 11-05 ruling). The straight stay-down chord is refused when it crosses ground the op is not
 * cutting; today's fallback is a full retract (up, across at the hop plane, down, then a long feed
 * at depth). On the tray that is 226 legs and ~487 s of rapid. This module routes the join instead:
 * the shortest path that stays inside the cleared region ERODED BY THE CUTTER RADIUS, so the whole
 * disc stays in cleared material, with every sample over B's below-material guard. The caller
 * (link(), when the chord is refused) chooses feed at depth or a rapid at the in-pocket safe Z by
 * the time guard against the retract it replaces.
 *
 * The polygon is the caller's own already-eroded free space (`open` in pocket.ts: the region
 * eroded by the tool radius less a chord grace) — this module does no offsetting.
 */
import type { Polygons } from '@/engine/cnc/cam/pocket';

export interface RoutePoint {
  x: number;
  y: number;
  z: number;
}

export interface RouteOptions {
  /** The already-eroded cleared polygon (the cutter's CENTRE space) at this level. */
  cleared: Polygons;
  /** The level being travelled (the cleared polygon's own cut Z). */
  levelZ: number;
  /** A Z inside the pocket airspace, above any restored material (the in-pocket rapid plane). */
  rapidZMm: number;
  /** Material top at a point, or null where it is not reachable; the guard needs z >= it. */
  materialAt: (x: number, y: number) => number | null;
  /** Sample spacing for the inside-the-polygon and below-material guards, mm; absent → 0.5. */
  sampleMm?: number;
}

export interface Route {
  /** The polyline from `from` to `to`, inclusive. */
  points: RoutePoint[];
  /** The path's own length, mm — the caller prices feed vs rapid travel from this. */
  lengthMm: number;
}

/**
 * CLOSED membership (#962 ruling): a point within 1e-6 mm of the polygon's boundary is INSIDE.
 * The cleared region is closed — the ring `pocketLoops` cuts lies exactly on `erode(region, R)`,
 * and the boundary of that region is cut material, not air. Float equality, not a grace.
 */
export const BOUNDARY_EPS_MM = 1e-6;

function insideEvenOdd(polys: Polygons, x: number, y: number): boolean {
  let c = false;
  for (const ring of polys) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** The cleared region's own membership, shared by every caller: closed within {@link BOUNDARY_EPS_MM}. */
export function insideClosed(polys: Polygons, x: number, y: number): boolean {
  if (insideEvenOdd(polys, x, y)) return true;
  for (const ring of polys) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (distanceToSegment(x, y, xj, yj, xi, yi) <= BOUNDARY_EPS_MM) return true;
    }
  }
  return false;
}

/**
 * The shortest path for the cutter CENTRE between two points, inside `cleared` (already eroded by
 * the radius) and above the material guard at every sample — the visibility graph over the
 * polygon's own vertices plus the endpoints, searched with Dijkstra. Returns null when no route
 * exists or the guard cannot prove one.
 */
export function routeWithin(from: RoutePoint, to: RoutePoint, opts: RouteOptions): Route | null {
  const sample = opts.sampleMm !== undefined && opts.sampleMm > 0 ? opts.sampleMm : 0.5;
  const walkable = (a: { x: number; y: number }, b: { x: number; y: number }, z: number): boolean => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / sample));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if (!insideClosed(opts.cleared, x, y)) return false;
      const top = opts.materialAt(x, y);
      if (top === null || z < top - 1e-6) return false;
    }
    return true;
  };
  if (!walkable(from, to, opts.levelZ)) {
    // Visible-graph nodes: the two endpoints plus every vertex of the cleared polygon.
    const nodes: { x: number; y: number }[] = [{ x: from.x, y: from.y }, { x: to.x, y: to.y }];
    for (const ring of opts.cleared) for (const [x, y] of ring) nodes.push({ x, y });
    const n = nodes.length;
    const edges: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (walkable(nodes[i]!, nodes[j]!, opts.levelZ)) {
          edges[i]!.push(j);
          edges[j]!.push(i);
        }
      }
    }
    // Dijkstra from node 0 (from) to node 1 (to).
    const dist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
    const prev = new Array<number>(n).fill(-1);
    const done = new Array<boolean>(n).fill(false);
    dist[0] = 0;
    for (let k = 0; k < n; k++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i]! < dist[u]!)) u = i;
      if (u < 0 || !Number.isFinite(dist[u]!)) break;
      done[u] = true;
      if (u === 1) break;
      for (const v of edges[u]!) {
        const w = Math.hypot(nodes[v]!.x - nodes[u]!.x, nodes[v]!.y - nodes[u]!.y);
        if (dist[u]! + w < dist[v]!) {
          dist[v] = dist[u]! + w;
          prev[v] = u;
        }
      }
    }
    if (!Number.isFinite(dist[1]!)) return null;
    const path: number[] = [];
    for (let v = 1; v !== -1; v = prev[v]!) path.push(v);
    path.reverse();
    const points: RoutePoint[] = path.map((i) => ({ x: nodes[i]!.x, y: nodes[i]!.y, z: opts.levelZ }));
    const lengthMm = points.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y), 0);
    return { points, lengthMm };
  }
  const lengthMm = Math.hypot(to.x - from.x, to.y - from.y);
  return { points: [{ ...from }, { ...to }], lengthMm };
}
