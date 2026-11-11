/**
 * The registration planner (#430 phase 1): where the stock is, found with the wired probe's Z-only
 * touches, as the 2026-10-15 bench found it (`docs/bench/traces/2026-10-15-console.log`).
 *
 * WHAT THE PLAN IS. The surface touch at a clean point — the centre of the CUT AREA (§5.9), else the
 * stock's — then one EDGE SCAN per edge the mount leaves to be found. A scan is a line across one
 * edge: it brackets the edge between a point ON the stock (the surface touch's coordinate along the
 * axis) and a point OFF it, then bisects to the fine step (`execute.ts`, #594).
 *
 * THE SURFACE TOUCH IS BOUNDED (#430 review). The job says where it expects the stock's top (machine
 * Z — from the stock's thickness, the mount and G54 Z); the seek travels only to that surface −
 * `surfaceToleranceMm`, and a reading outside expected ± tolerance is refused. One unchecked touch
 * would otherwise set the surface, the park height and every cap after it.
 *
 * WHICH EDGES, BY MOUNT (§5.9's table):
 *   - bracket — XY is the anchor bracket's (machine-known): the work origin comes from anchor1 and the
 *     stock's offset in the bracket; only the surface, unless Q10's OPTIONAL confirming touch is asked
 *     for (`bracketConfirm`, #427): one scan across the RIGHT edge and one across the BACK — the bracket's
 *     arms are on the left and the front, where a scan would land on the bracket — kept clear of the
 *     clamps. They confirm the stock is pushed into the corner; they never move the origin. While the
 *     bracket's offset from the anchor is a default, not measured, the confirming touch is REQUIRED.
 *     The plan carries the mount's obstacles (`mountObstacles`: the clamps and the arms, as the job
 *     places them): a top that reaches the travel height is refused, the surface point must be clear
 *     of them, and the operator confirms the clamps are where the plan puts them before anything moves
 *     sideways (`execute.ts`). The travel height is the resolved machine's `toolChange.clearanceZ`
 *     (`machine.ts`), passed in as `seekFromMachineZ`; BOTH the seek's start AND this refusal bound
 *     read that one value, so the invariant "nothing stands above the travel height" holds whatever
 *     height a valid calibration supplies.
 *     Every XY move on the bracket is sent in MACHINE coordinates (`G53`), from the bracket's origin, so
 *     the touches land on the stock whatever G54 was left in force.
 *   - vise — the left edge (a confirm against the fixed jaw) and the front edge (Y — Appendix C). The
 *     jaw tops must sit clear BELOW the park height and below the surface band, or a scan could not
 *     tell a jaw from the stock — or would move sideways into one.
 *   - tape — the left edge at TWO points (position and rotation) and the front edge.
 *
 * THE CORNERS ARE ROUNDED. A scan line is kept `cornerRadius + cornerClearanceMm` from both corners of
 * its edge, because a touch on the roll-off reads lower than the top and would look like the edge.
 *
 * Pure: work coordinates in, a plan out. No machine, no store.
 */

import { PARK_CLEARANCE_MM } from '@/platform/defaultsClient';
import { PROBE_RESIDUAL_MM } from '@/engine/cnc/probePlan';
import type { SetupFlip } from '@/types/engraveJob';
import { settingsProblem, type RegistrationSettings } from './settings';
import { planFootprintRegistration } from './footprint';
import { centrePair } from './centreFind';
import { MIN_SIDE_DEPTH_MM, SIDE_TOUCH_JAW_MARGIN_MM, sideTouchAllowed, sideTouchSelected, type SideTouchSubject } from './probe3d';

export type Mount = 'vise' | 'bracket' | 'tape';

/** The stock as the job expects it, in WORK XY (mm). */
export interface ExpectedStock {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  /** The radius of its rounded corners (a printed blank's), 0 for sharp ones. */
  cornerRadius: number;
}

export type Edge = 'left' | 'right' | 'front' | 'back';

/**
 * #525 — the corner a CORNER-FINDING plan measures: two sideways lines on each of the two edges
 * that meet there. The measure is the corner's position AND the stock's rotation (the angle the
 * edges really make), so this is Studio's "Set Origin with 3D Probe" corner mode.
 */
export type CornerId = 'front-left' | 'front-right' | 'back-left' | 'back-right';

/** The two edges that meet at a corner, in this module's own names. */
export function cornerEdges(id: CornerId): { xEdge: 'left' | 'right'; yEdge: 'front' | 'back' } {
  return {
    xEdge: id === 'front-right' || id === 'back-right' ? 'right' : 'left',
    yEdge: id === 'back-left' || id === 'back-right' ? 'back' : 'front',
  };
}

export interface EdgeScan {
  edge: Edge;
  along: number;
  expectedAt: number;
  outward: 1 | -1;
  start: number;
  limit: number;
  coarseStep: number;
  fineStep: number;
  /**
   * #593 — where the inward search stops when the scan's first touch misses the stock: the OPPOSITE
   * edge's expected position (the stock's far edge). Absent on a reference scan, whose bound is the
   * opening's centre and which never searches inward.
   */
  oppositeAt?: number;
  /**
   * #517 — a reading ABOVE the surface band on this scan is the mount's own top standing over a recessed
   * stock (the vise jaw when the stock sits below the jaw tops): it is where the stock ENDS, not an
   * obstacle in the way. The executor halves back from it like a miss and the outcome takes it as the
   * first touch off. Absent (the proud case, the bracket, tape): a high reading is a clamp, and stops.
   */
  aboveIsEdge?: boolean;
  /**
   * What the scan finds, in words, when it is not one of the stock's own edges — "the left wall of the
   * four holes" (#429). The finding's sentences use it; the stock's edge name otherwise.
   */
  label?: string;
}

/**
 * #598 — the probe checked out to the machine, so the planner resolves the tip/rim values from the
 * instrument rather than the shop fallback (`registrationSettings`). `tip.rimOffsetMm` is the
 * EFFECTIVE rim offset — the setting `tipRadiusMm`; `tip.rimOffsetUncertaintyMm` maps to
 * `tipRadiusUncertaintyMm`.
 *
 * #525 — the instrument is part of the spec: a Z-ONLY probe finds an edge by stepping past it and
 * descending at each point, while the 3D probe triggers SIDEWAYS and finds it in one horizontal
 * touch whose correction is the stylus ball's radius. `instrument` is derived from the accessory's
 * variant (`probeInstrument`), optional because a plan frozen before #525 carries none and is a
 * Z-only instrument by construction.
 *
 * `tip` is NULL for a checked-out probe nobody has measured yet — the house's 3D probe today. That
 * is not a licence to fall back to the shop's wired values: the planner refuses the plan and says
 * to measure the tip, because a sideways correction with the wrong radius is a silent offset on
 * every edge it finds.
 */
export interface ProbeSpec {
  id: string;
  variant: string | null;
  /** `xyz` = the Makera 3D probe (sideways touches); absent/`z-only` = the wired probe. */
  instrument?: ProbeInstrument;
  /** The measured tip, or null when this instrument's tip has never been measured. */
  tip: { diameterMm: number; rimOffsetMm: number; rimOffsetUncertaintyMm: number } | null;
  /**
   * #1179 B — the probe's BODY: how far the tip sticks out (`tipLengthMm`) and the stem/body
   * diameter above it. A floor deeper than the tip's length is entered by the body, and is only a
   * candidate when the body's diameter is recorded (or the floor is within the tip's length).
   * Absent on every record that never measured them — the candidate choice then keeps to the
   * uncut top and says so.
   */
  tipLengthMm?: number | null;
  bodyDiameterMm?: number | null;
  /**
   * #1200 — THE OPERATOR'S TOUCH RESTRICTION FOR THIS UNIT. `z-only` never plans a sideways
   * `G38.3`: a stylus that is not exactly on the spindle axis reads every edge off by the bend,
   * and side loads are what break a repaired one. `all` keeps the instrument's own capability.
   *
   * The effect is separate from `instrument` on purpose: the INSTRUMENT is what the variant is
   * (a 3D probe still releases its stylus before any rapid, still needs its M491 reference), and
   * this is how far the operator lets it touch. `probeFor` states the unit's default — `all` for
   * the 3D variant, `z-only` for the wired V2 (the issue's ruling, 2026-11-10) — and a plan with
   * no probe at all (or a probe with the field absent) keeps #1133's rule byte for byte.
   */
  touches?: ProbeTouchRestriction;
  /**
   * #1200 — HOW FAR OFF THE AXIS THE TIP MAY BE, mm, as the operator states it (0 default). A top
   * touch is never planned closer to an edge than this plus the tip radius: near an edge the ball
   * can drop onto the roll-off and read low, and a bent stylus makes that worse.
   */
  tipLateralUncertaintyMm?: number;
  /**
   * #1203 — THE SHANK (POST) FITTED TO THIS UNIT, its diameter in mm. The wired V2's sensor and
   * tip are one unit; the shank is a threaded post that swaps for different collets (1/8" =
   * 6.35 mm, 6 mm), so the fit-probe prompt names the collet the operator must have in the
   * spindle. The tip values belong to the sensor and survive a swap; only this changes.
   */
  shankMm?: number | null;
}

