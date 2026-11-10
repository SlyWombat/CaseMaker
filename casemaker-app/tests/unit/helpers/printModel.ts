/**
 * #1180 S2 — the print side's shared model helpers.
 *
 * These four were copied verbatim into ~20 print specs (`makeBoard` in 9, `countOps` in 10,
 * `bodies` in 5, `probeMaterial` in 6). The copies had already drifted only in ways that did not
 * matter (an unused `z` default, a probe cube size), so they are moved here as they were — a change
 * to the BuildOp primitives or the board schema is now one edit, and the specs' mesh work can be
 * shared on top (S3). The three specs whose `makeBoard` is a DIFFERENT fixture (boardSnap's
 * 40 × 50/standoff 5, boardVisualAssets' 50 × 40/3, chevronVent's 60 × 60/4) keep their own — a
 * shared name there would hide three distinct boards, not remove duplication.
 */

import type { BoardProfile } from '@/types';
import { cube, intersection, translate, type BuildOp } from '@/engine/compiler/buildPlan';
import { exec } from './manifoldExec';

/** A minimal, schema-valid board of `x` × `y` mm (1.6 mm PCB unless `z` says otherwise). */
export function makeBoard(x: number, y: number, z = 1.6): BoardProfile {
  return {
    id: `t-${x}x${y}`,
    name: 'T',
    manufacturer: 'T',
    pcb: { size: { x, y, z } },
    mountingHoles: [{ id: 'h1', x: 5, y: 5, diameter: 2.5 }],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 10,
    source: 'https://example.com',
    builtin: false,
  };
}

/** How many ops of `kind` a BuildOp tree holds, at any depth. */
export function countOps(op: BuildOp, kind: BuildOp['kind']): number {
  let n = op.kind === kind ? 1 : 0;
  if ('child' in op && op.child) n += countOps(op.child, kind);
  if ('children' in op) for (const c of op.children) n += countOps(c, kind);
  return n;
}

/** Positive-volume bodies in a solid. `decompose()` counts sealed voids as components too
 *  (negative volume), and they are not printed parts. */
export function bodies(op: BuildOp): number {
  const m = exec(op);
  const n = m.decompose().filter((c) => c.volume() > 0).length;
  m.delete();
  return n;
}

/** Volume of `op` ∩ a `size` cube centred on `p` — full volume means material there, 0 a void.
 *  The cube has to fit inside the feature being probed (a 0.8 mm channel needs `size` < 0.8). */
export function probeMaterial(op: BuildOp, p: [number, number, number], size = 1): number {
  const hit = exec(intersection([op, translate(p, cube([size, size, size], true))]));
  const v = hit.volume();
  hit.delete();
  return v;
}
