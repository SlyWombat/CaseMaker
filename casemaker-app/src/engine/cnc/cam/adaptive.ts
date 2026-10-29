/**
 * Adaptive clearing for metal pockets, with helical and ramped entry (#433 phase 1; wired into a
 * metal job's pocket by #666). The maintainer's Q9: ramped and helical entry reopen for METAL
 * POCKETS, delivered with this; engraving keeps its straight plunges (`Makera-Parity.md` §14.4 R16).
 *
 * WHERE A JOB USES IT (#666). `cam/engraveJob.ts` plans a metal job's SHAPE pocket with this module
 * instead of contour-parallel rings — as the ROUGHING pass when #250's finish allowance splits the
 * pocket, and as the whole cut when it does not. The job supplies the cutter, the depth and the
 * feed numbers (its feeds row), so `AdaptiveInput.provenance` is how a plan's notes say where the
 * cut numbers came from; with no provenance they are the shop's labelled placeholders, as phase 1
 * wrote them. A refusal is never a job refusal: the pocket falls back to rings and the run states
 * why (`adaptive-fallback`), which is the maintainer's "inform, don't refuse" rule.
 *
 * WHAT "ENGAGEMENT" MEANS HERE. The new material a move removes per mm of tool travel, in mm — the
 * effective radial width of cut. On a straight cut it IS the radial width (ae); around an inside arc
 * or into a corner it is larger than the stepover would say, and it is the load a 150 W spindle
 * feels in aluminium. The cap is `adaptive.engagementFraction` × the cutter diameter, and it holds
 * for every CLEARING move and every LINK at depth. The ENTRY (helix or ramp) is exempt: it goes into
 * solid material by nature, and its load is bounded by the ramp angle — descent per mm — instead.
 *
 * THE METHOD: GREEDY, EVERY STEP MEASURED. Offset rings bound only the radial DEPTH of a cut: the
 * step out to the next ring takes a near-full-width bite, and a ring round a small bore removes more
 * than ae per mm. So instead the planner keeps a grid of the standing material (`adaptiveGrid.ts`)
 * and walks the cutter in short steps (a fifth of its radius). At each step a coarse fan of directions
 * finds where the load crosses the TARGET and a bisection on the angle lands on it; the step taken is
 * the one nearest the target without passing the ACCEPT ceiling, preferring the material on the
 * cutter's right (climb, with the post's `M3`). Each step is judged on its heavier HALF, because a
 * step's average hides a load that climbs within it. A step that would pass the ceiling is never
 * taken, so the cap holds by construction; the margin between ACCEPT and the cap is what an
 * independent meter at a different resolution still reads under it (the spec's reads at most 0.27 mm
 * against the 0.3175 mm cap of a 3.175 mm cutter at 0.1). Judging the heavier half also means the
 * AVERAGE load sits below the target — about half the cap on open ground.
 *
 * LINKS. When no step is good the path ends and the planner finds a restart: a point where the
 * cutter's disc is already clear, next to standing material, nearest the tool. It moves there AT
 * DEPTH only when the whole swept capsule is already clear; otherwise it retracts to the hop height,
 * rapids across, rapids straight down the cleared column to a clearance above the floor and feeds
 * the rest. It never plunges into material.
 *
 * ENTRY, one per separate area the cutter can reach: a HELIX at the area's roomiest point
 * (`adaptive.helixDiameterFraction` × the cutter diameter, pitched by `adaptive.rampAngleDeg`, as G1
 * chords — the IR has no arcs — and a flat lap on the floor), refused when the bore does not fit; then
 * a RAMP zig-zagging along the longest straight line the centre can travel, with a flat pass back,
 * refused when that line is shorter than the cutter. Both refused refuses the plan. Material in an
 * area that already has an entry, but which no step can reach under the cap, refuses the plan too:
 * another entry there would be slotting by another name.
 *
 * LEVELS. The pocket is flat-floored with vertical walls, so the 2D path is planned once and replayed
 * at each level of at most `adaptive.stepDownMm`. At every level the levels above are fully cleared,
 * which is what makes the cleared-column rapids and the at-depth links of the 2D plan true there too.
 *
 * RUN IT IN A WORKER. `planAdaptive` is synchronous and takes seconds — a 16 × 12 mm pocket with a
 * 3.175 mm cutter at 0.1 walks some 5 000 measured steps on a ~100 000-cell grid — so it must never be
 * called on the UI thread. The cost grows with the pocket's area over the square of the engagement.
 *
 * THE NUMBERS ARE THE SHOP'S (`location.json` defaults): the engagement, step-down, helix fraction,
 * ramp angle, entry clearance and the planner's three refusal limits (grid size, residual share, neck
 * area) are chosen; the feeds and the spindle speed are OUR placeholders, labelled unmeasured, and no
 * Makera vendor number is in the repo (#347).
 */

