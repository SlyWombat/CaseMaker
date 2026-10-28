// The GROOVE oracle (#408, #221 piece 2): can a V-bit trace job be judged at all, and is the
// judgement worth making?
//
// A V trace is the first job whose cut is neither a pocket nor a slot: the material a cone removes
// at a level depends on how far below its tip that level sits. So this file pins three things that
// a "it passes now" would hide:
//
//   * the prediction really is a GROOVE — the region it reports at a level is the stroke dilated
//     by the cone's reach THERE, growing as the level rises, and never the mouth repeated (the
//     standing "do not" of #221: a V cut as a flat). A groove is also judged at a level of its
//     OWN near the top face: a job judged only at its floors asks the narrowest question it can,
//     and would certify a groove's centreline while saying nothing about its width;
//   * the band the comparison is made to is DERIVED from the grid the run swept with, not a
//     number anyone typed — the term `columnBandTerm` adds is the whole difference between a
//     column sweep passing and failing on sampling alone;
//   * and the comparison still REFUSES — a truncated trace, a trace cut too deep and a trace cut
//     in the wrong place are each caught through the real session, with the CAM's own program as
//     the passing control, so neither half of that can be faked by the other.
//
// The last describe block is the issue's acceptance run: the committed bench job, end to end,
// through the same generate → load → oracle sequence the panel performs.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession, type SimSession } from '@/workers/sim/session';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  ORACLE_AREA_FLOOR,
  ORACLE_SHALLOW_DEPTH_FRACTION,
  columnBandTerm,
  columnOracleBand,
  computeOracle,
  gridSliceAt,
  oracleBand,
  type OracleGroove,
  type OraclePredicted,
} from '@/engine/cnc/engrave/oracle';
import { grooveRadiusAt, vCone, type VCone } from '@/engine/cnc/vProfile';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { COLUMN_FLAT_PITCH_Y_FALLBACK_MM, COLUMN_SIM_RESOLUTION, type ColumnGrid } from '@/workers/geometry/columnEngine';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { saveBlocker, uploadBlocker, type EngraveRunView } from '@/store/engraveRunGate';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import type { CamMove, ToolpathIR } from '@/engine/cnc/cam/ir';
import type { SimDiagnostic } from '@/workers/sim/session';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, EngraveTraceItem } from '@/types/engraveJob';
import type { Tool } from '@/engine/cnc/tool';

/** The bench bit: a 30° engraver with a 0.3 mm flat. Its cone is the one every case here sweeps. */
const bit30 = (): Tool => ({
  number: 1,
  id: 'C1-BIT-ENGRAVE-30-0.3',
  name: 'Single Flute Engraving Bit 30 x 0.3',
  typeText: 'Engraving',
  shape: 'engraving',
  handleDiameter: 3.175,
  tipDiameter: 0.3,
  diameter: 3.175,
  cornerRadius: 0,
  angle: 30,
  halfAngle: 15,
  fluteLength: null,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
});

const CONE: VCone = vCone(bit30())!;

/** A 30 mm straight trace along +X at y = 20, 1 mm deep — clear of every edge by 10 mm. */
function line(over: Partial<EngraveTraceItem> = {}): EngraveTraceItem {
  return {
    kind: 'line',
    id: 'tr',
    position: { x: 0, y: 0 },
    rotation: 0,
    points: [
      [10, 20],
      [40, 20],
    ],
    closed: false,
    depth: 1,
    enabled: true,
    ...over,
  } as EngraveTraceItem;
}

/** A plain 60 × 60 × 12 PLA blank with one V-bit trace as its only item. */
function traceJob(trace: EngraveTraceItem = line()): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'groove oracle',
    stock: { length: 60, width: 60, thickness: 12, material: 'pla' },
    labels: [],
    shapes: [],
    toolKey: 'inv:kz-engrave-30-0-3',
    tool: bit30(),
    minFloor: 1,
    edgeMargin: 1,
    traces: [trace],
  };
}

