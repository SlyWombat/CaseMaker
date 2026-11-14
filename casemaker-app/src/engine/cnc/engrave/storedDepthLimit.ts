/**
 * #1126 — A DEPTH LIMIT THAT SURVIVES AS PLAIN DATA.
 *
 * The depth limit a program was verified under is a function, and a function cannot be stored. What
 * it is COMPOSED FROM can, and this module is both halves: {@link StoredDepthLimit} is the data the
 * posting path writes, and {@link depthLimitFromStored} rebuilds the same limit from it — pure
 * arithmetic, no wasm, no worker — so the re-check of a restored run judges the program under the
 * limit it was first verified with, not a nearby one.
 *
 * WHAT IS STORED, EXACTLY:
 *  - `marginMm`     the boundary margin the job's limit is composed with (#345);
 *  - `bedBoardMm`   the wasteboard under a bed job (#712), or null;
 *  - `through`      the THROUGH MASK's geometry — the through regions' opened polygons, the through
 *                   drills' holes and radius, and each cut-out's centre path, tab spans, radius and
 *                   tab height (`MaskGeometry`: plain numbers). The mask itself is arithmetic over
 *                   exactly that geometry (`buildThroughMask`), so it is rebuilt, not approximated;
 *                   null when the job has no through work;
 *  - `stack`        the LAYER STACK's sliced solid for a printed blank (#285): per layer, the
 *                   region still solid from the face down to that layer's far edge (the running
 *                   intersection's polygons, read off the wasm sections before they are freed) and
 *                   each layer's far edge. `maxDepthAt` over it is a point-in-polygon walk, the same
 *                   walk the live stack does; null for a blank with no print.
 * Nothing is sampled and nothing is approximated: the rebuilt limit equals the first one at every
 * point (`verifyContextPaths1126.spec.ts` compares them across the blank).
 */
import { jobDepthLimit, keepOutNameAt } from '@/engine/cnc/engrave/partPlan';
import { ceilingName, voidFloor } from '@/engine/cnc/engrave/depthBounds';
import { buildThroughMask, type MaskGeometry } from '@/engine/cnc/engrave/throughMask';
import { sacrificialDepthLimit, type DepthLimit, type ThroughMask } from '@/engine/cnc/verify';
import type { EngraveJob } from '@/types/engraveJob';
import type { Mm, Vec2 } from '@/types/units';

/** The sliced solid of a printed blank: `z1[i]` is layer i's far edge, `running[i]` what is solid down to it. */
export interface LayerSolid {
  z1: number[];
  running: Vec2[][][];
}

export interface StoredDepthLimit {
  marginMm: number;
  bedBoardMm: number | null;
  through: MaskGeometry | null;
  stack: LayerSolid | null;
}

const EPS = 1e-9;

/** Even-odd point-in-region over a set of contours (the layer stack's own walk). */
function pointInPolys(polys: readonly Vec2[][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of polys) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i]![0];
      const yi = ring[i]![1];
      const xj = ring[j]![0];
      const yj = ring[j]![1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The deepest a cutter may reach at (x, y) by the sliced solid: 0 = no cutting allowed. */
export function maxDepthIn(solid: LayerSolid, x: Mm, y: Mm): Mm {
  for (let i = 0; i < solid.running.length; i++) {
    if (!pointInPolys(solid.running[i]!, x, y)) return i === 0 ? 0 : solid.z1[i - 1]!;
  }
  return solid.z1[solid.z1.length - 1]!;
}

/**
 * The layer stack's limit composition (#285/#345), given the solid's answer: the sacrificial limit,
 * tightened by the solid's ceiling (less the margin) outside any through region or kerf.
 */
export function composeStackLimit(
  job: EngraveJob,
  solidAt: (x: Mm, y: Mm) => Mm,
  margin: Mm,
  through: ThroughMask | undefined,
  bedBoardMm: number | null | undefined,
): { limit: DepthLimit; reasonAt: (x: Mm, y: Mm) => 'void' | 'stock' } {
  const sacrificial = sacrificialDepthLimit(job.stock, job.sacrificial, {
    minFloor: job.minFloor,
    breakthrough: job.breakthrough,
    ...(through === undefined ? {} : { through }),
    ...(bedBoardMm === undefined || bedBoardMm === null ? {} : { bedBoardMm }),
  });
  return {
    limit(x, y) {
      const base = sacrificial(x, y);
      // Inside a through region or kerf the board is the floor, so the SOLID cannot bind.
      if (through !== undefined && through(x, y) !== null) return base;
      const solid = solidAt(x, y);
      // Outside the part the stack reports nothing: that is "no material", not "no cutting".
      if (solid <= EPS) return base;
      return Math.min(base, voidFloor(solid, margin));
    },
    reasonAt(x, y) {
      const solid = solidAt(x, y);
      return solid > EPS && solid < sacrificial(x, y) - EPS ? 'void' : 'stock';
    },
  };
}

/** The tail of the `cut-too-deep` sentence: which plane the limit at (x, y) is (#285, #345). */
export function depthLimitReason(stack: { reasonAt(x: Mm, y: Mm): 'void' | 'stock' }, job: EngraveJob, x: Mm, y: Mm): string {
  if (stack.reasonAt(x, y) === 'stock') return '— the floor the job keeps under the stock';
  return `— ${ceilingName(keepOutNameAt(job, x, y) ?? '')}`;
}

/** The limit a stored description composes, and the words for it where the first verification had them. */
export function depthLimitFromStored(
  job: EngraveJob,
  stored: StoredDepthLimit,
): { limit: DepthLimit; limitReasonAt?: (x: number, y: number) => string } {
  const through = stored.through === null ? undefined : (buildThroughMask(stored.through) ?? undefined);
  if (stored.stack === null) {
    return { limit: jobDepthLimit(job, stored.marginMm, through, stored.bedBoardMm) };
  }
  const solid = stored.stack;
  const composed = composeStackLimit(job, (x, y) => maxDepthIn(solid, x, y), stored.marginMm, through, stored.bedBoardMm);
  return { limit: composed.limit, limitReasonAt: (x, y) => depthLimitReason(composed, job, x, y) };
}
