/**
 * #737 — THE NECK FOR PARTING: the last operation leaves the part on a cylinder of the operator's
 * diameter at one end of the free span, so it can be sawn off after the run.
 *
 * WHY A NECK AND NOT A PART-OFF. The Z1's 4th axis holds the rod horizontally and the cutter
 * vertically (rotary-flow.md §3.6, Q6): a full part-off would have to cut through the axis, where
 * the floor stops being a radius and the part comes free in the spindle. A neck stops short of the
 * axis — it leaves a floor of `diameter / 2` — and the saw does the rest at the bench.
 *
 * WHERE THE NECK SITS is the map's own free span, `rotaryFreeSpan` (wrap.ts): the jaws' keep-out at
 * one end, the tailstock's band at the other. `end` picks which end, and the neck grows INWARD from
 * that end by its length. The span is the same one the findings and the verifier judge, so a neck
 * placed here can never be refused by a band the operator was not shown.
 *
 * EVERY NUMBER HERE IS A LABELLED DEFAULT, not a measurement (#238): the neck's diameter and
 * length, and the safe minimum below. They are chosen conservatively, stated as defaults in words
 * wherever they are refused, and the bench confirms them once the module is fitted.
 */
import type { EngraveJob, RotaryNeck, StockMaterial } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { MATERIAL_LABELS, isMetalMaterial, isWoodMaterial } from '@/engine/cnc/materials';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import {
  aroundOpeningRadius,
  jawsSentence,
  rotaryFreeSpan,
  rotaryMapOf,
  tailstockSentence,
  freeEndSentence,
  type RotaryMap,
} from './wrap';

/**
 * The neck's diameter Case Maker offers first, mm. Labelled default, not a bench result (#238).
 *
 * Seven, not the four the first draft offered: the default end is the CHUCK side (the stock goes
 * into the jaws there, so the saw frees the whole part rather than only the scrap stub), and the
 * strength check measures the cantilever to the neck's ROOT at the jaws' edge. On the design's
 * ⌀20 × 85 mm stick-out that piece is 82 mm long — 41 mm effective with the tailstock centre
 * sharing the bending — so PLA asks ⌀5.18 mm and softwood ⌀6.53 mm. A 4 mm default would be
 * refused by the app's own check; 7 mm clears PLA, softwood and metal. Both ends remain
 * available: the tailstock side is still the right end for some work, but it does not part the
 * part off, which the panel says.
 */
export const ROTARY_NECK_DIAMETER_MM = 7;

/** The neck's length Case Maker offers first, mm: the kerf plus clearance either side, and a bit. */
export const ROTARY_NECK_LENGTH_MM = 5;

/** The saw's kerf the neck must be long enough to take, mm — a common fine-tooth saw blade. */
export const ROTARY_SAW_KERF_MM = 0.5;

/** Clearance the saw needs on each side of the kerf, mm. */
export const ROTARY_NECK_SIDE_CLEARANCE_MM = 1;

/**
 * The shortest neck that can be sawn off: the kerf plus the clearance either side, mm.
 *
 * A longer neck is always allowed — this is the floor the refusal names, not a target. The default
 * 5 mm is comfortably above it.
 */
export const ROTARY_NECK_MIN_LENGTH_MM = ROTARY_SAW_KERF_MM + 2 * ROTARY_NECK_SIDE_CLEARANCE_MM;

/**
 * The side load the safe-minimum formula assumes at the piece the neck carries, N. A labelled
 * default with a stated basis, not a measurement: about 1 kg leaning on the part — a hand steadying
 * it, the saw's side pressure and a knock against the machine — acting sideways, perpendicular to
 * the rod's axis, at the FREE END of the piece the saw will free. That is the worst place for the
 * neck, because the load's moment arm is the whole carried length.
 *
 * The neck is cut LAST, with the part still held by the chuck and, when engaged, the tailstock
 * centre, so this is a deliberately rough check of an operator handling the part, not a cutting
 * force. #238 replaces the number with a bench measurement.
 */
export const ROTARY_NECK_LOAD_N = 10;

/**
 * Allowable bending stress by material group for the neck's safe minimum, MPa. Labelled defaults,
 * deliberately far below each group's yield or rupture strength:
 *
 *   - wood 15 MPa — clear softwood bends at 40–80 MPa; grain, knots and a printed blank's layers
 *     are why the allowable is a quarter of the weakest of them;
 *   - plastic 30 MPa — PLA yields near 50 MPa, the softer thermoplastics lower; 30 MPa is the
 *     conservative middle of the group;
 *   - metal 100 MPa — 6061-T6 yields at 276 MPa, and 100 MPa is near its fatigue allowance at
 *     millions of cycles; brass and copper sit lower, so the group number leans on the cautious end.
 *
 * #238 confirms these on PLA and aluminium once the module is fitted.
 */
