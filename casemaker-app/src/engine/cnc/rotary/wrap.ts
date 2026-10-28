/**
 * The rotary MAP (#240 slice 2, `/Rotary.md` R6, R9, R10, R12; design `rotary-flow.md` §3.7–§3.9).
 *
 * A rotary job is authored ON THE SURFACE, unrolled: `position.x` is millimetres ALONG the axis
 * from the jaws, `position.y` is millimetres AROUND the stock — arc length at the design radius
 * `R = ⌀/2`, zero at the seam (A = 0). The document does not change shape: the same label and
 * shape fields carry map coordinates when the stock is a cylinder. This module is the one place
 * that map's algebra lives, so the CAM, the verifier and the oracle cannot disagree about it:
 *
 *   - `arcToAngle` / `angleToArc` — `s = R·θ_rad`, R9's unwound A in degrees;
 *   - `aroundScale` — the map's around axis scaled into the tool's FOOTPRINT frame,
 *     `r_t / (R·atan(r_t/(R − d)))`. In that space an isotropic offset by `r_t` is the tool's own
 *     footprint on the map — `r_t` along X, `R·atan(r_t/(R − d))` around. The R10 design's
 *     `r_t · R/(R − d)` is the small-angle form of that arc (they agree to 0.1 % at engraving
 *     angles; at 32° the linear form over-claims by 12 %, and the opening, the CAM's first
 *     erosion and the oracle's facet allowance are only the same object in the exact form);
 *   - `aroundOpeningRadius` — the around half-width that opening comes out at,
 *     `R·atan(r_t/(R − d))`;
 *   - `facetTerm` — the R10/R-2 chord allowance `√(Z_t² + r_t²) − Z_t`, the depth by which the
 *     flat tip's straight edge sits above the floor at the edge of its own footprint;
 *   - `toRotaryIR` — the flat map-space IR turned into the rotary frame: every move's `y` becomes
 *     `a`, `y` becomes 0, and `z` becomes radial height above the axis.
 *
 * Everything here is pure data: no wasm, no machine, and no number that is not either the job's
 * own or a named Case Maker / Makera constant below.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { CamMove, CamOperation, ToolpathIR } from '@/engine/cnc/cam/ir';
import { SAFE_Z, estimateCycleSeconds, type RapidEstimate } from '@/engine/cnc/cam/ir';
import type { Polygons } from '@/engine/cnc/cam/pocket';

/**
 * The keep-out past the jaw face, mm — Case Maker's DEFAULT, not a measurement: Makera publishes
 * no jaw depth and the chuck body is unpublished (#626, design §5, §9 Q8). The map's jaws' band is
 * the first {@link ROTARY_JAW_KEEP_OUT_MM} mm of the stick-out: the grip itself is behind the map's
 * left edge (inside the jaws), so the two together are the design's "grip + 3 mm" of unusable stock.
 */
export const ROTARY_JAW_KEEP_OUT_MM = 3;

/**
 * The tailstock's band at the free end, mm, while the tailstock is in — Case Maker's DEFAULT:
 * Makera does not publish the tailstock's reach (#626, design §5, §9 Q8).
 */
export const ROTARY_TAILSTOCK_BAND_MM = 10;

/**
 * Clearance above the stock's surface a rapid needs before it may turn or traverse, mm — Makera's
 * own rule (`/Rotary.md` §1: the clearance above the axis is ½⌀ + 3 mm, the CAM guide's number).
 */
export const ROTARY_CLEARANCE_MM = 3;

/** The module's stock envelope, mm — Makera's published ⌀80 × 150 (`t_MachineType`, design §5). */
export const ROTARY_MAX_DIAMETER_MM = 80;
export const ROTARY_MAX_LENGTH_MM = 150;

/** The map a rotary job is authored on, in millimetres at the design radius. */
export interface RotaryMap {
  /** The stock's radius, `⌀/2`, mm — the map's radius and the frame's Z datum. */
  radius: number;
  /** One turn's arc at the surface, `2πR`, mm — the map's height. */
  circumference: number;
  /** The cuttable length: the stick-out, mm — the map's width. */
  stickout: number;
  /** How much stock is inside the jaws, mm (`stock.length − stickout`). */
  grip: number;
  /** The stock's full length along X, mm — the envelope check's number. */
  length: number;
  /** The tailstock is in. */
  tailstock: boolean;
}

/**
 * The map a job is written on, or `null` for a flat job. A cylinder stock held in the chuck is
 * the whole test: a cylinder in the VISE is not a rotary cut (a rod can be engraved flat), and a
 * rectangular stock in the chuck is not a shape the module holds.
 */
