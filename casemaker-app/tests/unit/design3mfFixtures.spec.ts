/**
 * The two fixture files #221 is accepted against (#221, J14).
 *
 * The synthetic `badgeProject()` covers the reader's rules; these two files are the ACTUAL
 * maintainer's projects, so this spec pins the numbers the V-carve slices will be measured
 * against: the blank, the two-colour split, every region's shadow, and its measured floor.
 *
 * The files are fixtures now (committed under `samples/badge-blank/`), so this spec runs on
 * every checkout rather than behind an `existsSync` skip. If a file changes, the numbers here
 * must be re-measured, not adjusted to make the spec pass.
 */
import { describe, expect, it } from 'vitest';
import { jobVise } from '@/engine/cnc/fixture';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePrusaThreeMf } from '@/engine/import/prusa3mf';
import { readDesign, type DesignImport } from '@/engine/import/design3mf';
import { designJobFor } from '@/engine/cnc/engrave/fromDesign';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';
import { generate, regions } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';
import { createSimSession, type SimSession } from '@/workers/sim/session';
import { jobMachine } from '@/engine/cnc/calibration';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { ORACLE_AREA_FLOOR } from '@/engine/cnc/engrave/oracle';
import { vCone, type VCone } from '@/engine/cnc/vProfile';
import {
  DEFAULT_V_CARVE_STEPOVER_RATIO,
  cutDepthAtDistance,
  vCarvePlane,
  vCarveStepover,
} from '@/engine/cnc/vCarveGeometry';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import type { OffsetFn, Polygons } from '@/engine/cnc/cam/pocket';
import type { EngraveRegions } from '@/workers/sim/engraveGenerate';

const here = dirname(fileURLToPath(import.meta.url));
const samples = join(here, '..', '..', '..', 'samples', 'badge-blank');

function read(name: string): DesignImport {
  const buf = readFileSync(join(samples, name));
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return readDesign(tl, parsePrusaThreeMf(bytes));
}

function region(design: DesignImport, name: string) {
  const found = design.regions.find((r) => r.name === name);
  if (found === undefined) throw new Error(`the fixture has no region named "${name}"`);
  return found;
}

/** 15° from the axis: the half angle of the bench's 30° engraving bit. */
const TAN15 = Math.tan(Math.PI / 12);

/** The 30° engraving bit the bench ran: 0.3 mm tip, 3.175 mm shank, 15° half angle. */
function bit30(): Tool {
  return flatEndMill(0.3, {
    name: 'Single Flute Engraving Bit 30 x 0.3',
    typeText: 'Engraving',
    shape: 'engraving',
    handleDiameter: 3.175,
    diameter: 3.175,
    tipDiameter: 0.3,
    angle: 30,
    halfAngle: 15,
  });
}

/**
 * The bench's V-carve job for a fixture: the design's own vectors, cut by the one 30° bit, with the
 * blank 1.2 mm proud of the jaw tops.
 *
 * 1.2 mm is the bench job's value and is legal on BOTH fixtures: it is under the blank's own
 * thickness (1.5 thin, 3.81 thick), and it keeps the jaw tops (−1.2 mm) below the deepest floor
 * the fixtures cut to (0.399 thin, 0.998 thick). The thick blank's `defaultStockProud` is 0.71 —
 * shallower than the logo's 0.998 floor — so leaving it to the default would grip above the cut.
 */
function vCarveJob(design: DesignImport): EngraveJob {
  const patch = designJobFor(design);
  const base = defaultEngraveJob();
  return {
    ...base,
    name: patch.name,
    stock: { ...base.stock, ...patch.stock },
    labels: [],
    shapes: [],
    vectors: [...patch.vectors],
    keepOuts: patch.keepOut ? [patch.keepOut] : [],
    toolKey: 'inv:kz-engrave-30-0-3',
    tool: bit30(),
    workholding: {
      kind: 'vise', vise: { ...jobVise(base), stockProud: 1.2 },
    },
  };
}

/** The cone the job's bit describes, or a loud failure — no flat fallback. */
function coneOf(job: EngraveJob): VCone {
  const tool = jobTool(job);
  if (tool === null) throw new Error('the job should name its cutter');
  const cone = vCone(tool);
  if (cone === null) throw new Error('the 30° bit must have a cone');
  return cone;
}

/** Area of a polygon set, through the same kernel the plan itself went through. */
function area(polys: Polygons): number {
  const cs = tl.CrossSection.ofPolygons(polys);
  const a = cs.area();
  cs.delete();
  return a;
}

/**
 * The cone's THREE outlines (#221 slice C). The colour plane was slice A/B's; this pins the two
 * the cone derives from it:
 *
 * - the SURFACE opening, the design outset by `f·tanHalf`: one tip radius plus `f·tanHalf` from
 *   the toolpath is exactly `D·tanHalf` away, where the cone reaches the cut depth — the top face;
 * - the WALL, the span between the floor inset (`e·tanHalf`) and the surface outset (`f·tanHalf`),
 *   whose sum is the full `D·tanHalf`;
 * - and the FLOOR, a tip radius out from the toolpath.
 *
 * Each identity is read through `cutDepthAtDistance`, the same flank arithmetic the column engine
 * sweeps, so this cannot drift from the simulation by being restated in other words.
 */
