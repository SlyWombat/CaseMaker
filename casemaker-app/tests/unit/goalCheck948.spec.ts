/**
 * #948 — THE GOAL CHECK IN THE APP'S OWN REPORT.
 *
 * The oracle's `goalCutInto` is the swept surface compared with the GOAL (#924's 3D half, the
 * port of the bench's `goal_check.py`), and until #948 nothing in the app handed it a swept top:
 * `session.oracle` accepted `{heightfield, sweptTop}` but every caller passed nothing, so the
 * field was dead code in the app and only the bench's page measured it.
 *
 * These tests pin the wiring, not the geometry: the live session exposes its own top, the worker
 * samples the goal at the page's checker's grid (0.1 mm, `tools/goal-hf.mts`), a rotary or exact
 * sweep is STATED unchecked rather than silently passed, a corpus program's report carries the
 * same numbers a direct call to `checkGoalCutInto` produces from the same two halves, and a
 * deliberately gouged program does not pass.
 *
 * The leftover bands and the pass line are read with the PAGE's own point rule (`sweptTopExact`,
 * `sweptPoint.ts`): the cutter stamped along the posted program at each goal cell's centre, which
 * reproduces `goal_check.py`'s coverage on the same program (relief 99.32 %, figure@j29 48.64 %)
 * while cut-into stays on the conservative column read.
 *
 * The relief case's zero cut-into is not this spec's invention: the bench's own `goal_check.py`,
 * run on the same posted program and the same 0.1 mm heightfield, reports 0.00 % cut-into / max
 * 0.000 mm too. The swept top is read as the HIGHEST column touching the goal cell (see
 * `session.sweptTop`): the two grids' origins are half a cell apart, so a nearest-column read
 * splits on float noise and a bilinear one smears walls — both invent cut-into the page does not
 * see. The cost of the conservative read is on the LEFTOVER side (the app reports more material
 * standing than the page's exact-point stamp), never on the verdict.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { goalCheckForProgram, type SimGoalCheck } from '@/engine/cnc/engrave/goalCheckInput';
import { checkGoalCutInto, goalCutIntoUnchecked } from '@/engine/cnc/engrave/designCheck';
import { sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/cam/surface3d';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import { Z1 } from '@/engine/cnc/machine';
import type { Tool } from '@/engine/cnc/tool';
import { createSimSession, type SimSession } from '@/workers/sim/session';
import { clearGoalFieldCache, goalInputFor, GOAL_CHECK_MAX_CELLS, GOAL_CHECK_PITCH_MM } from '@/workers/sim/goalCheckField';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => {
  clearTargetObjectMeshCache();
  clearGoalFieldCache();
});

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

async function read(name: string): Promise<Extract<Awaited<ReturnType<typeof readTargetObjectFile>>, { ok: true }>> {
  const bytes = readFileSync(here(name));
  const result = await readTargetObjectFile(new File([bytes], name), `goal-${name}`);
  if (!result.ok) throw new Error(`${name}: ${result.error}`);
  return result;
}

/** The goal object the picker builds, with `position` on the blank's centre. */
function targetOf(
  read: Extract<Awaited<ReturnType<typeof readTargetObjectFile>>, { ok: true }>,
  stock: { length: number; width: number },
): EngraveTargetObject {
  return {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    position: { x: stock.length / 2, y: stock.width / 2, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function goalJob(target: EngraveTargetObject, stock: { length: number; width: number; thickness: number }): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: target.name,
    labels: [],
    shapes: [],
    drills: [],
    stock: { ...stock, material: 'softwood' },
    toolKey: 'flat-1.0',
    targetObject: target,
  };
}

describe('#948 the goal check’s plain input', () => {
  it('states a multi-side goal unchecked rather than comparing the wrong frame', async () => {
    const imported = await read('relief-plate.stl');
    const target = targetOf(imported, { length: 80, width: 50 });
    const job = goalJob(target, { length: 80, width: 50, thickness: 20 });
    // A job that states setups takes the multi-side path (`pureGoalObject` answers null there).
    const sided: EngraveJob = {
      ...job,
      setups: [
        {
          id: 'setup-1',
          orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
          mount: { kind: 'vise' },
          itemIds: [],
          tools: [job.toolKey],
        },
      ],
    };
    const check = goalCheckForProgram(sided, true);
    expect(check).toBeDefined();
    expect(check && 'unchecked' in check).toBe(true);
    expect(check && 'unchecked' in check ? check.unchecked : '').toContain('more than one side');

    // A pure goal job hands its object across, field for field — no handle, plain data.
    const pure = goalCheckForProgram(job, true);
    expect(pure && 'target' in pure).toBe(true);
    if (pure && 'target' in pure) {
      expect(pure.target.sha256).toBe(target.sha256);
      expect(pure.target.data).toBe(target.data);
      expect(pure.target.position).toEqual(target.position);
    }

    // A program that is not a goal program has no goal to compare with.
    expect(goalCheckForProgram(job, false)).toBeUndefined();
  });

  it('reads a goal with no flat swept top as unchecked, in the report’s own words', () => {
    const live = { sweptTop: () => null } as unknown as SimSession;
    const check = goalCheckForProgram(
      goalJob(
        { id: 'x', name: 'x.stl', sha256: 'x', format: 'stl', size: { x: 1, y: 1, z: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: 0, enabled: true, role: 'goal' },
        { length: 10, width: 10, thickness: 5 },
      ),
      true,
    );
    expect(check && 'target' in check).toBe(true);
    const input = goalInputFor(live, check as SimGoalCheck);
    expect('unchecked' in input).toBe(true);
    if ('unchecked' in input) {
      expect(input.unchecked).toContain('no flat top');
      const report = goalCutIntoUnchecked(input.unchecked);
      expect(report.ran).toBe(false);
      expect(report.ok).toBe(true); // never a failure — a stated gap
      expect(report.maxCutIntoAt).toBeNull();
      expect(report.passCoverage).toBe(0.95);
      expect(report.sentence).toContain('not a pass');
    }
  });

  it('reads a target whose bytes are gone as unchecked too', () => {
    const live = { sweptTop: () => () => 0 } as unknown as SimSession;
    const input = goalInputFor(live, {
      target: {
        sha256: 'gone',
        format: 'stl',
        size: { x: 1, y: 1, z: 1 },
        position: { x: 0, y: 0, z: 0 },
        rotation: 0,
      },
    });
    expect('unchecked' in input).toBe(true);
    if ('unchecked' in input) expect(input.unchecked).toContain('could not be sampled');
  });
});

describe('#948 the pass line — zero cut-into is not the whole verdict', () => {
  /** A flat goal field where `1 − coverage` of the cells sit 0.5 above the swept top. */
  function fieldWithCoverage(n: number, coverage: number): GoalHeightfield {
    const z = new Float32Array(n * n).fill(-2);
    const above = Math.round(n * n * (1 - coverage));
    // The goal is DEEPER than the swept top on those cells: material stands 0.5 above the goal.
    for (let k = 0; k < above; k++) z[k] = -2.5;
    return {
      nx: n,
      ny: n,
      x0: 0,
      y0: 0,
      pitch: 0.5,
      topZ: 0,
      minZ: -2,
      z,
      covered: new Uint8Array(n * n).fill(1),
      coveredCount: n * n,
      resolutionNote: '0.5 mm grid',
    };
  }

  it('0 cut-into and 83.58 % coverage is NOT a pass, and the sentence says the coverage', () => {
    // The demo page's j29 elephant card: 0 cut-into, 83.58 % top-surface coverage (its rule asks
    // 95 %), which the page reads as Deviates while `ok` used to read it as a pass.
    const report = checkGoalCutInto(fieldWithCoverage(100, 0.8358), () => -2);
    expect(report.cutIntoFraction).toBe(0);
    expect(report.passCoverage).toBe(0.95);
    expect(report.ok).toBe(false);
    expect(report.sentence).toContain('coverage');
    expect(report.sentence).toContain('83.58');
    expect(report.sentence).toContain('95');
  });

  it('full coverage at the goal still passes', () => {
    const report = checkGoalCutInto(fieldWithCoverage(10, 1), () => -2);
    expect(report.ok).toBe(true);
    expect(report.passCoverage).toBe(0.95);
  });

  it('the pass line is the caller’s number, not a constant in the check', () => {
    const goal = fieldWithCoverage(100, 0.8358);
    expect(checkGoalCutInto(goal, () => -2, { passCoverage: 0.8 }).ok).toBe(true);
    expect(checkGoalCutInto(goal, () => -2, { passCoverage: 0.9 }).ok).toBe(false);
  });
});

describe('#948 the elephant corpus run — zero cut-into is not a pass', () => {
  it('figure@j29 reads ok:false on coverage, and the sentence names it', async () => {
    // The demo page's elephant stick job: a 0.6533-scaled figure laid on a 36 × 100 × 36 stick and
    // surfaced by Makera's 2 mm ball. The page's own checker reported 0 cut-into with coverage
    // well under its 95 % line — the case that read "Matches" in the app and "Deviates" on the page.
    const stock = { length: 36, width: 100, thickness: 36 };
    const imported = await read('figure.stl');
    const target: EngraveTargetObject = {
      id: imported.id,
      name: imported.name,
      format: imported.format,
      sha256: imported.sha256,
      data: imported.data,
      size: imported.size,
      position: { x: stock.length / 2, y: 50, z: 0 },
      rotation: 90,
      enabled: true,
      role: 'goal',
      scale: { x: 0.6533, y: 0.6533, z: 0.6533 },
    };
    const ballTool: Tool = {
      number: 1,
      id: '161032205031',
      name: '6*2*30.5mm Ball Nose Engraving',
      typeText: 'Ball Nose Engraving',
      shape: 'ball',
      handleDiameter: 6,
      tipDiameter: 2,
      diameter: 6,
      cornerRadius: 1,
      angle: null,
      halfAngle: null,
      fluteLength: 30.5,
      shoulderLength: 30.5,
      stickout: null,
      centreCutting: null,
    };
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      name: target.name,
      labels: [],
      shapes: [],
      drills: [],
      stock: { ...stock, material: 'hardwood' },
      toolKey: 'user:945-ball-30-5',
      tool: ballTool,
      targetObject: target,
    };
    const g = await generate(tl, job);
    expect(g.ok, g.errors.map((e) => e.message).join('; ')).toBe(true);
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), ballTool, Z1.id);
      expect(load.ok).toBe(true);
      const report = session.oracle(g.predicted, null, g.designItems, goalInputFor(session, goalCheckForProgram(job, true) as SimGoalCheck));
      expect(report.goalCutInto?.ran).toBe(true);
      // Nothing is cut INTO the goal; the run fails the pass line because too much of the goal's
      // top surface is never reached from this side.
      expect(report.goalCutInto?.cutIntoFraction).toBe(0);
      expect(report.goalCutInto?.passCoverage).toBe(0.95);
      expect(report.goalCutInto?.leftoverFractions[0]).toBeGreaterThan(0.05);
      expect(report.goalCutInto?.ok).toBe(false);
      expect(report.goalCutInto?.sentence).toContain('coverage');
      expect(report.goalCutInto?.sentence).toContain('95');
      expect(report.ok).toBe(false);
      // #948 — THE COVERAGE IS THE PAGE'S OWN READ, cell for cell. `goal_check.py` stamps the
      // cutter along this posted program at each goal cell's centre: 11744 of 22865 cells are more
      // than 0.1 mm above the goal (0.5136234419418325, i.e. 48.64 % coverage). The column grid's
      // max-of-four read gave 30.71 % — 18 points away — so the leftover must use the page's rule.
      expect(
        Math.abs((report.goalCutInto?.leftoverFractions[0] ?? 0) - 0.5136234419418325),
      ).toBeLessThanOrEqual(1 / (report.goalCutInto?.goalCells ?? 1));
    } finally {
      session.dispose();
    }
  }, 600_000);
});

