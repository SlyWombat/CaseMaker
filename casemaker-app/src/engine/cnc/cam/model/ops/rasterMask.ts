/**
 * cam/model/ops/rasterMask.ts — the grid→rectilinear-polygon-loop stitching `rough()`'s own level
 * mask and `pocket()`'s #966 per-level shadow mask both need: every cell an `inside` predicate
 * marks true becomes one unit square, the shared edges between two inside cells are dropped, and
 * what is left is stitched head-to-tail into rings (CCW outers, CW holes — the winding Clipper2's
 * offset expects).
 *
 * Extracted from `ops/rough.ts`'s own `maskLoops` (#959/#960), parameterised over the predicate so
 * #966's pocket shadow mask (`ops/pocket.ts`) can share the exact same geometry without
 * duplicating it — only the INSIDE RULE differs between the two callers (rough's own "below the CL
 * surface, not yet at its own target" vs. pocket's "nothing solid above this level, read off the
 * real design mesh"). No behaviour change to `rough()`: this is a pure extraction, `maskLoops`
 * there is now a thin wrapper building its own `inside` closure and delegating here.
 */
import type { Polygons } from '@/engine/cnc/cam/pocket';

export function maskLoopsFromPredicate(
  nx: number,
  ny: number,
  x0: number,
  y0: number,
  pitch: number,
  inside: (i: number, j: number) => boolean,
): Polygons {
  type Edge = { a: [number, number]; b: [number, number] };
  const edges: Edge[] = [];
  const push = (ai: number, aj: number, bi: number, bj: number): void => {
    edges.push({ a: [x0 + ai * pitch, y0 + aj * pitch], b: [x0 + bi * pitch, y0 + bj * pitch] });
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!inside(i, j)) continue;
      // The cell's own CCW boundary in (x up, y up), keeping only the sides facing OUTSIDE.
      if (!inside(i, j - 1)) push(i, j, i + 1, j); // bottom
      if (!inside(i + 1, j)) push(i + 1, j, i + 1, j + 1); // right
      if (!inside(i, j + 1)) push(i + 1, j + 1, i, j + 1); // top
      if (!inside(i - 1, j)) push(i, j + 1, i, j); // left
    }
  }
  if (edges.length === 0) return [];
  const key = (p: readonly [number, number]): string => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const byStart = new Map<string, Edge[]>();
  for (const e of edges) {
    const list = byStart.get(key(e.a));
    if (list === undefined) byStart.set(key(e.a), [e]);
    else list.push(e);
  }
  const used = new Set<Edge>();
  const loops: Polygons = [];
  for (const startEdge of edges) {
    if (used.has(startEdge)) continue;
    const ring: [number, number][] = [];
    let current: Edge | undefined = startEdge;
    while (current !== undefined && !used.has(current)) {
      used.add(current);
      ring.push(current.a);
      const nextList: Edge[] = byStart.get(key(current.b)) ?? [];
      current = nextList.find((e: Edge) => !used.has(e));
    }
    if (ring.length >= 4) loops.push(ring);
  }
  return loops;
}