/** How a probe can touch: straight down only, or sideways as well (#525). */
export type ProbeInstrument = 'z-only' | 'xyz';

/** #1200 — the operator's restriction on one probe UNIT: top touches only, or everything. */
export type ProbeTouchRestriction = 'z-only' | 'all';

/**
 * The instrument an accessory variant names. The house registers the 3D probe as variant `'3d'`
 * (#601, accessory `fx-probe-3d`); everything else — the wired touch probe, an unstated variant —
 * is the Z-only probe the current planner was written for.
 */
export function probeInstrument(variant: string | null): ProbeInstrument {
  return variant !== null && /^3d$/i.test(variant.trim()) ? 'xyz' : 'z-only';
}

/** The instrument a plan's probe was for; an absent field (a pre-#525 plan) is the wired probe. */
export function probeInstrumentOf(probe: Pick<ProbeSpec, 'instrument'> | null | undefined): ProbeInstrument {
  return probe?.instrument ?? 'z-only';
}

/**
 * #598 — the MEASURED mount datum: the vise's jaw top in machine Z, when it was measured, and by what
 * (the probe's id/variant that tapped it). The expected surface is `jawTopZ + stockProud`; with a
 * datum the surface seek is a SEARCH down to `jawTopZ − surfaceToleranceMm`, not a band around an
 * estimate, and the surface tolerance becomes a plausibility warning rather than a stop.
 */
export interface MountDatum {
  jawTopZ: number;
  measuredAt: string;
  by: string;
  /**
   * #1189 — the probe's `M491` reference at the tap that measured this jaw top. The value is a raw
   * machine Z; a probe refitted since then makes every expected surface shift by the difference.
   * Absent/null on a legacy datum: the card asks for the one-touch re-measure instead of using it.
   */
  probeRefZ?: number | null;
}

/**
 * #607 — which datum a mount tap's reading measures. The vise's reading IS its jaw-top datum; the
 * bracket's top is the seat it stands on plus the arm's measured height (`bracket.armTopMm`).
 *
 * The rotary is deliberately absent: a touch from above on a chuck/nose lands at the axis plus an
 * unmeasured radius, so writing `rotaryAxis` from it would be worse than no datum. That geometry
 * (a flat face at axis height, or the radius) is a bench question of its own — the rotary tap
 * arrives with it, and the union gains its member then.
 */
export type MountTapReference = 'vise-jaw-top' | 'bracket-seat' | 'rotary-axis';

/**
 * #599/#607 — the mount's reference point for the registration tap, as the plan carries it.
 *
 * The first four fields are #599's (the vise's fixed-jaw tap). #607 adds the three that let the
 * executor and the write-back treat a bracket or rotary the same way without knowing the mount:
 * WHAT the reading is for, what machine Z the touch expects, and how far below the reading the datum
 * sits. They are optional so a pre-#607 plan (and every test fixture built on one) still reads as
 * the vise's jaw top.
 */
export interface PlanMountTap {
  x: number;
  y: number;
  fromMachineZ: number;
  label: string;
  /** #607 — the datum this reading measures; absent means the vise's jaw top. */
  reference?: MountTapReference;
  /**
   * #607 — the machine Z the touch expects to meet (the stored reference surface: the jaw top, or
   * the bracket's top = seat + height), or null/absent when there is no stored reference to check
   * against. With one, the executor bounds the tap by it (floor `expectZ − 2`, reading within ±2).
   */
  expectZ?: number | null;
  /** #607 — how far below the reading the DATUM sits: the bracket's own height; 0/absent for the vise. */
  datumOffsetMm?: number;
  /**
   * #1189 — the probe's reference at the measurement `expectZ` comes from. The executor corrects
   * `expectZ` by `today's M491 − probeRefZ` before it compares a touch with it. Absent/null on a
   * legacy datum: the tap runs without a stale expectation and writes a fresh reading.
   */
  probeRefZ?: number | null;
}

export interface PlanInput {
  stock: ExpectedStock;
  mount: Mount;
  /**
   * #743 D-2 — the stock is a DISC, and this is the diameter the job states. The plan then scans
   * all FOUR edges through the centre-lines: opposite pairs give the centre and the span, which a
   * plate's one-sided scans cannot (a plate's origin is its corner; a disc's is its centre − R).
   * Absent for a rectangle, whose plan is unchanged.
   */
  disc?: { diameterMm: number };
  /**
   * #525 — THE CORNER ROUTINE (Studio's "Set Origin with 3D Probe" corner mode). When set, the plan
   * takes TWO sideways lines on each of the two edges that meet at this corner: their intersection
   * is the corner's position and the angle they make is the stock's rotation. Only the 3D probe can
   * do it (a sideways touch is how an edge is found), and only where both edges are free to touch
   * — the tape mount; a vise's jaws block the X edges and the bracket fixes the origin itself.
   */
  corner?: CornerId;
  /**
   * REQUIRED, and the CALLER's to supply: where the job expects the stock's top, in MACHINE Z, and what
   * that is from — the stock's thickness on the mount's known top (the vise's jaw top − proud, the
   * wasteboard + thickness). **Not G54 Z**: G54 Z is the CUTTER's zero (#387 — `G10 L2` writes it with
   * the cutter fitted, and it carries that tool's length), so it is not where a probe will touch the
   * stock, and using it would offset the whole seek band by the difference between the two tools.
   */
  expectedSurface: { machineZ: number; from: string };
  /**
   * #598 — the MEASURED mount datum (the vise's jaw top, machine Z). Present on the normal vise path;
   * null/absent means the caller could not supply one and turns the plan into a `need-datum` ("tap the
   * jaw first"), exactly as `need-seat` today. The legacy typed-seat path (the expert override) passes
   * null and relies on `expectedSurface` + `fixtureBelowSurfaceMm` as before.
   */
  mountDatum?: MountDatum | null;
  /**
   * #598 — the probe checked out to the machine. Absent with no checked-out probe; the caller resolves
   * the tip values into the settings first (`registrationSettings`), and this carries the instrument
   * on the plan for the record.
   */
  probe?: ProbeSpec | null;
  /**
   * #599/#607 — the mount's reference point for the registration tap, MACHINE XY. The caller
   * computes it (`mountContext.ts`: the vise's fixed-jaw top, the bracket's front arm, the rotary's
   * nose); the executor touches it once before the surface seek and checks it against the stored
   * reference. Absent on the tape.
   */
  mountTap?: PlanMountTap | null;
  /**
   * #1070 — THE CUT REGION'S FOOTPRINT for a bed-held job: its extents in WORK XY and the job's
   * own edge margin. Present, the plan is the region-extent registration — the front and left
   * edges touched at the region's ends, the far edges once each as presence proofs, one Z touch
   * per region corner — and the origin is derived from the touched edges. Absent: every existing
   * plan is exactly what it was.
   */
  region?: { min: [number, number]; max: [number, number]; marginMm: number };
  /**
   * #1070 — the machine's soft endstop (the calibration read). Every planned position is checked
   * against it before any line is sent; `null`/absent says the check could not be made.
   */
  softLimits?: { xMin: number; yMin: number; zMin: number } | null;
  /**
   * #619 — the stock's thickness, mm, for the datum path's upper surface bound: a normally mounted
   * blank may stand the full thickness proud of the jaw tops (it need not sit on the ledge), so the
   * seek accepts a surface up to `jawTop + thickness + tolerance`. Absent on the legacy seat path.
   */
  stockThicknessMm?: number;
  /**
   * #1189 — THE PROBE REFERENCE the expected surface was computed from (its datum's `probeRefZ`).
   * The plan is built before the probe's `M491`; the executor shifts the expected top and every
   * band derived from it by `today's M491 − this`. Absent/null: a derived or typed seat (no datum
   * sets the expectation), or a stored plan from before the key — today's behaviour.
   */
  probeRefZ?: number | null;
  /** #1189 — the datum's words in the correction sentence ('the seat', 'the jaw top', …). */
  probeRefLabel?: string | null;
  /**
   * #1189 — when the seek's FLOOR comes from a different datum than its expected top (a surface
   * top above, the jaw under it), that datum's own reference. Absent: the floor follows
   * {@link probeRefZ}.
   */
  floorProbeRefZ?: number | null;
  /**
   * REQUIRED, and the CALLER's to supply: the machine's own travel height in MACHINE Z — the resolved
   * machine's `toolChange.clearanceZ` (`machine.ts` → `resolveMachine`), the Z the controller lifts to
   * before any clearance traverse. It is BOTH the height the seek starts from AND the bound the obstacle
   * check is measured from (`planRegistration`), so the two can never drift: a clamp or the bracket's
   * arm whose top reaches this height is refused, because the probe would be driven into it.
   */
  seekFromMachineZ: number;
  /** The centre of the cut area, work XY — the clean point the surface is touched at. Default: the stock's centre. */
  cutCentre?: { x: number; y: number };
  /**
   * Vise: how far the jaw tops sit BELOW the stock's top (the stock's proud height), mm. NEGATIVE when
   * the stock sits below the jaw tops (a thin sheet on the ledges, #488/#517): the jaws then stand above
   * it by that much, and a touch past the gripped edge lands on a jaw and reads high.
   */
  fixtureBelowSurfaceMm?: number;
  /** Bracket: the work origin in MACHINE XY, from anchor1 and the stock's offset in the bracket. */
  bracketOrigin?: BracketOrigin;
  /**
   * Bracket, REQUIRED (#427): the clamps and the bracket's arms as the job places them, work XY, each top
   * in work Z (above the stock's top) — `mounts/bracket.ts`'s `clampObstacles` / `bracketObstacles`.
   * An empty list says "no clamps", and the operator is asked to confirm that too.
   */
  mountObstacles?: PlanObstacle[];
  /**
   * Bracket: Q10's confirming touch (#427) — scans across the right and back edges, each line kept clear
   * of `mountObstacles`. Optional once the bracket's offset is measured; required until then.
   */
  bracketConfirm?: boolean;
}

