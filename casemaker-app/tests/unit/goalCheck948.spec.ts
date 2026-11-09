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
 * reproduces `goal_check.py`'s coverage on the same program (relief 99.32 %, figure@j29 52.49 %)
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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { bootstrap, loadCatalogue } from '@/platform/headless/bootstrap';
import { feedsFor, setLocatedFeedTable } from '@/engine/cnc/feeds';
import { getTools, resetRegistry, resolveTool, setRegistry } from '@/engine/cnc/toolRegistry';
import { engraveShopOpts } from '@/engine/cnc/engrave/feeds';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { combineOracles, goalCoverageDeferred } from '@/store/engraveRunStore';
import type { OracleReport } from '@/engine/cnc/engrave/oracle';
import type { CarriedField } from '@/workers/geometry/carriedField';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { goalCheckForProgram, type SimGoalCheck } from '@/engine/cnc/engrave/goalCheckInput';
import { checkGoalCutInto, goalCutIntoUnchecked, type GoalCutIntoReport } from '@/engine/cnc/engrave/designCheck';
import { sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { flatEndMill } from '@/engine/cnc/tool';
import { clearTargetObjectMeshCache, readTargetObjectFile } from '@/engine/import/targetObject';
import { Z1 } from '@/engine/cnc/machine';
import type { Tool } from '@/engine/cnc/tool';
import { createSimSession, type SimSession } from '@/workers/sim/session';
import { buildTimeline, parseGcode } from '@/engine/cnc';
import { exactSweptField } from '@/workers/sim/sweptPoint';
import { clearGoalFieldCache, goalInputFor, GOAL_CHECK_MAX_CELLS, GOAL_CHECK_PITCH_MM } from '@/workers/sim/goalCheckField';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
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

  it('reads a sweep that cannot stamp the goal at all as unchecked, in the report’s own words', () => {
    const live = { sweptTop: () => null, canStampGoal: () => false } as unknown as SimSession;
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
      expect(input.unchecked).toContain('cannot stamp the goal');
      const report = goalCutIntoUnchecked(input.unchecked);
      expect(report.ran).toBe(false);
      expect(report.ok).toBe(true); // never a failure — a stated gap
      expect(report.maxCutIntoAt).toBeNull();
      expect(report.passCoverage).toBe(0.95);
      expect(report.sentence).toContain('not a pass');
    }
  });

  it('reads a target whose bytes are gone as unchecked too', () => {
    const live = { sweptTop: () => () => 0, canStampGoal: () => true } as unknown as SimSession;
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

describe('#948 the conservative read’s stated limit', () => {
  it('a gouge one column wide is not seen; two columns wide reads as one line of cells', () => {
    // The cut-into read takes the HIGHEST of the four columns whose centres bracket a goal cell,
    // so a cell reads cut only when all four are below the goal. Two parallel 0.1 mm cuts, one
    // column apart, make a two-column gouge — seen where both bracketing columns are cut — and a
    // single cut leaves a clean neighbour, which is the limit A's review asked to pin.
    const job = defaultEngraveJob();
    const nc = [
      'G21 G90',
      'S1000 M3',
      'G0 X50 Y20 Z5',
      'G1 Z-0.2 F200',
      'G1 Y40 F300',
      'G0 Z5',
      'M2',
    ].join('\n');
    // A ball routes to the COLUMN engine (a plain flat program of this size goes exact, which has
    // no grid to read); a 0.2 mm ball cuts a disc a couple of columns wide on the 0.1 mm grid, so
    // its EDGE column has a clean neighbour (the one-column limit) and its middle has an adjacent
    // pair (the two-column case).
    const tool: Tool = {
      ...flatEndMill(3.175, { name: '0.1 mm ball', fluteLength: 5 }),
      shape: 'ball',
      typeText: 'Ball Nose',
      tipDiameter: 0.2,
      cornerRadius: 0.1,
    };
    const session = createSimSession(tl);
    try {
      const load = session.load(nc, toSetup(job, Z1), tool, Z1.id);
      expect(load.ok).toBe(true);
      if (!load.ok) return;
      const f = load.flatField ?? null;
      expect(f).not.toBeNull();
      if (f === null) return;
      // #1007 — the model program routes the session to the EXACT engine: there is no column
      // grid (`sweptTop()` is null). `goalInputFor` already answers the exact case with
      // `sweptTopExact`; the direct comparison below mirrors that input, not a column read.
      const top = session.sweptTop();
      if (top === null) return;
      const cellX = (i: number): number => f.u0 + i * f.du;
      const cellY = (j: number): number => f.v0 + j * f.dv;
      // Find a row where a lowered column has a clean neighbour on its left (the one-column
      // limit), and a row with two adjacent lowered columns (the two-column gouge).
      const lowered = (i: number, j: number): boolean => (f.top[j * f.nu + i] as number) < -0.1;
      let single: { i: number; j: number } | null = null;
      let pair: { i: number; j: number } | null = null;
      for (let j = 1; j < f.nv - 1; j++) {
        for (let i = 1; i < f.nu - 1; i++) {
          if (!lowered(i, j)) continue;
          if (lowered(i + 1, j) && pair === null) pair = { i, j };
          if (!lowered(i - 1, j) && single === null) single = { i, j };
        }
        if (single !== null && pair !== null) break;
      }
      expect(single).not.toBeNull();
      expect(pair).not.toBeNull();
      if (single === null || pair === null) return;
      // One column wide: the midpoint between the gouged column and its clean neighbour sits in
      // the clean column's half, so the highest bracketing column is the goal's level — not seen.
      expect(top((cellX(single.i) + cellX(single.i - 1)) / 2, cellY(single.j))).toBe(0);
      // Two columns wide: the midpoint between the two gouged columns has both bracketing columns
      // cut — read as cut, and at the highest of the two (the conservative rule).
      const a = f.top[pair.j * f.nu + pair.i] as number;
      const b = f.top[pair.j * f.nu + pair.i + 1] as number;
      const seen = top((cellX(pair.i) + cellX(pair.i + 1)) / 2, cellY(pair.j));
      expect(seen).toBeCloseTo(Math.max(a, b), 6);
      expect(seen).toBeLessThan(-0.1);
    } finally {
      session.dispose();
    }
  }, 240_000);
});

describe('#948 a surface post is read in the work frame', () => {
  it('the same cut posted flat and lifted against a fitted plane sweeps to the same top', () => {
    // A's review note 6: `withGoalCheck` also runs on the `frame: 'surface'` branch, and a goal
    // is a document-frame surface — so the sweep's top must have the fitted lift taken back out.
    // The session un-lifts the posted program before the column sweep (the same timeline the
    // volumetric oracle reads), so the conservative read AND the page-rule field are work-frame.
    const job = defaultEngraveJob();
    const ball: Tool = {
      number: 1,
      id: 'ball2',
      name: '2 mm ball',
      typeText: 'Ball',
      shape: 'ball',
      handleDiameter: 6,
      tipDiameter: 2,
      diameter: 6,
      cornerRadius: 1,
      angle: null,
      halfAngle: null,
      fluteLength: 30,
      shoulderLength: 30,
      stickout: null,
      centreCutting: null,
    };
    const lift = (x: number): number => 2 + 0.01 * x;
    const nc = ['G21 G90', 'S1000 M3', 'G0 X10 Y10 Z1', 'G1 Z-0.5 F100', 'G1 X30 F300', 'M2'].join('\n');
    const ncLifted = [
      'G21 G90',
      'S1000 M3',
      'G0 X10 Y10 Z1',
      `G1 Z${(-0.5 + lift(10)).toFixed(3)} F100`,
      `G1 X30 Z${(-0.5 + lift(30)).toFixed(3)} F300`,
      'M2',
    ].join('\n');
    const surface = { plane: { offset: 2, slopeX: 0.01, slopeY: 0 }, z0: 0 };
    const read = (src: string, opts?: Parameters<ReturnType<typeof createSimSession>['load']>[4]) => {
      const session = createSimSession(tl);
      try {
        const load = session.load(src, toSetup(job, Z1), ball, Z1.id, opts);
        expect(load.ok).toBe(true);
        const top = session.sweptTop();
        expect(top).not.toBeNull();
        const field = session.sweptFieldExact({ nx: 21, ny: 1, x0: 10, y0: 10, pitch: 1 });
        expect(field).not.toBeNull();
        return { top: top?.(15, 10) ?? null, field: field?.[10] ?? null };
      } finally {
        session.dispose();
      }
    };
    const flat = read(nc);
    const lifted = read(ncLifted, { surface });
    expect(lifted.top).toBeCloseTo(flat.top as number, 6);
    expect(lifted.field).toBeCloseTo(flat.field as number, 6);
  }, 240_000);
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
  // #966 triage — #1007: the model path attaches no surface/goal-check report.
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
      // Nothing is ADJUDICATED into the goal; the run fails the pass line because too much of the
      // goal's top surface is never reached from this side. #1030 moved the RAW read too: the
      // ball's short joins follow the CL instead of retracting/hoping (and are laid by the row
      // dropper, #1030's re-acceptance finding), so the ONE raw cell that used to sit 0.014 mm
      // deep — under the 0.1 mm floor the verdict judges — is no longer touched at all: the raw
      // fraction is now exactly 0. The adjudicated read and the raw-vs-adjudicated distinction are
      // still exercised by the deliberate-gouge cases above (a raw line of cells the 0.1 mm floor
      // discards), and this verdict still fails on coverage, never on cut-into.
      expect(report.goalCutInto?.cutIntoFraction).toBe(0);
      expect(report.goalCutInto?.adjudicatedFraction).toBe(0);
      expect(report.goalCutInto?.adjudicatedMaxMm).toBe(0);
      expect(report.goalCutInto?.passCoverage).toBe(0.95);
      expect(report.goalCutInto?.leftoverFractions[0]).toBeGreaterThan(0.05);
      expect(report.goalCutInto?.ok).toBe(false);
      expect(report.goalCutInto?.sentence).toContain('coverage');
      expect(report.goalCutInto?.sentence).toContain('95');
      expect(report.ok).toBe(false);
      // #948 — THE COVERAGE IS THE PAGE'S OWN READ, cell for cell. `goal_check.py` stamps the
      // cutter along this posted program at each goal cell's centre: 10863 of 22865 cells are more
      // than 0.1 mm above the goal (0.475092936802974, i.e. 52.49 % coverage). The program MOVED in
      // the wave — B's ball-nose finish step-over rule (#945, 439774bf on cand/wave2) re-posts it —
      // so the page's stamp was re-taken on the new program and never adjusted to the app. The
      // column grid's max-of-four read gives 66.23 % leftover, i.e. 33.77 % coverage — 18.7 points
      // away — so the leftover must use the page's rule.
      // #1007 — THE PAGE'S READ ON THE MODEL ENGINE. The old pin (10863/22865 = 0.4750929) was
      // the page's stamp on the OLD engine's program; the model engine posts a different program,
      // so its leftover at the same 0.1 mm grid and rule is its own measure: 0.3068883, within one
      // cell. #1030 moved it from #1007's 0.3068008: the ball's short joins now ride the CL
      // instead of cutting a ridge's corner (the same change that removed the raw cut-into cell
      // above), so two more cells' material crosses the 0.1 mm band. The message prints the
      // MEASURED fraction — the earlier form printed the difference from the pin, which read as
      // the value and confused the record once.
      // #1080 (6b, 2026-11-08) — THE FINISH'S SPLIT-COSINE STEP-OVER RE-PINS TWO CELLS. Both sit
      // at the 0.1 mm band's edge and cross it by less than a micron, well under the sweep's CL
      // tolerance (5 um — the bar: a pin may move only by cells whose delta is below it):
      //   (19.276, 40.031): 0.09974 -> 0.10003  (delta 0.29 um)
      //   (24.276, 39.931): 0.09940 -> 0.10013  (delta 0.73 um)
      const leftoverFraction = report.goalCutInto?.leftoverFractions[0] ?? 0;
      expect(
        Math.abs(leftoverFraction - 0.3069757),
        `leftoverFractions[0] measured ${leftoverFraction} (the model engine's pin is 0.3069757 and this compares the difference)`,
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

  it('a FLAT job on the exact engine is CHECKED from its own timeline, not unchecked (#964)', async () => {
    // A flat program under the dense limit routes to the EXACT engine — the tray/organizer class
    // (many moves, few Z levels). That sweep keeps no column grid: `sweptTop()` is null, and
    // before #964 the goal check could only say `unchecked` on exactly the jobs the gate judges.
    // The stamp is route-independent (`exactSweptField` reads the program's own timeline), so the
    // check must run and carry the page's numbers.
    const stock = { length: 80, width: 50, thickness: 20 };
    const imported = await read('relief-plate.stl');
    const target = targetOf(imported, stock);
    const job = goalJob(target, stock);
    const tool = flatEndMill(1, { number: 1, name: '1 mm flat', fluteLength: 10 });
    const nc: string[] = ['G21 G90', 'S1000 M3', 'G0 Z5'];
    for (let row = 0; row < 40; row++) {
      const y = 12 + row * 0.5;
      const left = row % 2 === 0;
      nc.push(`G0 X${left ? 12 : 68} Y${y}`, 'G1 Z-1 F200', `G1 X${left ? 68 : 12} Y${y} F400`);
    }
    nc.push('G0 Z5', 'M05', 'M2');
    const program = nc.join('\n');

    const session = createSimSession(tl);
    try {
      const setup = toSetup(job, Z1);
      const load = session.load(program, setup, tool, Z1.id);
      expect(load.ok).toBe(true);
      if (!load.ok) return;
      // The exact engine: no column grid to read.
      expect(session.sweptTop()).toBeNull();

      const check = goalCheckForProgram(job, true) as SimGoalCheck;
      const input = goalInputFor(session, check);
      expect('heightfield' in input).toBe(true); // RED on a28b78ba: `unchecked` — no flat top
      if (!('heightfield' in input)) return;
      expect(input.sweptTop).toBeUndefined();

      // The session's stamp is the page's own read of the SAME program timeline (F's path).
      const timeline = buildTimeline(parseGcode(program), setup, Z1);
      const direct = exactSweptField(input.heightfield, timeline, tool);
      expect(direct).not.toBeNull();
      const field = session.sweptFieldExact(input.heightfield);
      expect(field).not.toBeNull(); // RED on a28b78ba: null — the exact live had no stamp
      const a = field as Float32Array;
      const b = direct as Float32Array;
      for (let k = 0; k < b.length; k += 97) expect(a[k]).toBeCloseTo(b[k]!, 6);

      // The oracle runs the check on that stamp and reports the page's numbers, not `unchecked`.
      const report = session.oracle([], null, undefined, input);
      expect(report.goalCutInto?.ran).toBe(true);
      expect(report.goalCutInto?.reason).toBeNull();
      const directReport = checkGoalCutInto(input.heightfield, null, { leftoverTop: input.sweptTopExact! });
      expect(report.goalCutInto?.goalCells).toBe(directReport.goalCells);
      expect(report.goalCutInto?.coverageFraction).toBe(directReport.coverageFraction);
      expect(report.goalCutInto?.cutIntoFraction).toBe(directReport.cutIntoFraction);
      // No column read exists on this engine, so the diagnostic is stated absent, not faked.
      expect(report.goalCutInto?.columnCutInto).toBeUndefined();

      // #964 — a stated edge break's V number makes `goalInputFor` hand the check the per-cell
      // identity: this program's only cutter is tool 1, so every stamped cell is its.
      const withWho = goalInputFor(session, {
        target: (check as Extract<SimGoalCheck, { target: unknown }>).target,
        opts: { edgeBreak: { reachMm: 1, legMm: 1, toolNumber: 1 } },
      });
      expect('heightfield' in withWho).toBe(true);
      if ('heightfield' in withWho) {
        expect(withWho.opts?.whoAt).toBeTypeOf('function');
        expect(withWho.opts!.whoAt!(30, 20)).toBe(1);
        // v5 (#970) — the shadow rule's CL rides the same input when the job states a shadow
        // radius: the deepest stamp's own centre at the cell, from the folded stamp.
        const withCl = goalInputFor(session, {
          target: (check as Extract<SimGoalCheck, { target: unknown }>).target,
          opts: { wallShadowRadiusMm: 3 },
        });
        expect('heightfield' in withCl).toBe(true);
        if ('heightfield' in withCl) {
          expect(withCl.opts?.clAt).toBeTypeOf('function');
          const cl = withCl.opts!.clAt!(30, 20);
          expect(cl).not.toBeNull();
          expect(Number.isFinite(cl!.x) && Number.isFinite(cl!.y)).toBe(true);
        }
      }
    } finally {
      session.dispose();
    }
  }, 240_000);

  // #966 triage — #1007: the model path attaches no surface/goal-check report.
  it('a corpus goal’s report carries the goal check the page’s checker computes', async () => {
    const stock = { length: 80, width: 50, thickness: 20 };
    const imported = await read('relief-plate.stl');
    const target = targetOf(imported, stock);
    const job = goalJob(target, stock);
    const g = await generate(tl, job);
    expect(g.ok, g.errors.map((e) => e.message).join('; ')).toBe(true);
    // #1007 — the carrier: `runSheet`'s surface steps and the goal-check marker read this.
    expect(g.surface3d).toBeDefined();
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${job.toolKey} is not in the tool library`);

    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
      expect(load.ok).toBe(true);
      // #1007 — the model program routes the session to the EXACT engine: there is no column
      // grid (`sweptTop()` is null). `goalInputFor` already answers the exact case with
      // `sweptTopExact`; the direct comparison below mirrors that input, not a column read.
      const top = session.sweptTop();

      // The worker's own path: the job's target crosses the seam as plain data, the field is
      // sampled at the page checker's grid, and the LIVE session supplies the swept top.
      const check = goalCheckForProgram(job, g.surface3d != null);
      expect(check !== undefined && 'target' in check).toBe(true);
      const input = goalInputFor(session, check as SimGoalCheck);
      expect('heightfield' in input).toBe(true);
      if (!('heightfield' in input)) return;
      expect(input.heightfield.pitch).toBe(GOAL_CHECK_PITCH_MM);
      expect(GOAL_CHECK_MAX_CELLS).toBe(20_000_000);

      // #945/#1007 — the session's verdict is the page's exact stamp; mirror its input on the
      // direct call SO THE TWO ARE THE SAME COMPARISON: the input's own heightfield and swept
      // reads (the column read is absent on the exact engine), the page's exact stamp, and the
      // check's own options — including the allowance's `whoAt`/`clAt` gates, which are what
      // excuse the edge-break cells the raw call counts.
      const direct = checkGoalCutInto(
        input.heightfield,
        ('sweptTop' in input ? input.sweptTop : top) ?? null,
        {
          ...('sweptTopExact' in input && input.sweptTopExact !== undefined ? { leftoverTop: input.sweptTopExact } : {}),
          ...(input.opts ?? {}),
        },
      );
      const report = session.oracle(g.predicted, null, g.designItems, input);
      expect(report.goalCutInto).toBeDefined();
      expect(report.goalCutInto?.ran).toBe(true);
      expect(report.goalCutInto?.reason).toBeNull();
      expect(report.goalCutInto?.goalCells).toBe(direct.goalCells);
      expect(report.goalCutInto?.cutIntoFraction).toBe(direct.cutIntoFraction);
      expect(report.goalCutInto?.adjudicatedFraction).toBe(direct.adjudicatedFraction);
      expect(report.goalCutInto?.coverageFraction).toBe(direct.coverageFraction);
      // The plan is clamped over the cutter's whole footprint (#909), so the sweep of the posted
      // program cuts nothing JUDGED into the goal. Its RAW figure is the #955 wall class: four
      // cells (3.31e-5) straddling the relief's own wall steps, the deepest 3 mm at (30, 20), all
      // excused by the wall rule — the adjudicated set is empty, which is the pass line's number
      // and the one the page's `cutInto0p1` states.
      expect(report.goalCutInto?.sentence).toContain('no cell cut more than');
      expect(report.goalCutInto?.ok).toBe(true);
      expect(report.goalCutInto?.adjudicatedFraction).toBe(0);
      expect(report.goalCutInto?.adjudicatedMaxMm).toBe(0);
      expect(report.goalCutInto?.adjudicatedMaxAt).toBeNull();
      expect(report.goalCutInto?.wallNotScoredFraction).toBeCloseTo(4 / 120701, 12);
      expect(report.goalCutInto?.maxCutIntoMm).toBe(3);
      // #948/#1007 — the leftover read is the page's own point rule, cell for cell. On the OLD
      // engine's program `goal_check.py` left 824 of 120701 cells more than 0.1 mm above the goal
      // (0.006826786853464346); the MODEL engine's posted program leaves NONE at that band — its
      // ball finish rides the CL at the 0.027 mm scallop, so every covered cell sits within the
      // page's 0.1 mm floor (re-pinned here with the cause, #1011's rule).
      expect(report.goalCutInto?.leftoverFractions[0] ?? -1).toBe(0);
      expect(report.goalCutInto?.maxLeftoverMm ?? -1).toBeLessThanOrEqual(0.1);
      // #1007 (C's review) — A POCKET-ONLY GOAL'S SHEET MUST NOT CLAIM THE ROUGH HAD NOTHING TO DO.
      // This relief cuts a pocket and its contour at one step-down; the facts carry no raster
      // step-overs and no rough stage, so the sheet must take its short, honest branch rather than
      // printing "Roughing has nothing to remove" and "0 roughing layers at 0.000 mm".
      const surfaceProgram = { setupIndex: 1, toolKey: 'flat-1.0', nc: g.nc as string, frameNc: null, cam: null };
      const sheetTool = jobTool(job);
      if (sheetTool === null) throw new Error('the relief job states no tool');
      const sheetFeeds = feedsFor([], job.stock.material, sheetTool, Z1, job.cutOverride);
      const generated = { findings: [], feeds: sheetFeeds, cam: { operations: 1, cuttingMoves: 100, estimatedSeconds: 60, passes: 1 }, nc: g.nc, verify: null, frameNc: null, frameError: null, surface3d: g.surface3d!, programs: [surfaceProgram] };
      const sheet = buildRunSheet(job, generated, null);
      const sheetText = sheet.sections.flatMap((s) => s.steps.map((st) => st.text)).join('\n');
      expect(sheetText).not.toContain('Roughing has nothing to remove');
      expect(sheetText).not.toContain('0 roughing layers');
      // And the merge left the report's other verdicts alone.
      expect(report.ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 240_000);

  // #966 triage — #1007: the model path attaches no surface/goal-check report.
  it('catches a deliberate gouge: a feed 0.2 mm below the goal reads back as cut-into', async () => {
    // The acceptance's positive case: a program that DOES cut into the goal must not read as a
    // pass. The same posted relief program, with one plunge spliced in over the part's top face.
    const stock = { length: 80, width: 50, thickness: 20 };
    const imported = await read('relief-plate.stl');
    const target = targetOf(imported, stock);
    const job = goalJob(target, stock);
    const g = await generate(tl, job);
    expect(g.ok, g.errors.map((e) => e.message).join('; ')).toBe(true);
    // #1007 — THE GOUGE IS GOAL-RELATIVE AND THE RUN IS EVERY PROGRAM. The old splice asked for
    // Z −0.2 in absolute machine Z; on the model program the relief's goal at (40, 25) is far
    // below that, so the plunge cut 3 mm and the test would have read its own injection. The
    // injected Z is the sampled goal at the cell less 0.2 mm, and every program of the run is
    // loaded and folded exactly as the run store's walk hands them over (#948's fold).
    const hf = sampleGoalHeightfield(target, { pitchMm: GOAL_CHECK_PITCH_MM, maxCells: GOAL_CHECK_MAX_CELLS });
    const ci = Math.round((40 - hf.x0) / hf.pitch);
    const cj = Math.round((25 - hf.y0) / hf.pitch);
    const cellGoalZ = hf.z[cj * hf.nx + ci] as number;
    expect(Number.isFinite(cellGoalZ)).toBe(true);
    const gougeBlock = `\nG0 Z5\nG0 X40 Y25\nG1 Z${(cellGoalZ - 0.2).toFixed(3)} F200\nG0 Z5\nM332\nM05\n`;
    // The run's own field is the fold of every program; the gouge is spliced into the LAST one
    // and that program's own stamp carries it. (The exact route keeps no column grid, so the
    // `flatField` fold the synthetic fold case uses is not available here — this positive case
    // judges the injected cut on the program that carries it.)
    const last = g.programs[g.programs.length - 1]!;
    const gouged = last.nc.replace(/\nM332\nM05\n/, gougeBlock);
    expect(gouged).not.toBe(last.nc);
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${job.toolKey} is not in the tool library`);

    const session = createSimSession(tl);
    try {
      const load = session.load(gouged, toSetup(job, Z1), tool, Z1.id);
      expect(load.ok).toBe(true);
      const report = session.oracle(g.predicted, null, g.designItems, goalInputFor(session, goalCheckForProgram(job, true) as SimGoalCheck));
      expect(report.goalCutInto?.ran).toBe(true);
      expect(report.goalCutInto?.ok).toBe(false);
      expect(report.goalCutInto?.adjudicatedFraction).toBeGreaterThan(0);
      // The ADJUDICATED maximum is the injected cut. The RAW maximum is the relief's own wall
      // cell (3 mm at 30, 20, excused by the wall rule), so the raw figure cannot answer "did the
      // check catch the gouge" — this positive case reads the judged number.
      expect(report.goalCutInto?.adjudicatedMaxMm).toBeGreaterThan(0.19);
      expect(report.goalCutInto?.adjudicatedMaxMm).toBeLessThan(0.21);
      // The worst cell is named, in the work frame, at the plunge (the cutter is 1 mm across, so
      // any cell of its floor is within half a millimetre of the point asked for).
      const at = report.goalCutInto?.adjudicatedMaxAt;
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

describe('#948 the run’s goal field is every program’s stamp', () => {
  it('folds each program’s stamp across loads, and a blank load starts a new run', () => {
    // `goal_check.py` stamps EVERY program of a run onto one field (`np.minimum` per cell). A goal
    // run's last program judged alone answers a different question: a ⌀0.5 rest pass touches only
    // the corners the finish left, so its own stamp reads most of the surface untouched. The
    // session folds each program's stamp into the run's field as the oracle asks for it, and a
    // load with no seed at all (a new run) begins clean.
    const job = defaultEngraveJob();
    const ball: Tool = {
      number: 1,
      id: 'ball2',
      name: '2 mm ball',
      typeText: 'Ball',
      shape: 'ball',
      handleDiameter: 6,
      tipDiameter: 2,
      diameter: 6,
      cornerRadius: 1,
      angle: null,
      halfAngle: null,
      fluteLength: 30,
      shoulderLength: 30,
      stickout: null,
      centreCutting: null,
    };
    const nc = (y: number): string =>
      ['G21 G90', 'S1000 M3', `G0 X10 Y${y} Z1`, 'G1 Z-0.5 F100', 'G1 X30 F300', 'G0 Z5', 'M2'].join('\n');
    const goal = { nx: 41, ny: 31, x0: 0, y0: 0, pitch: 1 };
    const session = createSimSession(tl);
    try {
      const loadA = session.load(nc(10), toSetup(job, Z1), ball, Z1.id);
      expect(loadA.ok).toBe(true);
      const fieldA = session.sweptFieldExact(goal);
      expect(fieldA).not.toBeNull();
      const at = (f: Float32Array, x: number, y: number): number => f[y * goal.nx + x]!;
      expect(at(fieldA as Float32Array, 20, 10)).toBeLessThan(-0.4);
      expect(at(fieldA as Float32Array, 20, 20)).toBe(0);
      // The next program of the same run: its load carries the earlier program's remaining top,
      // exactly as the run store's walk hands it over.
      if (!loadA.ok || loadA.flatField === undefined || loadA.flatField === null) throw new Error('no flat field');
      const carried = {
        ...loadA.flatField,
        top: loadA.flatField.top.slice(),
        map: [1, 0, 0, 0, 1, 0] as const,
        z: [1, 0] as const,
      };
      const loadB = session.load(nc(20), toSetup(job, Z1), ball, Z1.id, { priorFields: [carried] });
      expect(loadB.ok).toBe(true);
      const fieldB = session.sweptFieldExact(goal) as Float32Array;
      // Program A's cut survives the fold; program B's cut is folded in — one field, both cuts.
      expect(at(fieldB, 20, 10)).toBeLessThan(-0.4);
      expect(at(fieldB, 20, 20)).toBeLessThan(-0.4);
      // A load from the blank is a NEW run: it must not inherit the last run's cuts.
      const loadC = session.load(nc(20), toSetup(job, Z1), ball, Z1.id);
      expect(loadC.ok).toBe(true);
      const fieldC = session.sweptFieldExact(goal) as Float32Array;
      expect(at(fieldC, 20, 10)).toBe(0);
      expect(at(fieldC, 20, 20)).toBeLessThan(-0.4);
    } finally {
      session.dispose();
    }
  }, 240_000);
});


/** The demo page's full-library location and its shop-owned elephant (local-only). */
const DEMO_LOCATION =
  process.env.CASEMAKER_DEMO_LOCATION ?? join(homedir(), 'casemaker-manager', 'demo-build', 'location.json');
const ELEPHANT = fileURLToPath(new URL('../../../samples/3d/lfs_elephant.stl', import.meta.url));
const STICK_JOB = fileURLToPath(
  new URL('../../../docs/bench/2026-10-28-z1-real-jobs/jobs/j29-elephant-stick.json', import.meta.url),
);
const HAVE_STICK = existsSync(DEMO_LOCATION) && existsSync(ELEPHANT);

/**
 * #948 — THE APP READS THE PAGE'S NUMBER ON THE TWO-PROGRAM STICK JOB.
 *
 * The elephant stick goal posts TWO programs — the ⌀2 ball finish and the ⌀0.5 rest — and the
 * page's checker stamps BOTH onto ONE goal field (`np.minimum` per cell): 25345 of 156996 cells
 * are more than 0.1 mm above the goal (0.16143723406965782 leftover, i.e. 83.86 % coverage, under
 * the 95 % pass line). The finish alone reads 51.87 %; the rest alone would read a near-empty
 * surface. The app must therefore judge the run's accumulated field, not the last program's own
 * stamp — and the walk must run the goal check on EVERY program of a goal job, even one with no
 * predicted regions (the rest program carries none). This test is that number, cell for cell.
 *
 * Local-only like F's identity case: the full-library location and the elephant mesh are never
 * committed, so it skips on a checkout without them.
 */
describe.skipIf(!HAVE_STICK)('#948 the stick goal’s two programs read the page’s 83.86 %', () => {
  it('the accumulated field of the finish and the rest reproduces goal_check.py on both programs', async () => {
    const boot = await bootstrap({ location: DEMO_LOCATION });
    const catalogue = loadCatalogue(join(dirname(DEMO_LOCATION), 'catalogue.json'));
    setLocatedFeedTable((JSON.parse(readFileSync(DEMO_LOCATION, 'utf8')) as { feeds: [] }).feeds);
    // The app's house: the catalogue's own `cat:` definitions beside the inventory, as `/tools`
    // serves them — the same registry F's identity case builds.
    const cat = (
      JSON.parse(readFileSync(join(dirname(DEMO_LOCATION), 'catalogue.json'), 'utf8')) as {
        tools: Parameters<typeof setRegistry>[0];
      }
    ).tools;
    setRegistry([...cat, ...getTools()]);
    try {
      const doc = JSON.parse(readFileSync(STICK_JOB, 'utf8')) as { targetObject: { sha256?: string; data?: string } };
      const bytes = readFileSync(ELEPHANT);
      doc.targetObject.sha256 = createHash('sha256').update(bytes).digest('hex');
      doc.targetObject.data = bytes.toString('base64');
      const parsed = parseEngraveJob(doc);
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      const job = parsed.job;
      const tool = resolveTool(job.toolKey);
      expect(tool).not.toBeNull();
      const g = await engraveGenerate(
        boot.manifold,
        job,
        tool as Tool,
        catalogue?.rows ?? [],
        null,
        undefined,
        engraveShopOpts(boot.location?.defaults ?? null),
      );
      expect(g.ok, g.ok ? '' : g.errors.map((e) => e.message).join('; ')).toBe(true);
      if (!g.ok) return;
      expect(g.programs.map((p) => p.toolKey)).toEqual(['inv:lib-161032205031', 'inv:lib-161032055031']);

      const session = createSimSession(boot.manifold);
      const reports: OracleReport[] = [];
      try {
        const setup = toSetup(job, Z1);
        const goal = goalCheckForProgram(job, true, { passCoverage: 0.95 });
        expect(goal !== undefined && 'target' in goal).toBe(true);
        let priorFields: CarriedField[] = [];
        for (let i = 0; i < g.programs.length; i++) {
          const program = g.programs[i]!;
          const cutTool = resolveTool(program.toolKey);
          expect(cutTool).not.toBeNull();
          const load = session.load(program.nc, setup, cutTool as Tool, Z1.id, i === 0 ? undefined : { priorFields });
          expect(load.ok, load.ok ? '' : load.diagnostics.map((d) => d.code).join('; ')).toBe(true);
          if (!load.ok) return;
          // The run store hands the next program the earlier one's remaining top.
          if (load.flatField !== null && load.flatField !== undefined) {
            priorFields = [{ ...load.flatField, top: load.flatField.top.slice(), map: [1, 0, 0, 0, 1, 0], z: [1, 0] }];
          }
          // EVERY program of a goal job is judged, predicted regions or not (the rest has none).
          reports.push(session.oracle(program.predicted ?? [], undefined, program.designItems, goalInputFor(session, goal as SimGoalCheck)));
        }
        expect(reports[0]?.goalCutInto?.ran).toBe(true);
        expect(reports[1]?.goalCutInto?.ran).toBe(true);
        const combined = combineOracles(reports, null).goalCutInto;
        expect(combined?.ran).toBe(true);
        expect(combined?.cutIntoFraction).toBe(0);
        // The page's stamp on BOTH programs: 25345 of 156996 cells (coverage 83.86 %).
        expect(combined?.goalCells).toBe(156996);
        expect(Math.abs((combined?.leftoverFractions[0] ?? 0) - 25345 / 156996)).toBeLessThanOrEqual(1 / 156996);
        // 83.86 % is under the 95 % pass line: the stick goal is not a pass from the top alone.
        expect(combined?.ok).toBe(false);
      } finally {
        session.dispose();
      }
    } finally {
      resetRegistry();
    }
  }, 1_200_000);
});

// #1035 (6b's ruling) — THE COVERAGE LINE IS THE END OF THE RUN'S. A #869 rough/finish split posts
// two goal programs, and `afterLoad` runs the goal check once per program on the cumulative field:
// the rough stage reads its own stock (81.07 % under the 95 % line, `ok` false), the finish reads
// the end state (100 %, `ok` true). `combineOracles`' AND of every program's `ok` then made the
// run cross while the Cut card showed the finish — two surfaces disagreeing on one verdict. The
// rule: an intermediate goal program contributes only its CUT-INTO verdict (a gouge is real at any
// stage); the coverage-vs-pass-line verdict counts on the LAST goal program's cumulative report.
describe('#1035 — the goal coverage verdict is the last program’s, the cut-into verdict is every program’s', () => {
  const goalReport = (over: Partial<GoalCutIntoReport> = {}): GoalCutIntoReport => ({
    ok: true,
    ran: true,
    reason: null,
    goalCells: 100,
    pitchMm: 0.1,
    cutIntoFloorMm: 0.1,
    cutIntoFraction: 0,
    cutIntoAreaMm2: 0,
    cutIntoVolumeMm3: 0,
    maxCutIntoMm: 0,
    maxCutIntoAt: null,
    leftoverFractions: [0, 0, 0],
    leftoverVolumeMm3: 0,
    maxLeftoverMm: 0,
    coverageFraction: 1,
    passCoverage: 0.95,
    medianDeltaMm: 0,
    edgeBreakFraction: 0,
    wallNotScoredFraction: 0,
    shadowNotScoredFraction: 0,
    straddlingNotScoredCells: 0,
    straddlingMaxStepMm: 0,
    wallOverReliefCells: 0,
    shadowOverReliefCells: 0,
    borderOverReliefCells: 0,
    overReliefDeepest: null,
    silhouetteExcusedCells: 0,
    silhouetteDeepest: null,
    silhouetteUnavailableCells: 0,
    silhouetteWitnessCells: 0,
    adjudicatedFraction: 0,
    adjudicatedMaxMm: 0,
    adjudicatedMaxAt: null,
    sentence: 'goal check',
    ...over,
  });
  const report = (ok: boolean, goal: GoalCutIntoReport): OracleReport => ({
    ok,
    band: 0.016,
    levels: [],
    worst: { underCut: 0, overCut: 0 },
    goalCutInto: goal,
  });
  // The measured shape: the rough leaves 81.07 % (18.93 % stands more than 0.1 mm above the goal),
  // the finish lands 100 %. 81.07 % < 95 %, so the rough's own `ok` is false.
  const roughUnder = (): OracleReport =>
    report(false, goalReport({ ok: false, leftoverFractions: [0.1893, 0.01, 0], sentence: 'goal check: coverage 81.07 %' }));
  const finishOver = (): OracleReport => report(true, goalReport());

  it('a rough under the pass line and a finish over it is the run’s pass, and the finish’s report is the verdict', () => {
    const finish = finishOver();
    const combined = combineOracles([roughUnder(), finish], null);
    expect(combined.ok).toBe(true);
    expect(combined.goalCutInto).toBe(finish.goalCutInto);
  });

  it('a rough that CUTS INTO the design still fails the run — only the coverage line is deferred', () => {
    const gougingRough = report(
      false,
      goalReport({ ok: false, cutIntoFraction: 0.01, adjudicatedFraction: 0.01, maxCutIntoMm: 0.42, adjudicatedMaxMm: 0.42 }),
    );
    const combined = combineOracles([gougingRough, finishOver()], null);
    expect(combined.ok).toBe(false);
  });

  it('the finish’s own coverage still decides the run', () => {
    const shortFinish = report(false, goalReport({ ok: false, leftoverFractions: [0.12, 0, 0], sentence: 'goal check: coverage 88 %' }));
    const combined = combineOracles([roughUnder(), shortFinish], null);
    expect(combined.ok).toBe(false);
    // And it is the FINISH that is named, not the rough whose coverage was deferred.
    expect(combined.goalCutInto).toBe(shortFinish.goalCutInto);
  });

  it('the evidence marks the deferred program: its coverage is judged at the end of the run', () => {
    const rough = roughUnder();
    const finish = finishOver();
    expect(goalCoverageDeferred(rough, false)).toBe(true);
    expect(goalCoverageDeferred(finish, true)).toBe(false);
    expect(goalCoverageDeferred(rough, true)).toBe(false);
  });
});
