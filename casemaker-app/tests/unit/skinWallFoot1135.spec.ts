/**
 * #1135 — A LEVEL PASS MUST NOT CUT A WALL-FOOT CELL INTO THE GOAL (red-first).
 *
 * The organizer STEP row, isolated: the plan runs on a house holding ONE ⌀3.175 flat, so the
 * rough and the skin are that cutter (main's ⌀6 skin/rough never cover the failing cell, which is
 * why the organizer passed there). The defect: a level-pass raster position whose cutter DISC
 * reaches a cell whose CL stands above the pass level — the disc's rim cuts the neighbouring wall
 * by up to the level's own depth (0.194 mm at the organizer's (79.9, 143.4) cell). It was first
 * seen on the skin, then isolated to the ROUGH's pass at a mask boundary; the same guard now
 * covers the skin, the rough's levels and the rough's band skim.
 *
 * Two tests, one oracle (`checkGoalCutInto`, the gate's own adjudication):
 *  - a synthetic stepped block (runs on every box, no licensed file): a plateau with a 0.19 mm
 *    island — the organizer's wall-foot in miniature;
 *  - the organizer STEP itself (skips without CM_959_ORGANIZER_STEP, which the k3 env sets).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { stepToMesh } from '@/engine/import/stepMesh';
import { safeRasterRuns } from '@/engine/cnc/cam/pocket';
import { planModelCam, type ModelPlanInput, type ModelPlanOutput } from '@/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { parseGcode, setupFromHeader, stubSetup } from '@/engine/cnc';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { exactSweptFieldTooled } from '@/workers/sim/sweptPoint';
import { sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import type { ResultTop } from '@/engine/cnc/engrave/goalCoverage';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import type { EngraveTargetObject } from '@/types/engraveJob';

const ORGANIZER = process.env.CM_959_ORGANIZER_STEP;
const FLAT3175: Tool = flatEndMill(3.175, { number: 1, id: 'flat-3.175', name: 'flat-3.175', fluteLength: 30 })  // #1195 — reaches the 27.2 mm tray profile;

interface Placed {
  positions: Float32Array;
  indices: Uint32Array;
  target: EngraveTargetObject;
  stock: { length: number; width: number; thickness: number };
}

function boundsOf(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, positions[i + c]!);
      max[c] = Math.max(max[c]!, positions[i + c]!);
    }
  }
  return { min, max };
}

function targetOf(positions: Float32Array, indices: Uint32Array, name: string, position: { x: number; y: number; z: number }): EngraveTargetObject {
  const stl = buildBinaryStl([{ positions, indices }]);
  const sha256 = createHash('sha256').update(Buffer.from(stl)).digest('hex');
  const { min, max } = boundsOf(positions);
  return {
    id: sha256.slice(0, 16),
    name,
    format: 'stl',
    sha256,
    data: Buffer.from(stl).toString('base64'),
    size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
    position,
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function postContextFor(stock: { length: number; width: number; thickness: number }): PostContext {
  return {
    jobName: 'skin-wall-foot-1135',
    stock,
    materialName: 'hardwood',
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test-1135',
    toolKey: 'multi',
  };
}

function topOf(programs: readonly { ir: ToolpathIR; text: string }[], field: GoalHeightfield): { top: ResultTop; clAt: (x: number, y: number) => { x: number; y: number } | null } {
  let acc: Float32Array | null = null;
  let clX: Float32Array | null = null;
  let clY: Float32Array | null = null;
  for (const program of programs) {
    const parsed = parseGcode(program.text);
    const part = setupFromHeader(parsed.header).patch.part;
    if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') {
      throw new Error('#1135: a posted program carries no rectangular stock header');
    }
    const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
    const stamped = exactSweptFieldTooled(field, buildTimeline(parsed, setup, Z1), () => program.ir.tool);
    if (stamped === null) continue;
    if (acc === null) {
      acc = Float32Array.from(stamped.field);
      clX = Float32Array.from(stamped.clX);
      clY = Float32Array.from(stamped.clY);
    } else {
      for (let k = 0; k < acc.length; k++) {
        if (stamped.field[k]! < acc[k]!) {
          acc[k] = stamped.field[k]!;
          clX![k] = stamped.clX[k]!;
          clY![k] = stamped.clY[k]!;
        }
      }
    }
  }
  if (acc === null || clX === null || clY === null) throw new Error('#1135: no posted program removed anything');
  const topField = acc;
  const xs = clX;
  const ys = clY;
  const cell = (x: number, y: number): number | null => {
    const i = Math.round((x - field.x0) / field.pitch);
    const j = Math.round((y - field.y0) / field.pitch);
    if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return null;
    return j * field.nx + i;
  };
  return {
    top: (x, y) => {
      const k = cell(x, y);
      return k === null ? null : topField[k]!;
    },
    clAt: (x, y) => {
      const k = cell(x, y);
      return k === null ? null : { x: xs[k]!, y: ys[k]! };
    },
  };
}

/** Post every program, beam it onto the plan, and judge it with the GATE's own cut-into check. */
async function judge(placed: Placed, output: ModelPlanOutput): Promise<{ counted: number; detail: string; programs: { ir: ToolpathIR; text: string }[] }> {
  const programs: { ir: ToolpathIR; text: string }[] = [];
  for (const setup of output.perSetup) {
    for (const ir of setup.programs) {
      const posted = postZ1(ir, postContextFor(placed.stock), Z1);
      expect(posted.ok, `postZ1 refused — ${posted.ok ? '' : posted.errors.join('; ')}`).toBe(true);
      if (posted.ok) programs.push({ ir, text: posted.text });
    }
  }
  expect(programs.length, 'the plan posted no program').toBeGreaterThan(0);
  const goal = sampleGoalHeightfield(placed.target, { pitchMm: 0.1, stockTopZ: 0 });
  const { top, clAt } = topOf(programs, goal);
  const report = checkGoalCutInto(goal, top, {
    passCoverage: 0.95,
    wallShadowRadiusMm: 3,
    stockThicknessMm: placed.stock.thickness,
    clAt,
  });
  const counted = Math.round(report.adjudicatedFraction * report.goalCells);
  return {
    counted,
    detail:
      `${counted} adjudicated cell(s), up to ${report.adjudicatedMaxMm.toFixed(3)} mm at ${JSON.stringify(report.adjudicatedMaxAt)} ` +
      `(raw ${(report.cutIntoFraction * 100).toFixed(2)} %; wall ${(report.wallNotScoredFraction * 100).toFixed(2)} %, ` +
      `shadow ${(report.shadowNotScoredFraction * 100).toFixed(2)} %; straddling ${report.straddlingNotScoredCells} excused)`,
    programs,
  };
}

