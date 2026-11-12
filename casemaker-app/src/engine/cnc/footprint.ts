/**
 * #1235 stage 2 — THE REGION A CUT MAY TRAVEL OVER, in the program's (setup's) own frame, mm.
 *
 * The verifier's `cut-outside-footprint` rule asks one question: how far outside this region does
 * a cutting feed's centre end? The region is a LIST OF SHAPES — rectangles for a blank and its
 * sacrificial side strips, a circle for round stock — because a job has no single "the stock's
 * rectangle" (#1235's ruling on the first stage-2 hand-in: the limit stays cutter radius + one
 * posted step, and what changes is what it is measured FROM).
 *
 * The shapes are supplied by whoever builds the verifier context — the same place, and from the
 * same facts, as the depth limit. The verifier never rebuilds this region from the job and never
 * guesses: absent means no footprint was stated, and the rule does not run.
 */
import type { EngraveJob, Sacrificial } from '@/types/engraveJob';
import { sacrificialBoxes } from './sacrificial';

/** One shape of the cuttable region, in the program's frame, mm. */
export type FootprintShape =
  | { kind: 'rect'; x: number; y: number; length: number; width: number }
  | { kind: 'circle'; cx: number; cy: number; radius: number };

/** The stock facts a footprint needs: its box, and whether the box is round in plan. */
export interface FootprintStock {
  length: number;
  width: number;
  thickness: number;
  shape?: 'cylinder' | 'disc';
  diameter?: number;
}

/**
 * The blank's own outline as ONE shape. `'cylinder'` and `'disc'` are both round in plan (#743
 * D6: a disc is a round blank milled flat; a standing cylinder is a rod milled on its end), so
 * both read as the circle of the stated diameter. Absent is the rectangle `[0, L] × [0, W]`.
 */
export function blankFootprint(stock: FootprintStock): FootprintShape {
  if (stock.shape === 'cylinder' || stock.shape === 'disc') {
    const radius = (stock.diameter ?? Math.min(stock.length, stock.width)) / 2;
    return { kind: 'circle', cx: stock.length / 2, cy: stock.width / 2, radius };
  }
  return { kind: 'rect', x: 0, y: 0, length: stock.length, width: stock.width };
}

/**
 * The blank plus every piece of sacrificial material's XY extent — the region a cut may travel
 * over without leaving material (#213 §3; `supportedFootprint` states the same union as a
 * profile). With no sacrificial material the list is the blank's own shape alone.
 */
export function supportedFootprintShapes(
  stock: FootprintStock,
  sacrificial: Sacrificial | undefined,
): FootprintShape[] {
  const shapes: FootprintShape[] = [blankFootprint(stock)];
  if (sacrificial === undefined) return shapes;
  for (const box of sacrificialBoxes(stock, sacrificial)) {
    shapes.push({
      kind: 'rect',
      x: box.min[0],
      y: box.min[1],
      length: box.max[0] - box.min[0],
      width: box.max[1] - box.min[1],
    });
  }
  return shapes;
}

/**
 * A JOB's footprint in its own work frame: the blank's outline (rectangle, or the circle of a
 * round blank) plus every sacrificial piece.
 */
export function jobFootprint(job: EngraveJob): FootprintShape[] {
  return supportedFootprintShapes(job.stock, job.sacrificial);
}

/**
 * A SETUP's footprint in that setup's own frame (#1235's ruling: each setup is judged against
 * its own stock). The stock is resolved exactly as the setup's depth limit resolves it
 * (`stockForSetup`, #1082): the setup's stated box when it has one, else the job's blank. A
 * stated setup box is a plain box (no round face is stated), so it reads as a rectangle; the
 * job's blank keeps its own shape (a circle for a rod or disc). The job's sacrificial material
 * belongs to the job's blank, so it is included only where the blank is the stock.
 */
export function setupFootprint(job: EngraveJob, setupIndex: number): FootprintShape[] {
  const own = job.setups?.[setupIndex]?.stock;
  if (own !== undefined) return supportedFootprintShapes(own, undefined);
  return jobFootprint(job);
}

/**
 * How far `(x, y)` lies outside the UNION of `shapes`, mm; 0 when inside any one of them.
 *
 * A point outside every shape takes its distance to the nearest shape: the union's distance is
 * the minimum over its members, and touching rectangles therefore meet with distance 0 over the
 * seam (the point is inside both).
 */
export function distanceOutsideFootprint(
  x: number,
  y: number,
  shapes: readonly FootprintShape[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const shape of shapes) {
    const d =
      shape.kind === 'circle'
        ? Math.hypot(x - shape.cx, y - shape.cy) - shape.radius
        : Math.hypot(
            Math.max(shape.x - x, 0, x - (shape.x + shape.length)),
            Math.max(shape.y - y, 0, y - (shape.y + shape.width)),
          );
    if (d <= 0) return 0;
    if (d < nearest) nearest = d;
  }
  return nearest;
}
