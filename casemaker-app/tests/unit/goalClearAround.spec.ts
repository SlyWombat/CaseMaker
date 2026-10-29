/**
 * #764 — A GOAL MADE AS THE ITEM IS CLEARED AROUND ITSELF, DOWN TO ITS BASE PLANE.
 *
 * The 3D goal heightfield holds one top-Z per cell and leaves an uncovered cell at the stock top
 * ("the goal says nothing there"), so a mouse-shell item was finished correctly and then sat at
 * the bottom of a pit: every cell outside its footprint kept the blank's full height. The fix
 * samples a CLEAR BAND with the goal — a ring one cutter diameter plus one finishing step-over
 * wide by default, the whole blank on request — whose uncovered cells are part of the surface at
 * the goal's base plane, so the roughing and finishing passes that are written anyway cut it.
 *
 * Pinned on the #754 shell: after the run the stock within the ring is at the rim Z (the fixture's
 * base plane), the whole-blank choice reaches the stock's edge, "nothing" keeps the old cut, and a
 * MOLD is unchanged (its rim IS the stock top).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateSurface3dIR,
  sampleGoalHeightfield,
  type GoalHeightfield,
  type SurfaceFeeds,
  type SurfaceTool,
} from '@/engine/cnc/cam/surface3d';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { generateGoalProgram } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { RapidEstimate, CamMove } from '@/engine/cnc/cam/ir';
import { FLAT, type ColumnCutter, type CutMove } from '@/workers/geometry/columnEngine';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';

afterEach(() => clearTargetObjectMeshCache());

type V = [number, number, number];
type Tri = [V, V, V];

// ── The part and the blank (the #754 mouse shell) ──────────────────────────────────────────────
const A = 30;
const B = 17;
const H = 20;
const BLANK = { length: 80, width: 50, thickness: 26 };
const CX = 40;
const CY = 25;
const PITCH = 0.25;
const STOCK_RECT = { xMin: 0, xMax: BLANK.length, yMin: 0, yMax: BLANK.width };

function shell(a: number, b: number, h: number, x: number, y: number): number {
  const u2 = (x / a) ** 2 + (y / b) ** 2;
  if (u2 >= 1) return 0;
  return h * Math.sqrt(1 - u2) * (0.85 + 0.15 * (x / a));
}
const zOut = (x: number, y: number): number => shell(A, B, H, x, y);
const crownOf = (f: (x: number, y: number) => number): number => {
  let best = 0;
  for (let i = 0; i <= 400; i++) best = Math.max(best, f((i / 400) * A, 0));
  return best;
};
const CROWN = crownOf(zOut);
const BASE_Z = -CROWN;

function surfaceTris(f: (x: number, y: number) => number, seg = 64): Tri[] {
  const at = (r: number, t: number): V => {
    const x = A * r * Math.cos(2 * Math.PI * t);
    const y = B * r * Math.sin(2 * Math.PI * t);
    return [x, y, f(x, y)];
  };
  const tris: Tri[] = [];
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const p = at(i / seg, j / seg);
      const q = at((i + 1) / seg, j / seg);
      const r = at((i + 1) / seg, (j + 1) / seg);
      const s = at(i / seg, (j + 1) / seg);
      tris.push([p, q, r], [p, r, s]);
    }
  }
  return tris;
}

function stl(tris: Tri[]): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

let serial = 0;
function goal(f: (x: number, y: number) => number, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'shell',
    name: 'mouse-shell.stl',
    format: 'stl',
    sha256: (serial++).toString(16).padStart(64, 'c'),
    data: stl(surfaceTris(f)),
    size: { x: 2 * A, y: 2 * B, z: CROWN },
    position: { x: CX, y: CY, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

// ── The cutter, the feeds and the sweep ─────────────────────────────────────────────────────────
const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test' };
/** Makera's ⌀2 ball (the demo's own cutter). */
const BALL_R = 1;
const BALL: SurfaceTool = { radius: BALL_R, ball: true };
const BALL_TOOL = flatEndMill(2 * BALL_R, { shape: 'ball', name: '2 mm ball nose' });
const BALL_CUTTER: ColumnCutter = { radius: 0, tanHalf: null, cornerRadius: BALL_R, outerRadius: BALL_R };
const FINISH_STEP = 0.3;
const FEEDS: SurfaceFeeds = { feed: 900, plungeFeed: 300, stepDown: 1.5, roughStepOver: 1.2, finishStepOver: FINISH_STEP };
/** One cutter diameter plus one finishing step-over — the generator's own default ring. */
const RING_WIDTH = 2 * BALL_R + FINISH_STEP;

function prism(w: number, d: number, t: number): Setup {
  return stubSetup({ kind: 'prism', outline: rectProfile(w, d), thickness: t }, { kind: 'tape-down', contact: rectProfile(w, d) });
}

function sweep(moves: readonly CamMove[]): ReturnType<typeof FLAT.buildGrid> {
  const cut: CutMove[] = [];
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]!;
    const b = moves[i]!;
    if (b.kind !== 'feed') continue;
    cut.push({ step: i, line: i, u0: a.x, u1: b.x, v0: a.y, v1: b.y, z: Math.min(a.z, b.z) });
  }
  const grid = FLAT.buildGrid(prism(BLANK.length, BLANK.width, BLANK.thickness), BALL_CUTTER, cut, {
    dx: PITCH,
    dThetaDeg: PITCH,
  });
  for (const m of cut) FLAT.applyMove(grid, m, BALL_CUTTER);
  return grid;
}

