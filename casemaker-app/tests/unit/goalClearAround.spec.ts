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
import { sampleGoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

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

// ── The cutter and the ring ──────────────────────────────────────────────────────────────────────
/** Makera's ⌀2 ball (the demo's own cutter). */
const BALL_R = 1;
const BALL_TOOL = flatEndMill(2 * BALL_R, { shape: 'ball', name: '2 mm ball nose' });

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
  // "the default samples a ring at the goal's base plane, and the finish leaves it at the rim Z"
  // and "'nothing' keeps the pre-#764 cut..." are deleted here, not fixed: both called
  // generateSurface3dIR directly (via the now-removed finishingOf helper) to independently
  // sweep the finish's own surface, bypassing generateGoalProgram's real dispatch entirely —
  // #966 retired that function along with the rest of surface3d.ts. The heightfield sampling
  // itself (sampleGoalHeightfield's own clear-band behaviour) is untouched by #966 and still
  // proven by the third case below.

  // #982 pin — the fixture's ball-only set through the ONE model entry: no flat is the ball
  // fallback, never a refusal.
  it('#982 pin — a ball-only set plans the item through planModelCam (no flat: the ball floor pass)', async () => {
    const target = goal(zOut);
    const j = job(target);
    const { buildModelPlanInputForGoal } = await import('@/workers/sim/engraveGenerate');
    const { planModelCam } = await import('@/engine/cnc/cam/model/plan');
    const modelInput = await buildModelPlanInputForGoal(j, j.targetObject!, BALL_TOOL, {});
    const modelOut = await planModelCam(modelInput);
    expect(modelOut.perSetup[0]!.programs.length, 'no program was planned').toBeGreaterThan(0);
    expect(modelOut.perSetup.flatMap((s) => s.notes).join('\n')).toContain('no flat end mill');
  }, 120_000);

  // #1151 (#1134(c)'s ruling) — THE OWNED PLAN FIRST. With a catalogue cutter the full run would
  // plan the ideal as well; the deferred run posts the owned plan and says the comparison is owed.
  it('#1151 — deferIdeal posts the owned plan and leaves the comparison to the caller', async () => {
    const { engraveGenerate, buildModelPlanInputForGoal } = await import('@/workers/sim/engraveGenerate');
    const { planOwnedOnly } = await import('@/engine/cnc/cam/model/twoPlans');
    const { tl } = await import('./helpers/manifoldExec');
    const j = job(goal(zOut));
    const catalogue = [flatEndMill(1.5, { shape: 'ball', name: '1.5 mm ball nose (catalogue)' })];
    const deferred = await engraveGenerate(tl, j, BALL_TOOL, [], null, undefined, {}, undefined, catalogue, { deferIdeal: true });
    expect(deferred.ok).toBe(true);
    expect(deferred.idealDeferred).toBe(true);
    expect(deferred.planIdeal ?? null, 'the ideal was not run').toBeNull();
    expect(deferred.planTradeoff ?? null, 'no comparison was stated').toBeNull();
    // The posted plan is the OWNED half, computed exactly as a two-plan Generate computes it
    // first: the ideal comparison cannot move the plan or the bytes.
    const modelInput = await buildModelPlanInputForGoal(j, j.targetObject!, BALL_TOOL, {}, undefined, catalogue, []);
    const owned = await planOwnedOnly(modelInput);
    expect(JSON.stringify(deferred.plan)).toBe(JSON.stringify(owned));
  }, 120_000);

  // #1151 — a job whose RECORDED CHOICE is the ideal posts the ideal itself, so it keeps today's
  // order and waits for both plans; the flag cannot turn it into an early owned result.
  it('#1151 — a job whose recorded choice is the ideal waits for both plans', async () => {
    const { engraveGenerate } = await import('@/workers/sim/engraveGenerate');
    const { tl } = await import('./helpers/manifoldExec');
    const j = { ...job(goal(zOut)), planChoice: 'ideal' as const };
    const catalogue = [flatEndMill(1.5, { shape: 'ball', name: '1.5 mm ball nose (catalogue)' })];
    const result = await engraveGenerate(tl, j, BALL_TOOL, [], null, undefined, {}, undefined, catalogue, { deferIdeal: true });
    expect(result.ok).toBe(true);
    expect(result.idealDeferred ?? false).toBe(false);
    expect(result.planIdeal ?? null).not.toBeNull();
  }, 240_000);

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

// #764/#966 — "the default clears a ring..." and "'nothing' and a mold carry no clear note" are
// deleted here, not fixed: both asserted `out.surface3d!.resolutionNote`/`.notes`, which no longer
// exist — `generateGoalProgram` posts only through `cam/model` now. NOT PORTED, NOT JUST RETARGETED:
// grepped `clearAround`/`goalClearBand`/`sampleGoalHeightfield` across `engraveGenerate.ts` after
// the seam removal — zero hits. The model-cam goal path works from the mesh directly
// (`buildModelPlanInputForGoal`/`recogniseFeatures`) and has no heightfield "uncovered cell" concept
// to clear at all; #764's actual fix (an item goal's surrounding stock, within a ring or the whole
// blank, cut down to the base plane instead of left standing in a pit) has no equivalent here and
// is, as far as this file's own tests can tell, simply gone for a goal under this engine. Flagged on
// #966 rather than guessed at — `sampleGoalHeightfield`'s own clear-band sampling (proven above) is
// real and correct, but nothing in the model-cam dispatch reads it.
