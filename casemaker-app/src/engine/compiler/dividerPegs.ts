import type { Mm } from '@/types';
import {
  cube,
  translate,
  union,
  type BuildNode,
  type BuildOp,
} from './buildPlan';
import type { HoleGridOptions } from './holeGrid';

/**
 * Issue #150 — the drop-in peg family that fits the `holeGrid` sockets.
 *
 * A peg is one wall plate with a square tenon under each end. Drop it in and it
 * partitions the cavity; take it out and the floor is flat again. Widths are
 * quoted in HOLE SPANS, which is how the reviewed system quotes them too, so a
 * peg is described by the grid it lands in rather than by a millimetre figure
 * that stops being true when the pitch changes.
 *
 * Everything here is in the PEG's own frame: X along the wall, Y across its
 * thickness, Z up from the floor plane. The tenons hang BELOW z = 0, into the
 * sockets — so the part sits in assembly orientation and a host can place it at
 * the floor's Z with no further transform.
 */

/** End overhang past the outer tenon, per side, mm.
 *
 *  Measured, not chosen. ToolStack's pegs are 21.6 wide spanning 2 holes and
 *  33.6 spanning 3 (`/Toolbox.md`, "Interface 3 of 3"), against a 12.0 pitch:
 *  (21.6 − 12.0) / 2 = 4.8 and (33.6 − 24.0) / 2 = 4.8. The 5-hole peg measures
 *  56.6, which the same rule would put at 57.6 — 1.0 mm adrift on a 56.6 mm
 *  hand-measurement, so the rule is kept and the outlier recorded here rather
 *  than averaged in. */
export const PEG_WIDTH_EAR = 4.8;

/** Socket side minus tenon side, mm — the slip fit that lets a peg drop in.
 *
 *  PROVISIONAL: this is a FIT, and no peg has been printed here. It is the one
 *  number in this module that is ours rather than measured, and #153's fit
 *  variants are where it should get a measured value. A loose 0.4 will rattle;
 *  a tight 0.2 will not drop in on a printer running wide. */
export const PEG_TENON_FIT = 0.3;

/** How far the tenon stops short of the socket floor, mm.
 *
 *  PROVISIONAL, same reason. A gap keeps a stray blob or a bit of swarf from
 *  holding the peg proud and rocking the divider. */
export const PEG_TENON_BOTTOM_GAP = 0.4;

export interface DividerPegSpec {
  /** Stable id; the emitted node is `divider-peg-<id>`. */
  id: string;
  /** How many hole spans the wall crosses, centre to centre. 1 = one tenon. */
  spans: number;
  /** Wall height above the cavity floor, mm. */
  height: Mm;
  /** Wall thickness, mm. */
  thickness: Mm;
  enabled: boolean;
}

export interface DividerPegContext {
  /** The grid the pegs land in — only `pitch` and `socket` are read. */
  grid: Pick<HoleGridOptions, 'pitch' | 'socket'>;
  /** How deep the sockets are cut, mm — how far the tenons reach. */
  socketDepth: Mm;
  /** Socket minus tenon. Defaults to `PEG_TENON_FIT`. */
  tenonFit?: number;
  /** Tenon stops this far short of the socket floor. */
  bottomGap?: number;
  /** End overhang per side. Defaults to `PEG_WIDTH_EAR`. */
  ear?: number;
}

/**
 * The wall's overall length for a peg spanning `spans` holes: the outer tenon
 * centres are `(spans − 1)` pitches apart, plus the end overhang at each end.
 *
 * This is the rule `PEG_WIDTH_EAR` was derived from, and `tests/unit/
 * dividerPegs.spec.ts` pins it against the three measured pegs so a change to
 * the ear is caught here rather than in a print.
 */
export function pegWidth(spans: number, pitch: number, ear = PEG_WIDTH_EAR): number {
  return (spans - 1) * pitch + 2 * ear;
}

/** Why these numbers cannot make a peg, or null when they can. */
export function dividerPegProblem(spec: DividerPegSpec, ctx: DividerPegContext): string | null {
  if (!(spec.spans >= 1)) return 'A peg must span at least one hole';
  // WHOLES ONLY. The tenons sit `(spans − 1)` pitches apart, so a fractional
  // span puts them BETWEEN holes: the peg would stand on the floor with its
  // tenons jammed against socket walls rather than sitting in them, and the
  // panel would draw it as if it were fine. There is no half socket.
  if (!Number.isInteger(spec.spans)) {
    return `Peg ${spec.id}: ${spec.spans} holes is not a whole number of holes`;
  }
  if (!(spec.height > 0)) return `Peg ${spec.id}: height must be greater than zero`;
  if (!(spec.thickness > 0)) return `Peg ${spec.id}: thickness must be greater than zero`;
  const fit = ctx.tenonFit ?? PEG_TENON_FIT;
  if (!(ctx.grid.socket - fit > 0)) {
    return `Peg ${spec.id}: a ${fit} mm fit leaves no tenon in a ${ctx.grid.socket} mm socket`;
  }
  const reach = ctx.socketDepth - (ctx.bottomGap ?? PEG_TENON_BOTTOM_GAP);
  if (!(reach > 0)) return `Peg ${spec.id}: no tenon engages a ${ctx.socketDepth} mm socket`;
  return null;
}

/** One peg as a single connected solid, in assembly orientation (see header). */
export function buildDividerPegOp(spec: DividerPegSpec, ctx: DividerPegContext): BuildOp | null {
  if (dividerPegProblem(spec, ctx)) return null;
  const { pitch, socket } = ctx.grid;
  const fit = ctx.tenonFit ?? PEG_TENON_FIT;
  const gap = ctx.bottomGap ?? PEG_TENON_BOTTOM_GAP;
  const ear = ctx.ear ?? PEG_WIDTH_EAR;

  const length = pegWidth(spec.spans, pitch, ear);
  const tenonSide = socket - fit;
  const reach = ctx.socketDepth - gap;
  // Outer tenon centres, measured from the peg's own centre.
  const halfSpan = ((spec.spans - 1) * pitch) / 2;

  const wall = translate(
    [-length / 2, -spec.thickness / 2, 0],
    cube([length, spec.thickness, spec.height]),
  );

  const tenons = (spec.spans === 1 ? [0] : [-halfSpan, halfSpan]).map((cx) =>
    translate([cx - tenonSide / 2, -tenonSide / 2, -reach], cube([tenonSide, tenonSide, reach])),
  );

  return union([wall, ...tenons]);
}

/**
 * One `BuildNode` per enabled peg, skipped when a spec cannot build.
 *
 * Emitted as top-level nodes for the same reason the latch arms and flex
 * bumpers are (`ProjectCompiler.ts`, `latchOps.armNodes` / `ruggedOps.
 * bumperNodes`): a peg is a free part that prints on its own, not a feature of
 * the shell, and fusing it into the case mesh would make it un-printable as
 * something you drop in later.
 */
export function buildDividerPegOps(
  specs: readonly DividerPegSpec[],
  ctx: DividerPegContext,
): BuildNode[] {
  const nodes: BuildNode[] = [];
  for (const spec of specs) {
    if (!spec.enabled) continue;
    const op = buildDividerPegOp(spec, ctx);
    if (!op) continue;
    nodes.push({ id: `divider-peg-${spec.id}`, op });
  }
  return nodes;
}
