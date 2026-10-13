/**
 * The material-position scan (#391) — where the blank's edges really are, from the wired probe's
 * downward touches. A sibling of `registration.ts` (#272): the same job in, the same landmark
 * words out, and pure — no wasm, no store, no machine.
 *
 * WHY A Z-ONLY SCAN. `registration.ts` plans the X, Y and rotation touches a 3D probe makes, and
 * the wired probe that ships with the Z1 cannot make them: it is Z-only (decision 8,
 * /Z1-Firmware-Dialect.md §11.7), so it can never touch a vertical face. What it can do is touch
 * DOWN at a point of your choosing and report how far it went — and near an edge, how far it went
 * says which side of that edge the tip's centre is on. That inverted question is the whole
 * technique: step across the edge, watch the reading change, and say where the blank is. It is
 * how the blank's position gets checked before a cut, on a machine whose probe cannot find an
 * edge, after the origin has been set by whatever means the fixture allows.
 *
 * WHAT ONE TOUCH MEASURES — and it is not the tip's diameter alone, which is why this is written
 * down rather than assumed. A ball tip of radius `r` descending `o` mm OUTSIDE the blank's edge:
 *
 *     o <= 0        the ball is over the blank's top face and stops on it.              depth 0
 *     0 < o < r     the ball is over the jaw, but still meets the blank's CORNER first and
 *                   stops that much lower:  r − sqrt(r² − o²), rising from 0 to r.
 *     o >= r        the corner is out of reach. A jaw's top stops the ball `stockProud` down
 *                   when one is under the tip; with none, nothing stops it at all.
 *
 * So the trigger's depth below the blank's own top rises smoothly as the tip steps out, and only
 * the tip's POSITION says whether the ball's centre is still over the blank. The machine reports
 * the depth, so the scan reads the depth and asks it one question: has it left the blank's top?
 *
 * AND THAT QUESTION HAS THE BLANK'S DOME IN IT. The face being scanned is domed — 0.33 mm across
 * the 38 mm badge blank (#345), a slow rise that a touch near the edge cannot tell from the edge
 * itself. So the tolerance for "still the blank" is the job's OWN dome, and the resolution that
 * follows — the outward distance at which the corner contact has sunk past the dome,
 * `sqrt(2·r·dome − dome²)` — is 1.0 mm on that blank with the assumed 3 mm tip and 0.4 mm on flat
 * stock. That is what this scan can honestly claim; it is one more reason the tip's own
 * measurement (#208 A8) is worth taking, and the plan states the figure rather than leaving it
 * implied.
 *
 * NOTHING HERE DRIVES THE MACHINE, and nothing here needs to: the plan is a list of positions and
 * what to expect at each, the run sheet prints it in the operator's words, and the touches are
 * made from Studio's own touch-off dialog. What to DO with a measurement is #387's open question
 * (the work offset and the tool-length reference are entangled), so this module locates the blank
 * and stops there.
 */

import { viseEnvelope } from '@/engine/cnc/fixture';
import { PROBE_SPEC, SIDE_WORDS, type JobSide } from './registration';
import type { ProbeSpec } from '@/engine/cnc/probePlan';
import type { EngraveJob, StockFlatness } from '@/types/engraveJob';
import type { Mm, Vec2 } from '@/types/units';

/** How far the tip steps between coarse touches, mm (#391's own example). */
export const SCAN_COARSE_STEP_MM: Mm = 2;

/**
 * How far past the jaw tops a touch is allowed to travel before the plan calls it nothing, mm.
 *
 * The whole reason the cap exists: a `G38.2` that never triggers keeps descending at the probe's
 * own feed, and past the jaws there is nothing to stop it reaching the bed. One millimetre past
 * the jaw tops is enough to prove there is nothing between them and the cap, and short enough to
 * be harmless if there is.
 */
export const SCAN_MISS_MARGIN_MM: Mm = 1;