/**
 * The area `traceSweptProfile` gives ONE straight segment of length `L` and radius `r`: the hull
 * of the two end discs, which is `2·y_max·L` of band plus one whole disc's ends. The discs are
 * POLYGONS — `segmentsForRadius` sides, Manifold's default would be a square at this radius (#190)
 * — so both the disc's area and its half-height are the n-gon's, not the circle's.
 */
function capsuleArea(L: number, r: number): number {
  const n = segmentsForRadius(r);
  const disc = (n / 2) * r * r * Math.sin((2 * Math.PI) / n);
  let yMax = 0;
  for (let k = 0; k < n; k++) yMax = Math.max(yMax, Math.abs(r * Math.sin((2 * Math.PI * k) / n)));
  return disc + 2 * yMax * L;
}

function groove(tipDepth: number, cone: VCone = CONE): OraclePredicted {
  const paths: [number, number][][] = [
    [
      [10, 20],
      [40, 20],
    ],
  ];
  return { depth: tipDepth, polygons: [], groove: { paths, closed: [false], cone } satisfies OracleGroove };
}

/** A `ColumnGrid` with `h` given row by row (j = 0 first), 1 mm cells from (0, 0) with 2 × 2. */
function gridOf(h: number[]): ColumnGrid {
  return { kind: 'flat', nu: 2, nv: 2, u0: 0, du: 1, v0: 0, dv: 1, initial: 0, base: -3, h: Float32Array.from(h) };
}

/** The post context `engraveGenerate` builds, so a hand-posted program carries the same header. */
function postCtx(job: EngraveJob): PostContext {
  return {
    jobName: job.name,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    materialName: job.stock.material,
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test',
    toolKey: job.toolKey,
  };
}

/**
 * Generate, load, and hand back the session plus the load's own diagnostics — exactly the panel's
 * generate → simulate sequence, and the SIMDIAGNOSTICS the Save and Upload gates read.
 */
function load(job: EngraveJob, nc: string, tool: Tool): { session: SimSession; diagnostics: SimDiagnostic[] } {
  const session = createSimSession(tl);
  const r = session.load(nc, toSetup(job, Z1), tool, Z1.id);
  if (!r.ok) throw new Error(`load refused: ${JSON.stringify(r.diagnostics)}`);
  // The routing the whole issue is about: a cone never reaches the exact sweeper (#405), so this
  // is the column engine's answer this file is judging.
  expect(r.stats.engine).toBe('column');
  return { session, diagnostics: r.diagnostics };
}

/**
 * Post a bare cutting program: rapid to the start, plunge, then `endX` along +X at depth `d`. The
 * trace the prediction is judged against is always the job's own (`line()` at y = 20), so `y` is
 * the program's own Y — the one thing a wrong-program case can move.
 */
function posted(job: EngraveJob, endX: number, d = 1, y = 20): string {
  const moves: CamMove[] = [
    { kind: 'rapid', x: 10, y, z: 2 },
    { kind: 'feed', x: 10, y, z: -d, f: 200 },
    { kind: 'feed', x: endX, y, z: -d, f: 400 },
  ];
  const ir: ToolpathIR = {
    frame: 'flat',
    tool: bit30(),
    toolNumber: 1,
    spindleRpm: 12000,
    air: false,
    safeZ: 5,
    hopZ: 1,
    operations: [{ number: 1, name: '[T1]trace', labelId: 'tr', depth: d, moves, estimatedSeconds: 5 }],
  };
  const out = postZ1(ir, postCtx(job), Z1);
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.text;
}