export function rotaryMapOf(job: EngraveJob): RotaryMap | null {
  if (job.stock.shape !== 'cylinder' || job.workholding.kind !== 'rotary-chuck') return null;
  const diameter = job.stock.diameter ?? job.stock.width;
  if (!(diameter > 0)) return null;
  const radius = diameter / 2;
  const stickout = job.workholding.rotary.stickout;
  return {
    radius,
    circumference: 2 * Math.PI * radius,
    stickout,
    grip: Math.max(0, job.stock.length - stickout),
    length: job.stock.length,
    tailstock: job.workholding.rotary.tailstock,
  };
}

/** Is this job a rotary cut? The one predicate every stage branches on. */
export function isRotaryJob(job: EngraveJob): boolean {
  return rotaryMapOf(job) !== null;
}

/**
 * The span of the map a cut may use, mm along X (#724 B3): past the jaws' keep-out at the jaw
 * face, and short of the tailstock's band when the tailstock is in. Its CENTRE is where a layout
 * belongs by default — the stock's own middle is not it, because the two bands are not equal
 * (3 mm at the jaws against 10 mm at the free end), and a layout centred on the stock reaches
 * into the longer one. The findings pass judges the same span, so a placement and the sentence
 * that refuses it cannot disagree.
 */
export function rotaryFreeSpan(map: RotaryMap): { from: number; to: number; centre: number } {
  const from = Math.min(ROTARY_JAW_KEEP_OUT_MM, map.stickout);
  const to = map.tailstock ? Math.max(from, map.stickout - ROTARY_TAILSTOCK_BAND_MM) : map.stickout;
  return { from, to, centre: (from + to) / 2 };
}

/**
 * The two keep-out bands as the Simulate disclaimer states them (#724 W7 review), mm.
 *
 * The sentence must name the bands the findings and the verifier actually judge, so these are the
 * EFFECTIVE lengths — {@link rotaryFreeSpan}'s clamped ends, not the labelled defaults. A stick-out
 * shorter than the jaws' keep-out (3 mm) is all jaws, and it leaves no tailstock band at all: the
 * tailstock is then reported out, so the sentence never says "the last 0 mm" about a rod whose
 * every millimetre is already behind the jaws' line.
 */
export function rotaryBandFacts(map: RotaryMap): { jawsMm: number; tailstockMm: number; tailstock: boolean } {
  const span = rotaryFreeSpan(map);
  const tailstockMm = map.stickout - span.to;
  return { jawsMm: span.from, tailstockMm, tailstock: map.tailstock && tailstockMm > 0 };
}

/** Arc length at `radius`, mm → unwound degrees (R9: never wrapped, never moduloed). */
export function arcToAngle(arc: number, radius: number): number {
  return (arc / radius) * (180 / Math.PI);
}

/** Unwound degrees → arc length at `radius`, mm. The inverse of {@link arcToAngle}. */
export function angleToArc(degrees: number, radius: number): number {
  return (degrees * Math.PI * radius) / 180;
}

/**
 * Is there a floor left to cut at this depth? A cut exactly `R` deep reaches the axis, and past it
 * there is no stock at all — `false` for both, because a rotary cut's floor is a RADIUS above the
 * axis and zero is not a radius a map can be scaled onto.
 *
 * The measurement path asks this BEFORE {@link aroundScale}: a job with an axis-crossing item must
 * be refused by its own finding ("cuts through the centre"), and a throw from the scale would
 * replace that sentence with a stack trace before the findings stage could speak.
 */
export function hasFloor(radius: number, depth: number): boolean {
  return radius - depth > 0;
}

