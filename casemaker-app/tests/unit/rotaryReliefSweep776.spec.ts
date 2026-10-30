/**
 * #776 — THE LOBED-SHAFT RELIEF AT CUT RESOLUTION, swept within a budget.
 *
 * The job is `tests/e2e/rotaryReliefPreview.spec.ts`'s own lobed shaft (r(θ) = 8 + 1.2·cos 3θ over
 * 20 mm on a ⌀20 rod), generated through the app's pipeline and swept by the real column engine.
 * The e2e had to give the target a coarse surface (1 046 checkpoints) because a union per
 * checkpoint took hours; these tests hold the engine to the cut-resolution job instead:
 *
 *  - the span sweep changed no removal: on the COARSE job the grid and the removed volume are
 *    bit-identical to the per-column path it replaced (`noSpanSweep`), and
 *  - the CUT-RESOLUTION job finishes inside the stated 30 s budget, while reporting progress on
 *    every checkpoint and stopping at a budget it cannot meet.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { tl } from './helpers/manifoldExec';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { jobMachine } from '@/engine/cnc/calibration';
import { parseGcode } from '@/engine/cnc/gcode/interpreter';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { columnSweep, type ColumnSweepOk, type ColumnOutcome } from '@/workers/geometry/columnEngine';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

type V = [number, number, number];
type Tri = [V, V, V];
const TAU = Math.PI * 2;
const ROD_RADIUS = 10;
const LENGTH = 20;

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

/** The lobed side, as rings along the axis: r(θ) at every station (the e2e's own mesh). */
function lobedSide(maxLobe: number, length = LENGTH, rings = 20, seg = 144): Tri[] {
  const tris: Tri[] = [];
  const at = (i: number, s: number): V => {
    const x = -length / 2 + (i / rings) * length;
    const a = (s / seg) * TAU;
    const r = 8 + (maxLobe - 8) * Math.cos(3 * a);
    return [x, r * Math.sin(a), r * Math.cos(a)];
  };
  for (let i = 0; i < rings; i++) {
    for (let s = 0; s < seg; s++) {
      tris.push([at(i, s), at(i + 1, s), at(i + 1, s + 1)], [at(i, s), at(i + 1, s + 1), at(i, s + 1)]);
    }
  }
  return tris;
}

function target(maxLobe: number, coarse: boolean): EngraveTargetObject {
  const data = stl(lobedSide(maxLobe));
  const sha256 = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
  return {
    id: 'lobed-shaft',
    name: 'lobed-shaft.stl',
    format: 'stl',
    sha256,
    data,
    size: { x: LENGTH, y: 18, z: 18 },
    position: { x: 30, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    // The e2e's coarse override, verbatim. Absent = the job's own cut resolution.
    ...(coarse
      ? {
          surface: {
            gridPitchMm: 1,
            roughStepOverMm: 3,
            roughStepDownMm: 2,
            finishStepOverMm: 2.5,
            stockToLeaveMm: 0.3,
          },
        }
      : {}),
  };
}

function reliefJob(coarse: boolean): EngraveJob {
  const job = defaultEngraveJob();
  job.name = 'Lobed shaft relief';
  job.stock = {
    ...job.stock,
    length: 100,
    width: 2 * ROD_RADIUS,
    thickness: 2 * ROD_RADIUS,
    material: 'pla',
    shape: 'cylinder',
    diameter: 2 * ROD_RADIUS,
  };
  job.workholding = {
    kind: 'rotary-chuck',
    rotary: { stickout: 60, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
  };
  job.labels = [];
  job.shapes = [];
  job.targetObject = target(9.2, coarse);
  job.toolKey = 'flat-3.175x12-metal';
  return job;
}

/** Generate the relief program and hand back the timeline the sweep reads. */
function reliefTimeline(coarse: boolean) {
  const job = reliefJob(coarse);
  const tool = jobTool(job);
  if (tool === null) throw new Error('the lobed shaft names a tool the registry cannot resolve');
  const gen = engraveGenerate(tl, job, tool, [], null, undefined, {});
  expect(gen.ok, gen.errors.join('; ')).toBe(true);
  const nc = gen.programs[0]?.nc;
  if (nc === undefined) throw new Error('the relief posted no program');
  const mill = jobMachine(job, null);
  const setup = toSetup(job, mill, undefined, null);
  const timeline = buildTimeline(parseGcode(nc), setup, mill);
  return { timeline, tool, setup };
}

function swept(outcome: ColumnOutcome): ColumnSweepOk {
  expect(outcome.ok, outcome.ok ? '' : outcome.diagnostics.map((d) => d.message).join('; ')).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  return outcome;
}

describe('#776 — the lobed-shaft relief', () => {
  it('the coarse case removes EXACTLY what the per-column sweep removed', { timeout: 120_000 }, () => {
    const { timeline, tool, setup } = reliefTimeline(true);
    const legacy = swept(columnSweep(timeline, tool, setup, { noSpanSweep: true }));
    const fast = swept(columnSweep(timeline, tool, setup, {}));

    expect(fast.count).toBe(legacy.count);
    expect(fast.count).toBeGreaterThan(500); // the coarse job is still a real sweep
    expect(fast.stats.removedVolume).toBe(legacy.stats.removedVolume);
    expect(fast.grid.nu).toBe(legacy.grid.nu);
    expect(fast.grid.nv).toBe(legacy.grid.nv);
    // Cell for cell, not merely the total: a column that moved would be a different cut.
    let diff = -1;
    for (let i = 0; i < legacy.grid.h.length; i++) {
      if (!Object.is(legacy.grid.h[i], fast.grid.h[i])) {
        diff = i;
        break;
      }
    }
    expect(diff).toBe(-1);
  });

  it('the cut-resolution case sweeps inside a 30 s budget, reporting every checkpoint', { timeout: 120_000 }, () => {
    const { timeline, tool, setup } = reliefTimeline(false);
    let lastDone = 0;
    let total = 0;
    const out = swept(
      columnSweep(timeline, tool, setup, {
        budgetMs: 30_000,
        onProgress: (done, count) => {
          lastDone = done;
          total = count;
        },
      }),
    );
    expect(out.count).toBeGreaterThan(50_000); // this is the cut-resolution program, not the e2e's coarse one
    expect(out.stats.removedVolume).toBeGreaterThan(0);
    // Progress is the panel's "sweeping k / n checkpoints" and the worker's cancel signal; the
    // last report must be the whole program, not a prefix.
    expect(total).toBe(out.count);
    expect(lastDone).toBe(out.count);
  });

  it('a budget it cannot meet refuses by name rather than running on', { timeout: 120_000 }, () => {
    const { timeline, tool, setup } = reliefTimeline(true);
    const out = columnSweep(timeline, tool, setup, { budgetMs: 0 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.diagnostics.some((d) => d.code === 'sweep-budget-exceeded')).toBe(true);
  });
});