/** The depth two readings can be told apart by, mm. The machine's dial, not the probe's spec. */
const DEPTH_TOLERANCE_MM: Mm = 0.05;

/**
 * What to plan with when the job states no dome. NOT zero: an unstated dome is unknown, and 0 mm
 * would tell the plan the blank is flat (#345's own rule, and the badge figure is the measured
 * one the job would have carried). The plan says which figure it used.
 */
const PROVISIONAL_DOME_MM: Mm = 0.33;

/** A side of the blank. The same four `registration.ts` names, and the same words for them. */
export type ScanEdge = JobSide;

/**
 * What one downward touch found, read off the depth it triggered at.
 *
 * `corner` is the informative one and the reason the tip's geometry is written out above: a
 * reading there says the ball is over the blank's EDGE, so the edge is within a tip radius of the
 * point that produced it. `below` and `miss` both mean "not the blank", and are separate because
 * only a miss says the travel cap was reached — which is the reading that means the tip had
 * nothing under it at all.
 */
export type TouchSurface = 'blank' | 'corner' | 'below' | 'miss';

/** The two depths that turn a reading into a `TouchSurface`, mm below the reference touch. */
export interface ScanBands {
  /** At or above this, the reading is the blank's own top — the job's dome, plus the dial. */
  blankMm: Mm;
  /** At or below this, the reading is off the blank — the jaw's top, or anything lower. */
  belowMm: Mm;
}

/** One downward touch the operator makes. */
export interface ScanTouch {
  edge: ScanEdge;
  /** How far outside the blank's nominal edge it sits, mm. Negative is inboard, on the blank. */
  offsetMm: Mm;
  /**
   * What the touch is FOR, which is what the sheet's sentence about it turns on: `'inside'` clear
   * of the edge and on the blank, `'edge'` aimed at the corner band where the ball meets the edge
   * itself, `'outside'` past the blank where a jaw's top — or the cap — stops it.
   */
  role: 'inside' | 'edge' | 'outside';
  /** Where the tip goes, work frame mm. */
  at: Vec2;
  /**
   * What the physics above predicts here — which is what makes a reading that DISAGREES the
   * finding rather than a mystery.
   */
  expect: TouchSurface;
}

/** The first touch of the scan: the blank's top face, at its middle. */
export interface ScanReference {
  /** Where the tip goes, work frame mm. */
  at: Vec2;
  /**
   * `'blank'`, always, and it is not a tautology: this is the touch that says the reference really
   * is the blank's top face. If it comes back anything else, every reading below it is measured
   * from the wrong surface and the scan has found that instead of a position.
   */
  expect: TouchSurface;
}

/** The coarse pass across one edge of the blank. */
export interface EdgeScan {
  edge: ScanEdge;
  /** The axis the touches sit on: `'x'` for the left and right edges, `'y'` for front and back. */
  axis: 'x' | 'y';
  /** Which way the scan steps: `+1` toward larger coordinates, `−1` toward smaller. */
  dir: 1 | -1;
  /** The nominal edge's own coordinate in the work frame, mm — the job's stock edge. */
  nominalMm: Mm;
  /** The coordinate all its touches share on the other axis, mm — the middle of that edge. */
  alongMm: Mm;
  /**
   * True when a jaw's top lies under the outward touches, so they stop `stockProud` down.
   *
   * It is true for the left and right edges, whose touches sit on the jaw tops the blank is
   * clamped between — and FALSE for the front and back edges, because a jaw reaches only along the
   * blank's ENDS: at the middle of a side there is the gap between the jaws, and the tip finds
   * nothing at jaw height there at all. That is the one fact about the fixture the operator cannot
   * see from where they stand and the plan can, and it is why those touches are capped.
   */
  jawOutboard: boolean;
  /** In the order they are taken: inboard first, outward after. */
  touches: ScanTouch[];
}