export const ROTARY_NECK_ALLOWABLE_MPA = { wood: 15, plastic: 30, metal: 100 } as const;

export type RotaryNeckMaterialGroup = keyof typeof ROTARY_NECK_ALLOWABLE_MPA;

/**
 * The CAM region is pulled in by this much from each end of the neck, mm, so the POST's 3-decimal
 * rounding of an X can never leave the verifier's tool EDGE a hair inside a keep-out band (a neck
 * that starts at X 3 mm is exactly on the jaws' line; 3 + a tool radius rounds to 3.001 at worst).
 * The floor the oracle and the preview judge keeps the nominal edges — this only trims the cut.
 */
export const ROTARY_NECK_EDGE_GRID_MM = 0.001;

/** The neck operation's label id — the `EngraveRegion`'s id and the finding's `labelId`. */
export const ROTARY_NECK_ID = 'rotary-neck';

/** The neck as it sits on the map, mm. */
export interface RotaryNeckSpan {
  /** The neck's chuck-side edge, X on the map. */
  fromMm: number;
  /** The neck's free-side edge, X on the map. */
  toMm: number;
  /** The saw line: the neck's middle, X on the map. */
  sawAtMm: number;
  /** The floor's depth below the surface: `R − diameter / 2`, mm. */
  depthMm: number;
  /**
   * The piece the strength check treats as carried, mm: from the neck's ROOT — its chuck-side
   * edge, the end nearest the stock the part is held by — to the free end of the rod. The peak
   * bending moment is at that root, not at the saw line; measuring from the saw line understates
   * the arm by half the neck's length and errs unsafe.
   */
  carriedMm: number;
  /**
   * What the strength check treats as a cantilever, mm. With the tailstock engaged its centre holds
   * the carried piece's far end, so the bending is shared and the check counts HALF the carried
   * length; with the tailstock out the piece hangs free and the full length is used. A labelled
   * simplification, stated as such in the refusal.
   */
  effectiveMm: number;
}

/** The neck's facts, as the job, the CAM, the run sheet and the disclaimer all state them. */
export interface RotaryNeckFacts extends RotaryNeckSpan {
  end: 'chuck' | 'tailstock';
  diameterMm: Mm;
  lengthMm: Mm;
}

/**
 * The neck Case Maker offers first: off until the operator turns it on, with labelled defaults.
 *
 * The CHUCK side is the default because that is where the stock goes into the jaws: sawing a
 * tailstock-side neck frees only the scrap stub beyond it and leaves the part joined to the stock
 * in the chuck, so it does not part the part off. The tailstock side remains available for the
 * work that wants it; the panel states that consequence.
 */
export function defaultRotaryNeck(): RotaryNeck {
  return {
    end: 'chuck',
    diameter: ROTARY_NECK_DIAMETER_MM,
    length: ROTARY_NECK_LENGTH_MM,
  };
}

/**
 * The job's neck, or null. A neck only exists on a rotary map — a flat job has no surface to wrap
 * the cut round — and an absent field is OFF (the document rule: absent, never defaulted on).
 */
export function rotaryNeckOf(job: EngraveJob): RotaryNeck | null {
  if (rotaryMapOf(job) === null) return null;
  return job.workholding.kind === 'rotary-chuck' && job.workholding.rotary.neck !== undefined
    ? job.workholding.rotary.neck
    : null;
}

/**
 * Where the neck sits on the map, or null when it cannot sit anywhere yet (a non-positive length).
 *
 * `end: 'chuck'` grows the neck inward from the jaws' keep-out's edge; `end: 'tailstock'` grows it
 * inward from the free span's far edge (the tailstock's band when the tailstock is in, the rod's
 * end when it is out). The far edge is the one `rotaryFreeSpan` names, so the two cannot drift.
 */