/**
 * The map's around axis scaled into the TOOL FOOTPRINT's own frame (#240 R10, `/Rotary.md` §4.2).
 *
 * A vertical flat tip of radius `r_t` whose bottom sits at radius `Z_t = R − d` covers the stock's
 * surface out to the half-angle `atan(r_t / Z_t)` on each side (§4.2), which on the surface map is
 * the arc `R·atan(r_t / (R − d))`. Scaling the map's around axis by
 * `sy = r_t / (R·atan(r_t/(R − d)))` makes an ISOTROPIC offset by `r_t` in the scaled space the
 * footprint itself: `r_t` along X (not scaled) and `r_t/sy = R·atan(...)` around. So the opening,
 * the pocket's first erosion and the oracle's facet allowance all describe one footprint:
 *
 *   - the design's `r_t·R/(R − d)` is the small-angle form of the arc (`atan θ ≈ θ`); the two
 *     agree to 0.1 % at engraving angles (a ⌀1 mm cutter at r 9.5) and differ by 12 % at the
 *     thin-rod case (§4.5: r_t 1.5875, Z_t 2.5, 32°), where the oracle's own sentence — the floor
 *     at the region's edge is `R − d + (√(Z_t² + r_t²) − Z_t)` — is only true for the exact arc;
 *   - the step-over is measured in the scaled space, so it is an arc at the floor radius to the
 *     same 0.1 % at engraving angles, and up to 11 % FINER at 32° (never wider — the bound #191
 *     cares about is one-sided).
 *
 * `toolRadius` 0 or absent is a tool with no flat footprint of its own (a V-bit, whose rotary
 * footprint is not modelled yet): the floor's own frame `(R − d)/R` is returned, unchanged.
 *
 * Throws for a depth that reaches or passes the axis: there is no floor arc left, and the job is
 * refused before CAM by the depth findings/verifier ("cuts through the centre"). Callers that run
 * BEFORE the findings stage ask {@link hasFloor} instead.
 */
export function aroundScale(radius: number, depth: number, toolRadius = 0): number {
  if (!hasFloor(radius, depth)) {
    throw new Error(
      `a rotary cut ${depth} mm deep on a ⌀${radius * 2} mm stock reaches the axis: the map's around axis has no floor radius left to scale`,
    );
  }
  const floor = radius - depth;
  if (!(toolRadius > 0)) return floor / radius;
  return toolRadius / (radius * Math.atan(toolRadius / floor));
}

/**
 * The around half-width the anisotropic opening reaches on the map, mm — `R·atan(r_t/(R − d))`,
 * the exact form of the design's `r_t·R/(R − d)` (see {@link aroundScale}).
 */
export function aroundOpeningRadius(toolRadius: number, radius: number, depth: number): number {
  if (!(toolRadius > 0)) return 0;
  return toolRadius / aroundScale(radius, depth, toolRadius);
}

/**
 * The FACET term, mm (#240 R10, `/Rotary.md` §4.5): `√(Z_t² + r_t²) − Z_t`.
 *
 * The column engine models the flat tip's footprint as the wedge `Z_t/cos φ` (R-2), so at the
 * angular edge of that footprint the floor is this much higher than the tip's own radius. It is
 * the allowance the column oracle must carry BOTH ways: in the mask, so the footprint is a
 * footprint rather than a one-cell centreline, and in the band, so the edge's rise is not an
 * under-cut. Derived from the run's own `Z_t` and `r_t`, never hand-set.
 */
export function facetTerm(tipRadiusAboveAxis: number, toolRadius: number): number {
  if (!(tipRadiusAboveAxis > 0) || !(toolRadius > 0)) return 0;
  return Math.hypot(tipRadiusAboveAxis, toolRadius) - tipRadiusAboveAxis;
}

/**
 * Map polygons scaled into (or back out of) the tool footprint's frame, by
 * {@link aroundScale} — the CAM offsets in it, then returns each ring to the map with `1/sy`.
 */
export function scalePolygonsAround(polygons: Polylines, sy: number): Polygons {
  return polygons.map((contour) => contour.map(([x, y]) => [x, y * sy] as [number, number]));
}

/** A polygon set's contours, read-only — the shape `OraclePredicted.polygons` and `Polygons` share. */
type Polylines = readonly (readonly (readonly [number, number])[])[];

/**
 * The flat, map-space IR turned into the rotary frame (#240 R10, R6, R9).
 *
 * Every operation is one flat region pocket in MAP millimetres: `generateEngrave` pockets it with
 * the around axis scaled by `aroundScale(R, d, r_t)` — the tool's own footprint frame — and
 * returns every ring to the map before it becomes a move, so this conversion is a pure per-move
 * map → frame map:
 *
 *   a     = (y_map / R)·180/π  — unwound degrees (R9)
 *   z     = R + z_flat      — radial height above the axis; the surface is R, a floor `d` deep is R − d
 *   y     = 0               — R1: the cutter stays over the axis
 *
 * RAPIDS ARE LIFTED to `R + safeZ`. A rapid at the flat hop height would sit `R + 1` — inside the
 * 3 mm clearance the verifier requires before the stock may turn under it — while the flat file's
 * hop is safe there only because a flat job never turns. The lift is this frame's version of the
 * same rule the flat post applies, and the post's own air check reads feeds only.
 *
 * Operation cycle estimates are recomputed with the arc length added: `a` moves the stock, and a
 * model that reads only X/Y/Z would time a full turn as standing still.
 */
