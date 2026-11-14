// #1277 — A RESTORED ROTARY RUN IS RE-CHECKED IN ITS OWN FRAME, AGAINST THE SHOP'S ROTARY LIMITS.
//
// `recheckStoredPrograms` builds the verifier's context from the setup record, and its facts never
// stated the rotary frame, so every program of a restored ROTARY run was read as flat: the A words
// are foreign to the flat dialect and the recheck refused it with `not-our-dialect` ×6, whatever
// the job, the setups or any limit (it failed closed, for the wrong reason). The facts now state
// `rotary: rotaryMapOf(job, defaults)` with the shop's map passed by the caller; a flat job states
// none and is re-checked exactly as before.
//
// Three cases per rod job (the probe that found it): no setups / recommendation, no setups / a
// tighter shop keep-out, setups / a tighter shop keep-out. The keep-out test is only possible now.
import { describe, expect, it } from 'vitest';

import { jobMachine } from '@/engine/cnc/calibration';
import { defaultEngraveJob, newEngraveLabelId } from '@/engine/cnc/engrave/defaults';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { recheckStoredPrograms } from '@/engine/cnc/engrave/restoredRun';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';

const ORIENTATION = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

/** A ⌀10 rod in the chuck; with `withSetups`, one stated setup, so `job.setups` is defined. */
function rotaryJob(withSetups: boolean): EngraveJob {
  const base = defaultEngraveJob();
  const setup = { id: 'setup-1', orientation: ORIENTATION, mount: { kind: 'rotary' }, itemIds: ['shp-1'], tools: ['flat-1.0'] } as unknown as JobSetup;
  return {
    ...base,
    name: 'rotary-restored',
    stock: { length: 60, width: 10, thickness: 10, material: 'pla', shape: 'cylinder', diameter: 10 },
    workholding: { kind: 'rotary-chuck', rotary: { stickout: 50, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' } },
    labels: [],
    shapes: [{ id: 'shp-1', kind: 'rect', position: { x: 20, y: 15 }, rotation: 0, depth: 0.5, enabled: true, width: 10, height: 6, cornerRadius: 0 }],
    toolKey: 'flat-1.0',
    ...(withSetups ? { setups: [setup] } : {}),
  } as unknown as EngraveJob;
}

/** The post's own rotary shape, ending its cut at `x`: a 1 mm cutter's edge is then at `x − 0.5`. */
const rotaryProgram = (x: number): string =>
  ['%', 'G17 G21 G54 G90', 'M5', 'T1M6', 'G01 Z15 F200', 'G01 Y0 Z15', 'M3 S12000', 'G0 X20 Z15 A0', 'G1 Z4.5 F100', `G1 X${x} F500`, 'G0 Z15', 'G92.4A0S0', 'M9', 'M5', 'M30'].join('\n');

const CLEAN: VerifyReport = { ok: true, findings: [], stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [1, 1, 0] } } };
/** What an OLDER build's verifier said about the same bytes. */
const OLD_REFUSAL: VerifyReport = {
  ok: false,
  findings: [{ severity: 'error', code: 'cut-too-deep', line: 2, message: 'an older build refused this' }],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: -9, bbox: { min: [0, 0, 0], max: [1, 1, 0] } },
};

function generated(nc: string, stored: VerifyReport = CLEAN): EngraveGenerated {
  return {
    ok: true, stage: 'done', findings: [], errors: [], nc, verify: null, predicted: [],
    programs: [{ setupIndex: 1, setupId: 'setup-1', toolKey: 'flat-1.0', nc, programHash: 'h', frameNc: null, frameVerify: null, cam: null, verify: stored }],
  } as unknown as EngraveGenerated;
}

/** The shop tightened the jaws' keep-out from the recommendation (3 mm) to 8 mm. */
const TIGHT: ShopDefaults = {
  'rotary.jawKeepOutMm': { value: 8, source: 'chosen', setAt: '2026-11-14T00:00:00.000Z', unit: 'mm', note: null },
} as ShopDefaults;

function recheck(job: EngraveJob, defaults: ShopDefaults | null, nc: string, stored: VerifyReport = CLEAN) {
  const machine = jobMachine(job, null);
  return recheckStoredPrograms({
    job,
    generated: generated(nc, stored),
    machine,
    mount: null,
    // The caller's job-wide setup (used when the job states no setups) is built WITH the map, as the store does.
    setup: toSetup(job, machine, undefined, null, undefined, defaults),
    defaults,
  });
}

const codes = (r: ReturnType<typeof recheck>): string[] => r.errors.map((e) => e.finding.code);

describe('#1277 a restored rotary run is re-checked in the rotary frame', () => {
  for (const withSetups of [false, true]) {
    const label = withSetups ? 'with job.setups' : 'without job.setups';

    it(`${label}: its own programs recheck CLEAN at the recommendation (no more not-our-dialect)`, () => {
      const r = recheck(rotaryJob(withSetups), null, rotaryProgram(7));
      expect(codes(r)).toEqual([]);
      expect(r.generated.programs[0]!.verify!.ok).toBe(true);
    });

    it(`${label}: a tighter shop jaw keep-out refuses the stored program that violates it`, () => {
      const r = recheck(rotaryJob(withSetups), TIGHT, rotaryProgram(7));
      expect(codes(r)).toContain('wrap-into-clamp');
      expect(codes(r)).not.toContain('not-our-dialect');
      expect(r.generated.programs[0]!.verify!.ok).toBe(false);
    });

    it(`${label}: a real mismatch still fails, for its own reason (an edge inside the recommended 3 mm too)`, () => {
      const r = recheck(rotaryJob(withSetups), null, rotaryProgram(3.4));
      expect(codes(r)).toContain('wrap-into-clamp');
      expect(codes(r)).not.toContain('not-our-dialect');
    });
  }

  it('an older build’s refusal of the same clean bytes is replaced by this build’s reading', () => {
    const r = recheck(rotaryJob(false), null, rotaryProgram(7), OLD_REFUSAL);
    expect(codes(r)).toEqual([]);
    expect(r.generated.programs[0]!.verify!.ok).toBe(true);
    expect(r.generated.programs[0]!.verify!.findings).toEqual([]);
  });

  it('the bytes are untouched: this is a check, not a re-plan', () => {
    const nc = rotaryProgram(7);
    expect(recheck(rotaryJob(false), TIGHT, nc).generated.programs[0]!.nc).toBe(nc);
  });

  it('the REAL program the generator posts for a rod in the chuck rechecks clean in this frame', async () => {
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      name: 'Zoomba on a dowel',
      stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
      workholding: { kind: 'rotary-chuck', rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' } },
      labels: [
        { id: newEngraveLabelId(), text: 'Zoomba', font: DEFAULT_FONT_ID, weight: 'bold', size: 5, position: { x: 42.5, y: Math.PI * 10 }, rotation: 0, depth: 0.5, enabled: true },
      ],
      shapes: [],
      toolKey: 'flat-1.0',
    } as EngraveJob;
    const g = await generate(tl, job);
    expect(g.ok).toBe(true);
    const machine = jobMachine(job, null);
    const out = recheckStoredPrograms({
      job,
      generated: g,
      machine,
      mount: null,
      setup: toSetup(job, machine, undefined, null, undefined, null),
      defaults: null,
    });
    expect(out.errors.map((e) => e.finding.code)).toEqual([]);
    expect(out.generated.programs.every((p) => p.verify !== null && p.verify.ok)).toBe(true);
  });
});
