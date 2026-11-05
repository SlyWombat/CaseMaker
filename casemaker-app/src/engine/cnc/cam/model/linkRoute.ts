/**
 * linkRoute.ts — A PATH FOR THE CUTTER'S CENTRE INSIDE A POCKET'S CLEARED AREA (#962, the manager's
 * 11-05 ruling). The straight stay-down chord is refused when it crosses ground the op is not
 * cutting; today's fallback is a full retract (up, across at the hop plane, down, then a long feed
 * at depth). On the tray that is 226 legs and ~487 s of rapid. This module routes the join instead:
 * the shortest path that stays inside the cleared region ERODED BY THE CUTTER RADIUS, so the whole
 * disc stays in cleared material, with every sample over B's below-material guard. The caller
 * (link(), when the chord is refused) chooses feed at depth or a rapid at the in-pocket safe Z by
 * the time guard against the retract it replaces. `rapidZMm` is the in-pocket rapid plane — the
 * caller must keep it ABOVE the cut level (a G0 at cutting depth is wrong; a link at depth is a
 * feed), so the pocket passes levelZ + 1 mm clamped to its hop plane.
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
  /** The longest graph edge to consider, mm; absent → 40. */
  maxEdgeMm?: number;
  /** Sample spacing for the inside-the-polygon and below-material guards, mm; absent → 0.05. */
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
export interface RouteGraph {
  /** Reflex vertices of the cleared polygon (the visibility graph's nodes), plus their tags. */
  nodes: { x: number; y: number }[];
  /** Adjacent-node lists, edges proved at the COARSE pitch (the final path is re-proved at 0.05). */
  adj: number[][];
  /** The cleared polygon, the level and the material field the graph was built against. */
  cleared: Polygons;
  levelZ: number;
  materialAt: (x: number, y: number) => number | null;
}

/** Coarse edge proof pitch: cheap, and the chosen path is verified at the fine pitch afterwards. */
const COARSE_MM = 0.5;
/** Fine verification pitch — the same pitch the #959 guard samples feeds at. */
const FINE_MM = 0.05;

function walkableAt(cleared: Polygons, materialAt: (x: number, y: number) => number | null, a: { x: number; y: number }, b: { x: number; y: number }, z: number, step: number): boolean {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(len / step));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (!insideClosed(cleared, x, y)) return false;
    const top = materialAt(x, y);
    if (top === null || z < top - 1e-6) return false;
  }
  return true;
}

/** The polygon's reflex vertices: any vertex whose turn has the opposite sign to the ring's winding. */
function reflexVertices(cleared: Polygons): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const ring of cleared) {
    const n = ring.length;
    if (n < 3) continue;
    let area = 0;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[(i + 1) % n]!;
      area += x0 * y1 - x1 * y0;
    }
    const orientation = Math.sign(area);
    for (let i = 0; i < n; i++) {
      const [ax, ay] = ring[(i + n - 1) % n]!;
      const [bx, by] = ring[i]!;
      const [cx, cy] = ring[(i + 1) % n]!;
      const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
      if (Math.sign(cross) !== orientation && Math.abs(cross) > 1e-12) out.push({ x: bx, y: by });
    }
  }
  return out;
}

/**
 * Build the visibility graph for a cleared polygon at one level — ONCE per pocket level, reused by
 * every join (the manager's cost ruling). Nodes are the polygon's REFLEX vertices only (tens, not
 * the full outline); edges are prefiltered by length and proved at the coarse pitch.
 */
export function buildRouteGraph(
  cleared: Polygons,
  levelZ: number,
  materialAt: (x: number, y: number) => number | null,
  maxEdgeMm: number,
): RouteGraph {
  const nodes = reflexVertices(cleared);
  const adj: number[][] = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      if (Math.hypot(b.x - a.x, b.y - a.y) > maxEdgeMm) continue; // length prefilter
      if (walkableAt(cleared, materialAt, a, b, levelZ, COARSE_MM)) {
        adj[i]!.push(j);
        adj[j]!.push(i);
      }
    }
  }
  return { nodes, adj, cleared, levelZ, materialAt };
}

/**
 * Route one join on a prebuilt graph: the endpoints join the graph as two more nodes, Dijkstra
 * picks the path, and the CHOSEN path alone is re-proved at the fine pitch (0.05 mm) before it is
 * returned — the coarse build can only save time, never certify a path the guard would refuse.
 */
export function routeOnGraph(
  graph: RouteGraph,
  from: RoutePoint,
  to: RoutePoint,
  maxEdgeMm: number,
): Route | null {
  const nodes = [...graph.nodes, { x: from.x, y: from.y }, { x: to.x, y: to.y }];
  const n = nodes.length;
  const f = n - 2;
  const t = n - 1;
  const adj: number[][] = [...graph.adj.map((l) => [...l]), [], []];
  const link = (i: number, j: number): void => {
    if (i === j) return;
    if (Math.hypot(nodes[j]!.x - nodes[i]!.x, nodes[j]!.y - nodes[i]!.y) > maxEdgeMm) return;
    if (walkableAt(graph.cleared, graph.materialAt, nodes[i]!, nodes[j]!, graph.levelZ, COARSE_MM)) {
      adj[i]!.push(j);
      adj[j]!.push(i);
    }
  };
  for (let i = 0; i < n - 2; i++) {
    link(f, i);
    link(t, i);
  }
  link(f, t);
  const dist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[f] = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i]! < dist[u]!)) u = i;
    if (u < 0 || !Number.isFinite(dist[u]!)) break;
    done[u] = true;
    if (u === t) break;
    for (const v of adj[u]!) {
      const w = Math.hypot(nodes[v]!.x - nodes[u]!.x, nodes[v]!.y - nodes[u]!.y);
      if (dist[u]! + w < dist[v]!) {
        dist[v] = dist[u]! + w;
        prev[v] = u;
      }
    }
  }
  if (!Number.isFinite(dist[t]!)) return null;
  const path: number[] = [];
  for (let v = t; v !== -1; v = prev[v]!) path.push(v);
  path.reverse();
  const points: RoutePoint[] = path.map((i) => ({ x: nodes[i]!.x, y: nodes[i]!.y, z: graph.levelZ }));
  for (let i = 1; i < points.length; i++) {
    if (!walkableAt(graph.cleared, graph.materialAt, points[i - 1]!, points[i]!, graph.levelZ, FINE_MM)) return null;
  }
  const lengthMm = points.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y), 0);
  return { points, lengthMm };
}

/** The one-join entry (kept for callers without a cached graph): build, then route. */
export function routeWithin(from: RoutePoint, to: RoutePoint, opts: RouteOptions): Route | null {
  const maxEdgeMm = opts.maxEdgeMm !== undefined && opts.maxEdgeMm > 0 ? opts.maxEdgeMm : 40;
  const graph = buildRouteGraph(opts.cleared, opts.levelZ, opts.materialAt, maxEdgeMm);
  return routeOnGraph(graph, from, to, maxEdgeMm);
}