export function rotaryNeckSpan(map: RotaryMap, neck: RotaryNeck): RotaryNeckSpan | null {
  if (!(neck.length > 0) || !(neck.diameter > 0)) return null;
  const free = rotaryFreeSpan(map);
  const from = neck.end === 'chuck' ? free.from : free.to - neck.length;
  const to = neck.end === 'chuck' ? free.from + neck.length : free.to;
  const sawAt = (from + to) / 2;
  // The cantilever is anchored at the neck's ROOT, X `from` — the end nearest the stock held in
  // the chuck. The peak moment is there, not at the saw line, so the arm runs from the root to the
  // free end. (The first draft measured from the saw line and understated it by half the neck.)
  const carried = Math.max(0, map.stickout - from);
  return {
    fromMm: from,
    toMm: to,
    sawAtMm: sawAt,
    depthMm: map.radius - neck.diameter / 2,
    carriedMm: carried,
    effectiveMm: map.tailstock ? carried / 2 : carried,
  };
}

/** The job's neck facts, or null when it has no neck (or one that cannot be placed yet). */
export function rotaryNeckFacts(job: EngraveJob): RotaryNeckFacts | null {
  const map = rotaryMapOf(job);
  const neck = rotaryNeckOf(job);
  if (map === null || neck === null) return null;
  const span = rotaryNeckSpan(map, neck);
  if (span === null) return null;
  return { ...span, end: neck.end, diameterMm: neck.diameter, lengthMm: neck.length };
}

/**
 * The neck a RUN leaves: the one a POSTED program carries, or null when no posted program cut one.
 *
 * The job's setting is not the same fact. A rest program can be dropped with `setup-rest-nothing`,
 * leaving a job that still names a neck but a run that never cuts it; the saw step and the
 * coverage sentence must follow the programs, never the job. Structurally the worker's
 * `EngraveProgram` (or the sheet's `RunSheetProgram`), so both callers share one reader.
 */
export interface NeckCarryingProgram {
  neck?: RotaryNeckFacts | null;
}

/** The first posted program's neck, or null. See {@link NeckCarryingProgram}. */
export function neckCarriedBy(
  programs: readonly NeckCarryingProgram[] | null | undefined,
): RotaryNeckFacts | null {
  if (programs === null || programs === undefined) return null;
  for (const program of programs) {
    if (program.neck !== undefined && program.neck !== null) return program.neck;
  }
  return null;
}

/** The material group the safe minimum reads. */
export function rotaryNeckMaterialGroup(material: StockMaterial): RotaryNeckMaterialGroup {
  if (isWoodMaterial(material)) return 'wood';
  if (isMetalMaterial(material)) return 'metal';
  return 'plastic';
}

/**
 * The safe minimum neck diameter for a stock's material and the EFFECTIVE cantilever length, mm.
 *
 * The neck is treated as a round cantilever of length `effectiveMm` under the labelled side load
 * `ROTARY_NECK_LOAD_N` at its end. Its section modulus is `π·d³/32`, so the bending stress
 * `σ = 32·F·L/(π·d³)` reaches the allowable at
 *
 *   `d_min = cbrt(32·F·L / (π·σ_allow))`.
 *
 * Every input is a labelled default (see the constants above), and the effective length carries
 * one of its own: half the carried piece when the tailstock centre supports its far end. The
 * formula is the one the refusal's sentence states in words; it is a rough check, not a bench
 * measurement, and #238 owns confirming it.
 */
export function rotaryNeckMinDiameterMm(
  material: StockMaterial,
  effectiveMm: number,
): { diameterMm: number; group: RotaryNeckMaterialGroup; stressMpa: number; loadN: number } {
  const group = rotaryNeckMaterialGroup(material);
  const stressMpa = ROTARY_NECK_ALLOWABLE_MPA[group];
  const lengthM = Math.max(0, effectiveMm) / 1000;
  const diameterM = Math.cbrt((32 * ROTARY_NECK_LOAD_N * lengthM) / (Math.PI * stressMpa * 1e6));
  return { diameterMm: diameterM * 1000, group, stressMpa, loadN: ROTARY_NECK_LOAD_N };
}

/**
 * The CAM region for the neck, in MAP millimetres: the neck's rectangle, extended AROUND the
 * circumference by the tool's own opening arc at the floor.
 *
 * The extension is what makes the band close on itself. `pocketLoops` first erodes the region by
 * the tool radius; a region that ended exactly at y = 0 and y = C would leave the tool centre one
 * radius short of the seam and the seam uncut. `aroundOpeningRadius` is the around half-width the
 * same footprint opens at this floor (R10), so the first ring after the erosion lands exactly on
 * y = 0 and y = C, and every column of the band is cut.
 *
 * X is pulled in by `ROTARY_NECK_EDGE_GRID_MM` at each end for the post-rounding reason that
 * constant states. The region is a plain rectangle, wound CCW (outer).
 */