/** The bracket's origin in machine XY, and whether its offset from the anchor was measured. */
export interface BracketOrigin {
  x: number;
  y: number;
  from: string;
  offsetMeasured: boolean;
}

export interface PlanObstacle {
  kind: 'clamp' | 'bracket';
  label: string;
  min: [number, number];
  max: [number, number];
  /** Its highest point, work Z (the stock's top is 0). */
  topZ: number;
}

export interface RegistrationPlan {
  mount: Mount;
  stock: ExpectedStock;
  /** #743 D-2 — the disc this plan registers on its rim: its stated diameter. Absent for a rectangle. */
  disc?: { diameterMm: number };
  /**
   * #827 — a corner plan's X datum. `stock` (or absent): the stock's own X face, found with sideways
   * touches above the jaws. `jaw`: the stock does not stand proud enough, so X comes from the fixed
   * jaw's face with the Z-only scan — a tolerance answer, stated in one line, never a stop.
   */
  cornerXFrom?: 'stock' | 'jaw';
  /**
   * #525 — the corner this plan measures: two sideways lines per edge on the two named edges. The
   * outcome intersects their lines for the origin and reads the stock's rotation from the same
   * points. Absent on every other plan.
   */
  corner?: { id: CornerId; xEdge: 'left' | 'right'; yEdge: 'front' | 'back' };
  /** #619 — the stock's thickness, mm, for the datum path's upper surface bound. */
  stockThicknessMm?: number;
  /** #1189 — the probe reference the Z expectations were computed at, and whose words; see PlanInput. */
  probeRefZ?: number | null;
  probeRefLabel?: string | null;
  /** #1189 — the floor's own datum reference when it differs from {@link probeRefZ}. */
  floorProbeRefZ?: number | null;
  /**
   * #1189 — this is the SEAT-SEEK plan run to re-measure a seat whose stored reading predates the
   * probe's last fitting (it carries no reference). The one touch writes it with the reference.
   */
  seatRemeasure?: 'probe-refit';
  surfacePoint: { x: number; y: number };
  /**
   * #1179 B — TOUCH POINTS ON A BLANK THAT HAS BEEN CUT, work XY with the depth each point is
   * expected to sit at below the stock top (0 = uncut). The executor touches three (up to five
   * without an agreeing pair); a reading + its depth is the IMPLIED top, and two implied tops
   * agreeing within `cutBlankAgreeMm` are the answer. Present only on a cut-blank plan; absent on
   * a fresh blank, whose single-touch transcript is byte-identical.
   */
  surfaceChecks?: { x: number; y: number; depthMm: number }[];
  /**
   * #1179 B — the plan's check points were chosen OUTSIDE today's package footprint because no
   * finished program of this package is recorded: the earlier plan's cuts are unknown, and the
   * record says so (the points are assumed uncut, d = 0).
   */
  surfaceChecksUnknown?: true;
  /**
   * #1179 B — why the check points are the uncut top only (the probe's body/tip length is not
   * recorded, so a floor could not be entered safely). Present only when that restricted the
   * choice; the run's note carries the sentence.
   */
  surfaceChecksProbeNote?: string;
  /** The surface touch: from the machine's travel height (`seekFromMachineZ`), at most this far down; and the band a reading must land in. */
  seek: { fromMachineZ: number; travelMm: number; band: { min: number; max: number } };
  /** #598 — the measured mount datum the seek is a search from, or null on the legacy seat path. */
  mountDatum: MountDatum | null;
  /** #598 — the probe checked out to the machine, whose tip/rim resolved the settings; null with none. */
  probe: ProbeSpec | null;
  /** #599/#607 — the mount tap the executor touches before the surface seek, or null. */
  mountTap: PlanMountTap | null;
  scans: EdgeScan[];
  bracketOrigin: BracketOrigin | null;
  /** Bracket: what stands above the stock, as the operator must confirm it (#427). Empty elsewhere. */
  mountObstacles: PlanObstacle[];
  settings: RegistrationSettings;
  notes: string[];
  /**
   * #429 — a plan that registers on FEATURES cut in an earlier setup: each one's expected centre and
   * which of `scans` read its walls. Present only on such a plan; its outcome is `referenceOutcome`.
   */
  references?: ReferenceEntry[];
  /** #429 — the pair the turn is read between, how far apart, and to what resolution across the stock. */
  referenceRotation?: { between: [string, string]; separation: number; resolutionMm: number } | null;
}

export interface ReferenceEntry {
  itemId: string;
  name: string;
  /** Its expected centre, work XY. */
  centre: { x: number; y: number };
  /** Its expected size across X and Y, mm — what the measured wall separation is checked against. */
  size: { x: number; y: number };
  /** Indices into `scans`: the walls read on each axis (one or two each). */
  xScans: number[];
  yScans: number[];
}

export type PlanResult = { ok: true; plan: RegistrationPlan } | { ok: false; reason: string };

/** #593 — the opposite edge's expected position: where a scan's inward search stops. */
function oppositeExpectedAt(edge: Edge, stock: ExpectedStock): number {
  switch (edge) {
    case 'left':
      return stock.xMax;
    case 'right':
      return stock.xMin;
    case 'front':
      return stock.yMax;
    case 'back':
      return stock.yMin;
  }
}

