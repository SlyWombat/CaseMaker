/**
 * #221 — the run sheet's V-carve facts: the cone, the colour plane (resolved and raw), each item's
 * plane geometry, and the effective pass pitch beside the requested one.
 *
 * The sheet must not re-derive any of it. Every number asserted here is computed through the SAME
 * engine functions `buildRunSheet` imports — `vCone`, `vCarvePlane`, `vCarveStepover` and
 * `colourBoundaryDepthFor` — so a spec that passes cannot hide a second geometry beside the CAM's.
 *
 * The job is the bench's committed blank (`docs/bench/165-depth-ladder-row-A.job.json`) with the
 * 30° × 0.3 mm engraving bit and the thick fixture's print facts (3.0 mm split on 0.2 mm layers).
 * Its raw film is 0.81 mm and the print's grid resolves 0.80 mm, which is the "resolved value, raw
 * beside it" case the issue asks the sheet to state.
 */

import { describe, it, expect } from 'vitest';
import { jobVise } from '@/engine/cnc/fixture';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRunSheet,
  type RunSheet,
  type RunSheetGenerated,
} from '@/engine/cnc/engrave/runSheet';
import { dedupeFindings, jobTool, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc';
import { validateVise } from '@/engine/cnc/fixture';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { vCone } from '@/engine/cnc/vProfile';
import { DEFAULT_V_CARVE_STEPOVER_RATIO, vCarvePlane, vCarveStepover } from '@/engine/cnc/vCarveGeometry';
import { colourBoundaryDepthFor } from '@/engine/cnc/layerStack';
import type { EngraveJob } from '@/types/engraveJob';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';

const NOW = new Date('2026-10-04T00:00:00Z');
const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NC = [';@MKR|BEGIN', 'G21 G90', 'T1 M6', 'S12000', 'G1 Z-2.000 F200', 'M1', 'M2'].join('\n');

/** 15° from the axis: the bench's 30° engraving bit. */
const TAN15 = Math.tan(Math.PI / 12);

/** The sheet's own number formatter, so the assertions compare the printed spelling. */
const fmt = (n: number): string => String(Number(n.toFixed(3)));

function benchJob(): EngraveJob {
  const path = join(APP, '..', 'docs', 'bench', '165-depth-ladder-row-A.job.json');
  const parsed = parseEngraveJob(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.ok) throw new Error(`${path} should parse: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

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
 * The bench job as a V-carve: the 30° bit, and the print facts the thick fixture states. The
 * argument is the old `split` (the colour change measured from the BOTTOM); #492 stores the same
 * fact as `colour.capMm` measured from the engraved face, so the helper converts. `colour` is
 * omitted entirely (not set undefined) for the no-film case, because absence is the switch.
 */
function benchVJob(splitFromBottom?: number): EngraveJob {
  const base = benchJob();
  const colour =
    splitFromBottom === undefined
      ? undefined
      : { kind: 'printed' as const, capMm: base.stock.thickness - splitFromBottom, layerHeight: 0.2 };
  return {
    ...base,
    stock: { ...base.stock, ...(colour === undefined ? {} : { colour }) },
    toolKey: 'inv:kz-engrave-30-0-3',
    tool: bit30(),
  };
}

function stubGenerated(job: EngraveJob, extraFindings: JobFinding[] = []): RunSheetGenerated {
  const tool = jobTool(job);
  return {
    findings: [
      ...dedupeFindings([
        ...validateJob(job),
        ...validateVise(job.stock, jobVise(job), job.sacrificial),
      ]),
      ...extraFindings,
    ],
    feeds: tool ? feedsFor([], job.stock.material, tool, Z1, job.cutOverride) : null,
    cam: { operations: 6, cuttingMoves: 100, estimatedSeconds: 60, passes: 1 },
    nc: NC,
    verify: {
      ok: true,
      findings: [],
      stats: { lines: 7, cuttingMoves: 1, deepestZ: -2, bbox: { min: [0, 0, -2], max: [10, 10, 0] } },
    },
    frameNc: null,
  };
}

function sheetFor(job: EngraveJob, extraFindings: JobFinding[] = []): RunSheet {
  return buildRunSheet(job, stubGenerated(job, extraFindings), { diagnostics: [] }, NOW);
}

const section = (sheet: RunSheet, id: string) => {
  const s = sheet.sections.find((x) => x.id === id);
  expect(s, `section ${id}`).toBeTruthy();
  return s!;
};

const job = () => benchVJob(3.0);
const coneOf = (j: EngraveJob) => {
  const tool = jobTool(j);
  if (tool === null) throw new Error('the job should name its cutter');
  const cone = vCone(tool);
  if (cone === null) throw new Error('the 30° bit must have a cone');
  return cone;
};

/** The cut step for one bench item, found by the item's own name. */
function itemStep(sheet: RunSheet, name: string) {
  const steps = section(sheet, 'cut').steps;
  // The plan words a shape item as `Pocket rect "name" 5×5`, so the name is quoted rather than the
  // first thing on the line.
  const step = steps.find((s) => s.text.includes(`"${name}"`));
  expect(step, `a cut step for ${name} in ${JSON.stringify(steps.map((s) => s.text))}`).toBeTruthy();
  return step!;
}

describe('run sheet V-carve facts (#221)', () => {
  it('states the cone and the resolved colour plane, with the raw model split beside it', () => {
    const j = job();
    const sheet = sheetFor(j);
    const need = section(sheet, 'need');

    // The cutter/cone: the tip diameter, the half angle from the axis and the included angle.
    const coneStep = need.steps.find((s) => s.text.includes('V-bit’s cone'));
    expect(coneStep).toBeDefined();
    expect(coneStep!.value).toContain(`⌀ ${fmt(0.3)} mm tip`);
    expect(coneStep!.value).toContain('15° half-angle');
    expect(coneStep!.value).toContain('30° included');

    // The plane: the resolved film FIRST, the file's raw split beside it, and the layer grid.
    const planeStep = need.steps.find((s) => s.text.includes('The colour plane'));
    expect(planeStep).toBeDefined();
    const resolved = colourBoundaryDepthFor(3.81, 3.0, 0.2);
    expect(resolved).toBeCloseTo(0.8, 12);
    expect(planeStep!.text).toContain(`${fmt(resolved)} mm below the top`);
    // The raw model value the resolution moved from: thickness − split = 0.81 mm.
    expect(planeStep!.text).toContain(`file's raw 0.81 mm boundary`);
    expect(planeStep!.text).toContain('0.2 mm layers');
    expect(planeStep!.value).toBe(`colour plane ${fmt(resolved)} mm`);
  });

  it('states each item’s depth, plane radius, floor inset, surface outset and pitch', () => {
    const j = job();
    const sheet = sheetFor(j);
    const cone = coneOf(j);
    const film = colourBoundaryDepthFor(3.81, 3.0, 0.2);

    for (const depth of [0.8, 1.0, 1.6]) {
      const name = `A over pocket ${depth === 1 ? '1.0' : depth}`;
      const step = itemStep(sheet, name);
      const plane = vCarvePlane(cone, depth, film);

      // The engine's own arithmetic, not a second copy of it.
      expect(plane.planeRadius).toBeCloseTo(cone.tipRadius + Math.max(0, depth - film) * TAN15, 12);
      expect(plane.floorInset).toBeCloseTo(Math.max(0, depth - film) * TAN15, 12);
      expect(plane.surfaceOutset).toBeCloseTo(film * TAN15, 12);

      expect(step.value).toBe(
        `${fmt(depth)} mm deep · plane radius ${fmt(plane.planeRadius)} mm · ` +
          `floor inset ${fmt(plane.floorInset)} mm · surface outset ${fmt(plane.surfaceOutset)} mm`,
      );
      expect(step.text).toContain(`the floor is ${fmt(plane.floorInset)} mm inside the design each side`);
      expect(step.text).toContain(`the surface ${fmt(plane.surfaceOutset)} mm outside it`);
    }
  });

  it('prints the effective pitch beside the requested one, in the finding’s own warning words', () => {
    const j = job();
    const cone = coneOf(j);
    const film = colourBoundaryDepthFor(3.81, 3.0, 0.2);
    const plane = vCarvePlane(cone, 1.0, film);
    const stepover = vCarveStepover(plane.planeRadius, cone, DEFAULT_V_CARVE_STEPOVER_RATIO);
    expect(stepover.clamped).toBe(true);

    const step = itemStep(sheetFor(j), 'A over pocket 1.0');
    expect(step.text).toContain(
      `pass pitch ${fmt(stepover.effective)} mm at the colour plane, from the requested ` +
        `${fmt(stepover.requested)} mm`,
    );
    // The clamp is stated as the warning's fact, not as a fault and not with invented wording.
    expect(step.text).toContain(`clamped to the cutter’s ${fmt(cone.tipRadius)} mm tip radius`);
    expect(step.text).toContain('ridge of the top colour down strokes narrower than two passes apart');
  });

  it('prints requested = effective when the feeds override is under the tip radius', () => {
    const j = benchVJob(3.0);
    const gentle: EngraveJob = { ...j, cutOverride: { ...j.cutOverride, stepOver: 0.09 } };
    const cone = coneOf(gentle);
    const plane = vCarvePlane(cone, 1.0, colourBoundaryDepthFor(3.81, 3.0, 0.2));
    const stepover = vCarveStepover(plane.planeRadius, cone, 0.09 / (2 * cone.tipRadius));
    expect(stepover.clamped).toBe(false);

    const step = itemStep(sheetFor(gentle), 'A over pocket 1.0');
    expect(step.text).toContain(
      `pass pitch ${fmt(stepover.effective)} mm at the colour plane, from the requested ` +
        `${fmt(stepover.requested)} mm`,
    );
    expect(step.text).not.toContain('clamped');
  });

  it('carries the clamp finding into §8 verbatim', () => {
    const message =
      'A over pocket 1.0: pitch 0.15 mm, clamped to the cutter\'s 0.15 mm tip radius from the ' +
      'requested 0.244 mm — a wider pitch would leave a ridge of the top colour down strokes ' +
      'narrower than two passes apart.';
    const sheet = sheetFor(job(), [
      {
        severity: 'warning',
        code: 'vcarve-stepover-clamped',
        labelId: 'shp-a-1',
        message,
      },
    ]);
    const warnings = section(sheet, 'warnings');
    expect(warnings.steps.some((s) => s.text === message)).toBe(true);
  });

  it('says the plane is the floor when the job states no film', () => {
    const j = benchVJob();
    const sheet = sheetFor(j);
    const need = section(sheet, 'need');
    const planeStep = need.steps.find((s) => s.text.includes('no colour film'));
    expect(planeStep).toBeDefined();
    expect(planeStep!.value).toBe('no film — the plane is the floor');

    const cone = coneOf(j);
    const plane = vCarvePlane(cone, 1.0, null);
    expect(plane.planeRadius).toBeCloseTo(cone.tipRadius, 12);
    expect(plane.floorInset).toBe(0);
    expect(plane.surfaceOutset).toBeCloseTo(TAN15, 12);
    const step = itemStep(sheet, 'A over pocket 1.0');
    expect(step.text).toContain('with no film the colour plane is the floor');
    expect(step.value).toContain(`plane radius ${fmt(plane.planeRadius)} mm`);
    expect(step.value).toContain('floor inset 0 mm');
  });

  it('adds no V facts to a job cut by a flat end mill', () => {
    const sheet = sheetFor(benchJob());
    const all = JSON.stringify(sheet.sections);
    expect(all).not.toContain('half-angle');
    expect(all).not.toContain('colour plane');
    expect(all).not.toContain('plane radius');
    expect(all).not.toContain('pass pitch');
    // The default flat job's own wording is untouched.
    expect(all).toContain('step-over');
  });
});