import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import { HOP_Z, SAFE_Z, estimateCycleSeconds, toolNumberFor, type CamMove, type CamOperation, type RapidEstimate, type ToolpathIR } from './ir';
import type { Polygons } from './pocket';
import { MaterialGrid, RegionGeometry, distanceField, type P2 } from './adaptiveGrid';
import { cuttingRadiusForSweep, type Tool } from '../tool';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface AdaptiveSettings {
  /** The engagement cap, as a fraction of the cutter diameter. */
  engagementFraction: number;
  /** The deepest level, mm. */
  stepDownMm: number;
  /** The helix's diameter (of the centre's circle), as a fraction of the cutter diameter. */
  helixDiameterFraction: number;
  /** The helix's and the ramp's descent angle, degrees. */
  rampAngleDeg: number;
  /**
   * How far above the floor just cut a rapid down a cleared column stops, and the clearance an entry
   * starts from, mm.
   */
  entryClearanceMm: number;
  /** A grid larger than this many cells is refused rather than ground through. */
  maxCells: number;
  /** The left-over the plan tolerates as grid noise along the walls, as a share of the area to clear. */
  residualShare: number;
  /** Material in a neck narrower than the grid can see, mm², past which the plan is refused. */
  neckAreaMm2: number;
  /** The clearing and linking feed, mm/min — a placeholder. */
  cutFeed: number;
  /** The helix, ramp and feed-down feed, mm/min — a placeholder. */
  entryFeed: number;
  /** The spindle speed — a placeholder. */
  spindleRpm: number;
}

const KEYS: Record<keyof AdaptiveSettings, string> = {
  engagementFraction: 'adaptive.engagementFraction',
  stepDownMm: 'adaptive.stepDownMm',
  helixDiameterFraction: 'adaptive.helixDiameterFraction',
  rampAngleDeg: 'adaptive.rampAngleDeg',
  entryClearanceMm: 'adaptive.entryClearanceMm',
  maxCells: 'adaptive.maxCells',
  residualShare: 'adaptive.residualShare',
  neckAreaMm2: 'adaptive.neckAreaMm2',
  cutFeed: 'adaptive.cutFeed',
  entryFeed: 'adaptive.entryFeed',
  spindleRpm: 'adaptive.spindleRpm',
};

/** The adaptive settings from the shop defaults, with each one's source. */
export function adaptiveSettings(defaults: ShopDefaults | null): {
  settings: AdaptiveSettings;
  sources: Record<keyof AdaptiveSettings, string>;
} {
  const settings = {} as AdaptiveSettings;
  const sources = {} as Record<keyof AdaptiveSettings, string>;
  for (const [field, key] of Object.entries(KEYS) as [keyof AdaptiveSettings, string][]) {
    const d = readDefault(defaults, key);
    settings[field] = d.value;
    sources[field] = d.source;
  }
  return { settings, sources };
}

/**
 * The planner's own constants. CHOSEN, and about the method rather than the cut, so they are not shop
 * defaults: the target and the ceiling as fractions of the cap (the gap is the measuring margin), the
 * fan of directions, and how far inside the exact wall test each clearing step stays.
 *
 * The constants that USED to live here and do not — the entry clearance above the floor, the grid's
 * cell cap and the two residual limits — describe how the cut is planned and where it gives up, which
 * is the shop's to choose, so they are `adaptive.*` defaults now (#451).
 */
export const TARGET_OF_CAP = 0.7;
export const ACCEPT_OF_CAP = 0.8;
const DIRECTIONS = 18;
const BISECTIONS = 7;
/** Points per ring round a cell still to clear, when looking for a restart beside it. */
const RING_POINTS = 24;
/** A step ahead scoring under this (within ~15 % of the target, climb, a modest turn) ends the search. */
const GOOD_ENOUGH = 0.25;
/** How far inside the exact wall test every clearing step stays, mm: the written moves' rounding. */
const WALL_MARGIN_MM = 0.001;

export interface AdaptiveInput {
  tool: Tool;
  /** The pocket, work XY: outer contours CCW, holes (islands) CW. */
  region: Polygons;
  /** Positive mm below the top. */
  depth: number;
  settings: AdaptiveSettings;
  /**
   * #666 — where the CUT numbers came from, when a job supplies them rather than the shop's
   * `adaptive.*` placeholders. The job route takes the feeds row's spindle, feed and plunge feed and
   * the shallower of the row's step-down and `adaptive.stepDownMm`, so a plan's notes must name
   * that owner rather than claim a key it did not read. Absent (a direct caller, phase 1's spec):
   * the notes are the placeholder sentences this module has always written.
   */
  provenance?: AdaptiveProvenance;
}

/** #666 — the two places a plan's notes name where its cut numbers came from (see `AdaptiveInput`). */
export interface AdaptiveProvenance {
  /** The levels note's parenthetical, e.g. `the feeds row's 0.2 mm step-down`. */
  stepDown: string;
  /** The feeds note's subject, e.g. `the feeds row's feed, plunge feed and spindle speed`. */
  feeds: string;
}

export type EntryPlan =
  | { kind: 'helix'; centre: [number, number]; radius: number; segmentsPerTurn: number }
  | { kind: 'ramp'; a: [number, number]; b: [number, number]; legs: number };

/** One finding the plan carries (a refusal is the result's own `code`). */
export interface AdaptiveFinding {
  code: string;
  severity: 'info' | 'warning';
  message: string;
}

/** What a move is for: the spec's engagement meter exempts `entry` and ignores `travel`. */
export type MoveRole = 'entry' | 'clear' | 'link' | 'travel';

export interface AdaptivePlan {
  diameter: number;
  /** The engagement cap, mm (fraction × diameter). */
  capMm: number;
  /** The level Zs, shallowest first (negative). */
  levels: number[];
  entries: EntryPlan[];
  moves: CamMove[];
  /** One role per move, aligned with `moves`. */
  roles: MoveRole[];
  findings: AdaptiveFinding[];
  notes: string[];
  stats: {
    /** The largest engagement any clearing step was planned at, mm (the planner's own grid). */
    maxStepEngagement: number;
    medianStepEngagement: number;
    /** Area left standing that should have been cleared, mm² (grid noise along the walls). */
    residualArea: number;
    /** Area the cutter can reach, mm². */
    targetArea: number;
    /** Length of the 2D clearing path, mm. */
    clearingLength: number;
    /** Restarts that lifted to the hop height, per level. */
    lifts: number;
    /** Restarts of every kind — at depth or lifted — per level. */
    restarts: number;
    /** Grid cell size, mm, and the planner's step length, mm. */
    cell: number;
    step: number;
  };
}