export interface MaterialScanPlan {
  tipRadiusMm: Mm;
  /** The touch every reading is measured from: the blank's top face, at its middle. */
  reference: ScanReference;
  edges: EdgeScan[];
  bands: ScanBands;
  /** How far below the reference a touch may travel before it is certainly on nothing, mm. */
  missTravelMm: Mm;
  /** How far OUTSIDE the real edge a reading first leaves the blank, mm — the scan's own bias. */
  resolutionMm: Mm;
  /** Full sentences: the run sheet prints them after the steps. */
  notes: string[];
}

export type MaterialScanRefusalCode = 'not-proud-enough' | 'dome-covers-the-jaw';

export interface MaterialScanRefusal {
  refuse: true;
  code: MaterialScanRefusalCode;
  message: string;
}

export type MaterialScanResult = MaterialScanPlan | MaterialScanRefusal;

/**
 * The scan that checks the blank's position on this job: where to touch, what each touch should
 * find, how far a touch may travel, and what the fixture already guarantees.
 *
 * Refuses when the geometry cannot tell the blank from the jaw — a blank barely proud of the jaw
 * tops, or a dome as deep as the height it stands — rather than planning touches whose readings
 * would be read as a position when they are noise.
 */
export function planMaterialScan(job: EngraveJob, probe: ProbeSpec = PROBE_SPEC): MaterialScanResult {
  const { length, width } = job.stock;
  const vise = job.workholding.vise;
  const tipR = probe.tipDiameter / 2;
  const proud = vise.stockProud;

  if (!(proud > DEPTH_TOLERANCE_MM)) {
    return {
      refuse: true,
      code: 'not-proud-enough',
      message:
        `the blank stands ${fmtNum(proud)} mm proud of the jaw tops, so a touch just outside its ` +
        'edge reads the blank’s own height and there is nothing to tell the blank from the jaw. ' +
        'The height the blank stands proud (#208 A5) is what makes this scan work',
    };
  }

  const dome = job.stock.flatness?.dome ?? PROVISIONAL_DOME_MM;
  const blankMm = dome + DEPTH_TOLERANCE_MM;
  const belowMm = proud - DEPTH_TOLERANCE_MM;
  if (belowMm <= blankMm) {
    return {
      refuse: true,
      code: 'dome-covers-the-jaw',
      message:
        `the blank’s ${fmtNum(dome)} mm dome is as deep as the ${fmtNum(proud)} mm it stands proud ` +
        'of the jaw tops, so a reading at its edge cannot be told from one on the jaw. Flatten the ' +
        'blank, or raise it in the jaws, before checking its position this way',
    };
  }

  const bands: ScanBands = { blankMm, belowMm };
  // The fixture as an obstacle envelope — the ONE statement of where the jaws are (`viseEnvelope`
  // already carries the sacrificial shift, so a strip between jaw and blank moves the jaw's top
  // with it and this needs no second copy of that rule).
  const envelope = viseEnvelope(job.stock, vise, job.sacrificial);
  const jawUnder = (x: Mm, y: Mm): boolean =>
    envelope.boxes.some((b) => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1]);

  // Where the corner contact has sunk past the blank's own dome: the outward distance at which a
  // reading first stops reading as the blank. It answers two questions with one number — how far
  // past the real edge the change appears (the scan's bias) and how finely the scan can place an
  // edge — because they are the same distance.
  const resolutionMm = cornerBandMm(blankMm, tipR);

  /** What each of those four is for, in the same order — see `ScanTouch.role`. */
  const roles: readonly ScanTouch['role'][] = ['inside', 'inside', 'edge', 'outside'];

  const offsets: Mm[] = [
    // Clear of the edge, and should read the blank's own top: the touch that catches a blank
    // seated proud of where it is meant to be.
    -(tipR + SCAN_COARSE_STEP_MM),
    // Close to the edge, still on the blank — the near side of the bracket.
    -tipR,
    // AIMED AT THE EDGE ITSELF: the middle of the corner band, where the ball meets the blank's
    // corner and the reading goes deepest before the jaw takes it. The one sample whose expected
    // reading is neither the blank's top nor past it, so it is the one that places the edge within
    // a tip radius of a position the operator can read off the machine. Rounded to a tenth, because
    // it is a position to jog to and the scan cannot place an edge to a thousandth of anything.
    roundOff((resolutionMm + tipR) / 2),
    // Past the edge: a jaw's top, or nothing at all.
    tipR + SCAN_COARSE_STEP_MM,
  ];

  const edges: EdgeScan[] = sidesFor(job).map(({ edge, axis, dir, nominalMm, alongMm }): EdgeScan => {
    const at = (o: Mm): Vec2 =>
      axis === 'x' ? [nominalMm + dir * o, alongMm] : [alongMm, nominalMm + dir * o];
    const touches = offsets.map((offsetMm, i): ScanTouch => {
      const point = at(offsetMm);
      const depth = predictedDepthMm(offsetMm, tipR, proud, jawUnder(point[0], point[1]));
      return {
        edge,
        offsetMm,
        role: roles[i] ?? 'inside',
        at: point,
        expect: surfaceOf(depth, bands),
      };
    });
    const outward = at(tipR);
    return {
      edge,
      axis,
      dir,
      nominalMm,
      alongMm,
      jawOutboard: jawUnder(outward[0], outward[1]),
      touches,
    };
  });

  const missTravelMm = proud + SCAN_MISS_MARGIN_MM;
  const flatness: StockFlatness | undefined = job.stock.flatness;
  const free = edges.filter((e) => !e.jawOutboard);

  return {
    tipRadiusMm: tipR,
    reference: { at: [length / 2, width / 2], expect: 'blank' },
    edges,
    bands,
    missTravelMm,
    resolutionMm,
    notes: [
      `A touch stays on the blank’s own edge until the tip is about ${fmtNum(resolutionMm)} mm ` +
        `outside it, so a reading first leaves the blank that far PAST the real edge — read back ` +
        `${fmtNum(resolutionMm)} mm from where the reading changes and that is where the edge is.`,
      `The tip is ${fmtNum(probe.tipDiameter)} mm across as assumed, not as measured (#208 A8): a ` +
        'smaller tip is a sharper scan, and this figure is what the numbers above are made of.',
      flatness
        ? `The ${fmtNum(dome)} mm dome the reads are judged against is the one the job states (${flatness.source}, across the ${flatness.across}).`
        : `The job states no dome, so the reads are judged against the ${fmtNum(dome)} mm the badge blank measured — a domed blank is the case that matters, and this is the figure to correct.`,
      free.length > 0
        ? `Nothing lies at jaw height under the tip past ${names(free.map((e) => e.edge))} — a jaw ` +
          'reaches only along the blank’s ends — so those outside touches have nothing to stop ' +
          `them: a miss there is the expected reading, not a fault, and the cap ${fmtNum(missTravelMm)} mm ` +
          'below the reference is what keeps them off the bed.'
        : 'Every edge has a jaw top outside it, so an outside touch stops on the jaw rather than on the cap.',
      `The ${job.workholding.kind} already fixes X and rotation to within ±${fmtNum(vise.uncertainty)} mm, so the left and right edges mostly re-check that the blank is seated against them; the front and back edges are the free ones.`,
      'A Z-only tip cannot find rotation: this scan says where the edges are, not whether the blank sits square in the jaws.',
    ],
  };
}