function expectConeOutlines(r: EngraveRegions, cone: VCone, film: number): void {
  expect(r.cuts.length).toBeGreaterThan(0);
  for (const cut of r.cuts) {
    const label = cut.name ?? cut.id;
    const v = cut.vCarve;
    expect(v, `${label} is cut by the cone`).toBeDefined();
    if (v === undefined) continue;

    // The CAM writes the shipped plane arithmetic, not a second derivation of it.
    const plane = vCarvePlane(cone, cut.depth, film);
    expect(v.planeDepth, label).toBeCloseTo(plane.film, 12);
    expect(v.planeRadius, label).toBeCloseTo(plane.planeRadius, 12);
    expect(v.floorInset, label).toBeCloseTo(plane.floorInset, 12);
    expect(v.surfaceOutset, label).toBeCloseTo(plane.surfaceOutset, 12);
    // The wall is the whole flank: floor inset + surface outset = D·tanHalf.
    expect(v.floorInset + v.surfaceOutset, label).toBeCloseTo(cut.depth * TAN15, 12);

    // The DESIGN boundary is at the film: planeRadius from the toolpath cuts exactly e = D − f.
    expect(cut.depth - cutDepthAtDistance(cone, v.planeRadius, cut.depth), label).toBeCloseTo(film, 9);
    // The SURFACE opening is at the top face: one more `f·tanHalf` out and the cone is at D.
    expect(
      cut.depth - cutDepthAtDistance(cone, v.planeRadius + v.surfaceOutset, cut.depth),
      label,
    ).toBeCloseTo(0, 9);
    // The FLOOR is at the cut depth: a tip radius from the toolpath is uncut by the flank.
    expect(cutDepthAtDistance(cone, cone.tipRadius, cut.depth), label).toBeCloseTo(0, 12);

    // And the three regions nest, with the opening widest and the floor narrowest.
    const floorArea = area(v.floor);
    const planeArea = area(v.plane);
    const surfaceArea = area(v.surface);
    expect(planeArea, label).toBeGreaterThan(0);
    expect(surfaceArea, label).toBeGreaterThan(planeArea);
    expect(planeArea, label).toBeGreaterThan(floorArea);
    expect(floorArea, label).toBeGreaterThan(0);
  }
}

/**
 * The cone's level-set identity, as the oracle consumes it: at `depth` below the top face the
 * material the cone removes is the design offset by `(film − depth)·tanHalf`. At the film that is
 * the design itself (`delta = 0`); above it the region grows toward the surface opening, below it
 * it shrinks toward the floor.
 */
function coneLevel(
  r: EngraveRegions,
  film: number,
  depth: number,
  offset: OffsetFn,
): { depth: number; polygons: Polygons }[] {
  return r.cuts.map((cut) => {
    if (cut.vCarve === undefined) throw new Error(`${cut.name ?? cut.id} is cut by the cone`);
    const design = cut.vCarve.plane;
    const delta = (film - depth) * TAN15;
    return { depth, polygons: delta === 0 ? design : offset(design, delta) };
  });
}

/**
 * Ask the oracle about ONE level that is not a floor. `g.predicted` only carries floors, so a
 * level-specific prediction is how the surface and the wall are judged against the REAL simulated
 * column grid — the oracle's band and its area comparison, not a restatement of the arithmetic.
 */
