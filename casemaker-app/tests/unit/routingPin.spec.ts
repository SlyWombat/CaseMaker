// #786 slice 4a — THE SIM-ROUTING PIN (table B's routing row).
//
// The six routing codes are internal sweep guards, never a job refusal. This spec states the three
// paths an operator can actually reach:
//   1. a DENSE FLAT program is swept by the column engine (`dense-3d-refused` never surfaces);
//   2. a WRAPPED ROTARY program is swept by the column engine (`rotary-job` never surfaces);
//   3. an INDEXED-ROTARY rest pass, which the exact engine cannot seed, is re-swept FROM THE BLANK
//      by the run walk, with the note that says so (`prior-removal-rotary` names the retry, not
//      the end of the run).
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { createSimSession, type SimLoadOk } from '@/workers/sim/session';
import { sweepPrograms } from '@/engine/cnc/engrave/programSweep';
import { MAX_CHECKPOINTS } from '@/workers/geometry/sweep';
import { stubSetup } from '@/engine/cnc/setup';
import { flatEndMill } from '@/engine/cnc/tool';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

const flat = flatEndMill(1);

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const prism = () => stubSetup(SLAB, { kind: 'tape-down', contact: SLAB.outline });
const cylinder = () => stubSetup({ kind: 'cylinder', diameter: 20, length: 30 }, { kind: 'rotary-chuck', jawDiameter: 25, stickout: 30 });

/** A flat-end-mill program with more than the exact sweep's checkpoint cap. */
function denseFlatProgram(): string {
  const lines = ['S1000 M3'];
  for (let i = 0; i < MAX_CHECKPOINTS + 1; i++) {
    lines.push(`G0 X${10 + (i % 50)} Y${10 + (i % 7)} Z1`, `G1 Z${i % 2 ? -0.5 : -1} F100`, `G1 X${12 + (i % 50)}`, 'G0 Z1');
  }
  return lines.join('\n');
}

const WRAPPED = ['S1000 M3', 'G0 X0 Y0 Z30 A0', 'G1 Z5 F100', 'G1 A360 F500', 'G0 Z30'].join('\n');
/** Indexed: A changes only BETWEEN cuts, so the exact engine is the right one. */
const INDEXED = ['S1000 M3', 'G0 X2 Y0 Z30 A0', 'G1 Z5 F100', 'G1 X10', 'G0 Z30', 'G0 A90', 'G1 Z5 F100', 'G1 X10', 'G0 Z30'].join('\n');

/** A minimal solid — the refusal under test happens before the seed is ever read. */
function seedMesh(): NodeMeshOutput {
  return {
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    triangleCount: 2,
    vertexCount: 4,
    bbox: { min: [0, 0, 0], max: [10, 10, 0] },
    componentCount: 1,
  };
}

describe('#786 slice 4a — the sim-routing codes never surface as job refusals', () => {
  it('a dense flat program is swept by the column engine, not refused dense-3d-refused', () => {
    const session = createSimSession(tl);
    try {
      const r = session.load(denseFlatProgram(), prism(), flat, null);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r as SimLoadOk).stats.engine).toBe('column');
      expect(r.diagnostics.some((d) => d.code === 'dense-3d-refused')).toBe(false);
    } finally {
      session.dispose();
    }
  });

  it('a wrapped rotary program is swept by the column engine, not refused rotary-job', () => {
    const session = createSimSession(tl);
    try {
      const r = session.load(WRAPPED, cylinder(), flat, null);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r as SimLoadOk).stats.engine).toBe('column');
      expect(r.diagnostics.some((d) => d.code === 'rotary-job')).toBe(false);
    } finally {
      session.dispose();
    }
  });

  it('an indexed-rotary seed is re-swept from the blank, and the note says so', async () => {
    const session = createSimSession(tl);
    const seeded: boolean[] = [];
    try {
      const outcome = await sweepPrograms({
        programs: [{ kind: 'engrave', toolKey: 'flat-1', nc: INDEXED }],
        // The program starts ON material a previous pass left: that is the seed an indexed rotary
        // pass cannot take, and the walk retries it from the blank.
        initialRemoval: [seedMesh()],
        shopDrillPoint: null,
        cutterFor: () => flat,
        load: async ({ priorRemoval }) => {
          const seed = [...(priorRemoval ?? [])];
          seeded.push(seed.length > 0);
          return session.load(INDEXED, cylinder(), flat, null, seed.length > 0 ? { priorRemoval: seed } : {});
        },
        aborted: () => false,
      });
      expect(outcome.ok, JSON.stringify(outcome.ok ? '' : outcome.failed?.diagnostics)).toBe(true);
      if (!outcome.ok) return;
      const sweep = outcome.sweeps[0]!;
      // The exact engine cannot seed an indexed rotary pass: the walk re-swept it from the blank.
      expect(sweep.fromBlank).toBe(true);
      expect(sweep.fromBlankCode).toBe('prior-removal-rotary');
      expect(sweep.notes[0]?.message).toContain('was swept from the blank');
      expect(seeded).toEqual([true, false]);
      // And the blank sweep is a real one: the exact engine ran on the cylinder.
      expect(sweep.engine).toBe('exact');
      expect(sweep.errorCount).toBe(0);
    } finally {
      session.dispose();
    }
  });

  it('a normal flat job still takes the exact sweep (the routing above did not change it)', () => {
    const session = createSimSession(tl);
    try {
      const r = session.load(['S1000 M3', 'G0 X10 Y10 Z1', 'G1 Z-0.5 F100', 'G1 X40', 'G0 Z1'].join('\n'), prism(), flat, null);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r as SimLoadOk).stats.engine).toBe('exact');
    } finally {
      session.dispose();
    }
  });
});