describe('the V-trace prediction is a groove (#408 item 1)', () => {
  /**
   * Two traces of the SAME 30 mm stroke, tipped 0.5 and 1.0 mm down, so the report has a level at
   * each and the shallow one's region contains the deep one's — which is what lets one run measure
   * the region at several depths.
   *
   * Judged with a `sliceAt` that always answers "nothing was cut", which makes every level's
   * `predictedArea` the region's own area (`underCut` is then the region shrunk by the band, so a
   * band of 0 reports it whole). No wasm sweep, no grid: this is the prediction alone.
   */
  function areas(): { z: number; area: number }[] {
    const report = computeOracle(tl, () => null, [groove(0.5), groove(1.0)], 0);
    return report.levels.map((l) => ({ z: l.z, area: l.predictedArea }));
  }

  it('adds a level of its own near the top face, where the groove is at its widest (#408 review 1)', () => {
    const levels = areas();
    // Ascending, so the report reads shallow-first: the derived level, then the two floors.
    // `ORACLE_SHALLOW_DEPTH_FRACTION` of the SHALLOWEST groove — 0.05 mm under a 0.5 mm trace —
    // rather than a fixed millimetre, so a job of 0.2 mm traces is judged as near its own mouth.
    expect(levels.map((l) => l.z)).toEqual([-0.05, -0.5, -1]);

    const mouth = levels[0]!;
    // At 0.05 mm down the cone has risen 0.95 mm of its 15° flank when the DEEPER stroke is reached:
    // 0.15 + 0.95·tan15° = 0.405 mm, so the level's region is that stroke's, not the 0.5 mm one's.
    const reach = grooveRadiusAt(CONE, 0.95);
    expect(reach).toBeCloseTo(0.4045517328, 8);
    expect(mouth.area).toBeCloseTo(capsuleArea(30, reach), 2);

    // Which is the point of the level, and what answers the resolution finding #408 reported: judged
    // only at its floors, this job asks the narrowest question a V trace can be asked — a 0.3 mm
    // strip of tip, which under #408's 0.1 × 0.25 mm grid was judged through a 0.146 mm band and so
    // certified little more than that the groove's FLOOR sits on the centreline (#438 has since
    // given the flat grid a 0.1 mm Y pitch and a 0.083 mm band). The same groove here is 0.81 mm
    // wide, 2.7× the floor's strip, so the comparison at this level is about the shape the plan
    // draws rather than about one line through it.
    const floor = levels[2]!;
    expect(reach / CONE.tipRadius).toBeCloseTo(2.697, 2);
    expect(mouth.area).toBeGreaterThan(2 * floor.area);
  });

  it('dilates the stroke by the cone’s reach at the LEVEL, not at the trace’s own depth', () => {
    const levels = areas();
    const half = levels[1]!;
    const deep = levels[2]!;
    // The levels are the two traces' floors, in the work frame's negative Z.
    expect(half.z).toBe(-0.5);
    expect(deep.z).toBe(-1);

    // At 1.0 mm down, the cone has closed to its tip: 0.15 mm of flat, so the band is 0.3 mm wide.
    expect(deep.area).toBeCloseTo(capsuleArea(30, CONE.tipRadius), 2);
    // At 0.5 mm, the flank has risen half a millimetre's worth: 0.15 + 0.5·tan15° = 0.284 mm.
    const r = grooveRadiusAt(CONE, 0.5);
    expect(r).toBeCloseTo(0.2839745962, 8);
    expect(half.area).toBeCloseTo(capsuleArea(30, r), 2);
    // …and the union takes the wider of the two, so the level reads the SHALLOW trace's region.
    expect(half.area).toBeGreaterThan(deep.area);

    // The two levels are half a millimetre of flank apart, so their bands differ by exactly
    // `2·L·Δr` — the term that pins the slope `tanHalf`, since a prediction that used the trace's
    // own depth at every level (or the tip radius at every level) would not move with the level at
    // all. The end discs grow with the radius too, by well under a square millimetre here.
    const deltaBand = 2 * 30 * (r - CONE.tipRadius);
    const delta = half.area - deep.area;
    expect(delta).toBeGreaterThan(deltaBand);
    expect(delta - deltaBand).toBeLessThan(0.5);
    // 0.15 mm of tip plus half a millimetre of a 15° flank.
    expect(r).toBeCloseTo(0.15 + 0.5 * 0.2679491924, 6);
  });

  it('is NOT the mouth repeated — the smallest level is under half what a flat prediction would say', () => {
    const deep = areas()[2]!;
    // What #221's "do not" would predict: the groove's top opening at every level. At 1 mm deep
    // that is 0.836 mm wide — nearly three times the tip — so a flat prediction over-states this
    // level by ~16 mm², which is where the oracle would report the whole difference as under-cut.
    const mouth = capsuleArea(30, grooveRadiusAt(CONE, 1));
    expect(mouth).toBeGreaterThan(20);
    expect(deep.area).toBeLessThan(mouth / 2);
    // …and the mouth is still exactly what a trace tipped there would report AT the top face: the
    // formula reduces to `traceRadiusAt` there, so the two agree where they should — the shallow
    // LEVEL is not the top face (see the test above), and so sits just under it.
    expect(capsuleArea(30, CONE.tipRadius + 1 * CONE.tanHalf)).toBeCloseTo(mouth, 9);
  });

  it('derives no level from a groove whose floor is above 0 — a depth is a positive depth', () => {
    // The level set is the entries' own floors plus the derived shallow one; a degenerate entry can
    // invent neither, so a 0-depth groove cannot put a slice at the top face, where there is no
    // pocket to be inside of.
    expect(computeOracle(tl, () => null, [groove(0)], 0).levels).toEqual([]);
    expect(computeOracle(tl, () => null, [{ depth: 0, polygons: [] }], 0).levels).toEqual([]);
    // …and a flat item gets no shallow level at all: its region is the same set at every level
    // above its floor, so a level there would re-ask the question its floor already answered (and
    // it is not a level the plan cuts to).
    const flat = computeOracle(tl, () => null, [{ depth: 1, polygons: [] }], 0);
    expect(flat.levels).toEqual([]);
  });
});

