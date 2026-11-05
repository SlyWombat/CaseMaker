/**
 * #966 — THE SEAM (not the cutover). `generateGoalProgram` (`workers/sim/engraveGenerate.ts`) can
 * now route a goal job through EITHER engine, selected by `USE_MODEL_CAM_ENGINE`
 * (`engine/cnc/cam/model/plan.ts`, off by default — "set only by specs for now", that module's own
 * header):
 *
 *   - flag OFF (today's default): the old heightfield path (`generateSurface3dForGoal`) runs
 *     byte-for-byte unchanged — GREEN.
 *   - flag ON: `generateGoalProgram` builds a real `ModelPlanInput` from the SAME job/goal/tool and
 *     calls the real `planModelCam` — RED, but for a STATED reason, never a crash. Full #966 (the
 *     cutover: turning a `SetupPlan[]` into this function's posted `EngraveGenerated`, and removing
 *     the old engine) is a separate, later, two-owner pass — not built here. This spec documents
 *     today's actual state, not a hypothetical finished one, so it keeps meaning whatever `cam/
 *     model/plan.ts` lands next: either `planModelCam` itself refuses (still maturing elsewhere in
 *     #956) or it runs and this seam's own "conversion not implemented yet" statement fires — both
 *     are accepted, as long as the reason is NAMED, under the `#966` tag, never a bare stack trace.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { generateGoalProgram, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';

afterEach(() => {
  clearTargetObjectMeshCache();
  vi.doUnmock('@/engine/cnc/cam/model/plan');
  vi.resetModules();
});

// ── A small dome goal — the #764 shell formula at stick scale, fewer segments (speed only; the
// shape itself is the same proven relief: the apex touches the stock top, the base sits `H` below
// it, so there is genuine material to remove, not a degenerate flat plateau). ───────────────────
type V = [number, number, number];
type Tri = [V, V, V];
const A = 6;
const B = 4;
const H = 3;
const SEG = 10;
const BLANK = { length: 30, width: 20, thickness: 10 };
const CX = 15;
const CY = 10;

function domeHeight(x: number, y: number): number {
  const u2 = (x / A) ** 2 + (y / B) ** 2;
  if (u2 >= 1) return 0;
  return H * Math.sqrt(1 - u2);
}

function surfaceTris(): Tri[] {
  const at = (r: number, t: number): V => {
    const x = A * r * Math.cos(2 * Math.PI * t);
    const y = B * r * Math.sin(2 * Math.PI * t);
    return [x, y, domeHeight(x, y)];
  };
  const tris: Tri[] = [];
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < SEG; j++) {
      const p = at(i / SEG, j / SEG);
      const q = at((i + 1) / SEG, j / SEG);
      const r = at((i + 1) / SEG, (j + 1) / SEG);
      const s = at(i / SEG, (j + 1) / SEG);
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

function goalTarget(): EngraveTargetObject {
  return {
    id: 'goal-966',
    name: 'dome-966.stl',
    format: 'stl',
    sha256: 'f'.repeat(64),
    data: stl(surfaceTris()),
    size: { x: 2 * A, y: 2 * B, z: H },
    position: { x: CX, y: CY, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function jobFor(target: EngraveTargetObject): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, ...BLANK },
    targetObject: target,
  };
}

function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool: { ...tool, id: key, number: null }, provenance: 'test fixture' };
}

/** The finishing ball (the goal's own chosen cutter) and a flat — a real goal job's house carries
 * both; `cam/model/plan.ts`'s own pocket chain needs a flat, the curved pipeline needs the ball. */
const BALL: Tool = flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2', shape: 'ball', typeText: 'Ball Nose' });
const FLAT: Tool = flatEndMill(3, { number: 2, id: 'flat-3', name: 'flat-3' });
const SHOP: EngraveShopOpts = {
  tools: [entry('inv:ball-2', BALL), entry('inv:flat-3', FLAT)],
};

describe('#966 — generateGoalProgram routes through cam/model behind USE_MODEL_CAM_ENGINE', () => {
  it('flag off (the default): the old heightfield engine runs, green', async () => {
    const job = jobFor(goalTarget());
    const result = await generateGoalProgram(job, job.targetObject!, BALL, [], null, SHOP);
    expect(result.errors, result.errors.map((e) => `${e.stage}: ${e.message}`).join('\n')).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stage).toBe('done');
    expect(result.nc).not.toBeNull();
  });

  it('flag on: planModelCam is reachable with a real ModelPlanInput — red, for a named reason', async () => {
    vi.doMock('@/engine/cnc/cam/model/plan', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/engine/cnc/cam/model/plan')>();
      return { ...actual, USE_MODEL_CAM_ENGINE: true };
    });
    vi.resetModules();
    const { generateGoalProgram: generateGoalProgramModelCam } = await import('@/workers/sim/engraveGenerate');

    const job = jobFor(goalTarget());
    const result = await generateGoalProgramModelCam(job, job.targetObject!, BALL, [], null, SHOP);

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('cam');
    expect(result.errors).toHaveLength(1);
    const message = result.errors[0]!.message;
    // Named, under the #966 tag, one of the two seam-stated reasons — never a bare stack trace:
    // either `planModelCam` itself refused (still maturing elsewhere in #956/#957/#959/#960), or it
    // ran and this seam's own "the conversion is not built yet" statement fired.
    expect(message).toContain('cam/model seam (#966)');
    expect(message).toMatch(/planModelCam refused —|is not implemented yet \(the #966 seam only, not the cutover\)/);
    expect(message).not.toMatch(/\n\s+at /); // not a raw stack trace
  }, 30_000);
});