export type AdaptiveResult = { ok: true; plan: AdaptivePlan } | { ok: false; code: string; reason: string };

interface Candidate {
  to: P2;
  heading: number;
  /** The heavier half's load, mm. */
  ae: number;
  /** Cells still to clear that the step removes. */
  targets: number;
  side: number;
}

type Op2 =
  | { kind: 'entry'; entry: EntryPlan; end: P2 }
  | { kind: 'clear'; to: P2 }
  | { kind: 'link'; to: P2 }
  | { kind: 'lift'; to: P2 };

const fmt = (n: number) => String(r3(n));

/** Plan an adaptive clearing of `region` to `depth`: the 2D path, the entries, the moves — or why not. */
export function planAdaptive(input: AdaptiveInput): AdaptiveResult {
  const s = input.settings;
  const flat = cuttingRadiusForSweep(input.tool);
  if (!flat.ok) {
    return { ok: false, code: 'adaptive-not-flat', reason: `adaptive clearing needs a flat end mill: ${flat.reason}` };
  }
  const r = flat.radius;
  const D = 2 * r;
  if (!(input.depth > 0)) return { ok: false, code: 'adaptive-bad-settings', reason: 'the pocket has no depth' };
  const bad = badSettings(s);
  if (bad !== null) return { ok: false, code: 'adaptive-bad-settings', reason: bad };

  const geom = new RegionGeometry(input.region);
  if (geom.empty) return { ok: false, code: 'adaptive-no-room', reason: 'the region has no contour' };
  const cap = s.engagementFraction * D;
  const target = TARGET_OF_CAP * cap;
  const accept = ACCEPT_OF_CAP * cap;
  // The planner's MEASURING grid: a sixth of the engagement cap, or a twelfth of the radius, whichever
  // is finer. It is the resolution at which the load is SENSED, not a cut the machine makes — the
  // planner's own instrument, like DIRECTIONS above — so the divisor stays here rather than in the
  // shop defaults; what the grid may COST is the shop's (`adaptive.maxCells` below) (#451).
  const h = Math.min(cap / 6, r / 12);
  const step = Math.max(2 * h, r / 5);
  const cells = (Math.ceil((geom.maxX - geom.minX) / h) + 2) * (Math.ceil((geom.maxY - geom.minY) / h) + 2);
  if (cells > s.maxCells) {
    return {
      ok: false,
      code: 'adaptive-region-too-large',
      reason: `the region needs a ${cells.toLocaleString('en')}-cell material grid at ${fmt(h)} mm (the cap is ${s.maxCells.toLocaleString('en')}): a lighter engagement on a pocket this size is more than phase 1 plans`,
    };
  }
  const grid = new MaterialGrid(geom, h);
  const n = grid.nx * grid.ny;

  // Where the cutter's centre may stand, cell by cell (exact), and the area it reaches from there.
  const allowed = new Uint8Array(n);
  const clearance = new Float64Array(n);
  let anyAllowed = false;
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const k = j * grid.nx + i;
      if (grid.material[k] !== 1) continue;
      const c = geom.clearance(grid.cx(i), grid.cy(j));
      clearance[k] = c;
      if (c >= r) {
        allowed[k] = 1;
        anyAllowed = true;
      }
    }
  }
  if (!anyAllowed) {
    return { ok: false, code: 'adaptive-no-room', reason: `no part of the region is wide enough for the ${fmt(D)} mm cutter` };
  }
  grid.setTargets(distanceField(allowed, grid.nx, grid.ny, h), r);
  const targetArea = grid.totalTargets * h * h;
  const neck = subGridNeck(grid, clearance, r, s.neckAreaMm2);
  if (neck !== null) {
    return {
      ok: false,
      code: 'adaptive-engagement-exceeded',
      reason: `${fmt(neck.area)} mm² near (${fmt(neck.at[0])}, ${fmt(neck.at[1])}) lies in a part of the pocket within ${fmt(h)} mm of the ${fmt(D)} mm cutter's width: the cutter could only slot it full width, past the ${fmt(cap)} mm engagement`,
    };
  }

  const comps = components(allowed, clearance, grid);
  // Equal levels, none deeper than the step-down, so every level's entry descends the same height.
  const nLevels = Math.max(1, Math.ceil(input.depth / s.stepDownMm - 1e-9));
  const levels = Array.from({ length: nLevels }, (_, k) => r3((-input.depth * (k + 1)) / nLevels));
  const levelStep = input.depth / nLevels;
  const tanA = Math.tan((s.rampAngleDeg * Math.PI) / 180);
  const helixR = (s.helixDiameterFraction * D) / 2;

  const ops: Op2[] = [];
  const entries: EntryPlan[] = [];
  const findings: AdaptiveFinding[] = [];
  const stepEngagements: number[] = [];
  let clearingLength = 0;
  let lifts = 0;
  let restarts = 0;
  let pos: P2 | null = null;
  let heading = Math.PI / 2;
  // Every step removes at least one cell still to clear, so this bound is never met by a working planner.
  const maxSteps = grid.totalTargets + 1000;
  let steps = 0;

  /**
   * One candidate step from `p` at heading `phi`, measured — or null where the cutter would leave the
   * region. Measured in two halves and judged on the heavier: a step's average hides a load that
   * climbs within it (turning into material), and the meter that checks this reads 0.5 mm windows,
   * not whole steps. The halves partition the step's removal exactly — what the first half removes
   * lies behind the midpoint, what the second removes ahead of it.
   */
  const evaluate = (p: P2, phi: number): Candidate | null => {
    const q: P2 = [p[0] + step * Math.cos(phi), p[1] + step * Math.sin(phi)];
    // The wall test carries a micron of margin: the moves are written to 0.001 mm, and rounding moves a
    // point up to 0.7 µm. The chord between two allowed points can also graze a curved wall, so its
    // middle is checked too, which cuts that sagitta to a quarter.
    if (!geom.allows(q[0], q[1], r + WALL_MARGIN_MM)) return null;
    const mid: P2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if (!geom.allows(mid[0], mid[1], r + WALL_MARGIN_MM)) return null;
    const first = grid.sweep(p, mid, r, false);
    const second = grid.sweep(mid, q, r, false);
    return {
      to: q,
      heading: phi,
      ae: (Math.max(first.cells, second.cells) * h * h) / (step / 2),
      targets: first.targetCells + second.targetCells,
      side: first.side + second.side,
    };
  };

  /**
   * The best next step from `p`, or null. A coarse fan of directions finds where the load crosses the
   * target — turning toward the material raises it, away lowers it, and adjacent directions 10° apart
   * can differ by more than the whole allowance — and a bisection on the angle lands on it. Every
   * direction tried is a candidate if it is under the ceiling and clears something still to clear; the
   * nearest to the target wins, with the material on the right (climb) and a small turn preferred.
   */
  const bestStep = (p: P2, head: number): Candidate | null => {
    const fan: (Candidate | null | undefined)[] = new Array(DIRECTIONS);
    const angle = (k: number) => head + (k * 2 * Math.PI) / DIRECTIONS;
    const at = (k: number): Candidate | null => {
      const i = ((k % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
      if (fan[i] === undefined) fan[i] = evaluate(p, angle(i));
      return fan[i]!;
    };
    let best: { c: Candidate; score: number } | null = null;
    const consider = (c: Candidate | null): void => {
      if (c === null || c.targets === 0 || c.ae > accept) return;
      let turn = Math.abs(c.heading - head) % (2 * Math.PI);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      const score = Math.abs(c.ae - target) / target + (c.side < 0 ? 0 : 0.5) + 0.0015 * ((turn * 180) / Math.PI);
      if (best === null || score < best.score) best = { c, score };
    };
    const bisected = new Set<number>();
    /** Directions k and k+1 (10° apart): consider k, and bisect between them where the target lies. */
    const pair = (k: number): void => {
      const i = ((k % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
      if (bisected.has(i)) return;
      bisected.add(i);
      const a = at(k);
      const b = at(k + 1);
      consider(a);
      if ((a === null) !== (b === null)) {
        // One leaves the region, one does not: find the direction that runs along the wall, which is
        // where the last band of a wall is cut from.
        let inside = a === null ? angle(k + 1) : angle(k);
        let outside = a === null ? angle(k) : angle(k + 1);
        for (let n = 0; n < BISECTIONS; n++) {
          const m = (inside + outside) / 2;
          const c = evaluate(p, m);
          if (c === null) outside = m;
          else {
            consider(c);
            inside = m;
          }
        }
        return;
      }
      if (a === null || b === null || (a.ae - target) * (b.ae - target) >= 0) return;
      let lo = a.ae < target ? angle(k) : angle(k + 1);
      let hi = a.ae < target ? angle(k + 1) : angle(k);
      for (let n = 0; n < BISECTIONS; n++) {
        const m = (lo + hi) / 2;
        const c = evaluate(p, m);
        if (c === null) break;
        consider(c);
        if (c.ae > target) hi = m;
        else lo = m;
      }
    };
    // Ahead first — within 90° of the heading — and stop there when that already found a good step.
    const quarter = DIRECTIONS / 4;
    for (let k = -quarter; k < quarter; k++) pair(k);
    if (best !== null && (best as { score: number }).score < GOOD_ENOUGH) return (best as { c: Candidate }).c;
    for (let k = quarter; k < DIRECTIONS - quarter; k++) pair(k);
    return best === null ? null : (best as { c: Candidate }).c;
  };

  /** Walk from `pos` while a good step exists. */
  const walk = (): boolean => {
    for (let taken = 0; ; taken++) {
      const next = bestStep(pos!, heading);
      if (next === null) {
        if (taken > 0) stuck.fill(0);
        return true;
      }
      if (++steps > maxSteps) return false;
      grid.sweep(pos!, next.to, r, true);
      stepEngagements.push(next.ae);
      clearingLength += Math.hypot(next.to[0] - pos![0], next.to[1] - pos![1]);
      const last = ops[ops.length - 1];
      if (last !== undefined && last.kind === 'clear' && Math.abs(next.heading - heading) < 1e-12) {
        last.to = next.to; // the same heading: one straight move, not two
      } else {
        ops.push({ kind: 'clear', to: next.to });
      }
      pos = next.to;
      heading = next.heading;
    }
  };

  const entered = new Set<number>();
  const stuck = new Uint8Array(n);
  for (;;) {
    // A restart next to standing material, from a disc that is already clear.
    const restart: P2 | null = pos === null ? null : findRestart(grid, geom, r, step, pos, stuck, (q) => bestStep(q, heading) !== null);
    if (restart !== null) {
      restarts++;
      const p = pos!;
      if (sweptClear(grid, geom, p, restart, r, 20 * D)) {
        ops.push({ kind: 'link', to: restart });
      } else {
        ops.push({ kind: 'lift', to: restart });
        lifts++;
      }
      pos = restart;
      if (!walk()) return stepLimit(maxSteps);
      continue;
    }
    // No restart: an area with no entry yet that still has material to clear.
    const dist = distanceField(grid.target, grid.nx, grid.ny, h);
    const comp = comps.find((c, idx) => !entered.has(idx) && c.cells.some((k) => dist[k]! <= r));
    if (comp === undefined) break;
    entered.add(comps.indexOf(comp));
    const e = planEntry(geom, comp.best, comp.bestClearance, r, D, helixR, levelStep, tanA, s.entryClearanceMm);
    if (!e.ok) return { ok: false, code: 'adaptive-no-entry', reason: e.reason };
    if (e.helixRefused !== undefined) findings.push({ code: 'adaptive-helix-refused', severity: 'info', message: e.helixRefused });
    entries.push(e.entry);
    if (e.entry.kind === 'helix') {
      grid.stampDisc(e.entry.centre, r + helixR);
    } else {
      grid.stampCapsule(e.entry.a, e.entry.b, r);
    }
    ops.push({ kind: 'entry', entry: e.entry, end: e.end });
    if (pos !== null) lifts++;
    pos = e.end;
    heading = e.heading;
    if (!walk()) return stepLimit(maxSteps);
  }

  const residualArea = grid.remainingTargets * h * h;
  if (residualArea > s.residualShare * targetArea) {
    const where = residualCentroid(grid);
    return {
      ok: false,
      code: 'adaptive-engagement-exceeded',
      reason: `${fmt(residualArea)} mm² near (${fmt(where[0])}, ${fmt(where[1])}) cannot be cleared without passing the ${fmt(cap)} mm engagement (${s.engagementFraction} × ${fmt(D)} mm): the pocket narrows there to a slot the cutter would have to cut full width`,
    };
  }

  const { moves, roles } = replay(ops, levels, s, tanA);
  const sorted = [...stepEngagements].sort((a, b) => a - b);
  const prov = input.provenance;
  const notes = [
    `engagement capped at ${fmt(cap)} mm (${s.engagementFraction} × the ${fmt(D)} mm cutter), planned at ${fmt(target)} mm and never above ${fmt(accept)} mm on the planner's ${fmt(h)} mm grid`,
    prov === undefined
      ? `${levels.length} level(s) of ${fmt(levelStep)} mm (adaptive.stepDownMm ${s.stepDownMm})`
      : `${levels.length} level(s) of ${fmt(levelStep)} mm (${prov.stepDown})`,
    ...entries.map((e) =>
      e.kind === 'helix'
        ? `helix entry at (${fmt(e.centre[0])}, ${fmt(e.centre[1])}), ${fmt(2 * e.radius)} mm across at ${s.rampAngleDeg}°`
        : `ramp entry from (${fmt(e.a[0])}, ${fmt(e.a[1])}) to (${fmt(e.b[0])}, ${fmt(e.b[1])}) at ${s.rampAngleDeg}°, ${e.legs} leg(s) per level`,
    ),
    prov === undefined
      ? `feeds ${s.cutFeed} / ${s.entryFeed} mm/min and ${s.spindleRpm} rpm are starting values (adaptive.cutFeed, adaptive.entryFeed, adaptive.spindleRpm)`
      : `feeds ${s.cutFeed} / ${s.entryFeed} mm/min and ${s.spindleRpm} rpm are ${prov.feeds}`,
  ];
  return {
    ok: true,
    plan: {
      diameter: D,
      capMm: cap,
      levels,
      entries,
      moves,
      roles,
      findings,
      notes,
      stats: {
        maxStepEngagement: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
        medianStepEngagement: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0,
        residualArea,
        targetArea,
        clearingLength,
        lifts,
        restarts,
        cell: h,
        step,
      },
    },
  };
}

/**
 * Material in a part of the pocket barely wider than the cutter — so narrow that no cell centre of the
 * grid lands where the cutter's centre may stand, and the planner would never count it as material to
 * clear. Found by loosening the room test by most of a cell: material the loosened room reaches, that is
 * not material to clear, and that lies well away (over three cells) from any — so not the sliver an inside
 * corner leaves along its edge. Cutting there would be a full-width slot, so it is refused rather than
 * silently left standing.
 */
function subGridNeck(grid: MaterialGrid, clearance: Float64Array, r: number, neckAreaMm2: number): { area: number; at: P2 } | null {
  const h = grid.h;
  const loose = new Uint8Array(grid.material.length);
  for (let k = 0; k < loose.length; k++) if (grid.material[k] === 1 && clearance[k]! >= r - 0.75 * h) loose[k] = 1;
  const toLoose = distanceField(loose, grid.nx, grid.ny, h);
  const toTarget = distanceField(grid.target, grid.nx, grid.ny, h);
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < loose.length; k++) {
    if (grid.material[k] !== 1 || grid.target[k] === 1 || toLoose[k]! > r + h || toTarget[k]! <= 3 * h) continue;
    const i = k % grid.nx;
    sx += grid.cx(i);
    sy += grid.cy((k - i) / grid.nx);
    n++;
  }
  const area = n * h * h;
  return area > neckAreaMm2 ? { area, at: [sx / n, sy / n] } : null;
}

function stepLimit(maxSteps: number): AdaptiveResult {
  return {
    ok: false,
    code: 'adaptive-step-limit',
    reason: `the clearing path passed ${maxSteps.toLocaleString('en')} steps without finishing: a planner fault, refused rather than cut half-planned`,
  };
}

function badSettings(s: AdaptiveSettings): string | null {
  if (!(s.engagementFraction > 0 && s.engagementFraction <= 0.5)) return `an engagement of ${s.engagementFraction} × the diameter is outside 0 to 0.5`;
  if (!(s.stepDownMm > 0)) return `a step-down of ${s.stepDownMm} mm is not positive`;
  if (!(s.helixDiameterFraction >= 0.1 && s.helixDiameterFraction <= 0.95)) {
    return `a helix of ${s.helixDiameterFraction} × the diameter is outside 0.1 to 0.95 (above 1 it leaves a core standing in the middle)`;
  }
  if (!(s.rampAngleDeg > 0 && s.rampAngleDeg <= 30)) return `a ramp angle of ${s.rampAngleDeg}° is outside 0 to 30°`;
  if (!(s.entryClearanceMm > 0 && s.entryClearanceMm <= 5)) {
    return `an entry clearance of ${s.entryClearanceMm} mm is outside 0 to 5 mm`;
  }
  if (!(Number.isInteger(s.maxCells) && s.maxCells >= 1000 && s.maxCells <= 100_000_000)) {
    return `a grid cap of ${s.maxCells} cells is not a whole number from 1 000 to 100 000 000`;
  }
  if (!(s.residualShare >= 0 && s.residualShare <= 0.5)) {
    return `a residual share of ${s.residualShare} is outside 0 to 0.5 of the area to clear`;
  }
  if (!(s.neckAreaMm2 >= 0 && s.neckAreaMm2 <= 100)) {
    return `a neck area of ${s.neckAreaMm2} mm² is outside 0 to 100 mm²`;
  }
  if (!(s.cutFeed > 0 && s.entryFeed > 0 && s.spindleRpm > 0)) return 'a feed or the spindle speed is not positive';
  return null;
}

interface Component {
  cells: number[];
  /** The roomiest cell centre, and its distance to the nearest edge. */
  best: P2;
  bestClearance: number;
}

/** The separate areas the cutter's centre can roam (8-connected), roomiest first. */
function components(allowed: Uint8Array, clearance: Float64Array, grid: MaterialGrid): Component[] {
  const { nx, ny } = grid;
  const label = new Int32Array(allowed.length).fill(-1);
  const out: (Component & { bestK: number })[] = [];
  const stack: number[] = [];
  for (let start = 0; start < allowed.length; start++) {
    if (allowed[start] !== 1 || label[start] !== -1) continue;
    const id = out.length;
    const comp = { cells: [] as number[], best: [0, 0] as P2, bestClearance: -1, bestK: start };
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const k = stack.pop()!;
      comp.cells.push(k);
      if (clearance[k]! > comp.bestClearance) {
        comp.bestClearance = clearance[k]!;
        comp.bestK = k;
      }
      const i = k % nx;
      const j = (k - i) / nx;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const kk = jj * nx + ii;
          if (allowed[kk] === 1 && label[kk] === -1) {
            label[kk] = id;
            stack.push(kk);
          }
        }
      }
    }
    out.push(comp);
  }
  return out
    .sort((a, b) => b.bestClearance - a.bestClearance || a.bestK - b.bestK)
    .map((c) => ({ cells: c.cells, best: [grid.cx(c.bestK % nx), grid.cy(Math.floor(c.bestK / nx))] as P2, bestClearance: c.bestClearance }));
}