export function rotaryNeckCutRegion(
  map: Pick<RotaryMap, 'radius' | 'circumference'>,
  span: RotaryNeckSpan,
  toolRadius: number,
): Polygons {
  const seam = aroundOpeningRadius(toolRadius, map.radius, span.depthMm);
  const x0 = span.fromMm + ROTARY_NECK_EDGE_GRID_MM;
  const x1 = span.toMm - ROTARY_NECK_EDGE_GRID_MM;
  const y0 = -seam;
  const y1 = map.circumference + seam;
  return [
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
  ];
}

/**
 * What the neck removes, for the oracle and the preview: the band at the neck's full depth, all the
 * way round (`y` from 0 to the circumference, exactly as the CAM's outer ring reaches).
 *
 * The oracle tests this in map space with its periodic contour images, so a seam-boundary point is
 * judged by the same band as its neighbours — no special handling and no gap at the seam.
 */
export function rotaryNeckBand(
  map: Pick<RotaryMap, 'circumference'>,
  span: RotaryNeckSpan,
): Polygons {
  const edge = ROTARY_NECK_EDGE_GRID_MM;
  const x0 = span.fromMm + edge;
  const x1 = span.toMm - edge;
  const C = map.circumference;
  return [
    [
      [x0, 0],
      [x1, 0],
      [x1, C],
      [x0, C],
    ],
  ];
}

/** Two decimals for a computed minimum, mm — a default stated as a default, not a measurement. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** At most three decimals, trailing zeros dropped, for an operator sentence. */
function mm3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** One word for the end, so a refusal and the panel's control say the same thing. */
export function neckEndLabel(end: RotaryNeck['end']): string {
  return end === 'chuck' ? 'chuck side' : 'tailstock side';
}

/**
 * "the neck is 1 mm long, and a saw needs at least 2.5 mm to cut it off cleanly — 0.5 mm of kerf
 * and 1 mm clear either side." The neck's kerf-and-clearance floor, as a labelled default.
 */
export function neckTooShortSentence(lengthMm: number): string {
  return (
    `the neck is ${Math.round(lengthMm * 1000) / 1000} mm long, and a saw needs at least ` +
    `${ROTARY_NECK_MIN_LENGTH_MM} mm to cut it off cleanly — ${ROTARY_SAW_KERF_MM} mm of kerf and ` +
    `${ROTARY_NECK_SIDE_CLEARANCE_MM} mm clear either side`
  );
}

/** "the part is ⌀4 mm at that end, and the neck is ⌀6 mm" — a neck must be narrower than the part. */
export function neckWiderSentence(diameterMm: number, stockDiameterMm: number): string {
  return (
    `the neck is ⌀${Math.round(diameterMm * 1000) / 1000} mm, and the part at that end is ` +
    `⌀${Math.round(stockDiameterMm * 1000) / 1000} mm: a neck has to be narrower than the part it holds, ` +
    'so the cutter can cut it down all the way round'
  );
}

/**
 * "the neck is ⌀2 mm, and PLA with the whole part beyond the neck runs 82 mm from the neck’s root
 * at X 3 mm to the free end, and is held at both ends — by the neck and the tailstock centre — so
 * the bending is shared and the check counts half of it (41 mm), so it needs at least ⌀5.18 mm …"
 *
 * The sentence names the load, its direction and its basis, the support the carried piece gets,
 * the allowable stress and the fact that this is a still-to-be-checked default — in plain words,
 * so an operator can see this is a deliberately rough check built from chosen numbers, not a
 * measurement. The length is measured from the neck's ROOT, where the peak moment is; measuring
 * from the saw line would err unsafe by half the neck.
 */