function expectConeLevel(
  session: SimSession,
  r: EngraveRegions,
  film: number,
  depth: number,
  offset: OffsetFn,
): void {
  const report = session.oracle(coneLevel(r, film, depth, offset));
  expect(
    report.ok,
    JSON.stringify({ depth, band: report.band, worst: report.worst, levels: report.levels }),
  ).toBe(true);
  expect(report.levels).toHaveLength(1);
  expect(report.levels[0]!.z).toBeCloseTo(-depth, 9);
  expect(report.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
  expect(report.worst.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
}

describe('the thick badge fixture (single.3mf)', () => {
  const design = read('single.3mf');

  it('measures the 3.81 mm blank and its 0.81 mm top colour', () => {
    expect(design.stock.lengthX).toBeCloseTo(76.2, 2);
    expect(design.stock.widthY).toBeCloseTo(38.1, 2);
    expect(design.stock.thickness).toBeCloseTo(3.81, 2);
    expect(design.stock.zMin).toBeCloseTo(0, 2);
    expect(design.stock.zMax).toBeCloseTo(3.81, 2);
    expect(design.colourSplit).toBeCloseTo(3.0, 2);
    expect(design.layerHeight).toBeCloseTo(0.2, 2);
    expect(design.firstLayerHeight).toBeCloseTo(0.2, 2);
  });

  it('reads three cutting volumes with their own shadows and measured floors', () => {
    expect(design.regions.map((r) => r.name)).toEqual([
      '(Like the Whiskey)',
      'Single Barrel',
      'br',
    ]);

    const title = region(design, 'Single Barrel');
    expect(title.width).toBeCloseTo(66.915, 2);
    expect(title.height).toBeCloseTo(10.531, 2);
    expect(title.depth).toBeCloseTo(0.985, 3);

    const sub = region(design, '(Like the Whiskey)');
    expect(sub.width).toBeCloseTo(41.593, 2);
    expect(sub.height).toBeCloseTo(5.171, 2);
    expect(sub.depth).toBeCloseTo(0.985, 3);

    const logo = region(design, 'br');
    expect(logo.width).toBeCloseTo(21.04, 2);
    expect(logo.height).toBeCloseTo(13.773, 2);
    expect(logo.depth).toBeCloseTo(0.998, 3);
  });

  it('states PETG for both blank extruders; the PLA filaments are not blank material', () => {
    expect(design.filament).toEqual({
      types: ['PETG'],
      settingsIds: ['Generic PETG @XL'],
      material: 'petg',
      fibre: null,
    });
  });

  it('turns the blank onto the jaws and carries PETG', () => {
    const patch = designJobFor(design);
    expect(patch.stock.length).toBeCloseTo(38.1, 2);
    expect(patch.stock.width).toBeCloseTo(76.2, 2);
    expect(patch.stock.thickness).toBeCloseTo(3.81, 2);
    expect(patch.stock.material).toBe('petg');
    expect(patch.stock.colour).toMatchObject({ kind: 'printed', capMm: 0.81, layerHeight: 0.2 });
    expect(patch.vectors).toHaveLength(3);
    expect(patch.vectors.map((v) => v.name)).toEqual([
      '(Like the Whiskey)',
      'Single Barrel',
      'br',
    ]);
  });
});

describe('the thin-film fixture (thin-film/single-thin.3mf)', () => {
  const design = read(join('thin-film', 'single-thin.3mf'));

  it('measures the 1.5 mm blank and its 0.2 mm film', () => {
    expect(design.stock.lengthX).toBeCloseTo(76.0, 2);
    expect(design.stock.widthY).toBeCloseTo(25.35, 2);
    expect(design.stock.thickness).toBeCloseTo(1.5, 2);
    expect(design.stock.zMin).toBeCloseTo(0, 2);
    expect(design.stock.zMax).toBeCloseTo(1.5, 2);
    expect(design.colourSplit).toBeCloseTo(1.3, 2);
    expect(design.layerHeight).toBeCloseTo(0.2, 2);
    expect(design.firstLayerHeight).toBeCloseTo(0.2, 2);
  });

  it('reads the title, the whiskey line and the logo at the film’s measured depth', () => {
    expect(design.regions.map((r) => r.name)).toEqual([
      '(Like the Whiskey)',
      'Single Barrel',
      'br',
    ]);

    const title = region(design, 'Single Barrel');
    expect(title.width).toBeCloseTo(49.969, 2);
    expect(title.height).toBeCloseTo(7.864, 2);
    expect(title.depth).toBeCloseTo(0.394, 3);

    const sub = region(design, '(Like the Whiskey)');
    expect(sub.width).toBeCloseTo(49.969, 2);
    expect(sub.height).toBeCloseTo(6.212, 2);
    expect(sub.depth).toBeCloseTo(0.394, 3);

    const logo = region(design, 'br');
    expect(logo.width).toBeCloseTo(23.031, 2);
    expect(logo.height).toBeCloseTo(15.076, 2);
    expect(logo.depth).toBeCloseTo(0.399, 3);
  });

  it('states PETG for every blank extruder', () => {
    expect(design.filament).toEqual({
      types: ['PETG'],
      settingsIds: ['Generic PETG @XL'],
      material: 'petg',
      fibre: null,
    });
  });

  it('turns the 76 × 25.35 blank onto the jaws and carries PETG', () => {
    const patch = designJobFor(design);
    expect(patch.stock.length).toBeCloseTo(25.35, 2);
    expect(patch.stock.width).toBeCloseTo(76.0, 2);
    expect(patch.stock.thickness).toBeCloseTo(1.5, 2);
    expect(patch.stock.material).toBe('petg');
    expect(patch.stock.colour).toMatchObject({ kind: 'printed', layerHeight: 0.2 });
    expect(patch.stock.colour!.capMm).toBeCloseTo(0.2, 9);
    expect(patch.vectors).toHaveLength(3);
  });
});

/**
 * #221's first delivery target: the thin two-colour blank's WHOLE design, cut by ONE V-bit under
 * the colour-plane model. The fixture states a 0.2 mm film and item depths of 0.394/0.399 mm, so
 * the plane sits 0.194/0.199 mm above each floor and the tip radius grows by that much per side.
 */
describe('the thin fixture as a V-carve job (#221)', () => {
  const design = read(join('thin-film', 'single-thin.3mf'));

  it('reads the 0.2 mm film as the colour plane', () => {
    const r = regions(tl, vCarveJob(design));
    expect(r.colourBoundaryDepth).toBeCloseTo(0.2, 12);
  });

  it('gives every item the plane radius the manager measured: tip + e·tan(half)', () => {
    const r = regions(tl, vCarveJob(design));
    expect(r.cuts).toHaveLength(3);
    for (const cut of r.cuts) {
      expect(cut.vCarve).toBeDefined();
      const e = cut.depth - 0.2;
      expect(cut.vCarve!.planeRadius).toBeCloseTo(0.15 + e * TAN15, 9);
      expect(cut.vCarve!.floorInset).toBeCloseTo(e * TAN15, 9);
      expect(cut.vCarve!.surfaceOutset).toBeCloseTo(0.2 * TAN15, 9);
      expect(cut.vCarve!.planeDepth).toBeCloseTo(0.2, 12);
    }
    // The manager's worked numbers for the title/whiskey depths: 0.40396 mm of groove.
    const groove = (0.15 + 0.194 * TAN15) * 2;
    expect(groove).toBeCloseTo(0.40396, 5);
  });

  it('cuts the whole design with ONE V-bit and no error finding', () => {
    const job = vCarveJob(design);
    const g = generate(tl, job);
    expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.nc).not.toBeNull();
    // One tool, one program: the header states the cone, and the IR names one tool number.
    expect(g.nc).toContain('type=Engraving');
    expect(g.nc).toContain('tipdiameter=0.3');
    expect(g.nc).toContain('|angle=30|halfAngle=15');
    expect(g.nc).toContain(';@CM|TOOL|key=inv:kz-engrave-30-0-3');
    expect(g.cam!.operations).toBe(3);
  });

  // Slice D — the operator reads the pitch the CAM RUNS, with the requested number beside it, and
  // the sentence is a warning-worded note rather than a fault: the cut is correct either way.
  it('states the clamped pitch beside the requested one, per item', () => {
    const g = generate(tl, vCarveJob(design));
    expect(g.ok).toBe(true);
    const notes = g.findings.filter((f) => f.code === 'vcarve-stepover-clamped');
    expect(notes).toHaveLength(3);
    for (const note of notes) expect(note.severity).toBe('warning');
    // 0.6 × the 0.40396 mm groove at the plane = 0.242; the floor allows the 0.15 tip radius.
    const title = notes.find((f) => /requested 0\.242 mm/.test(f.message));
    expect(title).toBeDefined();
    expect(title!.message).toMatch(/pitch 0\.15 mm/);
    expect(title!.message).toMatch(/ridge of the top colour/);
  });

  it('raises no note when the override asks for less than the tip radius', () => {
    const job = vCarveJob(design);
    const gentle = { ...job, cutOverride: { ...job.cutOverride, stepOver: 0.09 } };
    const g = generate(tl, gentle);
    expect(g.ok).toBe(true);
    expect(g.findings.filter((f) => f.code === 'vcarve-stepover-clamped')).toEqual([]);
  });

  // Slice B — the program slice A writes has to survive the two halves of the run that judge it:
  // the column engine sweeps the cone at the program's constant Z, and the oracle compares the
  // material left at the FLOOR with the geometry's floor polygons (the design inset by e·tan).
  // Slice C — the cone's other two outlines are judged the same way: the colour plane and a level
  // up the wall are each an oracle level, against the same real swept grid.
  it('simulates on the column cone and the oracle accepts the floor, the plane and the wall', () => {
    const job = vCarveJob(design);
    const cone = coneOf(job);
    const r = regions(tl, job);
    const film = r.colourBoundaryDepth;
    expect(film).not.toBeNull();
    if (film === null) throw new Error('the thin fixture states a colour split');

    // The three outlines, through the cone's own depth arithmetic.
    expectConeOutlines(r, cone, film);

    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const tool = jobTool(job);
    expect(tool).not.toBeNull();
    if (g.nc === null || tool === null) throw new Error('the job should generate a program');

    const setup = toSetup(job, jobMachine(job, null));
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc, setup, tool, job.machineId);
      expect(load.ok, load.ok ? '' : JSON.stringify(load.diagnostics)).toBe(true);
      if (!load.ok) return;
      // The cone is swept by the column engine (#405); the exact sweeper would have refused it.
      expect(load.stats.engine).toBe('column');
      expect(load.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      // The program is ONE bit at constant Z: the work origin is the stock's top face, so the
      // deepest CUTTING move is the model's own D (0.394/0.399), and nothing goes below it.
      const path = session.simPath();
      let deepestCut = 0;
      for (let i = 0; i < path.kind.length; i++) {
        if (path.kind[i] === 1) deepestCut = Math.min(deepestCut, path.xyz[i * 3 + 2]!);
      }
      expect(deepestCut).toBeGreaterThan(-0.4);
      expect(deepestCut).toBeLessThan(-0.39);

      // The oracle compares the material at each FLOOR with the geometry's floor polygons — the
      // design inset by e·tan — and must find the sweep reproduced them inside the derived band.
      const oracle = session.oracle(g.predicted);
      expect(oracle.ok, JSON.stringify({ worst: oracle.worst, levels: oracle.levels })).toBe(true);
      // One level per distinct floor the plan states: the two text items at 0.394 and the logo
      // at 0.399. The floor polygons are what `predicted` carries, so there is no mouth level.
      const floors = oracle.levels.map((level) => level.z);
      expect(floors.length).toBe(2);
      expect(Math.min(...floors)).toBeCloseTo(-0.399, 3);
      expect(Math.max(...floors)).toBeCloseTo(-0.394, 3);
      expect(oracle.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(oracle.worst.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);

      // The two outlines slice B left implicit, read off the SAME simulated columns:
      // - the colour plane at d = f, where the cone's region is the design itself;
      // - a mid-wall level at d = f/2, where the region is the design outset by (f − d)·tan.
      const offset = makeClipperOffset(tl);
      expectConeLevel(session, r, film, film, offset);
      expectConeLevel(session, r, film, film / 2, offset);
    } finally {
      session.dispose();
    }
  });
});

/**
 * The thick badge fixture as the same ONE-bit job (#221 slice C). Its floor is 4.6× the thin
 * blank's, its blank 2.5×, and its two depths differ by 0.013 mm — a real second job, not a scaled
 * first one. The same cone, the same verification: engine, deepest Z, floor levels, and the
 * plane/wall levels the oracle never sees.
 */
describe('the thick fixture as a V-carve job (#221)', () => {
  const design = read('single.3mf');

  it('resolves the colour plane at 0.8 mm: the fixture’s 3.81 − 3.0 = 0.81 snaps to a layer line', () => {
    // The file's split is 3.0 mm from the blank's bottom, so the raw film is 0.81. The job reads the
    // film as a depth below the top and snaps it to the printer's layer grid (`[0, .2, .4, …]`),
    // which lands on 0.8. The plane arithmetic below uses the resolved number — the one the CAM
    // and the oracle both ran on.
    const r = regions(tl, vCarveJob(design));
    expect(r.colourBoundaryDepth).toBeCloseTo(0.8, 12);
  });

  it('is held 1.2 mm proud: legal on the blank, and the jaw tops stay below the deepest floor', () => {
    const job = vCarveJob(design);
    const setup = toSetup(job, jobMachine(job, null));
    const jaws = (setup.fixture?.boxes ?? []).filter((b) => b.id.startsWith('vise-'));
    expect(jaws.length).toBe(2);
    for (const jaw of jaws) {
      // Work origin is the stock top; the jaw tops are at −stockProud.
      expect(jaw.max[2]).toBeCloseTo(-1.2, 12);
    }
    // The logo's 0.998 floor is above the jaw tops at −1.2 (and 1.2 is under the 3.81 blank).
    const deepestFloor = Math.max(...regions(tl, job).cuts.map((c) => c.depth));
    expect(deepestFloor).toBeCloseTo(0.998, 3);
    expect(deepestFloor).toBeLessThan(1.2);
    expect(job.stock.thickness).toBeCloseTo(3.81, 2);
    expect(jobVise(job).stockProud).toBeLessThan(job.stock.thickness);
  });

  it('generates one program with the same one V-bit and no error finding', () => {
    const g = generate(tl, vCarveJob(design));
    expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.nc).not.toBeNull();
    expect(g.nc).toContain('type=Engraving');
    expect(g.nc).toContain('tipdiameter=0.3');
    expect(g.nc).toContain(';@CM|TOOL|key=inv:kz-engrave-30-0-3');
    expect(g.cam!.operations).toBe(3);
  });

  it('simulates on the column cone; the oracle accepts the two floors, the plane and the wall', () => {
    const job = vCarveJob(design);
    const cone = coneOf(job);
    const r = regions(tl, job);
    const film = r.colourBoundaryDepth;
    expect(film).not.toBeNull();
    if (film === null) throw new Error('the badge states a colour split');

    expectConeOutlines(r, cone, film);

    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const tool = jobTool(job);
    expect(tool).not.toBeNull();
    if (g.nc === null || tool === null) throw new Error('the job should generate a program');

    const setup = toSetup(job, jobMachine(job, null));
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc, setup, tool, job.machineId);
      expect(load.ok, load.ok ? '' : JSON.stringify(load.diagnostics)).toBe(true);
      if (!load.ok) return;
      expect(load.stats.engine).toBe('column');
      expect(load.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

      const path = session.simPath();
      let deepestCut = 0;
      for (let i = 0; i < path.kind.length; i++) {
        if (path.kind[i] === 1) deepestCut = Math.min(deepestCut, path.xyz[i * 3 + 2]!);
      }
      // The work origin is the stock top, so the deepest CUTTING move is the logo's own 0.998.
      expect(deepestCut).toBeGreaterThan(-1.0);
      expect(deepestCut).toBeLessThan(-0.99);

      // Two floors: the two text items at 0.985 and the logo at 0.998. They are close, so the
      // oracle's band must still separate them into two levels rather than merge them.
      const oracle = session.oracle(g.predicted);
      expect(oracle.ok, JSON.stringify({ worst: oracle.worst, levels: oracle.levels })).toBe(true);
      const floors = oracle.levels.map((level) => level.z);
      expect(floors.length).toBe(2);
      expect(Math.min(...floors)).toBeCloseTo(-0.998, 4);
      expect(Math.max(...floors)).toBeCloseTo(-0.985, 4);
      expect(oracle.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(oracle.worst.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);

      // The colour plane and a shallow wall level, on the same simulated grid. The level is 0.2 mm
      // below the top, where the region is the design outset by (0.8 − 0.2)·tan.
      const offset = makeClipperOffset(tl);
      expectConeLevel(session, r, film, film, offset);
      expectConeLevel(session, r, film, 0.2, offset);
    } finally {
      session.dispose();
    }
  });
});

