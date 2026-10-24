// #625 — judge the exact-sweep density cap in the blank's SURFACE frame, not the lifted work frame.
//
// #608's re-post against a measured tilt lifts every FEED move's Z by the fitted plane's lift at its
// XY. A flat job that is well under the exact 2.5D sweep's `MAX_CHECKPOINTS` cap then reads as
// "dense 3D" by the lift alone — every move carries its own Z, so every move is its own (segment, Z)
// run — and the density gate routed it to the COLUMN engine, whose staircase disagreed with the exact
// boundary by more than the oracle's 4-cell area floor (0.836 mm² under-cut on the 2026-10-24 bench;
// issue #625).
//
// The fix sweeps the surface-frame image of the program: subtract the lift from every FEED at its XY
// (the exact inverse of `applySurfaceLift`) and re-bucket, so the flat job reads as the flat program
// it is and stays on the exact engine — whose verdict is then identical to the flat post by
// construction — while a genuinely dense program keeps its genuinely distinct levels and still routes
// to the column engine. The column engine keeps #623's seat + surface grid; the exact engine no longer
// seats or shears, because the un-lift IS the surface frame for a flat program.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession, type SimLoadOk, type SimLoadResult } from '@/workers/sim/session';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { type SurfaceFrame } from '@/engine/cnc/engrave/surfacePlane';
import { ORACLE_AREA_FLOOR, type OracleReport } from '@/engine/cnc/engrave/oracle';
import { Z1 } from '@/engine/cnc/machine';
import { MAX_CHECKPOINTS } from '@/workers/geometry/sweep';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';

/**
 * The ~0.29 mm tilt the bench saw: 0.002 mm/mm of X + 0.0015 mm/mm of Y across the 100 × 60 default
 * blank is 0.29 mm at the far corner. Small enough to post (the shallowest label is 0.5 mm), large
 * enough that the lifted 3-label program crosses `MAX_CHECKPOINTS` (2628 runs on the bench).
 * `z0 = 0`: the reference touch is the plane at the origin.
 */
const TILT: SurfaceFrame = { plane: { offset: 0, slopeX: 0.002, slopeY: 0.0015 }, z0: 0 };

/** The default 3-label job (100 × 60, labels 0.5 / 1 / 2 mm) on a 1 mm flat end mill — the exact engine. */
function defaultJob(): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, name: 'surface lift density', toolKey: 'flat-1.0' };
}

function load(job: EngraveJob, nc: string, tool: Tool, surface: SurfaceFrame | null): { session: ReturnType<typeof createSimSession>; result: SimLoadResult } {
  const session = createSimSession(tl);
  const result = session.load(nc, toSetup(job, Z1), tool, Z1.id, surface === null ? undefined : { surface });
  return { session, result };
}

function expectExactEngine(r: SimLoadResult): void {
  expect(r.ok).toBe(true);
  const ok = r as SimLoadOk;
  // The exact sweep that cut material yields a removal ghost; the column engine never does.
  expect(ok.meshes.removal).not.toBeNull();
  // And it was not refused by the density cap, by name.
  expect(ok.diagnostics.some((d) => d.code === 'dense-3d-refused')).toBe(false);
}

function expectColumnEngine(r: SimLoadResult): void {
  expect(r.ok).toBe(true);
  const ok = r as SimLoadOk;
  // The column (dexel) engine builds no removal ghost.
  expect(ok.meshes.removal).toBeNull();
  expect(ok.diagnostics.some((d) => d.code === 'dense-3d-refused')).toBe(false);
}

describe('surface-frame density (#625)', () => {
  it('a flat 3-label job re-posted with a 0.29 mm tilt stays on the EXACT engine and matches flat', () => {
    const job = defaultJob();
    const tool = jobTool(job)!;
    const flatGen: EngraveGenerated = generate(tl, job);
    const liftGen: EngraveGenerated = generate(tl, job, null, [], undefined, { surface: TILT });
    if (flatGen.nc === null || liftGen.nc === null) {
      throw new Error(`generate refused — flat ${flatGen.stage} | lifted ${liftGen.stage}: ${[...flatGen.errors, ...liftGen.errors].map((e) => e.message).join('; ')}`);
    }
    // The package really does follow the tilt.
    expect(liftGen.surface).toEqual(TILT);
    expect(liftGen.nc).not.toBe(flatGen.nc);

    const flat = load(job, flatGen.nc, tool, null);
    const lifted = load(job, liftGen.nc, tool, TILT);
    try {
      // The flat post is the control: it sweeps on the exact engine (a removal ghost), under the cap.
      expectExactEngine(flat.result);
      // The fix: the same job lifted by the tilt is NOT routed to the column engine by the lift alone.
      expectExactEngine(lifted.result);

      const flatReport: OracleReport = flat.session.oracle(flatGen.predicted);
      const liftedReport: OracleReport = lifted.session.oracle(liftGen.predicted);
      expect(flatReport.frame).toBe('work');
      expect(liftedReport.frame).toBe('surface');
      expect(liftedReport.ok).toBe(true);
      // Identical to flat by construction (the exact engine swept the un-lifted flat program): ~0.
      expect(liftedReport.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(Math.abs(liftedReport.worst.underCut - flatReport.worst.underCut)).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      expect(Math.abs(liftedReport.worst.overCut - flatReport.worst.overCut)).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
    } finally {
      flat.session.dispose();
      lifted.session.dispose();
    }
  });

  it('a genuinely dense flat program still routes to the COLUMN engine even when a surface is set', () => {
    // MAX_CHECKPOINTS + 1 causal runs (each plunge is its own run), exactly as simSessionDenseFlat.
    const lines = ['S1000 M3'];
    for (let i = 0; i < MAX_CHECKPOINTS + 1; i++) {
      lines.push(`G0 X${10 + (i % 50)} Y${10 + (i % 7)} Z1`, `G1 Z${i % 2 ? -0.5 : -1} F100`, `G1 X${12 + (i % 50)}`, 'G0 Z1');
    }
    const nc = lines.join('\n');
    const tool = flatEndMill(1);
    const job = defaultJob();

    const session = createSimSession(tl);
    try {
      // Loaded WITH the surface: the un-lift must not collapse a program that is dense on its own.
      const r = session.load(nc, toSetup(job, Z1), tool, Z1.id, { surface: TILT });
      expectColumnEngine(r);
    } finally {
      session.dispose();
    }
  });
});