/**
 * #741 — THE PREDICTED V REGION STOPS AT THE BIT'S BODY TOO.
 *
 * A V-carve region's floor is grown by the flank's rise at each level above it. That rise ends
 * where the flank meets the cutter's cylindrical body: past `maxGrow = outerRadius − tipRadius`
 * the bit cuts a vertical wall, so the predicted section must stop growing. Without the cap a
 * 5.1 mm-deep pocket on the 3.175 mm chamfer was predicted 10.3 mm wider than the floor at the
 * shallow level — a mouth the bit cannot cut, which would make the verifier's own prediction the
 * thing that is wrong rather than the program.
 *
 * The level comes from a shallow GROOVE in the same report: a V region's floor alone only asks
 * the section at its own depth, where the cone's rise is zero and no cap can bind.
 */
describe('the V-region prediction stops at the bit’s body (#741)', () => {
  const square: [number, number][] = [
    [40, 40],
    [50, 40],
    [50, 50],
    [40, 50],
  ];
  const bodyR = 3.175 / 2;
  const maxGrow = bodyR - 0.05; // the chamfer's 0.1 mm tip: outer radius − tip radius
  const deep: OraclePredicted = {
    depth: 5.1,
    polygons: [square],
    itemId: 'pocket',
    vRegion: { tanHalf: 1, maxGrow },
  };
  const band = 0.1;
  const shallow = -0.5 * ORACLE_SHALLOW_DEPTH_FRACTION; // the groove's own derived level

  /** The region one entry contributes at a level: the report with it, less the report without. */
  function regionAreaAt(level: number): number {
    const withRegion = computeOracle(tl, () => null, [groove(0.5), deep], band);
    const without = computeOracle(tl, () => null, [groove(0.5)], band);
    const at = (report: { levels: { z: number; predictedArea: number }[] }, z: number): number =>
      report.levels.find((l) => Math.abs(l.z - z) < 1e-9)?.predictedArea ?? NaN;
    return at(withRegion, level) - at(without, level);
  }

  it('grows the floor by the flank’s run to the body and no further', () => {
    const cs = tl.CrossSection.ofPolygons([square]);
    const capped = cs.offset(maxGrow, 'Round', 2, segmentsForRadius(band));
    const expected = capped.area();
    cs.delete();
    capped.delete();

    expect(regionAreaAt(shallow)).toBeCloseTo(expected, 3);
  });

  it('is not the uncapped flank — which is more than twice the area', () => {
    const cs = tl.CrossSection.ofPolygons([square]);
    const unbounded = cs.offset((5.1 - 0.05) * 1, 'Round', 2, segmentsForRadius(band));
    const wide = unbounded.area();
    cs.delete();
    unbounded.delete();

    expect(wide).toBeGreaterThan(regionAreaAt(shallow) * 2);
  });
});

