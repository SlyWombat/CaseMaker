/**
 * #1180 — the #764 shell fixtures, shared by `goalClearAround` (the plan and the heightfield) and
 * `goalClearDefer1151` (the deferred ideal), split so the two heavy cases run in parallel workers.
 * Moved verbatim.
 */

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { stl } from './meshes';

export type V = [number, number, number];
type Tri = [V, V, V];

// ── The part and the blank (the #754 mouse shell) ──────────────────────────────────────────────
export const A = 30;
export const B = 17;
export const H = 20;
export const BLANK = { length: 80, width: 50, thickness: 26 };
export const CX = 40;
export const CY = 25;
export const PITCH = 0.25;
export const STOCK_RECT = { xMin: 0, xMax: BLANK.length, yMin: 0, yMax: BLANK.width };

export function shell(a: number, b: number, h: number, x: number, y: number): number {
  const u2 = (x / a) ** 2 + (y / b) ** 2;
  if (u2 >= 1) return 0;
  return h * Math.sqrt(1 - u2) * (0.85 + 0.15 * (x / a));
}
export const zOut = (x: number, y: number): number => shell(A, B, H, x, y);
export const crownOf = (f: (x: number, y: number) => number): number => {
  let best = 0;
  for (let i = 0; i <= 400; i++) best = Math.max(best, f((i / 400) * A, 0));
  return best;
};
export const CROWN = crownOf(zOut);
export const BASE_Z = -CROWN;

export function surfaceTris(f: (x: number, y: number) => number, seg = 64): Tri[] {
  const at = (r: number, t: number): V => {
    const x = A * r * Math.cos(2 * Math.PI * t);
    const y = B * r * Math.sin(2 * Math.PI * t);
    return [x, y, f(x, y)];
  };
  const tris: Tri[] = [];
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const p = at(i / seg, j / seg);
      const q = at((i + 1) / seg, j / seg);
      const r = at((i + 1) / seg, (j + 1) / seg);
      const s = at(i / seg, (j + 1) / seg);
      tris.push([p, q, r], [p, r, s]);
    }
  }
  return tris;
}

let serial = 0;
export function goal(f: (x: number, y: number) => number, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'shell',
    name: 'mouse-shell.stl',
    format: 'stl',
    sha256: (serial++).toString(16).padStart(64, 'c'),
    data: stl(surfaceTris(f)),
    size: { x: 2 * A, y: 2 * B, z: CROWN },
    position: { x: CX, y: CY, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

// ── The cutter and the ring ──────────────────────────────────────────────────────────────────────
/** Makera's ⌀2 ball (the demo's own cutter). */
export const BALL_R = 1;
export const BALL_TOOL = flatEndMill(2 * BALL_R, { shape: 'ball', name: '2 mm ball nose' });

export function job(target: EngraveTargetObject): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, ...BLANK },
    targetObject: target,
  };
}