export function neckThinnerSentence(
  material: StockMaterial,
  diameterMm: number,
  span: Pick<RotaryNeckSpan, 'fromMm' | 'carriedMm' | 'effectiveMm'> & {
    end: RotaryNeck['end'];
    tailstock: boolean;
  },
  minDiameterMm: number,
): string {
  const group = rotaryNeckMaterialGroup(material);
  const stressMpa = ROTARY_NECK_ALLOWABLE_MPA[group];
  const root = Math.round(span.fromMm * 1000) / 1000;
  const carried = Math.round(span.carriedMm * 1000) / 1000;
  const effective = Math.round(span.effectiveMm * 1000) / 1000;
  const piece = span.end === 'chuck' ? 'the whole part beyond the neck' : 'the stub beyond the neck';
  const support = span.tailstock
    ? `${piece} runs ${carried} mm from the neck’s root at X ${root} mm to the free end, and is held at ` +
      `both ends — by the neck and the tailstock centre — so the bending is shared and the check counts ` +
      `half of it (${effective} mm)`
    : `${piece} runs ${carried} mm from the neck’s root at X ${root} mm to the free end and hangs free, ` +
      `so the check counts all of it (${effective} mm)`;
  const groupWord = group === 'metal' ? 'metal' : group === 'plastic' ? 'plastic' : 'wood';
  return (
    `the neck is ⌀${Math.round(diameterMm * 1000) / 1000} mm, and ${MATERIAL_LABELS[material]} with ` +
    `${support}, so it needs at least ⌀${round2(minDiameterMm)} mm. The ${ROTARY_NECK_LOAD_N} N load acts ` +
    `sideways at the free end of that piece, and ${stressMpa} MPa is the allowable bending stress for ` +
    `${groupWord}. Those numbers are Case Maker's defaults, not measurements: the neck is cut last, ` +
    'with the part still held, so this is a deliberately rough check and the minimum is a guess until ' +
    'it is checked on the machine. Make the neck thicker, shorten the part, or choose a stronger stock'
  );
}

/**
 * "the neck runs X 70–75 mm, and Engrave text \"I\" reaches X 71.7–72.3 mm, so the neck would cut
 * through it." The neck is the operator's own cut, but it may not erase a design item: the item
 * and the neck cannot both occupy the same X, and the refusal names both extents so either can
 * move.
 */
export function neckCutsItemSentence(
  who: string,
  itemXMin: number,
  itemXMax: number,
  span: Pick<RotaryNeckSpan, 'fromMm' | 'toMm'>,
): string {
  return (
    `the neck runs X ${mm3(span.fromMm)}–${mm3(span.toMm)} mm, and ${who} reaches X ` +
    `${mm3(itemXMin)}–${mm3(itemXMax)} mm, so the neck would cut through it`
  );
}

/**
 * "the neck is 5 mm long, and \"6 mm flat\" is ⌀6 mm wide: a cutter as wide as the neck or wider
 * cannot leave a floor along it — it cuts the whole neck away instead." A flat cutter needs at
 * least its own diameter of floor to move along; a neck no longer than that is not a neck.
 */
export function neckCutterTooWideSentence(
  lengthMm: number,
  cutterName: string,
  cutterDiameterMm: number,
): string {
  return (
    `the neck is ${mm3(lengthMm)} mm long, and "${cutterName}" is ⌀${mm3(cutterDiameterMm)} mm wide: ` +
    'a cutter as wide as the neck or wider cannot leave a floor along it — it cuts the whole neck ' +
    `away instead. Make the neck longer than ⌀${mm3(cutterDiameterMm)} mm, use a narrower cutter for ` +
    'the last cut, or turn the neck off'
  );
}

/**
 * "The neck for parting is set, but no program in this run cuts it …" — the RUN-level refusal for
 * a neck the operator asked for that no posted program leaves. The case that exposed it: a rest
 * pair whose only rest program was dropped with `setup-rest-nothing`, so the rough-only program
 * posted without the neck, `neck-not-cut` never fired, and every sentence still said the part was
 * on a neck.
 */
export function neckNoProgramSentence(): string {
  return (
    'The neck for parting is set, but no program in this run cuts it: the program that would have ' +
    'left the neck was not posted. Turn the neck off, or keep a program that cuts it and leave that ' +
    'program last.'
  );
}

export function neckIntoBandSentence(map: RotaryMap, span: RotaryNeckSpan): string {
  const free = rotaryFreeSpan(map);
  // A span EDGE that lands on a band edge is exactly on the line, not inside the band. Floating
  // subtraction can leave 2.999999999999993 for `free.to - length`; without this the band sentence
  // would say the neck "reaches X 3 mm, inside the first 3 mm" — true only of the last bit.
  const EPS_MM = 1e-6;
  if (span.fromMm < free.from - EPS_MM) {
    // The neck's chuck-side edge crossed the jaws' line: a tailstock-side neck longer than the
    // free span, or a free span shorter than the jaws' own keep-out.
    return jawsSentence(span.fromMm);
  }
  if (span.toMm > free.to + EPS_MM) {
    // A chuck-side neck ran past the free span's far edge — into the tailstock's band, or off the
    // rod when the tailstock is out. One sentence per case, the map's own.
    return map.tailstock ? tailstockSentence(span.toMm, map.stickout) : freeEndSentence(span.toMm, map.stickout);
  }
  return '';
}
