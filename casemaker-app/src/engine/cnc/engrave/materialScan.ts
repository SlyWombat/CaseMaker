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
 * down rather than assumed. A tip of outer radius `r` descending `o` mm OUTSIDE the blank's edge:
 *
 *     o <= 0        the tip is over the blank's top face and stops on it.                depth 0
 *     0 < o < r     the tip is over the jaw, but still meets the blank's CORNER first and
 *                   stops that much lower:  r − sqrt(r² − o²), rising from 0 to r.
 *     o >= r        the corner is out of reach. A jaw's top stops the tip `stockProud` down
 *                   when one is under the tip; with none, nothing stops it at all.
 *
 * So the trigger's depth below the blank's own top rises smoothly as the tip steps out, and only
 * the tip's POSITION says whether it is still over the blank. The machine reports the depth, so
 * the scan reads the depth and asks it one question: has it left the blank's top?
 *
 * THE CONTACT MODEL IS A ROUND FOOT, AND THE TIP IS NOT ONE. A8 calipered the wired probe on
 * 2026-10-15 (#208): it is a plain cylinder 2.0 mm across, "a hollow cylinder, no ball". What
 * meets the blank's edge is therefore a rim at 1.0 mm, and `r − sqrt(r² − o²)` is written for a
 * ROUND foot of that radius — the rim's own reading against a square edge has not been measured
 * on the bench. The figure this module derives (`r` in, the 0.31 mm resolution out) is the
 * radius's, and re-checking the model against the cylinder is an open item for the #391
 * re-review, filed there rather than settled here.
 *
 * AND THAT QUESTION HAS THE BLANK'S DOME IN IT. The face being scanned is domed — 0.33 mm across
 * the 38 mm badge blank and 0.1 mm along its length (#345, §11.8), a slow rise that a touch near
 * the edge cannot tell from the edge itself. So the tolerance for "still the blank" is the blank's
 * OWN dome, and the dome is a SHAPE rather than one number (review of 36f3837, #391): it is lower
 * at the sides than at the ends, so "the blank's own top" is a different depth at each edge, and
 * `domeDropMm` below is the model that says how much lower. Each edge is judged against the top
 * where THAT edge is — which is what stops the single stated figure from swallowing a real change
 * near an edge that sits twice as far below the middle as the figure allows.
 *
 * WHAT THAT LEAVES AS THE RESOLUTION. A reading leaves the blank's own top once the corner
 * contact has sunk it past that local top by more than the dial can tell — a fixed 0.05 mm — so
 * the outward distance at which the change appears is `sqrt(2·r·0.05 − 0.05²)`: **0.31 mm** with
 * the measured 2.0 mm tip (#208 A8 — it was 0.4 mm while the tip stood in at 3 mm unmeasured), at
 * every edge, and *not* the ~1 mm the dome-sized band gave before. That is the figure the sheet
 * asks the operator to measure back by, and the reason the tip is stated on the sheet rather than
 * folded into a margin: the plan names the number it came from.
 *
 * NOTHING HERE DRIVES THE MACHINE, and nothing here needs to: the plan is a list of positions and
 * what to expect at each, the run sheet prints it in the operator's words, and the touches are
 * made from Studio's own touch-off dialog. What to DO with a measurement is #387's open question
 * (the work offset and the tool-length reference are entangled), so this module locates the blank
 * and stops there.
 */

import { inflate, viseEnvelope } from '@/engine/cnc/fixture';
import { DEFAULT_BADGE_DOME_MM } from './fromBadge';
import type { ObstacleBox } from '@/engine/cnc/setup';
import { PROBE_SPEC, SIDE_WORDS, type JobSide } from './registration';
// TYPE ONLY: this module is in the sim worker's import graph (via `runSheet.ts`), and a worker never
// imports `defaultsClient` (#449). The numbers come in as arguments.
import type { RegistrationSettings } from '@/engine/cnc/registration/settings';
import type { EngraveJob, StockFlatness } from '@/types/engraveJob';
import type { Mm, Vec2 } from '@/types/units';

/**
 * The scan's tunables (#449, #452) — the SAME shop defaults the registration planner reads
 * (`registration.*` in `location.json`), so the printed routine and the app's own scan cannot step
 * differently. {@link materialScanSettingsFrom} takes them off the planner's resolved settings; with
 * no location, {@link SCAN_FALLBACK} is used, and each of its numbers is that key's own labelled
 * fallback in `defaultsClient.ts` (`benchDefaults.spec.ts`/`materialScan.spec.ts` hold them equal).
 */
export interface MaterialScanSettings {
  /** How far the tip steps between coarse touches — `registration.coarseStepMm`. */
  coarseStepMm: Mm;
  /** The gap above the reference each touch is sent from — `registration.parkAboveSurfaceMm`. */
  startGapMm: Mm;
  /** How far past the jaw tops a touch may travel — `registration.scanMissMarginMm`. */
  missMarginMm: Mm;
  /** The depth two readings are told apart by — `registration.readingResolutionMm`. */
  readingResolutionMm: Mm;
  /** The wired probe tip's outside diameter — `registration.tipDiameterMm` (measured, #208 A8). */
  tipDiameterMm: Mm;
  /** The touch's feed, mm/min — `registration.touchFeed`, the planner's own scan feed. */
  touchFeed: number;
}

/** The labelled NO-SERVICE fallback: each figure is its key's fallback (and seed). */
export const SCAN_FALLBACK: Readonly<MaterialScanSettings> = {
  coarseStepMm: 1,
  startGapMm: 3,
  missMarginMm: 1,
  readingResolutionMm: 0.05,
  tipDiameterMm: PROBE_SPEC.tipDiameter,
  touchFeed: 150,
};

/** The scan's settings, off the registration planner's own (`registrationSettings(defaults)`). */
export function materialScanSettingsFrom(
  s: Pick<
    RegistrationSettings,
    'coarseStepMm' | 'parkAboveSurfaceMm' | 'scanMissMarginMm' | 'readingResolutionMm' | 'tipDiameterMm' | 'touchFeed'
  >,
): MaterialScanSettings {
  return {
    coarseStepMm: s.coarseStepMm,
    startGapMm: s.parkAboveSurfaceMm,
    missMarginMm: s.scanMissMarginMm,
    readingResolutionMm: s.readingResolutionMm,
    tipDiameterMm: s.tipDiameterMm,
    touchFeed: s.touchFeed,
  };
}

/**
 * How far the tip steps between coarse touches, mm — the FALLBACK, `registration.coarseStepMm`'s.
 * It was 2 here while the planner stepped 1 (#452); the sheet now prints the plan's own step.
 */
export const SCAN_COARSE_STEP_MM: Mm = SCAN_FALLBACK.coarseStepMm;

/**
 * How far past the jaw tops a touch is allowed to travel before the plan calls it nothing, mm.
 *
 * The whole reason the cap exists: a `G38.2` that never triggers keeps descending at the probe's
 * own feed, and past the jaws there is nothing to stop it reaching the bed. One millimetre past
 * the jaw tops is enough to prove there is nothing between them and the cap, and short enough to
 * be harmless if there is.
 */
export const SCAN_MISS_MARGIN_MM: Mm = SCAN_FALLBACK.missMarginMm;

/**
 * How far above the reference the tip is brought before each touch, mm — the height the touch is
 * SENT from (#391 review item 1).
 *
 * It has to be stated, because the `G38.2` Z word is a distance to TRAVEL and not a place to go
 * (§11.6), so the operator cannot send a touch at all without a start height to count down from.
 * The reference touch leaves the tip on the blank's top; this is the gap lifted above it, and it
 * is the blank's own dome plus room, since the face falls away toward the edges.
 */
export const SCAN_START_GAP_MM: Mm = SCAN_FALLBACK.startGapMm;

/**
 * The depth two readings can be told apart by, mm. The machine's dial, not the probe's spec — the
 * fallback; a plan uses its settings' `readingResolutionMm`.
 */
export const DEPTH_TOLERANCE_MM: Mm = SCAN_FALLBACK.readingResolutionMm;

/**
 * What to plan with when the job states no dome. NOT zero: an unstated dome is unknown, and 0 mm
 * would tell the plan the blank is flat (#345's own rule, and the badge figure is the measured
 * one the job would have carried). The plan says which figure it used.
 */
const PROVISIONAL_DOME_MM: Mm = DEFAULT_BADGE_DOME_MM;

/**
 * The blank's dome ALONG its longer span, mm — the second figure §11.8 measured (0.33 mm across
 * the badge's 38 mm span, ~0.1 mm along its 76 mm one), and the one the job has no field for: a
 * job states `flatness.dome` for ONE direction, and the model needs both.
 *
 * It is the measured badge blank's figure standing in for whatever blank is in the jaws, so the
 * plan names it as an assumption in its notes. A job that states its dome across the LONG span
 * gets its own figure there, and this one stands in across the short span instead.
 */
const DOME_ALONG_LONG_MM: Mm = 0.1;

/** A side of the blank. The same four `registration.ts` names, and the same words for them. */
export type ScanEdge = JobSide;

/**
 * What one downward touch found, read off the depth it triggered at.
 *
 * `corner` is the informative one and the reason the tip's geometry is written out above: a
 * reading there says the tip is over the blank's EDGE, so the edge is within a tip radius of the
 * point that produced it. `below` and `miss` both mean "not the blank", and are separate because
 * only a miss says the travel cap was reached — which is the reading that means the tip had
 * nothing under it at all.
 */
export type TouchSurface = 'blank' | 'corner' | 'below' | 'miss';

/**
 * What the fixture leaves under a point: a jaw's top certainly, nothing certainly, or — between
 * the two — a jaw whose own width the measurement does not pin down (decision 28).
 *
 * `maybe` is the whole reason this is not a boolean. The jaw boxes are the shipped or saved
 * dimensions grown by the vise's own `uncertainty`, and every consumer is supposed to work over
 * that band rather than trusting the point value (#203). A touch inside the raw box is on a jaw
 * whatever the true width is; one inside the grown box but not the raw one is on the jaw only if
 * the jaw runs wider than its nominal figure — which the plan does not get to assume.
 */
export type JawReach = 'on' | 'maybe' | 'off';

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
  /**
   * The OTHER surface this touch may read, when the fixture's own uncertainty covers the point
   * (`JawReach` = `'maybe'`). Present only when the two readings really differ, so a correct reading
   * is not a fault: `expect` is what the NOMINAL jaw gives (usually nothing, `miss`), and this is
   * what a jaw whose face reaches further in — or whose top runs wider — would give instead (the
   * jaw's top, `below`). One direction only, because growing the box can only ADD jaw.
   */
  alsoMaybe?: TouchSurface;
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
   * How far the blank's own top sits below the reference AT THIS TOUCH LINE, mm — the dome as a
   * shape rather than one tolerance (#391 review item 4). The blank's face is not flat and not
   * even: it is highest near the middle and falls away toward the sides, by a different figure
   * along each span, so this is what a reading here is judged against. `domeDropMm` owns the model.
   */
  dropMm: Mm;
  /**
   * The two depths that turn a reading HERE into a surface: this edge's own top plus the dial, and
   * the jaw's top. Per edge, because the first is (the second is the same everywhere — the jaw
   * top does not dome).
   */
  bands: ScanBands;
  /**
   * What lies under the outward touches: a jaw's top certain (`'on'`), nothing certain (`'off'`),
   * or a jaw whose width the fixture's own uncertainty leaves open (`'maybe'`).
   *
   * `'on'` for the left and right edges, whose touches sit on the jaw tops the blank is clamped
   * between — and `'off'` for the front and back edges, because a jaw reaches only along the
   * blank's ENDS: at the middle of a side there is the gap between the jaws, and the tip finds
   * nothing at jaw height there at all. That is the one fact about the fixture the operator cannot
   * see from where they stand and the plan can, and it is why those touches are capped.
   */
  jawUnder: JawReach;
  /** In the order they are taken: inboard first, outward after. */
  touches: ScanTouch[];
}

export interface MaterialScanPlan {
  tipRadiusMm: Mm;
  /** The settings the plan was made with (#449/#452) — the sheet quotes them rather than a constant. */
  settings: MaterialScanSettings;
  /** The touch every reading is measured from: the blank's top face, at its middle. */
  reference: ScanReference;
  edges: EdgeScan[];
  /**
   * The band the JOB's own statement gives — its stated dome plus the dial — which is the OUTER
   * bound: the blank's face is domed by at most that much anywhere, and each edge is judged
   * against the tighter band it carries (`EdgeScan.bands`), because the top where that edge is sits
   * above the figure's own extreme. Only `belowMm`, the jaw's top, is the same for every edge and
   * is therefore exact wherever it is read.
   */
  bands: ScanBands;
  /** How far below the reference a touch may travel before it is certainly on nothing, mm. */
  missTravelMm: Mm;
  /**
   * How far OUTSIDE the real edge a reading first leaves the blank, mm — the scan's own bias.
   *
   * ONE figure for every edge, and not by approximation: each edge's band is its own top plus the
   * dial, so the corner contact has to climb past the DIAL, the same 0.05 mm everywhere. It is
   * what the tip's radius buys and the tip alone (`sqrt(2·r·0.05 − 0.05²)`), which is why the tip
   * is stated on the sheet — measured, #208 A8 — rather than folded into a margin.
   */
  resolutionMm: Mm;
  /**
   * Full sentences: what this plan ASSUMES and what the fixture already guarantees. The run sheet
   * prints them, in this order, ahead of the steps that quote the numbers they qualify — an operator
   * about to act on a prediction reads what it rests on first (#391 review item 2).
   */
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
export function planMaterialScan(job: EngraveJob, scan: MaterialScanSettings = SCAN_FALLBACK): MaterialScanResult {
  const { length, width } = job.stock;
  const vise = job.workholding.vise;
  const tipR = scan.tipDiameterMm / 2;
  const proud = vise.stockProud;
  const dial = scan.readingResolutionMm;
  const step = scan.coarseStepMm;

  if (!(proud > dial)) {
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
  const blankMm = dome + dial;
  const belowMm = proud - dial;
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
  const inAny = (boxes: readonly ObstacleBox[], x: Mm, y: Mm): boolean =>
    boxes.some((b) => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1]);
  // The same boxes grown by the vise's own uncertainty — the band every consumer is meant to work
  // over (#203). Inside the raw box the jaw is there whatever its true width is; inside the grown
  // one it is there only if the jaw runs wider than the number says, and the plan says so rather
  // than picking the reading it prefers (#391 review item 7).
  const grown = envelope.boxes.map((b) => inflate(b, envelope.uncertainty));
  const jawReach = (x: Mm, y: Mm): JawReach =>
    inAny(envelope.boxes, x, y) ? 'on' : inAny(grown, x, y) ? 'maybe' : 'off';

  // Where the corner contact has sunk past the blank's own top: the outward distance at which a
  // reading first stops reading as the blank. It answers two questions with one number — how far
  // past the real edge the change appears (the scan's bias) and how finely the scan can place an
  // edge — because they are the same distance. Past the DIAL rather than the dome, since each edge
  // is judged against the top where that edge is: see `resolutionMm` on the plan.
  const resolutionMm = cornerBandMm(dial, tipR);

  /** What each of those four is for, in the same order — see `ScanTouch.role`. */
  const roles: readonly ScanTouch['role'][] = ['inside', 'inside', 'edge', 'outside'];

  const offsets: Mm[] = [
    // Clear of the edge, and should read the blank's own top: the touch that catches a blank
    // seated proud of where it is meant to be.
    -(tipR + step),
    // Close to the edge, still on the blank — the near side of the bracket.
    -tipR,
    // AIMED AT THE EDGE ITSELF: the middle of the corner band, where the tip meets the blank's
    // corner and the reading goes deepest before the jaw takes it. The one sample whose expected
    // reading is neither the blank's top nor past it, so it is the one that places the edge within
    // a tip radius of a position the operator can read off the machine. Rounded to a tenth, because
    // it is a position to jog to and the scan cannot place an edge to a thousandth of anything.
    roundOff((resolutionMm + tipR) / 2),
    // Past the edge: a jaw's top, or nothing at all.
    tipR + step,
  ];

  const edges: EdgeScan[] = sidesFor(job).map(({ edge, axis, dir, nominalMm, alongMm }): EdgeScan => {
    const at = (o: Mm): Vec2 =>
      axis === 'x' ? [nominalMm + dir * o, alongMm] : [alongMm, nominalMm + dir * o];
    // The blank's own top AT THIS LINE, and the band that follows from it. The face is a shape, so
    // each edge is judged against the height it actually has, not against the one figure the job
    // states for one direction (#391 review item 4) — and that is what keeps a reading on a blank
    // whose edges sit twice as far below the middle as the figure allows from being read as a cut.
    const [ex, ey] = at(0);
    const dropMm = domeDropMm(job, ex, ey);
    const edgeBands: ScanBands = { blankMm: dropMm + dial, belowMm };
    const touches = offsets.map((offsetMm, i): ScanTouch => {
      const point = at(offsetMm);
      const reach = jawReach(point[0], point[1]);
      // The reading the plan stands behind is the one the fixture's NOMINAL dimensions give. When
      // the uncertainty reaches this point the other one is named beside it, rather than folded
      // away: the jaw is calipered now, so the band is narrow (±0.5, #208 2026-10-15), but it is
      // still a band — "the jaw's top, or nothing at all if the jaw runs wider than its number"
      // stays the honest sentence, and one reading is not a fault (item 7).
      const sure = predictedDepthMm(offsetMm, tipR, proud, dropMm, reach === 'on');
      const touch: ScanTouch = {
        edge,
        offsetMm,
        role: roles[i] ?? 'inside',
        at: point,
        expect: surfaceOf(sure, edgeBands),
      };
      if (reach === 'maybe') {
        const other = surfaceOf(predictedDepthMm(offsetMm, tipR, proud, dropMm, true), edgeBands);
        if (other !== touch.expect) touch.alsoMaybe = other;
      }
      return touch;
    });
    const outward = at(tipR);
    return {
      edge,
      axis,
      dir,
      nominalMm,
      alongMm,
      dropMm,
      bands: edgeBands,
      jawUnder: jawReach(outward[0], outward[1]),
      touches,
    };
  });

  const missTravelMm = proud + scan.missMarginMm;
  /** The outward touch's offset past the nominal edge, mm — the last of `offsets`. */
  const outwardMm = tipR + step;
  const flatness: StockFlatness | undefined = job.stock.flatness;
  const acrossX = flatness === undefined || flatness.across === 'width';
  const free = edges.filter((e) => e.jawUnder === 'off');
  const unsure = edges.filter((e) => e.jawUnder === 'maybe');
  /** The blank's own height below the reference at one edge's touch line, mm. */
  const dropAt = (edge: ScanEdge): Mm => edges.find((e) => e.edge === edge)!.dropMm;
  /** The two figures the shape is built from: the span the job's own dome names, and the other. */
  const acrossDrop = acrossX ? dropAt('left') : dropAt('front');
  const otherDrop = acrossX ? dropAt('front') : dropAt('left');

  return {
    tipRadiusMm: tipR,
    settings: { ...scan },
    reference: { at: [length / 2, width / 2], expect: 'blank' },
    edges,
    bands,
    missTravelMm,
    resolutionMm,
    notes: [
      // THE TIP FIRST (#391 review item 2): it is the figure every other one here is derived from,
      // so an operator reading a prediction is entitled to know what it is and where it came from.
      // It used to say AS ASSUMED — no tip had been measured. A8 calipered it on 2026-10-15, so the
      // sentence now names the reading instead (and still names WHICH probe it is, because the
      // machine ships three and only the wired one is the touch-off tip).
      `The tip is ${fmtNum(scan.tipDiameterMm)} mm across, measured (#208 A8, 2026-10-15: the wired ` +
        `probe's shaft — a hollow cylinder, no ball): every position and depth below is derived ` +
        `from this one figure — the ${fmtNum(resolutionMm)} mm the reading stands past the edge is ` +
        'its radius and the dial, and a smaller tip is a sharper scan.',
      flatness
        ? `The ${fmtNum(dome)} mm the reads are allowed to vary by is the dome the job states ` +
          `(${flatness.source}, across its ${flatness.across}).`
        : `The job states no dome, so the reads are allowed the ${fmtNum(dome)} mm the badge blank ` +
          'measured — a domed blank is the case that matters, and this is the figure to correct.',
      `The face is a SHAPE and not one number, so the blank’s own top sits at a different depth at ` +
        `each edge: about ${fmtNum(dropAt('left'))} mm below the reference at the left and right ` +
        `edges, ${fmtNum(dropAt('front'))} mm at the front and back. The ${fmtNum(acrossDrop)} mm the ` +
        `job states is taken across the span it names; the other span carries the ` +
        `${fmtNum(otherDrop)} mm §11.8 measured on the badge blank. Each edge’s step prints the ` +
        'height it is judged against.',
      free.length > 0
        ? `Nothing lies at jaw height under the tip past ${names(free.map((e) => e.edge))} — a jaw ` +
          'reaches only along the blank’s ends — so those outside touches have nothing to stop ' +
          `them: a miss there is the expected reading, not a fault, and the cap ${fmtNum(missTravelMm)} mm ` +
          'below the reference is what keeps them off the bed.'
        : 'Every edge has a jaw top outside it, so an outside touch stops on the jaw rather than on the cap.',
      ...(unsure.length > 0
        ? [
            `Past ${names(unsure.map((e) => e.edge))} the answer is not certain either way: the ` +
              `outward touch sits within the ${fmtNum(vise.uncertainty)} mm the fixture’s own ` +
              'measurement is uncertain by, so the jaw’s top may end short of it. Those steps print ' +
              'both readings.',
          ]
        : []),
      `The ${job.workholding.kind} already fixes X and rotation to within ±${fmtNum(vise.uncertainty)} mm, so the left and right edges mostly re-check that the blank is seated against them; the front and back edges are the free ones.`,
      'A Z-only tip cannot find rotation: this scan says where the edges are, not whether the blank sits square in the jaws.',
      // #449 review item 5 — #452's 1 mm step brings the outside touch to within a millimetre of the
      // blank's wall, and it may descend the whole start gap plus the cap there. That is safe only if
      // nothing wider than the tip reaches the blank's top edge first — an assumption, stated as one.
      `The outside touch is ${fmtNum(outwardMm)} mm past the edge — the tip's side ${fmtNum(outwardMm - tipR)} mm from ` +
        `the blank's wall — and may descend ${fmtNum(scan.startGapMm + missTravelMm)} mm from where it is sent. That ` +
        'ASSUMES the probe’s straight shaft, below anything wider than the tip, is longer than that descent: not ' +
        'measured. If it is shorter, the wider part meets the blank’s top edge and the reading is not the tip’s.',
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
function predictedDepthMm(o: Mm, tipR: Mm, proud: Mm, dropMm: Mm, jawUnder: boolean): Mm | null {
  // Inside the edge the tip lands on the blank's own face, which is `dropMm` down here.
  if (o <= 0) return dropMm;
  // The corner contact is a CLIMB up from that face (`r − sqrt(r² − o²)`), and a reading is a depth
  // below the reference: the blank's local top plus the climb.
  const climb = o < tipR ? tipR - Math.sqrt(tipR * tipR - o * o) : null;
  const corner = climb === null ? null : dropMm + climb;
  // Whichever the tip meets first — the jaw's top only stops it if the jaw stands above the
  // corner, and past a full radius the corner is out of reach entirely.
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
 * How far outside the real edge the corner contact has sunk the reading past `sinkMm`, mm: the
 * outward distance at which a reading first stops reading as the blank.
 *
 * `sinkMm` is the HEADROOM a reading has before it stops being the surface it is compared against
 * — the dial, for an edge (`bands.blankMm` less the blank's own height there), because each edge is
 * judged against its own top. The result is capped at the tip's radius, which is the deepest the
 * corner contact goes: past that the tip is off the blank entirely and the scan is no better than
 * its tip.
 */
function cornerBandMm(sinkMm: Mm, tipR: Mm): Mm {
  return sinkMm >= tipR ? tipR : Math.sqrt(2 * tipR * sinkMm - sinkMm * sinkMm);
}

/**
 * The blank's own face as a SHAPE, mm below its highest point, at a point on the blank — the model
 * that replaced the dome-as-a-tolerance the review of 36f3837 called out (#391 item 4).
 *
 * Two parabolas, one per span, which is the shape §11.8 measured: the badge blank's face is convex,
 * highest near the middle, and **0.33 mm lower at its left and right edges** than at the middle,
 * **0.1 mm lower at its front and back**. Those are not the same number and they are not a
 * tolerance around the middle's: a touch near a side meets a face 0.33 mm further down than a touch
 * near an end, and a plan that judged both by the middle's figure would swallow the first 0.28 mm
 * of a real change at the ends.
 *
 * THE SPANS ARE THE JOB'S, AND THE WORD `across` IS THE BADGE'S — THE OTHER WAY ROUND. `flatness`
 * travels with a badge, where `across: 'width'` means the BADGE's width, which `badgeBlankFor`
 * makes the job's `stock.length`: the X span the left and right edges bound. So `'width'` is the
 * job's X, `'length'` its Y, and the stated figure is applied to the span it names — with the
 * badge's measured figure for the span the job states nothing about.
 */
function domeDropMm(job: EngraveJob, x: Mm, y: Mm): Mm {
  const { length, width } = job.stock;
  const acrossX = job.stock.flatness === undefined || job.stock.flatness.across === 'width';
  const stated = job.stock.flatness?.dome ?? PROVISIONAL_DOME_MM;
  const dropX = acrossX ? stated : DEFAULT_BADGE_DOME_MM;
  const dropY = acrossX ? DOME_ALONG_LONG_MM : stated;
  // Normalised so ±1 is the blank's own edge on that axis and 0 is its middle, where the reference
  // touch is: the model's zero and the scan's zero are the same point by construction.
  const u = length > 0 ? (2 * x) / length - 1 : 0;
  const v = width > 0 ? (2 * y) / width - 1 : 0;
  return dropX * u * u + dropY * v * v;
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