/**
 * The four sides of this job's blank, in the work frame: X runs left–right along the jaws' clamp
 * direction and +Y runs away from the operator (`setup.ts`), so a side names itself. The
 * coordinates are the JOB's — a 38 mm blank and a 100 mm blank share no number, and the edge is
 * where the file says the stock's edge is, which is exactly what the scan is testing.
 */
function sidesFor(job: EngraveJob): readonly EdgeSide[] {
  const { length, width } = job.stock;
  return [
    { edge: 'left', axis: 'x', dir: -1, nominalMm: 0, alongMm: width / 2 },
    { edge: 'right', axis: 'x', dir: 1, nominalMm: length, alongMm: width / 2 },
    { edge: 'front', axis: 'y', dir: -1, nominalMm: 0, alongMm: length / 2 },
    { edge: 'back', axis: 'y', dir: 1, nominalMm: width, alongMm: length / 2 },
  ];
}

/** A side's place in the work frame: which axis it is on, which way is outward, and where. */
interface EdgeSide {
  edge: ScanEdge;
  axis: 'x' | 'y';
  dir: 1 | -1;
  /** The nominal edge's own coordinate, mm. */
  nominalMm: Mm;
  /** The middle of the side, mm — the coordinate every touch on this edge shares. */
  alongMm: Mm;
}