/**
 * A restart: a point whose disc is already clear, a step or less from material still to clear, from
 * which `canStep` finds a good first step — or null when there is none.
 *
 * Driven by the material, nearest the tool first: the nearest cell still to clear, and points on rings
 * round it just over the cutter's radius away. A cell none of those points can start on is marked
 * STUCK with its neighbours within a step (they mostly fail the same way), so the next search moves on;
 * the marks are lifted whenever a walk makes progress, since cutting nearby can open a way in. A null
 * therefore means every cell still to clear was tried since the last cut.
 */
function findRestart(
  grid: MaterialGrid,
  geom: RegionGeometry,
  r: number,
  step: number,
  from: P2,
  stuck: Uint8Array,
  canStep: (q: P2) => boolean,
): P2 | null {
  const { nx, target } = grid;
  for (;;) {
    let bestK = -1;
    let bestD2 = Infinity;
    for (let k = 0; k < target.length; k++) {
      if (target[k] !== 1 || stuck[k] === 1) continue;
      const i = k % nx;
      const dx = grid.cx(i) - from[0];
      const dy = grid.cy((k - i) / nx) - from[1];
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestK = k;
      }
    }
    if (bestK < 0) return null;
    const mi = bestK % nx;
    const m: P2 = [grid.cx(mi), grid.cy((bestK - mi) / nx)];
    const points: { q: P2; d2: number }[] = [];
    for (const rad of [r + 0.3 * step, r + 0.65 * step, r + step]) {
      for (let a = 0; a < RING_POINTS; a++) {
        const t = (2 * Math.PI * a) / RING_POINTS;
        const q: P2 = [m[0] + rad * Math.cos(t), m[1] + rad * Math.sin(t)];
        points.push({ q, d2: (q[0] - from[0]) ** 2 + (q[1] - from[1]) ** 2 });
      }
    }
    points.sort((a, b) => a.d2 - b.d2);
    for (const { q } of points) {
      if (!geom.allows(q[0], q[1], r + WALL_MARGIN_MM) || grid.discCells(q, r) !== 0) continue;
      if (canStep(q)) return q;
    }
    // Stuck: this cell and its neighbours within a step, until the next walk cuts something.
    const reach = Math.ceil(step / grid.h);
    const mj = (bestK - mi) / nx;
    for (let j = Math.max(0, mj - reach); j <= Math.min(grid.ny - 1, mj + reach); j++) {
      for (let i = Math.max(0, mi - reach); i <= Math.min(nx - 1, mi + reach); i++) {
        if ((i - mi) ** 2 + (j - mj) ** 2 <= reach * reach) stuck[j * nx + i] = 1;
      }
    }
  }
}

