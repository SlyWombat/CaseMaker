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
import { settingsProblem, type RegistrationSettings } from './settings';

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
}

/** How a probe can touch: straight down only, or sideways as well (#525). */
export type ProbeInstrument = 'z-only' | 'xyz';

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
export type MountTapReference = 'vise-jaw-top' | 'bracket-seat';

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
}

export interface PlanInput {
  stock: ExpectedStock;
  mount: Mount;
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
   * #619 — the stock's thickness, mm, for the datum path's upper surface bound: a normally mounted
   * blank may stand the full thickness proud of the jaw tops (it need not sit on the ledge), so the
   * seek accepts a surface up to `jawTop + thickness + tolerance`. Absent on the legacy seat path.
   */
  stockThicknessMm?: number;
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
  /** #619 — the stock's thickness, mm, for the datum path's upper surface bound. */
  stockThicknessMm?: number;
  surfacePoint: { x: number; y: number };
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
    start: expectedAt - outward * s.scanInsideMm,
    limit: expectedAt + outward * s.scanReachMm,
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
  if (s.scanInsideMm * 2 >= Math.min(width, depth)) {
    return { ok: false, reason: `the stock is too small for a scan that starts ${s.scanInsideMm} mm inside its edges` };
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
  // #598 — with a measured vise datum the seek is a SEARCH down to `jawTopZ − tolerance` (over a proud
  // stock the probe can only meet the stock), not a band around the estimate; the ceiling is the
  // expected surface + tolerance either way. The legacy seat path — and a datum with the stock recessed
  // below the jaw tops (#517) — keeps the band's own floor.
  const seekFloor =
    mount === 'vise' && mountDatum !== null && exp > mountDatum.jawTopZ
      ? r3(mountDatum.jawTopZ - s.surfaceToleranceMm)
      : r3(exp - s.surfaceToleranceMm);
  const band = { min: seekFloor, max: r3(exp + s.surfaceToleranceMm) };
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
  const inset = Math.max(1, stock.cornerRadius);
  if (
    surfacePoint.x < stock.xMin + inset ||
    surfacePoint.x > stock.xMax - inset ||
    surfacePoint.y < stock.yMin + inset ||
    surfacePoint.y > stock.yMax - inset
  ) {
    return { ok: false, reason: 'the surface point is not well inside the stock' };
  }

  const notes: string[] = [];
  const keepOff = stock.cornerRadius + s.cornerClearanceMm;
  const span = (lo: number, hi: number, name: string): { lo: number; hi: number } | string =>
    hi - lo > 2 * keepOff
      ? { lo: lo + keepOff, hi: hi - keepOff }
      : `the ${name} edge is ${r3(hi - lo)} mm long — too short to keep a scan ${keepOff} mm clear of its rounded corners`;

  const scans: EdgeScan[] = [];
  const midY = (stock.yMin + stock.yMax) / 2;
  const midX = (stock.xMin + stock.xMax) / 2;
  let bracketOrigin: RegistrationPlan['bracketOrigin'] = null;
  let mountObstacles: PlanObstacle[] = [];
  if (mount === 'bracket') {
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
    if (!input.bracketConfirm && !input.bracketOrigin.offsetMeasured) {
      return {
        ok: false,
        reason: 'the first touch confirms the bracket’s position: approve the confirming touch, or measure the bracket’s offset from the anchor',
      };
    }
    if (!input.bracketConfirm) {
      notes.push(`the bracket fixes X and Y: the origin is ${input.bracketOrigin.from}; only the surface is touched`);
    } else {
      const ys = span(stock.yMin, stock.yMax, 'right');
      if (typeof ys === 'string') return { ok: false, reason: ys };
      const xs = span(stock.xMin, stock.xMax, 'back');
      if (typeof xs === 'string') return { ok: false, reason: xs };
      // A line clear of every clamp and arm, grown by the probe's rim and the corner clearance.
      const clearLine = (edge: 'right' | 'back', lo: number, hi: number): number | null => {
        const scan = scanFor(edge, (lo + hi) / 2, stock, s);
        const [a, b] = [Math.min(scan.start, scan.limit), Math.max(scan.start, scan.limit)];
        const mid = (lo + hi) / 2;
        const candidates = Array.from({ length: 9 }, (_, i) => lo + ((hi - lo) * i) / 8).sort((p, q) => Math.abs(p - mid) - Math.abs(q - mid));
        for (const c of [mid, ...candidates]) {
          const hits = mountObstacles.some((r) => {
            const [across, along] = edge === 'right' ? ([0, 1] as const) : ([1, 0] as const);
            return r.max[across] + grow > a && r.min[across] - grow < b && c > r.min[along] - grow && c < r.max[along] + grow;
          });
          if (!hits) return r3(c);
        }
        return null;
      };
      const yRight = clearLine('right', ys.lo, ys.hi);
      const xBack = clearLine('back', xs.lo, xs.hi);
      if (yRight === null || xBack === null) {
        return {
          ok: false,
          reason: `no line across the ${yRight === null ? 'right' : 'back'} edge stays clear of the clamps: move a clamp, or register without the confirming touch`,
        };
      }
      scans.push(scanFor('right', yRight, stock, s), scanFor('back', xBack, stock, s));
      notes.push(
        `the bracket fixes X and Y: the origin is ${input.bracketOrigin.from}; the right and back edges are scanned only to confirm the stock is pushed into the corner (they carry its size error too), and never move the origin`,
      );
    }
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
        notes.push('the fixed jaw fixes X and rotation: the left-edge scan confirms it, the front-edge scan finds Y');
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
          `the stock sits ${r3(above)} mm below the jaw tops: a left-edge touch past the stock lands on the fixed jaw and reads ABOVE the surface band — that reading is the jaw, so the edge is where the readings go high; the fixed jaw fixes X and rotation, the front-edge scan finds Y`,
        );
      }
    }
    const ys = span(stock.yMin, stock.yMax, 'left');
    if (typeof ys === 'string') return { ok: false, reason: ys };
    const xs = span(stock.xMin, stock.xMax, 'front');
    if (typeof xs === 'string') return { ok: false, reason: xs };
    if (mount === 'tape') scans.push(scanFor('left', ys.lo, stock, s), scanFor('left', ys.hi, stock, s));
    else scans.push({ ...scanFor('left', midY, stock, s), ...(jawAboveStock ? { aboveIsEdge: true } : {}) });
    scans.push(scanFor('front', midX, stock, s));
  }

  if (mountDatum !== null) {
    notes.push(
      `the mount datum is the measured jaw top at machine Z ${mountDatum.jawTopZ} (${mountDatum.by}, ${mountDatum.measuredAt}); the surface seek searches down to ${band.min}, ${s.surfaceToleranceMm} mm below the jaw top`,
    );
  }
  notes.push(
    `the surface is expected at machine Z ${exp} (${input.expectedSurface.from}); a reading outside ${band.min} to ${band.max} stops the run`,
    `every touch stops at the surface − ${s.capBelowSurfaceMm} mm: a touch that finds nothing by then is a miss, not a dive`,
    `the probe reads the stock until its centre is ${s.tipRadiusMm} mm past the edge (the measured effective rim offset); the edges are corrected by it`,
  );
  return {
    ok: true,
    plan: {
      mount,
      stock,
      stockThicknessMm: input.stockThicknessMm,
      surfacePoint,
      seek: { fromMachineZ: seekFromMachineZ, travelMm: travel, band },
      mountDatum,
      probe,
      mountTap,
      scans,
      bracketOrigin,
      mountObstacles,
      settings: s,
      notes,
    },
  };
}