describe('#948 the live session’s swept top', () => {
  it('is null with nothing loaded', () => {
    const session = createSimSession(tl);
    try {
      expect(session.sweptTop()).toBeNull();
    } finally {
      session.dispose();
    }
  });

  it('a corpus goal’s report carries the goal check the page’s checker computes', async () => {
    const stock = { length: 80, width: 50, thickness: 20 };
    const imported = await read('relief-plate.stl');
    const target = targetOf(imported, stock);
    const job = goalJob(target, stock);
    const g = await generate(tl, job);
    expect(g.ok, g.errors.map((e) => e.message).join('; ')).toBe(true);
    expect(g.surface3d).not.toBeNull();
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${job.toolKey} is not in the tool library`);

    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
      expect(load.ok).toBe(true);
      const top = session.sweptTop();
      expect(top).not.toBeNull();

      // The worker's own path: the job's target crosses the seam as plain data, the field is
      // sampled at the page checker's grid, and the LIVE session supplies the swept top.
      const check = goalCheckForProgram(job, g.surface3d != null);
      expect(check !== undefined && 'target' in check).toBe(true);
      const input = goalInputFor(session, check as SimGoalCheck);
      expect('heightfield' in input).toBe(true);
      if (!('heightfield' in input)) return;
      expect(input.heightfield.pitch).toBe(GOAL_CHECK_PITCH_MM);
      expect(GOAL_CHECK_MAX_CELLS).toBe(20_000_000);

      const direct = checkGoalCutInto(
        sampleGoalHeightfield(target, { pitchMm: GOAL_CHECK_PITCH_MM, maxCells: GOAL_CHECK_MAX_CELLS }),
        top as NonNullable<ReturnType<SimSession['sweptTop']>>,
      );
      const report = session.oracle(g.predicted, null, g.designItems, input);
      expect(report.goalCutInto).toBeDefined();
      expect(report.goalCutInto?.ran).toBe(true);
      expect(report.goalCutInto?.reason).toBeNull();
      expect(report.goalCutInto?.goalCells).toBe(direct.goalCells);
      expect(report.goalCutInto?.cutIntoFraction).toBe(direct.cutIntoFraction);
      expect(report.goalCutInto?.coverageFraction).toBe(direct.coverageFraction);
      // The plan is clamped over the cutter's whole footprint (#909), so the sweep of the posted
      // program cuts nothing into the goal — the bench's own `goal_check.py`, run on this same
      // posted program and heightfield, also reports 0 cut-into (0.00 %, max 0.000 mm), and its
      // 0.68 % leftover (max 3 mm) is this check's leftover in the same bands.
      expect(report.goalCutInto?.sentence).toContain('no cell cut more than');
      expect(report.goalCutInto?.ok).toBe(true);
      expect(report.goalCutInto?.cutIntoFraction).toBe(0);
      expect(report.goalCutInto?.maxCutIntoMm).toBe(0);
      expect(report.goalCutInto?.maxCutIntoAt).toBeNull();
      // #948 — the leftover read is the page's own point rule, cell for cell: `goal_check.py` on
      // this same posted program leaves 824 of 120701 cells more than 0.1 mm above the goal
      // (0.006826786853464346). The app must answer with the same count.
      expect(
        Math.abs((report.goalCutInto?.leftoverFractions[0] ?? 0) - 0.006826786853464346),
      ).toBeLessThanOrEqual(1 / (report.goalCutInto?.goalCells ?? 1));
      expect(report.goalCutInto?.maxLeftoverMm).toBe(3);
      // And the merge left the report's other verdicts alone.
      expect(report.ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 240_000);

  it('catches a deliberate gouge: a feed 0.2 mm below the goal reads back as cut-into', async () => {
    // The acceptance's positive case: a program that DOES cut into the goal must not read as a
    // pass. The same posted relief program, with one plunge spliced in over the part's top face.
    const stock = { length: 80, width: 50, thickness: 20 };
    const imported = await read('relief-plate.stl');
    const target = targetOf(imported, stock);
    const job = goalJob(target, stock);
    const g = await generate(tl, job);
    expect(g.ok, g.errors.map((e) => e.message).join('; ')).toBe(true);
    // Splice the plunge BEFORE the program's shutdown (`M332` vacuum off / `M05` spindle stop):
    // a cut after the spindle stops is not a cut, and the sweep agrees.
    const gouged = (g.nc as string).replace(
      /\nM332\nM05\n/,
      '\nG0 Z5\nG0 X40 Y25\nG1 Z-0.2 F200\nG0 Z5\nM332\nM05\n',
    );
    expect(gouged).not.toBe(g.nc);
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${job.toolKey} is not in the tool library`);

    const session = createSimSession(tl);
    try {
      const load = session.load(gouged, toSetup(job, Z1), tool, Z1.id);
      expect(load.ok).toBe(true);
      const report = session.oracle(g.predicted, null, g.designItems, goalInputFor(session, goalCheckForProgram(job, true) as SimGoalCheck));
      expect(report.goalCutInto?.ran).toBe(true);
      expect(report.goalCutInto?.ok).toBe(false);
      expect(report.goalCutInto?.cutIntoFraction).toBeGreaterThan(0);
      expect(report.goalCutInto?.maxCutIntoMm).toBeGreaterThan(0.19);
      expect(report.goalCutInto?.maxCutIntoMm).toBeLessThan(0.21);
      // The worst cell is named, in the work frame, at the plunge (the cutter is 1 mm across, so
      // any cell of its floor is within half a millimetre of the point asked for).
      const at = report.goalCutInto?.maxCutIntoAt;
      expect(at).not.toBeNull();
      expect(Math.abs((at as { x: number }).x - 40)).toBeLessThanOrEqual(0.5);
      expect(Math.abs((at as { y: number }).y - 25)).toBeLessThanOrEqual(0.5);
      expect(report.goalCutInto?.sentence).toContain('cut into');
      // The oracle's own verdict folds the goal check in: a gouge is not a pass.
      expect(report.ok).toBe(false);
    } finally {
      session.dispose();
    }
  }, 240_000);
});