/** The cutter can travel a → b at depth: every disc along it is inside the region and already clear. */
function sweptClear(grid: MaterialGrid, geom: RegionGeometry, a: P2, b: P2, r: number, maxLength: number): boolean {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len > maxLength) return false;
  const n = Math.max(1, Math.ceil(len / (grid.h / 2)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    if (!geom.allows(x, y, r + WALL_MARGIN_MM)) return false;
    if (grid.discCells([x, y], r) !== 0) return false;
  }
  return true;
}

function residualCentroid(grid: MaterialGrid): P2 {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let k = 0; k < grid.target.length; k++) {
    if (grid.target[k] !== 1) continue;
    const i = k % grid.nx;
    sx += grid.cx(i);
    sy += grid.cy((k - i) / grid.nx);
    n++;
  }
  return n === 0 ? [0, 0] : [sx / n, sy / n];
}

type EntryResult =
  | { ok: true; entry: EntryPlan; end: P2; heading: number; helixRefused?: string }
  | { ok: false; reason: string };

/** The entry for one area: a helix at its roomiest point, else a ramp along its longest line. */
function planEntry(
  geom: RegionGeometry,
  c: P2,
  clear: number,
  r: number,
  D: number,
  helixR: number,
  levelStep: number,
  tanA: number,
  entryClearanceMm: number,
): EntryResult {
  const bore = r + helixR;
  if (clear >= bore + WALL_MARGIN_MM) {
    const segmentsPerTurn = Math.max(12, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.01, helixR / 4) / helixR)));
    return {
      ok: true,
      entry: { kind: 'helix', centre: [c[0], c[1]], radius: helixR, segmentsPerTurn },
      end: [c[0] + helixR, c[1]],
      heading: Math.PI / 2,
    };
  }
  const helixRefused = `a ${fmt(2 * helixR)} mm helix needs a ${fmt(2 * bore)} mm bore, and the roomiest point of this area, (${fmt(c[0])}, ${fmt(c[1])}), is ${fmt(2 * clear)} mm across: ramping in instead`;
  // The longest straight line the centre can travel through the roomiest point.
  let best: { a: P2; len: number; u: P2 } | null = null;
  const march = (ux: number, uy: number): number => {
    const ds = Math.min(0.02, r / 20);
    let t = 0;
    while (t < 1000 && geom.allows(c[0] + (t + ds) * ux, c[1] + (t + ds) * uy, r + WALL_MARGIN_MM)) t += ds;
    return t;
  };
  for (let deg = 0; deg < 180; deg += 5) {
    const ux = Math.cos((deg * Math.PI) / 180);
    const uy = Math.sin((deg * Math.PI) / 180);
    const fwd = march(ux, uy);
    const back = march(-ux, -uy);
    const len = fwd + back;
    if (best === null || len > best.len + 1e-9) best = { a: [c[0] - back * ux, c[1] - back * uy], len, u: [ux, uy] };
  }
  if (best === null || best.len < D) {
    return {
      ok: false,
      reason: `${helixRefused.replace(/: ramping in instead$/, '')}; and the longest straight line the centre can ramp along there is ${fmt(best?.len ?? 0)} mm, shorter than the ${fmt(D)} mm cutter — no helix or ramp fits, and a metal pocket is not plunged`,
    };
  }
  // The deepest descent a level's ramp makes: from the clearance above the level before, to this one.
  const needed = (levelStep + entryClearanceMm) / tanA;
  const len = Math.min(best.len, Math.max(D, needed));
  const a: [number, number] = [best.a[0], best.a[1]];
  const b: [number, number] = [best.a[0] + len * best.u[0], best.a[1] + len * best.u[1]];
  const legs = Math.max(1, Math.ceil((levelStep + entryClearanceMm) / (len * tanA) - 1e-9));
  // The last descending leg ends at B when the leg count is odd, A when even; a flat pass back ends at the other.
  const end: P2 = legs % 2 === 1 ? a : b;
  return { ok: true, entry: { kind: 'ramp', a, b, legs }, end, heading: Math.atan2(end === a ? -best.u[1] : best.u[1], end === a ? -best.u[0] : best.u[0]), helixRefused };
}