describe('the column engine’s slice and band (#408 items 2 and 3)', () => {
  it('reads a level off the cells cut to at or below it, at the cell’s own square', () => {
    // Four 1 mm cells; the far row was cut to −1, the near row was not cut at all. `h` is the
    // REMAINING top of each column, so a cell is gone at level `z` when its top sits at or below
    // `z` — its material is gone all the way down past the level.
    const grid = gridOf([0, 0, -1, -1]);
    const at = gridSliceAt(tl, grid);

    // Every level from the top face down to the cut cells' own floor finds those two cells removed
    // and neither of the untouched ones.
    for (const z of [-0.5, -1 + 0.001]) {
      const cut = at(z)!;
      expect(cut.area()).toBeCloseTo(2, 3); // two cells × 1 mm²
      cut.delete();
    }

    // Below every floor nothing was removed at that level, and the oracle is handed null rather
    // than an empty CrossSection, which `ofPolygons([])` refuses.
    expect(at(-1.001)).toBeNull();
    expect(at(-3)).toBeNull();
  });

  it('adds the grid’s own cell diagonal to the band, derived and never hand-set', () => {
    const grid = gridOf([0, 0, 0, 0]);
    // Half the diagonal of a cell: the furthest a cell's edge can sit from the centre that decided
    // it is inside the region.
    expect(columnBandTerm(grid)).toBeCloseTo(Math.hypot(1, 1) / 2, 12);
    expect(columnOracleBand(1000, grid)).toBeCloseTo(oracleBand(1000) + columnBandTerm(grid), 12);

    // The term is the GRID's, so a coarser grid is told the truth about itself: at #408's flat
    // resolution (0.1 mm × 0.25 mm — the rotary's 0.25° reused as millimetres) the term is 0.13 mm,
    // ten times the sweep's own band, which is why a column sweep judged at the exact band fails on
    // sampling alone.
    const old: ColumnGrid = { ...grid, du: 0.1, dv: 0.25 };
    expect(columnBandTerm(old)).toBeCloseTo(0.134629, 6);
    expect(columnBandTerm(old)).toBeGreaterThan(8 * oracleBand(1000));

    // #438: a FLAT job now takes its own Y pitch — the shop's `sim.columnFlatPitchYMm`, whose
    // labelled fallback is 0.1 mm — so its cell is 0.1 × 0.1 and the term halves to 0.071 mm.
    // Still over four times the sweep's own band at 1000 contours: the grid remains most of what is allowed.
    expect(COLUMN_FLAT_PITCH_Y_FALLBACK_MM).toBe(0.1);
    const flat: ColumnGrid = { ...grid, du: COLUMN_SIM_RESOLUTION.dx, dv: COLUMN_FLAT_PITCH_Y_FALLBACK_MM };
    expect(columnBandTerm(flat)).toBeCloseTo(Math.SQRT2 * 0.05, 9);
    expect(columnBandTerm(flat)).toBeCloseTo(0.070711, 6);
    expect(columnBandTerm(flat)).toBeGreaterThan(4 * oracleBand(1000));
  });
});