function scanFor(edge: Edge, along: number, stock: ExpectedStock, s: RegistrationSettings): EdgeScan {
  const outward: 1 | -1 = edge === 'right' || edge === 'back' ? 1 : -1;
  const expectedAt = edge === 'left' ? stock.xMin : edge === 'right' ? stock.xMax : edge === 'front' ? stock.yMin : stock.yMax;
  return {
    edge,
    along,
    expectedAt,
    outward,
    // #1133 — THE EDGE-FIND BAND. The scan spans the expected edge ± `edgeBandMm`, never further:
    // a sideways seek approaches from OUTSIDE the stock and stops at the first touch, and the
    // Z-only fallback's bracket never probes deeper in than the band — so an edge find is never
    // near the bores, pockets and clamps inside the stock (the maintainer's rule, 2026-11-09).
    start: expectedAt - outward * s.edgeBandMm,
    limit: expectedAt + outward * s.edgeBandMm,
    oppositeAt: oppositeExpectedAt(edge, stock),
    coarseStep: s.coarseStepMm,
    fineStep: s.fineStepMm,
  };
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function planRegistration(input: PlanInput, s: RegistrationSettings): PlanResult {
  const { stock, mount } = input;
  const bad = settingsProblem(s);
  if (bad !== null) return { ok: false, reason: bad };
  const width = stock.xMax - stock.xMin;
  const depth = stock.yMax - stock.yMin;
  if (!(width > 0 && depth > 0) || !(stock.cornerRadius >= 0)) {
    return { ok: false, reason: 'the stock has no size to register' };
  }
  // #1133 — the band's inner end must still be on THIS side of the stock's opposite edge: a scan
  // whose band spans the whole stock has no side to approach from.
  if (s.edgeBandMm >= Math.min(width, depth)) {
    return {
      ok: false,
      reason: `the stock (${r3(width)} × ${r3(depth)} mm) is too small for the ${s.edgeBandMm} mm edge-find band — the scan would start at or past its opposite edge`,
    };
  }

  // The surface seek: bounded to the expected surface ± tolerance, and started from the machine's own
  // travel height (`seekFromMachineZ`) — the SAME value the obstacle check below is measured from.
  const exp = input.expectedSurface.machineZ;
  if (!Number.isFinite(exp)) return { ok: false, reason: 'the job does not say where it expects the stock’s top' };
  const seekFromMachineZ = input.seekFromMachineZ;
  if (!Number.isFinite(seekFromMachineZ)) return { ok: false, reason: 'the machine’s travel height is not known' };
  const mountDatum = input.mountDatum ?? null;
  const probe = input.probe ?? null;
  const mountTap = input.mountTap ?? null;
  // #525 — a checked-out probe with no measured tip refuses the plan. Falling back to the shop's
  // wired-probe values would plan a sideways touch with an assumed radius, which offsets every edge
  // it finds by the difference — silently. The wired probe's record is measured; the 3D probe's is
  // not, so the first thing its owner sees is this sentence, not a plausible-looking plan.
  if (probe !== null && probe.tip === null) {
    return {
      ok: false,
      reason:
        `measure the ${probeInstrumentOf(probe) === 'xyz' ? '3D probe' : 'checked-out probe'}'s tip first: ` +
        `it has no measured tip values, and a probe correction cannot be assumed. Measure its tip on a known-width ` +
        `feature and record it in Manage › Accessories, then plan again`,
    };
  }
  // #525 — THE CORNER ROUTINE's own preconditions, refused before any scan is built:
  //  - a DISC has no corner (it registers on its rim);
  //  - only the 3D probe finds an edge sideways; a wired/Z-only probe steps over one edge at a time;
  //  - both edges must be free to touch: the TAPE mount, because a vise's jaws stand where the side
  //    approach travels and the bracket fixes X and Y from its own anchor.
  const corner = input.corner;
  if (corner !== undefined) {
    if (input.disc !== undefined) {
      return { ok: false, reason: 'a disc has no corner to find — it registers on its rim, with the four centre-line scans' };
    }
    // #827 — A CORNER ON ANY MOUNT THAT CAN TOUCH THE STOCK'S OWN FACES. On the vise the X face
    // is touched above the jaw top when the stock stands proud enough (the executor refuses with
    // the fixed-jaw sentence otherwise); on the bracket the stock's exposed faces are touched,
    // the anchor remaining the fallback. No tape requirement any more.

    if (probeInstrumentOf(probe) !== 'xyz') {
      return {
        ok: false,
        reason:
          'the corner routine needs the 3D probe: it finds each edge with one sideways touch, while the wired probe steps over an edge at a time and cannot see the angle between two edges',
      };
    }
  }
  // #598 — with a measured vise datum the seek is a SEARCH down to `jawTopZ − tolerance` (over a proud
  // stock the probe can only meet the stock), not a band around the estimate; the ceiling is the
  // expected surface + tolerance either way. The legacy seat path — and a datum with the stock recessed
  // below the jaw tops (#517) — keeps the band's own floor.
  const floorFromDatum = mount === 'vise' && mountDatum !== null && exp > mountDatum.jawTopZ;
  const seekFloor = floorFromDatum ? r3(mountDatum!.jawTopZ - s.surfaceToleranceMm) : r3(exp - s.surfaceToleranceMm);
  const band = { min: seekFloor, max: r3(exp + s.surfaceToleranceMm) };
  // #1189 — the floor is the JAW's when it comes from the jaw datum; it then shifts by that
  // datum's own reference, which may differ from the expected surface's (a surface top above, a
  // jaw measured in another seating). Absent, both follow the expected surface's datum.
  const floorProbeRefZ = floorFromDatum ? (mountDatum!.probeRefZ ?? null) : (input.probeRefZ ?? null);
  if (band.max + s.parkAboveSurfaceMm > seekFromMachineZ) {
    return { ok: false, reason: `the stock's top is expected at machine Z ${exp}: too high to park ${s.parkAboveSurfaceMm} mm above it` };
  }
  const travel = r3(seekFromMachineZ - band.min);
  if (travel > s.surfaceSeekMm) {
    return {
      ok: false,
      reason: `the stock's top is expected ${r3(seekFromMachineZ - exp)} mm below the start, more than the ${s.surfaceSeekMm} mm the surface touch may travel`,
    };
  }

  const surfacePoint = input.cutCentre ?? { x: (stock.xMin + stock.xMax) / 2, y: (stock.yMin + stock.yMax) / 2 };
  // #1200 — A TOP TOUCH KEEPS THE UNIT'S LATERAL UNCERTAINTY PLUS THE TIP RADIUS CLEAR OF EVERY
  // EDGE: near an edge the ball can meet the roll-off instead of the flat top and read low, and an
  // off-axis tip (a bent stylus) turns that into an error. The old inset (a millimetre, or the
  // corner radius) still applies on top.
  const lateralSigma = probe?.tipLateralUncertaintyMm ?? 0;
  const topTouchInset = Math.max(1, stock.cornerRadius, s.tipRadiusMm + lateralSigma);
  if (
    surfacePoint.x < stock.xMin + topTouchInset ||
    surfacePoint.x > stock.xMax - topTouchInset ||
    surfacePoint.y < stock.yMin + topTouchInset ||
    surfacePoint.y > stock.yMax - topTouchInset
  ) {
    return {
      ok: false,
      reason:
        `the surface touch point is not well inside the stock: a top touch keeps ${r3(topTouchInset)} mm clear of every edge ` +
        `(the tip's ${r3(s.tipRadiusMm)} mm radius${lateralSigma > 0 ? ` plus its ${r3(lateralSigma)} mm lateral uncertainty` : ''})`,
    };
  }

  // #1070 — A BED-HELD JOB IS REGISTERED ON THE CUT REGION'S FOOTPRINT. The region's extents go
  // in; two touches per bounding edge at them, the far edges once each as presence proofs, one Z
  // touch per region corner. THE ANCHOR DATUM IS ONLY THE SEED: it puts every planned move in
  // machine coordinates — and the soft-limit check runs on those before any line — while the
  // origin itself comes from the touched front and left edge lines, through the existing #525
  // corner derivation, so a seed error never enters the cut.
  if (input.region !== undefined) {
    if (mount !== 'bracket') {
      return { ok: false, reason: 'the footprint registration is for a bed-held job — this mount has no region to register on' };
    }
    const seed = input.bracketOrigin;
    if (!seed) return { ok: false, reason: 'the bracket mount needs the origin from the machine’s anchor' };
    const fp = planFootprintRegistration({
      stock: { length: width, width: depth, thickness: input.stockThicknessMm ?? 0, cornerRadius: stock.cornerRadius },
      region: { minX: input.region.min[0], minY: input.region.min[1], maxX: input.region.max[0], maxY: input.region.max[1] },
      marginMm: input.region.marginMm,
      origin: { x: seed.x, y: seed.y, from: seed.from },
      softLimits: input.softLimits ?? null,
      expectedSurface: input.expectedSurface,
      seekFromMachineZ,
      probe: {
        instrument: input.probe?.instrument === 'xyz' ? 'xyz' : 'z-only',
        tipRadiusMm: s.tipRadiusMm,
        // #1200 — the unit's restriction rides the footprint plan too: the dispatch reads it.
        ...(input.probe?.touches === undefined ? {} : { touches: input.probe.touches }),
        ...(input.probe?.tipLateralUncertaintyMm === undefined
          ? {}
          : { tipLateralUncertaintyMm: input.probe.tipLateralUncertaintyMm }),
        // #1203 — the fitted post's shank rides the plan so the executor can name the collet.
        ...(input.probe?.shankMm === undefined || input.probe.shankMm === null ? {} : { shankMm: input.probe.shankMm }),
      },
      settings: {
        scanInsideMm: s.scanInsideMm,
        scanReachMm: s.scanReachMm,
        coarseStepMm: s.coarseStepMm,
        fineStepMm: s.fineStepMm,
        cornerClearanceMm: s.cornerClearanceMm,
        parkAboveSurfaceMm: s.parkAboveSurfaceMm,
        surfaceToleranceMm: s.surfaceToleranceMm,
      },
      obstacles: (input.mountObstacles ?? []).map((o) => ({ label: o.label, min: o.min, max: o.max })),
    });
    if (!fp.ok) return { ok: false, reason: fp.reason };
    return {
      ok: true,
      plan: {
        mount,
        stock,
        stockThicknessMm: input.stockThicknessMm,
        ...(input.probeRefZ == null ? {} : { probeRefZ: input.probeRefZ }),
        ...(input.probeRefLabel == null ? {} : { probeRefLabel: input.probeRefLabel }),
        ...(floorProbeRefZ == null ? {} : { floorProbeRefZ }),
        surfacePoint: {
          x: r3((input.region.min[0] + input.region.max[0]) / 2),
          y: r3((input.region.min[1] + input.region.max[1]) / 2),
        },
        seek: { fromMachineZ: seekFromMachineZ, travelMm: travel, band },
        mountDatum,
        probe,
        mountTap,
        scans: fp.plan.scans.map((sc) => ({
          edge: sc.edge,
          along: sc.along,
          expectedAt: sc.expectedAt,
          outward: sc.edge === 'right' || sc.edge === 'back' ? 1 : -1,
          start: sc.start,
          limit: sc.limit,
          coarseStep: s.coarseStepMm,
          fineStep: s.fineStepMm,
        })),
        bracketOrigin: seed,
        mountObstacles: input.mountObstacles ?? [],
        settings: s,
        corner: { id: 'front-left', xEdge: 'left', yEdge: 'front' },
        notes: fp.plan.notes,
      },
    };
  }

  const notes: string[] = [];
  const keepOff = stock.cornerRadius + s.cornerClearanceMm;
  const span = (lo: number, hi: number, name: string): { lo: number; hi: number } | string =>
    hi - lo > 2 * keepOff
      ? { lo: lo + keepOff, hi: hi - keepOff }
      : `the ${name} edge is ${r3(hi - lo)} mm long — too short to keep a scan ${keepOff} mm clear of its rounded corners`;

  const scans: EdgeScan[] = [];
  /** #827 — see RegistrationPlan.cornerXFrom; set by the corner branch, read by the plan's return. */
  let cornerXFrom: 'stock' | 'jaw' | undefined;
  const disc = input.disc !== undefined;
  const midY = (stock.yMin + stock.yMax) / 2;
  const midX = (stock.xMin + stock.xMax) / 2;
  let bracketOrigin: RegistrationPlan['bracketOrigin'] = null;
  let mountObstacles: PlanObstacle[] = [];
  if (mount === 'bracket') {
    // #743 — a disc is not a bracket part (its Holding option is shown refused): the bracket
    // touches a rim at two points and the cutter turns it. A plan that asks anyway is refused
    // rather than measured against a corner the disc never fills.
    if (input.disc !== undefined) {
      return { ok: false, reason: 'a disc is cut on its face and sits on tape or in the vise — the bracket holds a corner, not a rim' };
    }
    if (!input.bracketOrigin) return { ok: false, reason: 'the bracket mount needs the origin from the machine’s anchor' };
    if (!input.mountObstacles) {
      return { ok: false, reason: 'the bracket mount needs where the clamps and the bracket’s arms are — the probe travels beside them' };
    }
    bracketOrigin = input.bracketOrigin;
    mountObstacles = input.mountObstacles;
    // Every top must sit below the travel height, with the surface's own tolerance to spare. The bound
    // is the SAME `seekFromMachineZ` the seek starts from, so this refusal moves with the travel height.
    for (const o of mountObstacles) {
      const topMachine = r3(exp + o.topZ);
      if (topMachine >= seekFromMachineZ - s.surfaceToleranceMm) {
        return {
          ok: false,
          reason: `${o.label} stands to machine Z ${topMachine}, up to the probe's travel height (machine Z ${seekFromMachineZ}): the probe would be driven into it — use lower clamps or thinner stock`,
        };
      }
    }
    // The surface point must not be under (or beside) anything standing above the stock.
    const grow = s.tipRadiusMm + s.cornerClearanceMm;
    const under = mountObstacles.find(
      (o) => surfacePoint.x > o.min[0] - grow && surfacePoint.x < o.max[0] + grow && surfacePoint.y > o.min[1] - grow && surfacePoint.y < o.max[1] + grow,
    );
    if (under) return { ok: false, reason: `the surface touch point is at ${under.label}: move the clamp, or touch the stock somewhere clear of it` };
    // #1133 — A BRACKET HOLD FIXES X, Y AND ROTATION (repeat 0.05 mm, fit 0.1 mm): the plan is the
    // SURFACE TOUCH and nothing else. #1070's footprint find — two touches per edge at the cut
    // region's extents — was the vise's kind of plan, and the old right/back "confirming" scans
    // went with it: on a bracket nothing scans. The origin is the bracket's own
    // (`bracketOrigin`), carried with its uncertainty, and the outcome says X and Y were taken on
    // trust. `bracketConfirm` is accepted and ignored so callers written against the old shape
    // still compile; there is no edge-find branch left to reach.
    notes.push(`the bracket fixes X and Y: the origin is ${input.bracketOrigin.from}; only the surface is touched`);
  } else {
    /** Vise, #517: the stock sits below the jaw tops, so a jaw reads HIGH past the gripped edge — and that is the edge. */
    let jawAboveStock = false;
    if (mount === 'vise') {
      // #598 — with a datum the proud height is MEASURED (`expectedSurface − jawTopZ`), not the
      // `seat + ledgeStep` estimate; without one the legacy typed-seat path still supplies it.
      const proud = mountDatum !== null ? r3(exp - mountDatum.jawTopZ) : input.fixtureBelowSurfaceMm;
      if (proud === undefined || !Number.isFinite(proud)) {
        return { ok: false, reason: 'the vise mount needs how far the jaw tops sit below the stock’s top' };
      }
      // A jaw within the surface band of the stock's top — either way — reads as the stock: the scan could
      // not see the edge. The test is on the DISTANCE (#517): a jaw 1.6 mm ABOVE a 1.5 mm sheet is as
      // distinguishable as one 1.6 mm below it, and the sign only says which way the reading goes.
      if (Math.abs(proud) <= s.surfaceBandMm) {
        const where = proud < 0 ? `${r3(-proud)} mm above` : `${r3(proud)} mm below`;
        return { ok: false, reason: `the jaw tops sit ${where} the stock’s top — within the ${s.surfaceBandMm} mm surface band, so a jaw touch would read as the stock` };
      }
      if (proud > 0) {
        // The legacy seat path still refuses a tolerance that reaches the jaw tops (the seek band, not
        // a search, would read a jaw as the surface). With a measured datum the seek searches to
        // `jawTopZ − tolerance`, so the tolerance is a plausibility WARNING, not a stop.
        if (mountDatum === null && s.surfaceToleranceMm >= proud) {
          return { ok: false, reason: `the surface tolerance (${s.surfaceToleranceMm} mm) reaches the jaw tops ${proud} mm below the stock — a seek onto a jaw would read as the surface` };
        }
        if (mountDatum !== null && s.surfaceToleranceMm >= proud) {
          notes.push(
            `the surface tolerance (${s.surfaceToleranceMm} mm) reaches the jaw tops ${r3(proud)} mm below the stock: the seek searches to ${r3(mountDatum.jawTopZ - s.surfaceToleranceMm)}, so a missing stock would read a jaw as the surface — check the stock is in the vise before registering`,
          );
        }
        notes.push(
          disc
            ? 'the jaws touch a disc on two lines at its centre-line: all four rim edges are scanned, and the centre is the midpoint of each opposite pair'
            : 'the fixed jaw fixes X and rotation: the left-edge scan confirms it, the front-edge scan finds Y',
        );
      } else {
        // The jaws stand above the stock: every sideways move is made at the park height, which must clear
        // them — the seek band lies below the jaw tops, so a seek cannot mistake a jaw for the surface.
        const above = -proud;
        if (above >= s.parkAboveSurfaceMm - PARK_CLEARANCE_MM) {
          return {
            ok: false,
            reason: `the jaw tops stand ${r3(above)} mm above the stock, which the ${s.parkAboveSurfaceMm} mm park height does not clear by ${PARK_CLEARANCE_MM} mm — the probe would be driven into a jaw between touches`,
          };
        }
        jawAboveStock = true;
        notes.push(
          disc
            ? `the disc sits ${r3(above)} mm below the jaw tops: a touch past either X edge lands on a jaw and reads ABOVE the surface band — that reading is the jaw, so the edge is where the readings go high; all four rim edges are scanned and the centre is the midpoint of each opposite pair`
            : `the stock sits ${r3(above)} mm below the jaw tops: a left-edge touch past the stock lands on the fixed jaw and reads ABOVE the surface band — that reading is the jaw, so the edge is where the readings go high; the fixed jaw fixes X and rotation, the front-edge scan finds Y`,
        );
      }
    }
    const ys = span(stock.yMin, stock.yMax, 'left');
    if (typeof ys === 'string') return { ok: false, reason: ys };
    const xs = span(stock.xMin, stock.xMax, 'front');
    if (typeof xs === 'string') return { ok: false, reason: xs };
    if (disc) {
      // #743 D-2 — FOUR TOUCHES THROUGH THE CENTRE-LINES. A disc's origin is its centre less R,
      // so both opposite edges are needed on each axis: the midpoint of each pair is the centre
      // and the span between them is the diameter. Each line runs through the centre-line, where
      // the circle's extreme point is — an off-line scan by δ misses it by about δ²/2R (a 1 mm
      // error costs 0.033 mm on ⌀30, so a hand-placed line is honest, but a line anywhere else is
      // not). A tape job gets all four; a vise job too — the jaws only FIX the X edges, they do
      // not measure the disc.
      const above = jawAboveStock ? { aboveIsEdge: true as const } : {};
      scans.push(
        { ...scanFor('left', midY, stock, s), ...above },
        { ...scanFor('right', midY, stock, s), ...above },
        scanFor('front', midX, stock, s),
        scanFor('back', midX, stock, s),
      );
      notes.push(
        `the disc is registered on its rim: left, right, front and back scans through its centre-lines; the centre is the midpoint of each opposite pair and the touched span is checked against the stated ⌀${r3(input.disc!.diameterMm)} mm`,
      );
    } else if (corner !== undefined) {
      // #525 — CORNER MODE: two sideways lines on each of the two edges that meet at the corner, at
      // the ends of each edge's usable span — the longest baseline, clear of the rounded corners.
      // #827 — ON THE VISE, X COMES FROM THE STOCK'S OWN FACE ONLY WHEN IT STANDS PROUD ENOUGH; a
      // stock that does not is registered with the fixed jaw's face as X, and the plan says so in
      // one line. The tolerance answer is stated, not refused.
      if (mount === 'vise') {
        const proud = mountDatum === null ? null : Math.round((input.expectedSurface.machineZ - mountDatum.jawTopZ) * 1000) / 1000;
        const needed = Math.round((s.tipRadiusMm + SIDE_TOUCH_JAW_MARGIN_MM + MIN_SIDE_DEPTH_MM) * 1000) / 1000;
        if (proud !== null && proud < needed) {
          cornerXFrom = 'jaw';
          notes.push(
            `the stock stands ${proud} mm proud of the jaws — X is taken from the fixed jaw's face (the Z-only edge scan); side-touching the stock's own X face needs ${needed} mm`,
          );
        }
      }
      const { xEdge, yEdge } = cornerEdges(corner);
      const ysC = span(stock.yMin, stock.yMax, xEdge);
      if (typeof ysC === 'string') return { ok: false, reason: ysC };
      const xsC = span(stock.xMin, stock.xMax, yEdge);
      if (typeof xsC === 'string') return { ok: false, reason: xsC };
      scans.push(
        scanFor(xEdge, ysC.lo, stock, s),
        scanFor(xEdge, ysC.hi, stock, s),
        scanFor(yEdge, xsC.lo, stock, s),
        scanFor(yEdge, xsC.hi, stock, s),
      );
      notes.push(
        `corner mode: two sideways lines on the ${xEdge} edge (at Y ${r3(ysC.lo)} and ${r3(ysC.hi)}) and two on the ${yEdge} edge (at X ${r3(xsC.lo)} and ${r3(xsC.hi)}) — their intersection is the corner and the angle they make is the stock's rotation`,
      );
    } else if (mount === 'tape') scans.push(scanFor('left', ys.lo, stock, s), scanFor('left', ys.hi, stock, s));
    else scans.push({ ...scanFor('left', midY, stock, s), ...(jawAboveStock ? { aboveIsEdge: true } : {}) });
    if (!disc && corner === undefined) scans.push(scanFor('front', midX, stock, s));
  }

  if (mountDatum !== null) {
    notes.push(
      `the mount datum is the measured jaw top at machine Z ${mountDatum.jawTopZ} (${mountDatum.by}, ${mountDatum.measuredAt}); the surface seek searches down to ${band.min}, ${s.surfaceToleranceMm} mm below the jaw top`,
    );
  }
  // #1133 — a vise with no measured jaw top cannot take a side touch: `sideTouchSetup` keeps the
  // ball above the ledge, which it cannot place without the datum, so its free front/back edges
  // keep the Z-only scan. Stated, so the operator knows which edge find will run.
  if (mount === 'vise' && mountDatum === null) {
    const zOnly = [...new Set(scans.filter((sc) => sideTouchAllowed('vise', sc.edge)).map((sc) => sc.edge))];
    if (zOnly.length > 0) {
      const named = zOnly.map((e) => `the ${e} edge`).join(' and ');
      notes.push(
        `${named} ${zOnly.length === 1 ? 'keeps' : 'keep'} the Z-only scan: no measured jaw top for a sideways touch; banded to ±${s.edgeBandMm} mm`,
      );
    }
  }
  // #1200 — THE RESTRICTION IS STATED, WITH WHAT WAS PLANNED INSTEAD. A unit restricted to top
  // touches takes no sideways seek (sideTouchSelected); where the mount WOULD have offered one,
  // the note names those edges and the method they got instead. Nothing is said when the
  // unrestricted plan would have been the same (a mount with no free edge, or a plan with no probe).
  if (probe !== null && probe.touches === 'z-only') {
    const unrestricted: SideTouchSubject = {
      mount,
      mountDatum,
      ...(corner !== undefined ? { corner: { id: corner, ...cornerEdges(corner) } } : {}),
      ...(cornerXFrom === undefined ? {} : { cornerXFrom }),
      probe: { touches: 'all' },
    };
    const wouldSide = [...new Set(scans.filter((sc) => sideTouchSelected(unrestricted, sc.edge)).map((sc) => sc.edge))];
    if (wouldSide.length > 0) {
      const named = wouldSide.map((e) => `the ${e} edge`).join(', ');
      notes.push(
        `the probe is restricted to top touches: ${named} ${wouldSide.length === 1 ? 'is' : 'are'} found by stepping Z over ${wouldSide.length === 1 ? 'it' : 'them'}, not with a sideways touch`,
      );
    }
  }
  // #1200 (manager's note) — A RESTRICTED 3D UNIT IS A NEW PATH: it has never run a registration
  // on this machine, and it stays under the first-run guard until the bench proves it. Said on the
  // plan's own notes, so the card and the record carry it.
  if (probe !== null && probe.instrument === 'xyz' && probe.touches === 'z-only') {
    notes.push(
      'the 3D probe has not run a registration on this machine yet: this top-touches-only path is its first run and stays under the first-run guard until the bench proves it',
    );
  }
  notes.push(
    `the surface is expected at machine Z ${exp} (${input.expectedSurface.from}); a reading outside ${band.min} to ${band.max} stops the run`,
    `every touch stops at the surface − ${s.capBelowSurfaceMm} mm: a touch that finds nothing by then is a miss, not a dive`,
    // #1133 — the band, its provenance, and what it buys: the maintainer's own rule.
    `every edge find stays within ±${s.edgeBandMm} mm of where the edge is expected (the stock's own size error, the mount's repeat 0.05 mm and fit 0.1 mm, plus margin); the probe stops at the first touch off the stock`,
    `the probe reads the stock until its centre is ${s.tipRadiusMm} mm past the edge (the measured effective rim offset); the edges are corrected by it`,
  );
  return {
    ok: true,
    plan: {
      mount,
      stock,
      // #743 — present only on a disc, so a rectangular plan's record is unchanged.
      ...(input.disc !== undefined ? { disc: input.disc } : {}),
      // #525 — present only on a corner plan, so every other plan's record is unchanged.
      ...(corner !== undefined ? { corner: { id: corner, ...cornerEdges(corner) } } : {}),
      stockThicknessMm: input.stockThicknessMm,
      ...(input.probeRefZ == null ? {} : { probeRefZ: input.probeRefZ }),
      ...(input.probeRefLabel == null ? {} : { probeRefLabel: input.probeRefLabel }),
      ...(floorProbeRefZ == null ? {} : { floorProbeRefZ }),
      surfacePoint,
      seek: { fromMachineZ: seekFromMachineZ, travelMm: travel, band },
      mountDatum,
      probe,
      mountTap,
      scans,
      bracketOrigin,
      mountObstacles,
      settings: s,
      ...(cornerXFrom === undefined ? {} : { cornerXFrom }),
      notes,
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// #1073 — SIDE 2'S REGISTRATION, PER FLIP METHOD
// ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * #1073 — HOW FAR THE TIP'S CENTRE ENTERS A LOCATING BORE, mm below side 2's top. CHOSEN, not
 * measured (6b's amendment D): the fixture lists it. A job may state its own.
 */
export const FLIP_PROBE_ENTRY_DEPTH_MM = 3;

/**
 * #1073 — the seed's own error allowance added to each sideways search, mm. CHOSEN: the seed touch
 * only has to put the tip inside the bore; the walls themselves are found by contact, so the
 * search is the bore's own room plus this allowance for the seed being slightly off.
 */
export const FLIP_SEED_SLACK_MM = 1;

/** #1073 — the release after a triggered sideways touch, mm: the house's 3 mm probe-away. */
export const FLIP_PROBE_AWAY_MM = 3;

/**
 * #1073 — the least diametral clearance a bore must leave the tip, mm. Below it the tip is pressed
 * into the wall on the way in and the sideways touches cannot find a wall from the centre.
 */
export const FLIP_MIN_BORE_CLEARANCE_MM = 1;

/**
 * #1073 — SIDE 2'S REGISTRATION, as the flip's method makes it.
 *
 * The flip changes what the probe can trust. Both methods read the turn and Y from a pair of
 * touches across the front edge and seed X from one touch on the fence side; they differ in what
 * follows:
 *
 *   - `tabs-in-blank` (the FRAME method): the two locating bores side 1 left — ⌀5–6, stored as the
 *     setup's own pins — are entered over their seeded centres and touched sideways +X/−X/+Y/−Y,
 *     each triggered touch released with `G38.5`. The pair of centres fixes X exactly and its
 *     midpoint line cross-checks the turn the front pair read.
 *   - `free-then-flip` (the VENDOR method): the part was freed on side 1 and is posed on its own
 *     front edge; the pair of touches runs on that straight edge, the fence-side extreme seeds X,
 *     and there are no bores — a part with no straight edge long enough to read a turn cannot be
 *     posed against two arms by touches, and is refused by name.
 *
 * HOUSE RULE #518: every probe is `G38.3` (a miss is a reading, not an alarm); `G38.5` releases a
 * trigger. The sideways moves come from `centrePair` — the bore-centre geometry #790 measured on
 * the bench — so a later executor runs this plan through the centre-find machinery.
 *
 * Pure: the expected stock, the hold and the settings in, a plan of touches out.
 */
export interface FlipRegistrationInput {
  /** Which method the setup chose; it decides who frees the part and how side 2 registers. */
  method: SetupFlip['method'];
  /**
   * The expected stock in SIDE 2's work XY: the whole blank's box (frame method), or the freed
   * part's silhouette box (vendor method).
   */
  stock: ExpectedStock;
  /** Frame method: the two locating bores as side 1 left them, in side 2's work XY — the setup's pins. */
  holes?: readonly { x: number; y: number }[];
  /** Frame method: the bores' diameter, mm (⌀5–6 for the wired V2's ⌀2 tip). */
  boreDiameterMm?: number;
  /** The probe's tip diameter, mm — the ball the bore walls are read against. */
  probeTipDiameterMm?: number;
  /** How far the tip's centre enters each bore — a shop default seeded {@link FLIP_PROBE_ENTRY_DEPTH_MM}. */
  entryDepthMm?: number;
  /**
   * Vendor method: the part's own front edge, as the straight run it really is, in side 2's work
   * frame, mm along X. A part whose outline is not straight there (a disc) states a run too short
   * to read a turn on, and the method is refused by name.
   */
  frontStraight?: { minX: number; maxX: number };
  /** Vendor method: the y where the silhouette reaches its leftmost point — the X seed's line.
   *  Default: the part box's middle. */
  leftSeedY?: number;
  /** The touch residual a pair's turn reads at, mm — `registration.probeResidualMm` (#451). */
  touchResidualMm?: number;
  settings: RegistrationSettings;
}

/** One locating bore, as the probe will enter and touch it. */
export interface FlipHoleFind {
  /** The seeded centre the probe enters over, side-2 work XY — the stored pin. */
  at: { x: number; y: number };
  /** The bore's stated diameter, mm. */
  boreDiameterMm: number;
  /** The probe tip's radius, mm — the ball the walls are read against. */
  ballRadiusMm: number;
  /** Each sideways touch's search travel from the centre, mm. */
  searchMm: number;
  /** How far below side 2's top the tip's centre enters, mm. */
  entryDepthMm: number;
  /** The entry plunge's travel from the park height, mm (G91, down): the seek that must find nothing. */
  plungeMm: number;
  /** The four sideways touches, in the ruling's order: +X, −X, +Y, −Y. */
  touches: { axis: 'x' | 'y'; sign: 1 | -1; from: { x: number; y: number }; travelMm: number }[];
  /** The release after each triggered touch, mm (a G38.5 back along the touched axis). */
  releaseMm: number;
  /**
   * A sideways touch that travels its whole search with NO contact is a MISS, and a miss STOPS
   * this find by name — a wall not where the pin seeded it means the pin is not where side 1 left
   * it. (House rule #518 makes the miss a reading rather than an alarm; the reading is still a
   * stop, never a skip.) The executor must carry this.
   */
  onMiss: 'stop-the-find';
}

/** #1073 — one step of side 2's registration, in the order the probe runs it. */
export type FlipRegistrationStep =
  | { kind: 'edge-pair'; purpose: 'y-and-rotation'; scans: [EdgeScan, EdgeScan] }
  | { kind: 'seed'; purpose: 'x-seed'; scan: EdgeScan }
  | { kind: 'hole'; purpose: 'x-exact-and-turn-check'; index: 1 | 2; find: FlipHoleFind };

/** #1073 — the turn the bores read, checked against the turn the front pair read. */
export interface FlipTurnCheck {
  /** The two bore centres the line is taken between, side-2 work XY. */
  between: [{ x: number; y: number }, { x: number; y: number }];
  /** How far apart the bores are, mm. */
  separationMm: number;
  /** The angle the stored pin line makes, degrees — what the measured line is compared with. */
  expectedAngleDeg: number;
  /**
   * How far the bores' turn may sit from the front pair's, degrees. DERIVED from the touch
   * residual: each pair reads its angle to ±2r/separation, so the difference is bounded by the
   * two summed — not a measured figure.
   */
  angleToleranceDeg: number;
}

export interface FlipRegistrationPlan {
  method: SetupFlip['method'];
  steps: FlipRegistrationStep[];
  /** The bores' turn cross-check; null on the vendor method (no bores). */
  crossCheck: FlipTurnCheck | null;
  notes: string[];
}

export type FlipRegistrationResult = { ok: true; plan: FlipRegistrationPlan } | { ok: false; reason: string };

export function planFlipRegistration(input: FlipRegistrationInput): FlipRegistrationResult {
  const s = input.settings;
  const bad = settingsProblem(s);
  if (bad !== null) return { ok: false, reason: bad };
  const { stock } = input;
  if (!(stock.xMax > stock.xMin && stock.yMax > stock.yMin) || !(stock.cornerRadius >= 0)) {
    return { ok: false, reason: 'the stock has no size to register' };
  }
  const vendor = input.method === 'free-then-flip';
  const keepOff = stock.cornerRadius + s.cornerClearanceMm;

  // THE PAIR THE TURN IS READ BETWEEN, on the front edge — the blank's own edge (frame) or the
  // straight run of the freed part's outline (vendor).
  let pairLo: number;
  let pairHi: number;
  if (vendor) {
    if (input.frontStraight === undefined) {
      return {
        ok: false,
        reason: 'the vendor method poses the part on its own front edge — the job does not say how much of that edge is straight',
      };
    }
    const straightMm = r3(input.frontStraight.maxX - input.frontStraight.minX);
    pairLo = input.frontStraight.minX + keepOff;
    pairHi = input.frontStraight.maxX - keepOff;
    if (!(pairHi > pairLo)) {
      return {
        ok: false,
        reason: `the part’s front edge is straight for ${straightMm} mm — too short for two touches kept ${r3(keepOff)} mm clear of its corners; keep it in the blank on tabs`,
      };
    }
  } else {
    pairLo = stock.xMin + keepOff;
    pairHi = stock.xMax - keepOff;
    if (!(pairHi > pairLo)) {
      return {
        ok: false,
        reason: `the blank is ${r3(stock.xMax - stock.xMin)} mm along X — too short for two touches kept ${r3(keepOff)} mm clear of its corners`,
      };
    }
  }
  const pairSeparation = r3(pairHi - pairLo);
  const across = r3(stock.yMax - stock.yMin);
  // The house's own rotation rule (#429): a pair `separation` apart reads the turn to
  // ±(2 × fineStep/4 × across)/separation — a turn it cannot resolve is not measured.
  const resolutionMm = r3((2 * (s.fineStepMm / 4) * across) / pairSeparation);
  if (!(resolutionMm < s.edgeMarginMm)) {
    return {
      ok: false,
      reason: vendor
        ? `the part’s front edge gives ${pairSeparation} mm between touches: the turn would read to ±${resolutionMm} mm across ${across}, no better than the ${s.edgeMarginMm} mm margin — a shape with no straight edge cannot be posed against two arms by touches; keep it in the blank on tabs`
        : `the blank’s front edge gives ${pairSeparation} mm between touches: the turn would read to ±${resolutionMm} mm across ${across}, no better than the ${s.edgeMarginMm} mm margin`,
    };
  }

  const frontPair: [EdgeScan, EdgeScan] = [
    scanFor('front', r3(pairLo), stock, s),
    scanFor('front', r3(pairHi), stock, s),
  ];
  const seedY = r3(vendor && input.leftSeedY !== undefined ? input.leftSeedY : (stock.yMin + stock.yMax) / 2);
  const steps: FlipRegistrationStep[] = [
    { kind: 'edge-pair', purpose: 'y-and-rotation', scans: frontPair },
    { kind: 'seed', purpose: 'x-seed', scan: scanFor('left', seedY, stock, s) },
  ];
  const notes: string[] = [];

  if (vendor) {
    notes.push(
      `the freed part is posed on its own front edge — straight for ${r3((input.frontStraight!.maxX - input.frontStraight!.minX))} mm — ` +
        'the pair finds Y and the turn, the fence-side extreme seeds X: no bores, no tabs',
    );
    return { ok: true, plan: { method: input.method, steps, crossCheck: null, notes } };
  }

  const { holes, boreDiameterMm, probeTipDiameterMm } = input;
  if (holes === undefined || holes.length !== 2) {
    return { ok: false, reason: 'the frame method locates on the two bores side 1 left — this job states no bore centres' };
  }
  if (boreDiameterMm === undefined || probeTipDiameterMm === undefined) {
    return { ok: false, reason: 'the frame method needs the bore diameter and the probe tip diameter to state the sideways touches' };
  }
  const clearance = r3(boreDiameterMm - probeTipDiameterMm);
  if (!(clearance >= FLIP_MIN_BORE_CLEARANCE_MM)) {
    return {
      ok: false,
      reason: `a ⌀${r3(probeTipDiameterMm)} tip in a ⌀${r3(boreDiameterMm)} bore leaves ${clearance} mm of room — the tip cannot touch the walls (needs ${FLIP_MIN_BORE_CLEARANCE_MM} mm); bore ⌀5–6`,
    };
  }
  const entryDepthMm = r3(input.entryDepthMm ?? FLIP_PROBE_ENTRY_DEPTH_MM);
  // The wall lies (⌀bore − ⌀tip)/2 from the centre; the search adds the seed's own allowance.
  const searchMm = r3(clearance / 2 + FLIP_SEED_SLACK_MM);
  const ballRadiusMm = r3(probeTipDiameterMm / 2);
  const plungeMm = r3(s.parkAboveSurfaceMm + entryDepthMm);

  for (const [i, hole] of holes.entries()) {
    const at = { x: r3(hole.x), y: r3(hole.y) };
    const touches = (['x', 'y'] as const).flatMap((axis) =>
      ([1, -1] as const).map((sign) => {
        const pair = centrePair('bore', at, axis, sign, searchMm);
        return { axis, sign, from: pair.from, travelMm: pair.travelMm };
      }),
    );
    steps.push({
      kind: 'hole',
      purpose: 'x-exact-and-turn-check',
      index: (i + 1) as 1 | 2,
      find: { at, boreDiameterMm, ballRadiusMm, searchMm, entryDepthMm, plungeMm, touches, releaseMm: FLIP_PROBE_AWAY_MM, onMiss: 'stop-the-find' },
    });
  }

  // THE TURN CROSS-CHECK: the bores' centre line against the front pair's line. Each pair reads
  // its angle to ±2r/separation, so the difference is bounded by the sum of the two.
  const [a, b] = holes;
  const holeSeparation = Math.hypot(b!.x - a!.x, b!.y - a!.y);
  if (!(holeSeparation > 0)) {
    return { ok: false, reason: 'the two bores sit at the same point — they cannot cross-check the turn' };
  }
  const residual = input.touchResidualMm ?? PROBE_RESIDUAL_MM;
  const toleranceRad = (2 * residual) / pairSeparation + (2 * residual) / holeSeparation;
  const crossCheck: FlipTurnCheck = {
    between: [a!, b!],
    separationMm: r3(holeSeparation),
    expectedAngleDeg: r3((Math.atan2(b!.y - a!.y, b!.x - a!.x) * 180) / Math.PI),
    angleToleranceDeg: r3((toleranceRad * 180) / Math.PI),
  };

  notes.push(
    `side 2 registers on the front edge pair (Y and the turn), a fence-side seed touch for X, then the two ` +
      `⌀${r3(boreDiameterMm)} bores ${r3(holeSeparation)} mm apart — four sideways touches each, a G38.5 release after every trigger: ` +
      `exact X and a turn cross-check to ±${crossCheck.angleToleranceDeg}°`,
    `the tip enters each bore ${entryDepthMm} mm below side 2’s top (chosen, not measured); a trigger on the entry ` +
      'means the bore is not where the seed says — stop with the reading; a sideways touch that misses its wall stops the find too',
  );
  return { ok: true, plan: { method: input.method, steps, crossCheck, notes } };
}