/** The 2D plan as moves, level by level. */
function replay(ops: readonly Op2[], levels: readonly number[], s: AdaptiveSettings, tanA: number): { moves: CamMove[]; roles: MoveRole[] } {
  const moves: CamMove[] = [];
  const roles: MoveRole[] = [];
  const push = (m: CamMove, role: MoveRole) => {
    moves.push({ ...m, x: r3(m.x), y: r3(m.y), z: r3(m.z) } as CamMove);
    roles.push(role);
  };
  let x = 0;
  let y = 0;
  let z = SAFE_Z;
  const rapid = (nx: number, ny: number, nz: number, role: MoveRole = 'travel') => {
    push({ kind: 'rapid', x: nx, y: ny, z: nz }, role);
    x = nx;
    y = ny;
    z = nz;
  };
  const feed = (nx: number, ny: number, nz: number, f: number, role: MoveRole) => {
    push({ kind: 'feed', x: nx, y: ny, z: nz, f }, role);
    x = nx;
    y = ny;
    z = nz;
  };
  /** Up to the hop height, across, down a cleared column to `floor` + the clearance. */
  const travelTo = (tx: number, ty: number, floor: number) => {
    if (moves.length > 0 && z < HOP_Z) rapid(x, y, HOP_Z);
    rapid(tx, ty, HOP_Z);
    // Over uncut stock (the first level) the rapid stops at the hop height and the entry FEEDS the
    // last of the way down to the face, so the approach to the top has its clearance. Over a floor
    // already cut it rapids down the cleared column to the clearance above that floor — but never
    // above the face, since a feed that ends above Z0 is a cut in the air the post refuses.
    if (floor === 0) return;
    const stop = Math.min(0, floor + s.entryClearanceMm);
    rapid(tx, ty, stop);
  };
  let top = 0;
  for (const level of levels) {
    for (const op of ops) {
      if (op.kind === 'entry') {
        const e = op.entry;
        // From the top face on the first level; from the clearance above the floor just cut on every
        // level after — capped at the face, so a level shallower than the clearance never starts its
        // entry in the air (a feed ending above Z0 is refused by the post).
        const start = Math.min(0, top + s.entryClearanceMm * (top === 0 ? 0 : 1));
        if (e.kind === 'helix') {
          const [cx, cy] = e.centre;
          travelTo(cx + e.radius, cy, top);
          if (z > start) feed(cx + e.radius, cy, start, s.entryFeed, 'entry');
          const perTurn = 2 * Math.PI * e.radius * tanA;
          const turns = (start - level) / perTurn;
          const nDown = Math.max(1, Math.ceil(turns * e.segmentsPerTurn));
          const sweep = turns * 2 * Math.PI;
          for (let i = 1; i <= nDown; i++) {
            const t = i / nDown;
            const a = sweep * t;
            feed(cx + e.radius * Math.cos(a), cy + e.radius * Math.sin(a), start + (level - start) * t, s.entryFeed, 'entry');
          }
          // A flat lap on the floor, then on round to angle 0 — where the 2D plan's clearing starts.
          const lapEnd = 2 * Math.PI * Math.ceil((sweep + 2 * Math.PI - 1e-9) / (2 * Math.PI));
          const nLap = Math.max(1, Math.ceil(((lapEnd - sweep) / (2 * Math.PI)) * e.segmentsPerTurn));
          for (let i = 1; i <= nLap; i++) {
            const a = i === nLap ? 0 : sweep + ((lapEnd - sweep) * i) / nLap;
            feed(cx + e.radius * Math.cos(a), cy + e.radius * Math.sin(a), level, s.entryFeed, 'entry');
          }
        } else {
          const { a, b, legs } = e;
          travelTo(a[0], a[1], top);
          if (z > start) feed(a[0], a[1], start, s.entryFeed, 'entry');
          // Always `legs` legs, sharing the descent: the leg count fixes which end the ramp finishes
          // at, and that end is where the 2D plan's clearing starts, at every level alike.
          let at: P2 = a;
          for (let i = 1; i <= legs; i++) {
            const to: P2 = at === a ? b : a;
            feed(to[0], to[1], start + ((level - start) * i) / legs, s.entryFeed, 'entry');
            at = to;
          }
          const back: P2 = at === a ? b : a;
          feed(back[0], back[1], level, s.entryFeed, 'entry');
        }
      } else if (op.kind === 'clear') {
        feed(op.to[0], op.to[1], level, s.cutFeed, 'clear');
      } else if (op.kind === 'link') {
        feed(op.to[0], op.to[1], level, s.cutFeed, 'link');
      } else {
        travelTo(op.to[0], op.to[1], level);
        feed(op.to[0], op.to[1], level, s.entryFeed, 'link');
      }
    }
    top = level;
  }
  if (z < HOP_Z) rapid(x, y, HOP_Z);
  rapid(x, y, SAFE_Z);
  return { moves, roles };
}