/**
 * #221 slice 9 (thin half) — END-TO-END ACCEPTANCE on the thin fixture, appended as its own
 * self-contained describe because slice C's spec is a sibling commit.
 *
 * One job, the whole design, one V-bit: generate → findings → the column engine's cone → the
 * V-carve oracle at the floors. It covers the two finding cases the slice asks for in ONE run —
 * the `vcarve-surface-merge` warning the fixture's tight strokes raise, and the
 * `vcarve-stepover-clamped` note with the requested pitch beside the effective one.
 *
 * THE FILM IS READ, NOT ASSUMED. Today `single-thin.3mf` states its colour split through its print,
 * so `colourBoundaryDepth` resolves to 0.2 mm; when #492 (J19) makes it a purchased laminate with
 * an assumed 0.075 mm cap, the helper follows the source. Every relationship below is stated in
 * terms of `f`, and exactly one test pins today's 0.2 so a silent fixture move is still loud.
 */
describe('the thin fixture end to end (#221 acceptance)', () => {
  const design = read(join('thin-film', 'single-thin.3mf'));

  /** 15° from the axis: the half angle of the bench's 30° engraving bit. */
  const TAN15 = Math.tan(Math.PI / 12);

  /** The finding messages' own formatter (`Math.round(v·1000)/1000`). */
  const mm = (v: number): string => String(Math.round(v * 1000) / 1000);

  /** The 30° engraving bit the bench ran: 0.3 mm tip, 3.175 mm shank, 15° half angle. */
  function bit30(): Tool {
    return flatEndMill(0.3, {
      name: 'Single Flute Engraving Bit 30 x 0.3',
      typeText: 'Engraving',
      shape: 'engraving',
      handleDiameter: 3.175,
      diameter: 3.175,
      tipDiameter: 0.3,
      angle: 30,
      halfAngle: 15,
    });
  }

  /** The bench's one-bit job for the fixture (1.2 mm proud; legal on the 1.5 mm blank). */
  function thinJob(): EngraveJob {
    const patch = designJobFor(design);
    const base = defaultEngraveJob();
    return {
      ...base,
      name: patch.name,
      stock: { ...base.stock, ...patch.stock },
      labels: [],
      shapes: [],
      vectors: [...patch.vectors],
      keepOuts: patch.keepOut ? [patch.keepOut] : [],
      toolKey: 'inv:kz-engrave-30-0-3',
      tool: bit30(),
      workholding: {
        kind: 'vise', vise: { ...jobVise(base), stockProud: 1.2 },
      },
    };
  }

  /** The cone the job's bit describes, or a loud failure — no flat fallback. */
  function coneOf(job: EngraveJob): VCone {
    const tool = jobTool(job);
    if (tool === null) throw new Error('the job should name its cutter');
    const cone = vCone(tool);
    if (cone === null) throw new Error('the 30° bit must have a cone');
    return cone;
  }

  /**
   * The film the pipeline actually resolved for this job, mm — the source the expectations use.
   * It is the colour boundary the PRINT has, so it follows the print split today and the laminate
   * assumption when #492 lands; only the pinned test below states a number.
   */
  function filmFrom(r: EngraveRegions): number {
    const film = r.colourBoundaryDepth;
    if (film === null) throw new Error('the thin fixture states a colour split');
    return film;
  }

  /** Area of a polygon set, through the same kernel the plan itself went through. */
  function area(polys: Polygons): number {
    const cs = tl.CrossSection.ofPolygons(polys);
    const a = cs.area();
    cs.delete();
    return a;
  }

  /**
   * The cone's level-set identity as the oracle consumes it: at `depth` below the top face the
   * material the cone removes is the design offset by `(film − depth)·tanHalf`. At the film that is
   * the design itself; above it the region grows toward the surface opening, below it shrinks
   * toward the floor.
   */
  function coneLevels(
    r: EngraveRegions,
    film: number,
    depth: number,
    offset: OffsetFn,
  ): { depth: number; polygons: Polygons }[] {
    return r.cuts.map((cut) => {
      if (cut.vCarve === undefined) throw new Error(`${cut.name ?? cut.id} is cut by the cone`);
      const delta = (film - depth) * TAN15;
      return { depth, polygons: delta === 0 ? cut.vCarve.plane : offset(cut.vCarve.plane, delta) };
    });
  }

  /** Ask the oracle about ONE level that is not a floor, and require it inside the area floor. */
  function expectLevel(session: SimSession, r: EngraveRegions, film: number, depth: number, offset: OffsetFn): void {
    const report = session.oracle(coneLevels(r, film, depth, offset));
    expect(
      report.ok,
      JSON.stringify({ depth, band: report.band, worst: report.worst, levels: report.levels }),
    ).toBe(true);
    expect(report.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
    expect(report.worst.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
  }

  // The ONE pinned film. If this fails, the fixture (or #492's laminate source) moved and every
  // relationship below must be re-read against the new material — do not adjust it to pass.
  it('pins today’s film at 0.2 mm, read from the plan rather than assumed by the assertions', () => {
    const r = regions(tl, thinJob());
    expect(filmFrom(r)).toBeCloseTo(0.2, 12);
  });

  it('states planeRadius, the floor and the surface as functions of the film it read', () => {
    const job = thinJob();
    const r = regions(tl, job);
    const film = filmFrom(r);
    const cone = coneOf(job);
    const offset = makeClipperOffset(tl);
    expect(r.cuts).toHaveLength(3);

    for (const cut of r.cuts) {
      const v = cut.vCarve;
      expect(v, `${cut.name ?? cut.id} is cut by the cone`).toBeDefined();
      if (v === undefined) continue;
      const label = cut.name ?? cut.id;
      const e = cut.depth - film;

      // The CAM's offset IS the colour-plane model, not a second derivation of it.
      const plane = vCarvePlane(cone, cut.depth, film);
      expect(v.planeDepth, label).toBeCloseTo(plane.film, 12);
      expect(v.planeRadius, label).toBeCloseTo(plane.planeRadius, 12);

      // planeRadius = tipRadius + (D − f)·tanHalf.
      expect(v.planeRadius, label).toBeCloseTo(cone.tipRadius + e * TAN15, 9);
      // The floor is (D − f)·tanHalf narrower per side than the design.
      expect(v.floorInset, label).toBeCloseTo(e * TAN15, 9);
      // The surface opening is the design outset by f·tanHalf per side.
      expect(v.surfaceOutset, label).toBeCloseTo(film * TAN15, 9);
      // Floor to surface is the whole cone: (D − f) + f = D.
      expect(v.floorInset + v.surfaceOutset, label).toBeCloseTo(cut.depth * TAN15, 9);

      // The same identities through the flank arithmetic the column engine sweeps: at rPlane the
      // cone is exactly f below the top; one surface outset further out it reaches the top face;
      // and a tip radius from the toolpath is uncut.
      expect(cut.depth - cutDepthAtDistance(cone, v.planeRadius, cut.depth), label).toBeCloseTo(film, 9);
      expect(
        cut.depth - cutDepthAtDistance(cone, v.planeRadius + v.surfaceOutset, cut.depth),
        label,
      ).toBeCloseTo(0, 9);
      expect(cutDepthAtDistance(cone, cone.tipRadius, cut.depth), label).toBeCloseTo(0, 12);

      // And the drawn outlines are those offset constructions of the design. The SURFACE is the
      // design outset; the FLOOR is the CAM’s own reach (#584) — the first ring, the design eroded
      // by the PLANE radius, swept by the tip disc. It agrees with the `floorInset` erosion along a
      // straight wall and lies strictly inside it at a convex corner, which no ring can reach.
      expect(area(v.surface), label).toBeCloseTo(area(offset(v.plane, film * TAN15)), 6);
      expect(area(v.floor), label).toBeCloseTo(
        area(offset(offset(v.plane, -v.planeRadius), cone.tipRadius)),
        6,
      );
      expect(area(v.surface), label).toBeGreaterThan(area(v.plane));
      expect(area(v.plane), label).toBeGreaterThan(area(v.floor));
    }
  });

  // The two finding cases, in ONE generated job. Both are warnings: the colour line at the plane
  // is still correct, so neither refuses the cut.
  it('raises the surface-merge warning and the clamped-pitch note, with both pitches stated', () => {
    const job = thinJob();
    const r = regions(tl, job);
    const film = filmFrom(r);
    const cone = coneOf(job);
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);

    const merges = g.findings.filter((f) => f.code === 'vcarve-surface-merge');
    expect(merges.length).toBeGreaterThan(0);
    for (const merge of merges) expect(merge.severity).toBe('warning');
    // The item the manager named to watch: "(Like the Whiskey)" at 6.2 mm cap height.
    const sub = r.cuts.find((c) => c.name?.includes('(Like the Whiskey)'));
    expect(sub).toBeDefined();
    const subMerge = merges.find((m) => m.labelId === sub!.id);
    expect(subMerge).toBeDefined();
    // The threshold is the surface wall offset from f: 2 × f·tanHalf, not a hard-coded 0.107.
    expect(subMerge!.message).toContain(`closer than ${mm(2 * film * TAN15)} mm`);
    expect(subMerge!.message).toContain(`2 × the ${mm(film * TAN15)} mm surface wall offset`);
    expect(subMerge!.message).toContain('ridge of the top colour');

    const notes = g.findings.filter((f) => f.code === 'vcarve-stepover-clamped');
    expect(notes).toHaveLength(3);
    for (const note of notes) {
      expect(note.severity).toBe('warning');
      const cut = r.cuts.find((c) => c.id === note.labelId);
      expect(cut).toBeDefined();
      const planeRadius = cut!.vCarve!.planeRadius;
      // The request is the seed × the groove width at the plane; the floor allows the tip radius.
      const step = vCarveStepover(planeRadius, cone, DEFAULT_V_CARVE_STEPOVER_RATIO);
      expect(step.requested).toBeCloseTo(DEFAULT_V_CARVE_STEPOVER_RATIO * 2 * planeRadius, 9);
      expect(step.clamped).toBe(true);
      // "Beside the requested one": the same note carries the effective pitch AND the request.
      expect(note.message).toContain(`pitch ${mm(step.effective)} mm`);
      expect(note.message).toContain(`requested ${mm(step.requested)} mm`);
    }
  });

  it('sweeps the program on the column cone and the oracle accepts every floor', () => {
    const job = thinJob();
    const r = regions(tl, job);
    const film = filmFrom(r);
    const g = generate(tl, job);
    expect(g.ok).toBe(true);

    const tool = jobTool(job);
    expect(tool).not.toBeNull();
    if (g.nc === null || tool === null) throw new Error('the job should generate a program');

    const setup = toSetup(job, jobMachine(job, null));
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc, setup, tool, job.machineId);
      expect(load.ok, load.ok ? '' : JSON.stringify(load.diagnostics)).toBe(true);
      if (!load.ok) return;
      expect(load.stats.engine).toBe('column');
      expect(load.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

      // The work origin is the stock's top face. The deepest CUTTING move is the deepest stated
      // item depth and nothing goes below it: D is the floor by construction.
      const deepestFloor = Math.max(...r.cuts.map((cut) => cut.depth));
      const path = session.simPath();
      let deepestCut = 0;
      for (let i = 0; i < path.kind.length; i++) {
        if (path.kind[i] === 1) deepestCut = Math.min(deepestCut, path.xyz[i * 3 + 2]!);
      }
      expect(deepestCut).toBeCloseTo(-deepestFloor, 4);

      // Floor levels: one per distinct item depth (0.394 text, 0.399 logo today), all accepted.
      const oracle = session.oracle(g.predicted);
      expect(oracle.ok, JSON.stringify({ worst: oracle.worst, levels: oracle.levels })).toBe(true);
      const distinctFloors = new Set(r.cuts.map((cut) => cut.depth));
      expect(oracle.levels).toHaveLength(distinctFloors.size);
      for (const depth of distinctFloors) {
        expect(
          oracle.levels.some((level) => Math.abs(-level.z - depth) < 1e-5),
          `a floor at ${depth} mm`,
        ).toBe(true);
      }
      expect(oracle.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(oracle.worst.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);

      // The colour plane itself (depth = f is the design) and a mid-wall level, on the same grid.
      const offset = makeClipperOffset(tl);
      expectLevel(session, r, film, film, offset);
      expectLevel(session, r, film, film / 2, offset);
    } finally {
      session.dispose();
    }
  });
});

/**
 * #221 slice 9 (thick half) — ACCEPTANCE GATES on `single.3mf`, appended self-contained beside
 * slice C's sibling describe.
 *
 * A later edit to the fixture must fail here rather than silently move the numbers the slice was
 * accepted on: the model's 3.81 mm and split 3.0 (raw film 0.81) print as 19 × 0.2 = 3.80 mm with
 * the colour change at layer 15 (film 0.80); the floors are 0.985/0.985/0.998; the column engine
 * sweeps the cone and the oracle accepts both floors with zero under- and over-cut.
 */
describe('the thick fixture acceptance gates (#221)', () => {
  const design = read('single.3mf');
  const TAN15 = Math.tan(Math.PI / 12);

  function bit30(): Tool {
    return flatEndMill(0.3, {
      name: 'Single Flute Engraving Bit 30 x 0.3',
      typeText: 'Engraving',
      shape: 'engraving',
      handleDiameter: 3.175,
      diameter: 3.175,
      tipDiameter: 0.3,
      angle: 30,
      halfAngle: 15,
    });
  }

  /** The bench's one-bit job; 1.2 mm proud, the value the thick acceptance ran with. */
  function thickJob(): EngraveJob {
    const patch = designJobFor(design);
    const base = defaultEngraveJob();
    return {
      ...base,
      name: patch.name,
      stock: { ...base.stock, ...patch.stock },
      labels: [],
      shapes: [],
      vectors: [...patch.vectors],
      keepOuts: patch.keepOut ? [patch.keepOut] : [],
      toolKey: 'inv:kz-engrave-30-0-3',
      tool: bit30(),
      workholding: {
        kind: 'vise', vise: { ...jobVise(base), stockProud: 1.2 },
      },
    };
  }

  function coneOf(job: EngraveJob): VCone {
    const tool = jobTool(job);
    if (tool === null) throw new Error('the job should name its cutter');
    const cone = vCone(tool);
    if (cone === null) throw new Error('the 30° bit must have a cone');
    return cone;
  }

  function area(polys: Polygons): number {
    const cs = tl.CrossSection.ofPolygons(polys);
    const a = cs.area();
    cs.delete();
    return a;
  }

  function coneLevels(
    r: EngraveRegions,
    film: number,
    depth: number,
    offset: OffsetFn,
  ): { depth: number; polygons: Polygons }[] {
    return r.cuts.map((cut) => {
      if (cut.vCarve === undefined) throw new Error(`${cut.name ?? cut.id} is cut by the cone`);
      const delta = (film - depth) * TAN15;
      return { depth, polygons: delta === 0 ? cut.vCarve.plane : offset(cut.vCarve.plane, delta) };
    });
  }

  function expectLevel(session: SimSession, r: EngraveRegions, film: number, depth: number, offset: OffsetFn): void {
    const report = session.oracle(coneLevels(r, film, depth, offset));
    expect(
      report.ok,
      JSON.stringify({ depth, band: report.band, worst: report.worst, levels: report.levels }),
    ).toBe(true);
    expect(report.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
    expect(report.worst.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
  }

  it('pins the PRINTED film: 19 × 0.2 mm layers, colour change at layer 15, 0.80 mm', () => {
    // The model's raw subtraction is 3.81 − 3.0 = 0.81, but the printed part is layer-quantised:
    // 19 layers of 0.2 = 3.80 mm, with the colour change at layer 15. 0.80 is the material; the
    // 0.01 is the model's arithmetic and never existed. No finding is raised for the difference.
    const layerHeight = design.layerHeight;
    const colourSplit = design.colourSplit;
    expect(layerHeight, 'the fixture states its print grid').not.toBeNull();
    expect(colourSplit, 'the fixture states its colour split').not.toBeNull();
    if (layerHeight === null || colourSplit === null) throw new Error('the fixture states its print');
    const layers = Math.round(design.stock.thickness / layerHeight);
    const splitAtLayer = Math.round(colourSplit / layerHeight);
    expect(layers).toBe(19);
    expect(splitAtLayer).toBe(15);
    const printedFilm = (layers - splitAtLayer) * layerHeight;
    expect(printedFilm).toBeCloseTo(0.8, 12);
    const rawModelFilm = design.stock.thickness - colourSplit;
    expect(rawModelFilm).toBeCloseTo(0.81, 6);
    expect(rawModelFilm - printedFilm).toBeCloseTo(0.01, 6);

    const r = regions(tl, thickJob());
    expect(r.colourBoundaryDepth).toBeCloseTo(printedFilm, 12);

    // The three measured floors the acceptance used.
    expect(region(design, 'Single Barrel').depth).toBeCloseTo(0.985, 3);
    expect(region(design, '(Like the Whiskey)').depth).toBeCloseTo(0.985, 3);
    expect(region(design, 'br').depth).toBeCloseTo(0.998, 3);
  });

  it('holds the blank 1.2 mm proud so the jaw tops stay below the 0.998 floor', () => {
    const job = thickJob();
    const setup = toSetup(job, jobMachine(job, null));
    const jaws = (setup.fixture?.boxes ?? []).filter((b) => b.id.startsWith('vise-'));
    expect(jaws.length).toBe(2);
    for (const jaw of jaws) {
      // Work origin is the stock top; the jaw tops are at −stockProud.
      expect(jaw.max[2]).toBeCloseTo(-1.2, 12);
    }
    // The default 0.71 would grip ABOVE the logo's 0.998 floor; 1.2 is also under the 3.81 blank.
    const deepestFloor = Math.max(...regions(tl, job).cuts.map((cut) => cut.depth));
    expect(deepestFloor).toBeCloseTo(0.998, 3);
    expect(deepestFloor).toBeLessThan(1.2);
    expect(jobVise(job).stockProud).toBeLessThan(job.stock.thickness);
  });

  it('generates one program with the same one V-bit and no error finding', () => {
    const g = generate(tl, thickJob());
    expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.nc).not.toBeNull();
    expect(g.nc).toContain('type=Engraving');
    expect(g.nc).toContain('tipdiameter=0.3');
    expect(g.nc).toContain(';@CM|TOOL|key=inv:kz-engrave-30-0-3');
    expect(g.cam!.operations).toBe(3);
  });

  it('sweeps the cone and the oracle accepts both floors with zero under- and over-cut', () => {
    const job = thickJob();
    const cone = coneOf(job);
    const r = regions(tl, job);
    const film = r.colourBoundaryDepth;
    expect(film).not.toBeNull();
    if (film === null) throw new Error('the badge states a colour split');
    expect(film).toBeCloseTo(0.8, 12);

    // The plane arithmetic and the outlines the accepted run drew.
    for (const cut of r.cuts) {
      const v = cut.vCarve;
      expect(v).toBeDefined();
      if (v === undefined) continue;
      const plane = vCarvePlane(cone, cut.depth, film);
      expect(v.planeRadius).toBeCloseTo(plane.planeRadius, 12);
      expect(v.floorInset).toBeCloseTo(plane.floorInset, 12);
      expect(v.surfaceOutset).toBeCloseTo(plane.surfaceOutset, 12);
      expect(v.floorInset + v.surfaceOutset).toBeCloseTo(cut.depth * TAN15, 9);
      expect(area(v.surface)).toBeGreaterThan(area(v.plane));
      expect(area(v.plane)).toBeGreaterThan(area(v.floor));
    }

    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const tool = jobTool(job);
    expect(tool).not.toBeNull();
    if (g.nc === null || tool === null) throw new Error('the job should generate a program');

    const setup = toSetup(job, jobMachine(job, null));
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc, setup, tool, job.machineId);
      expect(load.ok, load.ok ? '' : JSON.stringify(load.diagnostics)).toBe(true);
      if (!load.ok) return;
      expect(load.stats.engine).toBe('column');
      expect(load.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

      // Work origin is the stock top; the deepest cutting move is the logo's own 0.998.
      const path = session.simPath();
      let deepestCut = 0;
      for (let i = 0; i < path.kind.length; i++) {
        if (path.kind[i] === 1) deepestCut = Math.min(deepestCut, path.xyz[i * 3 + 2]!);
      }
      expect(deepestCut).toBeCloseTo(-0.998, 4);

      // Two floors (0.985 text, 0.998 logo), the accepted band, and NO under- or over-cut.
      const oracle = session.oracle(g.predicted);
      expect(oracle.ok, JSON.stringify({ worst: oracle.worst, levels: oracle.levels })).toBe(true);
      expect(oracle.band).toBeCloseTo(0.090622, 6);
      expect(oracle.levels).toHaveLength(2);
      expect(oracle.worst.underCut).toBe(0);
      expect(oracle.worst.overCut).toBe(0);

      const text = oracle.levels.find((level) => Math.abs(-level.z - 0.985) < 1e-6);
      const logo = oracle.levels.find((level) => Math.abs(-level.z - 0.998) < 1e-6);
      expect(text, 'the 0.985 floor').toBeDefined();
      expect(logo, 'the 0.998 floor').toBeDefined();
      // The areas the slice was accepted on — a fixture edit that moves the glyphs moves these.
      // #584 moved `predictedArea` only: the floor is the CAM’s reach, which rounds off each
      // convex corner the first ring cannot enter (≈0.07% of the glyph area); the simulation and
      // its tolerance are untouched.
      // #669 — the TEXT level's prediction now carries the LOGO region's section at that level,
      // grown by the cone as it rises above the logo's 0.998 floor (`OraclePredicted.vRegion`,
      // (0.998 − 0.985)·tan 15° ≈ 0.0035 mm of outset around every glyph). The old 365.21 was the
      // logo's FLOOR area, 0.51 mm² narrower than the mouth the simulation really removes; the
      // z = −0.998 level itself is unchanged (its own floor, no growth). Both floors still check
      // with ZERO under- and over-cut (asserted above), which is the point of the growth.
      expect(text!.predictedArea).toBeCloseTo(365.72, 2);
      expect(text!.simulatedArea).toBeCloseTo(365.73, 2);
      expect(logo!.predictedArea).toBeCloseTo(78.07, 2);
      expect(logo!.simulatedArea).toBeCloseTo(78.16, 2);

      // The colour plane (d = 0.8) and a shallow wall level (d = 0.2) on the same simulated grid.
      const offset = makeClipperOffset(tl);
      expectLevel(session, r, film, film, offset);
      expectLevel(session, r, film, 0.2, offset);
    } finally {
      session.dispose();
    }
  });
});