describe('the oracle refuses a V trace cut short (#408 acceptance 2)', () => {
  it('passes the CAM’s own program and refuses a truncated sweep of the same trace', () => {
    const job = traceJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();
    // The prediction is the groove, not the mouth's polygons: an entry of the trace's own depth
    // carrying the cone, with no polygon set to be repeated at every level (#408 item 1).
    expect(g.predicted).toHaveLength(1);
    expect(g.predicted[0]!.groove).toBeDefined();
    expect(g.predicted[0]!.polygons).toEqual([]);
    expect(g.predicted[0]!.depth).toBe(1);

    const good = load(job, g.nc!, bit30());
    try {
      const report = good.session.oracle(g.predicted);
      // The trace's own floor, and the derived level a tenth of the way down (#408 review 1).
      expect(report.levels.map((l) => l.z)).toEqual([-0.1, -1]);
      const mouth = report.levels[0]!;
      const level = report.levels[1]!;

      // A single trace has ONE floor, and at a trace's own floor the cone is down to its tip: the
      // predicted region is a 0.3 mm strip, whatever depth the job names. The flat column grid
      // samples the stock at 0.1 × 0.1 mm (#438: its own Y pitch, `COLUMN_FLAT_PITCH_Y_FALLBACK_MM`),
      // so it resolves that strip as THREE rows of cells — and the mask's area is the strip's to
      // within a few hundredths of a mm². Under #408's 0.1 × 0.25 mm grid it was ONE 0.25 mm row,
      // 7.5 mm² against the strip's 9.07.
      expect(level.predictedArea).toBeCloseTo(capsuleArea(30, CONE.tipRadius), 2);
      expect(level.simulatedArea).toBeCloseTo(level.predictedArea, 1);

      // The band is 0.083 mm — half a ~0.1 × 0.1 mm cell's diagonal (0.0706: the cells are refit to
      // the grid's extent, so a hair under 0.1), plus the sweep's own 0.012. So the strip that
      // survives the comparison AT THE FLOOR is ±0.067 mm about the centreline: the floor level
      // checks that the tip cut a strip of real width there. Under #408's 0.25 mm pitch the band
      // was 0.146 mm and that strip ±0.004 mm — a check of the centreline alone, the finding #438
      // was opened for. The shallow level above still asks about the shape: at 0.1 mm down the
      // same groove is 0.78 mm wide.
      expect(report.band).toBeGreaterThan(0.08);
      expect(report.band).toBeLessThan(0.085);
      expect(CONE.tipRadius - report.band).toBeGreaterThan(0.065);
      expect(mouth.predictedArea).toBeCloseTo(capsuleArea(30, grooveRadiusAt(CONE, 0.9)), 2);
      expect(mouth.simulatedArea).toBeGreaterThan(2 * level.simulatedArea);
      expect(mouth.predictedArea).toBeGreaterThan(2 * level.predictedArea);
      expect(report.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(report.worst.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(report.ok).toBe(true);
      // #580 — the column engine sweeps on a grid, so the floor is resolution-aware (cell area ×
      // 4), not the absolute sliver floor the exact sweeper uses.
      expect(report.areaFloor).toBeDefined();
      expect(report.areaFloor!).toBeGreaterThan(ORACLE_AREA_FLOOR);
    } finally {
      good.session.dispose();
    }

    // The known-bad case, and the one the step-over rule CANNOT produce: `boldStrokePasses` already
    // holds the passes inside the cut width (#191), so a coarse spine lies outside the prediction
    // and is invisible to it. What is visible — and what a truncated program, an interrupted
    // upload or a mistyped length really looks like — is a stroke the file stops half way through.
    const short = load(job, posted(job, 25), bit30());
    try {
      const report = short.session.oracle(g.predicted);
      expect(report.ok).toBe(false);
      const mouth = report.levels[0]!;
      const level = report.levels[1]!;

      // And the refusal is the SHALLOW level's, which is what makes it useful: the prediction is
      // ERODED by the band before the comparison — only what is definitely inside the plan is held
      // against the sim — so at 0.1 mm down what is left to be judged is a strip of
      // `grooveRadiusAt(cone, 0.9) − band` = 0.309 mm either side of the centreline (0.245 under
      // #408's coarser grid), or 18.5 mm² over the 30 mm stroke. A file that cut only its first
      // half leaves half of that behind.
      const reach = grooveRadiusAt(CONE, 0.9);
      const missed = 2 * (reach - report.band) * (25 - 10);
      expect(missed).toBeCloseTo(9.26, 1);
      expect(mouth.underCut).toBeGreaterThan(missed * 0.9);
      expect(mouth.underCut).toBeLessThan(missed * 1.1);

      // At the FLOOR the same file leaves `2·(tipRadius − band)·15` mm² — the ±0.067 mm strip
      // above, over the half it did not cut: about 2 mm², three orders of magnitude over the floor.
      // Under #408's 0.25 mm pitch that strip was ±0.004 mm, so the floor's share of this miss was
      // about a quarter of a mm²: the tip is now judged on a width, not a line (#438).
      const eroded = 2 * (CONE.tipRadius - report.band) * 30;
      expect(eroded).toBeGreaterThan(3.9);
      expect(eroded).toBeLessThan(4.2);
      expect(level.underCut).toBeGreaterThan(eroded * 0.4);
      expect(level.underCut).toBeLessThan(eroded * 0.6);
      // Nothing was cut outside the plan at either level, so the refusal is the under-cut's alone —
      // a band that had swallowed this would have shown up as an over-cut instead.
      expect(report.worst.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
    } finally {
      short.session.dispose();
    }
  });
});

describe('the oracle refuses a program the plan does not describe (#408 review 4)', () => {
  it('catches a trace cut 0.5 mm too deep, as an over-cut at both levels', () => {
    const job = traceJob();
    const g = generate(tl, job);
    const deep = load(job, posted(job, 40, 1.5), bit30());
    try {
      const report = deep.session.oracle(g.predicted);
      expect(report.ok).toBe(false);
      const mouth = report.levels[0]!;
      const floor = report.levels[1]!;

      // The plan's floor is z = −1 and the file cuts to −1.5, so at that level the cone still has
      // 0.5 mm of flank above it: its own cut there spans `grooveRadiusAt(cone, 0.5)` = 0.284 mm
      // either side, where the plan says the tip's 0.15. Everything the mask reaches past the
      // grown region's 0.233 mm line is material the job never asked to remove: 0.051 mm a side,
      // about 3.1 mm² over the 30 mm stroke. At 0.1 mm down the same holds one flank higher —
      // the file's cone reaches 0.525 mm (`grooveRadiusAt(cone, 1.4)`), the grown plan 0.474.
      //
      // Under #408's 0.25 mm pitch the grown line sat at 0.296 mm, BEYOND the file's own 0.284 at
      // the floor, so the over-cut there was the 0.25 mm cells stepping over the line, not the
      // extra depth. At 0.1 mm the extra width is outside the band on its own, and the mask reads
      // it to within a cell: between a quarter and twice the true excess (0.1 mm rows, so up to
      // 0.05 mm of each 0.051 mm side is quantisation).
      const fileReach = grooveRadiusAt(CONE, 0.5);
      const grownHalf = CONE.tipRadius + report.band;
      expect(fileReach).toBeCloseTo(0.2839745962, 8);
      expect(grownHalf).toBeCloseTo(0.2326, 3);
      expect(fileReach).toBeGreaterThan(grownHalf);
      const floorExcess = 2 * (fileReach - grownHalf) * 30;
      expect(floor.overCut).toBeGreaterThan(floorExcess * 0.25);
      expect(floor.overCut).toBeLessThan(floorExcess * 2);
      const mouthExcess = 2 * (grooveRadiusAt(CONE, 1.4) - (grooveRadiusAt(CONE, 0.9) + report.band)) * 30;
      expect(mouthExcess).toBeGreaterThan(2.5);
      expect(mouth.overCut).toBeGreaterThan(mouthExcess * 0.25);
      expect(mouth.overCut).toBeLessThan(mouthExcess * 2);

      // It cut everything the plan named and then some, so the disagreement is one-way: nothing is
      // under-cut. A bad program is not merely "different" — the direction says what went wrong.
      expect(report.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
    } finally {
      deep.session.dispose();
    }
  });

  it('catches a trace cut 0.1 mm to the side of the planned stroke', () => {
    const job = traceJob();
    const g = generate(tl, job);
    // The program's own Y is 20.1 where the job's trace is at 20 — ONE cell of the flat grid's
    // 0.1 mm across-stroke pitch (#438; under half a cell at #408's 0.25 mm), and only 0.017 mm
    // more than the 0.083 mm band, so it is about the smallest shift the oracle can promise to see.
    const off = load(job, posted(job, 40, 1, 20.1), bit30());
    try {
      const report = off.session.oracle(g.predicted);
      expect(report.ok).toBe(false);
      const mouth = report.levels[0]!;
      const floor = report.levels[1]!;

      // It is caught, and on both sides. The shift exceeds the band by 0.017 mm a side — about
      // 0.5 mm² over the stroke at either level — and what the mask reads of that depends on where
      // the shifted edges fall between cell centres. At the FLOOR (edges at 19.95 and 20.25) a
      // whole boundary row changes sides, so it is read as ~0.84 mm² under-cut on one side and the
      // same over-cut on the other: the tip's strip is now three rows wide, so this level judges
      // position, where under #408's single 0.25 mm row it could not. At the shallow level the
      // edges land near cell centres and the mask reads only a hundredth or so — still over the
      // floor, but it is the floor level that refuses this file now (under #408 it was the
      // shallow level). A shift inside the band remains invisible by construction: that is what
      // the band promises not to report.
      expect(floor.underCut).toBeGreaterThan(0.25);
      expect(floor.overCut).toBeGreaterThan(0.25);
      expect(mouth.underCut).toBeGreaterThan(ORACLE_AREA_FLOOR);
      expect(mouth.overCut).toBeGreaterThan(ORACLE_AREA_FLOOR);
      expect(floor.underCut).toBeGreaterThan(mouth.underCut);
      // And the plan itself is untouched: the prediction the file is judged against is the job's.
      expect(mouth.predictedArea).toBeCloseTo(capsuleArea(30, grooveRadiusAt(CONE, 0.9)), 2);
    } finally {
      off.session.dispose();
    }
  });
});

describe('the committed bench job passes the oracle in the panel (#408 acceptance 1)', () => {
  it('takes docs/bench/single-barrel.job.json through generate → simulate → check', () => {
    // The issue's first acceptance line, and the reason it exists: this job generates and
    // simulates today, but the app refuses to SAVE or UPLOAD it because the oracle had no
    // grooved-cut path. Every number below comes off the committed document, as the panel reads it.
    const raw = readFileSync(new URL('../../../docs/bench/single-barrel.job.json', import.meta.url), 'utf8');
    const parsed = parseEngraveJob(JSON.parse(raw));
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const job = parsed.job;

    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();
    // One groove entry per trace — the two strokes of the badge, both at 1 mm.
    expect(g.predicted.map((p) => p.depth)).toEqual([1, 1]);
    expect(g.predicted.every((p) => p.groove !== undefined)).toBe(true);

    const loaded = load(job, g.nc!, jobTool(job)!);
    try {
      const report = loaded.session.oracle(g.predicted);
      // Both traces are 1 mm deep, so one derived shallow level (0.1 mm) and the shared floor.
      expect(report.levels.map((l) => l.z)).toEqual([-0.1, -1]);
      expect(report.levels[0]!.predictedArea).toBeGreaterThan(2 * report.levels[1]!.predictedArea);
      // The band is the column engine's own, so it is stated rather than assumed: the sweep's term
      // plus half a ~0.1 × 0.1 mm cell's diagonal (#438; 0.148 at #408's 0.1 × 0.25 mm).
      expect(report.band).toBeGreaterThan(0.08);
      expect(report.band).toBeLessThan(0.09);
      expect(report.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(report.worst.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(report.ok).toBe(true);

      // …and the point of the whole issue: with the oracle green, Save and Upload OPEN. The view
      // is the one the store builds after a finished run, so the gates are read exactly as the
      // panel's buttons read them.
      const view: EngraveRunView = {
        generated: g,
        oracle: report,
        simDiagnostics: loaded.diagnostics,
        simStatus: 'ready',
        phase: 'ready',
        acknowledged: true,
        staleSince: null,
        error: null,
      };
      expect(saveBlocker(view)).toBeNull();
      expect(uploadBlocker(view)).toBeNull();

      // And the gate is not vacuous: this is the state the job was in BEFORE #408, when the oracle
      // threw on a V-bit live and the store could never set a report at all.
      expect(saveBlocker({ ...view, oracle: null })).toBe('the prediction has not been checked');
      expect(saveBlocker({ ...view, oracle: { ...report, ok: false } })).toBe(
        'the simulation does not match the prediction',
      );
    } finally {
      loaded.session.dispose();
    }
  });
});