/**
 * The depth below the blank's top a ball of radius `tipR` stops at, `o` mm outside the edge, mm —
 * or `null` when nothing stops it within the cap. THE ONE STATEMENT OF THE PHYSICS at the top of
 * this file: the plan's own expectations are made from it.
 */
function predictedDepthMm(o: Mm, tipR: Mm, proud: Mm, jawUnder: boolean): Mm | null {
  if (o <= 0) return 0;
  const corner = o < tipR ? tipR - Math.sqrt(tipR * tipR - o * o) : null;
  if (jawUnder && (corner === null || proud <= corner)) return proud;
  return corner;
}

/** Which surface a trigger depth was, on this job's bands. `null` is a touch that never fired. */
function surfaceOf(depthMm: Mm | null, bands: ScanBands): TouchSurface {
  if (depthMm === null) return 'miss';
  if (depthMm <= bands.blankMm) return 'blank';
  if (depthMm >= bands.belowMm) return 'below';
  return 'corner';
}

/**
 * How far outside the real edge the corner contact has sunk past the blank's own dome, mm: the
 * outward distance at which a reading first stops reading as the blank. Capped at the tip's
 * radius, which is the deepest the corner contact goes — past that a dome cannot be told from an
 * edge at all, and the scan is no better than its tip.
 */
function cornerBandMm(blankMm: Mm, tipR: Mm): Mm {
  return blankMm >= tipR ? tipR : Math.sqrt(2 * tipR * blankMm - blankMm * blankMm);
}

/** `1.5` → `1.5 mm inside`; `-1.5` → `1.5 mm outside`. The words a touch's offset reads as. */
export function inOutWord(offsetMm: Mm): string {
  const n = `${fmtNum(Math.abs(offsetMm))} mm`;
  return offsetMm < 0 ? `${n} inside` : `${n} outside`;
}

/** Where along an edge the touches sit — the middle of the side the edge is parallel to. */
export function alongWord(edge: ScanEdge): string {
  return edge === 'left' || edge === 'right' ? 'the middle of the blank’s width' : 'the middle of the blank’s length';
}

/** What a touch is predicted to find, in the operator's words. */
export function surfaceWord(surface: TouchSurface): string {
  switch (surface) {
    case 'blank':
      return 'the blank’s own top';
    case 'corner':
      return 'the blank’s edge itself — the tip is over the corner';
    case 'below':
      return 'off the blank and lower — the jaw’s top, or whatever is under the tip';
    case 'miss':
      return 'nothing at all: the tip stops on its travel cap';
  }
}

/** `['front', 'back']` → `the front edge and the back edge`. Side names alone: a note lists them. */
function names(edges: readonly ScanEdge[]): string {
  const parts = edges.map((e) => SIDE_WORDS[e].name);
  if (parts.length <= 1) return parts[0] ?? 'nothing';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** `0.33` → `0.33`. Trailing zeros dropped, like every other figure the sheet prints. */
function fmtNum(n: Mm): string {
  return String(Number(n.toFixed(3)));
}

/** A position to jog to, to a tenth of a millimetre — finer than any touch can resolve. */
function roundOff(n: Mm): Mm {
  return Math.round(n * 10) / 10;
}