export function toRotaryIR(ir: ToolpathIR, radius: number, rapid: RapidEstimate): ToolpathIR {
  const operations: CamOperation[] = ir.operations.map((op) => {
    const moves: CamMove[] = op.moves.map((move) => {
      const a = arcToAngle(move.y, radius);
      const z = radius + move.z;
      const liftedRapid = move.kind === 'rapid' ? Math.max(z, radius + SAFE_Z) : z;
      return move.kind === 'feed'
        ? { kind: 'feed', x: move.x, y: 0, z, f: move.f, a }
        : { kind: 'rapid', x: move.x, y: 0, z: liftedRapid, a };
    });
    return { ...op, moves, estimatedSeconds: estimateCycleSeconds(moves, rapid, radius) };
  });
  return { ...ir, frame: 'rotary', rotary: { radius }, operations };
}

// ---- The refusal sentences (design §3.9, §4) --------------------------------
//
// OPERATOR WORDS, WITH UNITS, AND NO INTERNAL CODE. The codes (`axis-crossing`,
// `rotary-y-off-axis`, `wrap-into-clamp`, `rotary-rapid-engaged`, `stock-exceeds-module`) live in
// the finding's `code` field — data, never the sentence.

/**
 * "cuts through the centre" — a tip or floor at or below the axis. `z` is the signed distance
 * BELOW the axis: 0 reaches it exactly, negative passes it. A depth of exactly the radius is the
 * common case (an item whose depth equals R), so it gets its own sentence rather than "0 mm past".
 */
export function throughCentreSentence(z: number): string {
  const foot = 'a rotary cut keeps the cutter above the axis, where the floor is a radius above it';
  if (z === 0) {
    return `cuts through the centre: the cutter tip reaches the axis exactly, and ${foot} — use a shallower depth or a larger diameter`;
  }
  return `cuts through the centre: the cutter tip reaches ${Math.abs(Math.round(z * 1000) / 1000)} mm past the axis, and ${foot} — use a shallower depth or a larger diameter`;
}

/** "leaves the line over the axis" — work Y is not 0 (R1). */
export function offAxisSentence(y: number): string {
  return `leaves the line over the axis (Y ${Math.round(y * 1000) / 1000} mm): a rotary program keeps the cutter over the axis, and every Y is 0`;
}

/** "runs into the jaws" — a cut inside the jaws' keep-out band at the map's left end. */
export function jawsSentence(x: number): string {
  return `runs into the jaws: it reaches X ${Math.round(x * 1000) / 1000} mm, inside the first ${ROTARY_JAW_KEEP_OUT_MM} mm of the stick-out, where the chuck's jaws are`;
}

/**
 * "runs off the free end of the rod" — a cut past the stick-out with the tailstock OUT: the map
 * ends at the stick-out, and beyond it there is no stock at all (#724).
 */
export function freeEndSentence(x: number, stickout: number): string {
  return `runs off the free end of the rod: it reaches X ${Math.round(x * 1000) / 1000} mm, and the stick-out is ${Math.round(stickout * 1000) / 1000} mm long`;
}

/** "runs into the tailstock's band" — a cut in the free end's keep-out. */
export function tailstockSentence(x: number, stickout: number): string {
  const from = Math.round((stickout - ROTARY_TAILSTOCK_BAND_MM) * 1000) / 1000;
  return `runs into the tailstock's band: it reaches X ${Math.round(x * 1000) / 1000} mm, and the tailstock holds the last ${ROTARY_TAILSTOCK_BAND_MM} mm of the stick-out (X ${from}–${Math.round(stickout * 1000) / 1000} mm)`;
}

/** "turns the stock while the cutter is in it" — an A or X rapid below the clearance. */
export function turningInCutSentence(z: number, radius: number): string {
  const inside = Math.round((radius - z) * 1000) / 1000;
  return `turns the stock while the cutter is in it: the cutter is ${inside > 0 ? `${inside} mm inside the stock` : 'not clear of the stock'} at Z ${Math.round(z * 1000) / 1000} mm, and a turn or a traverse needs ${ROTARY_CLEARANCE_MM} mm of clearance above the surface (Z ${Math.round((radius + ROTARY_CLEARANCE_MM) * 1000) / 1000} mm)`;
}

/** "does not fit the rotary's ⌀80 × 150 mm" — the module's envelope. */
export function envelopeSentence(diameter: number, length: number): string {
  return `does not fit the rotary's ⌀${ROTARY_MAX_DIAMETER_MM} × ${ROTARY_MAX_LENGTH_MM} mm: this stock is ⌀${Math.round(diameter * 1000) / 1000} × ${Math.round(length * 1000) / 1000} mm`;
}