/** What the IR needs beyond the plan: the operation's names, the tool and the machine's rapid model. */
export interface AdaptiveIRContext {
  tool: Tool;
  depth: number;
  settings: AdaptiveSettings;
  name: string;
  labelId: string;
  air: boolean;
  rapid: RapidEstimate;
}

/** A plan as a postable IR: one operation, the end mill as its tool. */
export function adaptivePlanIR(plan: AdaptivePlan, ctx: AdaptiveIRContext): ToolpathIR {
  const op: CamOperation = {
    number: 1,
    name: ctx.name,
    labelId: ctx.labelId,
    depth: ctx.depth,
    moves: plan.moves,
    estimatedSeconds: estimateCycleSeconds(plan.moves, ctx.rapid),
  };
  return {
    frame: 'flat',
    tool: ctx.tool,
    toolNumber: toolNumberFor(ctx.tool),
    spindleRpm: ctx.settings.spindleRpm,
    air: ctx.air,
    safeZ: SAFE_Z,
    hopZ: HOP_Z,
    operations: [op],
  };
}

/** The adaptive pocket, planned and as a postable IR — or the refusal. */
export function adaptiveIR(
  input: AdaptiveInput & Omit<AdaptiveIRContext, 'tool' | 'depth' | 'settings'>,
): { ok: true; ir: ToolpathIR; plan: AdaptivePlan } | { ok: false; code: string; reason: string } {
  const r = planAdaptive(input);
  if (!r.ok) return r;
  return { ok: true, plan: r.plan, ir: adaptivePlanIR(r.plan, input) };
}
