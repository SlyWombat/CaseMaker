/**
 * cam/model/ops/chamfer.ts — §3.5 of `docs/design/cam-model-engine.md` (#960).
 *
 * Chamfer / edge-break as its own op, on each `Rim`. `generateChamfer` (`cam/chamfer.ts:65`) is
 * already a standalone op module with its own result type — this op calls it, it does not rework
 * it. Sizing comes from `ModelPlanInput.edgeBreak` (A's R3 on #956: the job's own field, read
 * independently of the gate's allowance, never from this engine's plan output).
 *
 * THE GEOMETRY, as `cam/chamfer.ts`'s own header derives it: the tip plane sits exactly at the
 * bevel's bottom (`depth = width / tan α`), and the tool's centre runs one TIP RADIUS from the
 * edge on the AIR side — outside the part for the outer contour, into a pocket for its rim. The
 * job's `edgeBreak.legMm` IS that depth; this op caps it at the cone's own leg (the deepest its
 * flank reaches at the outer radius) and refuses a zero-depth bevel rather than posting a scratch.
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import type { CutParams } from '@/engine/cnc/feeds';
import type { RapidEstimate } from '@/engine/cnc/cam/ir';
import { generateChamfer, type ChamferCut } from '@/engine/cnc/cam/chamfer';
import { coneHeight, vCone } from '@/engine/cnc/vProfile';
import type { OffsetFn, Polygons } from '@/engine/cnc/cam/pocket';
import { cutterKeyOf } from '../sequence';
import type { Rim } from '../features';
import type { OpOutcome, PassRef, RegionRef } from '../plan';
import type { EdgeBreakSpec } from '../types';

export interface ChamferOpOptions {
  cutter: Tool;
  rim: Rim;
  region: RegionRef;
  edgeBreak: EdgeBreakSpec;
  /** The real Clipper2 offset (as the pocket op takes) — the path's tip-radius offset. */
  offset: OffsetFn;
  params: CutParams;
  rapid: RapidEstimate;
}

function signedArea(ring: readonly [number, number][]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j]![0] - ring[i]![0]) * (ring[j]![1] + ring[i]![1]);
  }
  return area / 2;
}

/** The rim's polyline as a closed, counter-clockwise ring. */
function closedRing(polyline: readonly [number, number][]): [number, number][] {
  const points = polyline.map((p) => [p[0], p[1]] as [number, number]);
  const first = points[0];
  const last = points[points.length - 1];
  if (first !== undefined && last !== undefined && (first[0] !== last[0] || first[1] !== last[1])) {
    points.push([first[0], first[1]]);
  }
  return signedArea(points) < 0 ? points.reverse() : points;
}

export function chamfer(opts: ChamferOpOptions): OpOutcome {
  if (!((cuttingDiameter(opts.cutter) ?? 0) > 0)) {
    throw new Error(`cam/model/ops/chamfer: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const cone = vCone(opts.cutter);
  if (cone === null) {
    throw new Error(`cam/model/ops/chamfer: ${opts.cutter.name || opts.cutter.shape} is not a cone — a chamfer is one bevel cut by a cone's flank`);
  }
  const coneLeg = coneHeight(cone);
  const wanted = opts.edgeBreak.legMm;
  const depth = Math.max(0, coneLeg === null ? wanted : Math.min(wanted, coneLeg));
  if (!(depth > 0)) {
    throw new Error('cam/model/ops/chamfer: the stated edge break has no depth — a zero-depth bevel is not a cut');
  }

  const ring = closedRing(opts.rim.polyline);
  // The tool's centre runs a TIP RADIUS off the edge on the AIR side: outward for the part's own
  // contour, into the pocket for a pocket rim (`of` is the region the rim belongs to).
  const airSign = opts.rim.of === 'contour' ? 1 : -1;
  // THE REAL RIMS FOUND THIS: a rim whose polyline winds against its region, or one whose own
  // width is under the tip radius, offsets EMPTY on the named side. Try the other side, then a
  // point-tipped reading (the path on the edge itself) rather than refusing a rim the tree
  // reported — the bevel is real either way; the tip's 0.05 mm is the only difference.
  let path: Polygons = cone.tipRadius > 0 ? opts.offset([ring], airSign * cone.tipRadius) : [ring];
  if (path.length === 0 && cone.tipRadius > 0) path = opts.offset([ring], -airSign * cone.tipRadius);
  if (path.length === 0) path = [ring];

  // `generateChamfer` places the tip plane at `-cut.depth`, and this engine's IR Z 0 is the stock
  // top while the rim states its own Z: the cut's depth is the tip plane's distance below Z 0.
  const tipZ = opts.rim.z - depth;
  const cut: ChamferCut = {
    id: opts.rim.id,
    name: `Chamfer "${opts.rim.id}"`,
    path,
    depth: -tipZ,
  };
  const ir = generateChamfer([cut], opts.cutter, opts.params, opts.rapid);

  const passes: PassRef[] = [];
  for (const contour of path) {
    const start = contour[0];
    if (start === undefined) continue;
    passes.push({
      z: tipZ,
      boundary: [contour],
      cleared: { z: tipZ, boundary: [contour] },
      entry: [start[0], start[1], tipZ],
      exit: [start[0], start[1], tipZ],
    });
  }
  return { ir, cutter: cutterKeyOf(opts.cutter), passes };
}