function heightAt(grid: ReturnType<typeof FLAT.buildGrid>, x: number, y: number): number {
  const i = Math.round((x - grid.u0) / grid.du);
  const j = Math.round((y - grid.v0) / grid.dv);
  return grid.h[j * grid.nu + i] as number;
}

function finishingOf(hf: GoalHeightfield) {
  return generateSurface3dIR({
    heightfield: hf,
    tool: BALL,
    toolObj: BALL_TOOL,
    toolNumber: 1,
    spindleRpm: 16000,
    air: true,
    feeds: FEEDS,
    rapid: RAPID,
    labelId: 'shell',
  }).finishing;
}

function job(target: EngraveTargetObject): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, ...BLANK },
    targetObject: target,
  };
}

describe('#764 — the item goal is cleared around itself', () => {
  it('the default samples a ring at the goal’s base plane, and the finish leaves it at the rim Z', () => {
    const target = goal(zOut);
    const hf = sampleGoalHeightfield(target, {
      pitchMm: PITCH,
      clear: { kind: 'ring', widthMm: RING_WIDTH },
      stockRect: STOCK_RECT,
      baseZ: BASE_Z,
    });
    // A cell just outside the footprint's edge is part of the surface, at the base plane; a cell
    // well beyond the ring is left at the stock top as before.
    const inside = (x: number, y: number): number => {
      const i = Math.round((x - hf.x0) / hf.pitch);
      const j = Math.round((y - hf.y0) / hf.pitch);
      return j * hf.nx + i;
    };
    const band = inside(CX + A + 1.5, CY);
    expect(hf.covered[band]!).toBe(1);
    expect(hf.z[band]!).toBeCloseTo(BASE_Z, 5);
    // The expanded grid's corner is beyond the band's reach round the ellipse: it is left as it
    // was, at the stock top (the grid ends at the ring's outer edge along the axes; the corners
    // of that rectangle are further from the part than the width).
    const corner = inside(hf.x0 + 0.3, hf.y0 + 0.3);
    expect(hf.covered[corner]!).toBe(0);
    expect(hf.z[corner]!).toBeCloseTo(0, 5);
    // The grid now reaches past the footprint by the ring's width.
    expect(hf.x0).toBeLessThanOrEqual(CX - A);
    expect(hf.x0 + (hf.nx - 1) * hf.pitch).toBeGreaterThanOrEqual(CX + A + RING_WIDTH - 1e-6);

    // The finishing pass over that field leaves the ring's floor at the rim Z.
    const grid = sweep(finishingOf(hf).moves);
    const midRing = CX + A + 1.15; // > one ball radius from both walls
    expect(heightAt(grid, midRing, CY)).toBeCloseTo(BASE_Z, 1);
  });

  it('“nothing” keeps the pre-#764 cut: the stock outside the footprint stands', () => {
    // The pre-#764 grid is the footprint's own bounding box, so the probe is a corner of that box
    // outside the ellipse — in the grid, uncovered, and left at the stock top by the finish.
    const hf = sampleGoalHeightfield(goal(zOut), { pitchMm: PITCH });
    const px = CX + A - 1;
    const py = CY + B - 1;
    const i = Math.round((px - hf.x0) / hf.pitch);
    const j = Math.round((py - hf.y0) / hf.pitch);
    expect(hf.covered[j * hf.nx + i]!).toBe(0);
    const grid = sweep(finishingOf(hf).moves);
    expect(heightAt(grid, px, py)).toBeCloseTo(0, 1);
  });

  it('“the whole blank” clears the stock’s own rectangle to the base plane', () => {
    const hf = sampleGoalHeightfield(goal(zOut), {
      pitchMm: PITCH,
      clear: { kind: 'whole' },
      stockRect: STOCK_RECT,
      baseZ: BASE_Z,
    });
    expect(hf.x0).toBeCloseTo(0, 6);
    expect(hf.y0).toBeCloseTo(0, 6);
    const i = Math.round((1 - hf.x0) / hf.pitch);
    const j = Math.round((1 - hf.y0) / hf.pitch);
    const k = j * hf.nx + i;
    expect(hf.covered[k]!).toBe(1);
    expect(hf.z[k]!).toBeCloseTo(BASE_Z, 5);
  });
});

describe('#764 — the goal row wires it, and a mold is unchanged', () => {
  function generate(surface: EngraveTargetObject['surface'], goalMode?: 'item' | 'mold') {
    const target = goal(zOut, { surface, ...(goalMode === undefined ? {} : { goalMode }) });
    const j = job(target);
    return generateGoalProgram(j, j.targetObject!, BALL_TOOL, [], null, {});
  }

  it('the default clears a ring one cutter diameter plus a step-over wide, and says so', () => {
    const out = generate({ finishStepOverMm: FINISH_STEP });
    expect(out.errors).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.surface3d!.resolutionNote).toContain(`cleared a ${RING_WIDTH} mm band`);
    expect(out.surface3d!.notes.some((n) => n.startsWith('Cleared a 2.3 mm band'))).toBe(true);
  });

  it('“nothing” and a mold carry no clear note', () => {
    const none = generate({ clearAround: 'none' });
    expect(none.ok).toBe(true);
    expect(none.surface3d!.resolutionNote).not.toContain('cleared');
    expect(none.surface3d!.notes.some((n) => n.startsWith('Cleared'))).toBe(false);
    const mold = generate({ clearAround: 'ring' }, 'mold');
    expect(mold.ok).toBe(true);
    expect(mold.surface3d!.resolutionNote).not.toContain('cleared');
    expect(mold.surface3d!.notes.some((n) => n.startsWith('Cleared'))).toBe(false);
  });
});