describe('#1135 — the shared wall-foot rule, on every box', () => {
  it('a ring crossing a raised step comes back as safe runs only; a safe ring is unchanged', () => {
    // The rule, in isolation: a level pass at -1.2, a step whose disc-aware CL is -1.0 over a
    // band, and a square ring crossing that band. Every returned point must satisfy the exact
    // disc test (the CL under it is at or below the level); a ring that touches no unsafe point
    // comes back CLOSED and byte-identical, which is what keeps the untouched plans unchanged.
    const R = 1.5875;
    const LEVEL = -1.2;
    const clAt = (x: number): number => (x + R >= 13 && x - R <= 15.5 ? -1.0 : LEVEL);
    const unsafeAt = (x: number): boolean => clAt(x) > LEVEL + 1e-6;
    const crossing: [number, number][] = [[8, 5], [20, 5], [20, 15], [8, 15]];
    const runs = safeRasterRuns(crossing, unsafeAt, 0.25);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) for (const [x] of run.points) expect(clAt(x)).toBeLessThanOrEqual(LEVEL + 1e-6);
    expect(runs.every((run) => !run.closed), 'a broken ring is traced as open runs').toBe(true);
    const safeRing: [number, number][] = [[2, 2], [6, 2], [6, 6], [2, 6]];
    const whole = safeRasterRuns(safeRing, unsafeAt, 0.25);
    expect(whole).toHaveLength(1);
    expect(whole[0]!.closed).toBe(true);
    expect(whole[0]!.points).toEqual(safeRing);
  });
});

async function placeOrganizerAsync(file: string): Promise<Placed> {
  const bytes = fs.readFileSync(file);
  const read = await stepToMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'recognition');
  const { min, max } = read.mesh.bbox;
  const stock: [number, number] = [170, 170];
  const modelTop = -1.2;
  const dx = stock[0] / 2 - (min[0] + max[0]) / 2;
  const dy = stock[1] / 2 - (min[1] + max[1]) / 2;
  const dz = modelTop - max[2];
  const positions = Float32Array.from(read.mesh.positions);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i]! + dx;
    positions[i + 1] = positions[i + 1]! + dy;
    positions[i + 2] = positions[i + 2]! + dz;
  }
  const indices = Uint32Array.from(read.mesh.indices);
  return {
    positions,
    indices,
    target: targetOf(read.mesh.positions, indices, 'organizer', { x: stock[0] / 2, y: stock[1] / 2, z: modelTop }),
    stock: { length: stock[0], width: stock[1], thickness: (max[2] - min[2]) - modelTop },
  };
}

describe.skipIf(ORGANIZER === undefined)('#1135 — the wall-foot guard, on the organizer STEP', () => {
  it('a ⌀3.175-only organizer plan skins the plateau: zero adjudicated cells', async () => {
    const placed = await placeOrganizerAsync(ORGANIZER!);
    const { min, max } = boundsOf(placed.positions);
    const input: ModelPlanInput = {
      geometry: { triangles: { positions: placed.positions, indices: placed.indices, triangleCount: placed.indices.length / 3, bbox: { min, max } } },
      setups: [{ frame: { up: [0, 0, 1], stockTop: 0 }, underside: 'flatOnStockBottom' }],
      stock: { length: placed.stock.length, width: placed.stock.width, thickness: placed.stock.thickness, material: 'hardwood' },
      fixture: { mount: 'tape', envelope: null },
      cutters: { house: [FLAT3175], catalogue: [] },
      tolerances: {},
      edgeBreak: { legMm: 0 },
    };
    const result = await judge(placed, await planModelCam(input));
    expect(result.programs.some((p) => p.ir.tool.id === 'flat-3.175'), 'the 3.175 skin never posted').toBe(true);
    expect(result.counted, `#1135 organizer: ${result.detail}`).toBe(0);
  }, 900_000);
});
