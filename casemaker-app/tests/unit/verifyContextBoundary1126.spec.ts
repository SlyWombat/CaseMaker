// #1126 — WHAT THE POSTING KNEW IS STORED; WHAT THE JOB STATES IS DERIVED AGAIN, BY THE SAME FUNCTION.
//
// The stored context holds the hop, the allowances, the through geometry and the layer sections.
// The footprint and the mount's obstacles come from the job, the shop and the machine, so the
// re-check asks the same functions the first verification asked and must hand the verifier the same
// boxes. Spy on the real `verifyProgram` and compare what it is given at generation and at re-check.
import { describe, expect, it, vi } from 'vitest';

import type { VerifyContext } from '@/engine/cnc/verify';

const seen: { text: string; ctx: VerifyContext }[] = [];
vi.mock('@/engine/cnc/verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/cnc/verify')>();
  return {
    ...actual,
    verifyProgram: (text: string, ctx: VerifyContext) => {
      seen.push({ text, ctx });
      return actual.verifyProgram(text, ctx);
    },
  };
});

import { jobMachine } from '@/engine/cnc/calibration';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobMountObstacles, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { recheckStoredPrograms } from '@/engine/cnc/engrave/restoredRun';
import { presetPartOnBoard } from '@/engine/cnc/sacrificial';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';
import { trimGenerated, type EngraveGeneratedFull, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';

const ORIENTATION = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

function firstByText(from: number): Map<string, VerifyContext> {
  const out = new Map<string, VerifyContext>();
  for (const { text, ctx } of seen.slice(from)) if (!out.has(text)) out.set(text, ctx);
  return out;
}

/** Generate, then re-check the JSON round-tripped result; hand back both contexts per program text. */
async function generateAndRecheck(job: EngraveJob, shop: EngraveShopOpts, mount: ReturnType<typeof jobMountObstacles>) {
  const from = seen.length;
  const g: EngraveGeneratedFull = await generate(tl, job, null, [], undefined, shop);
  expect(g.ok, JSON.stringify(g.errors) + JSON.stringify(g.findings.filter((f) => f.severity === 'error')) + JSON.stringify(g.verify?.findings)).toBe(true);
  const first = firstByText(from);
  const afterGeneration = seen.length;
  const machine = jobMachine(job, null);
  recheckStoredPrograms({
    job,
    generated: JSON.parse(JSON.stringify(trimGenerated(g))),
    machine,
    mount,
    setup: toSetup(job, machine, mount?.fixture, null, undefined, null),
    defaults: null,
  });
  return { g, first, again: firstByText(afterGeneration) };
}

describe('#1126 — the footprint and the mount are derived again, not stored', () => {
  it('a setup that states its own box: the verifier is handed the same footprint at first verification and at re-check', async () => {
    const base = defaultEngraveJob();
    const top = { id: 'setup-top', orientation: ORIENTATION, mount: { kind: 'tape' }, itemIds: ['part'], tools: ['flat-1.0'] } as unknown as JobSetup;
    const flip = {
      id: 'setup-flip',
      orientation: ORIENTATION,
      mount: { kind: 'tape' },
      itemIds: ['part2'],
      tools: ['flat-1.0'],
      flip: { method: 'free-then-flip', axis: 'left-right' },
      stock: { length: 60, width: 40, thickness: 6, provenance: 'stated' },
    } as unknown as JobSetup;
    const job = {
      ...base,
      stock: { ...base.stock, length: 100, width: 70, thickness: 8 },
      toolKey: 'flat-1.0',
      sacrificial: presetPartOnBoard(),
      labels: [],
      shapes: [
        { id: 'part', name: 'Part', kind: 'rect', position: { x: 50, y: 35 }, rotation: 0, width: 20, height: 10, depth: 0.5, cornerRadius: 0, enabled: true },
        { id: 'part2', name: 'Part2', kind: 'rect', position: { x: 30, y: 20 }, rotation: 0, width: 20, height: 10, depth: 0.5, cornerRadius: 0, enabled: true },
      ],
      setups: [top, flip],
    } as unknown as EngraveJob;
    const { g, first, again } = await generateAndRecheck(job, {}, null);
    expect(g.programs.length).toBeGreaterThanOrEqual(2);
    let compared = 0;
    for (const program of g.programs) {
      const original = first.get(program.nc);
      if (original === undefined) continue;
      const rechecked = again.get(program.nc);
      expect(rechecked, `setup ${program.setupIndex} is re-verified`).toBeDefined();
      expect(rechecked!.footprint, `setup ${program.setupIndex}: footprint`).toEqual(original.footprint);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(2);
  });

  it('a bracket mount: the obstacle boxes the re-check hands the verifier equal the first verification’s', async () => {
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      toolKey: 'flat-1.0',
      workholding: { kind: 'bracket', bracket: { anchor: 1, variant: 'thin', clamps: [{ edge: 'right', at: 6 }], source: 'default' } },
    } as EngraveJob;
    const mount = jobMountObstacles(job, null);
    expect(mount, 'the bracket models obstacles').not.toBeNull();
    expect(mount!.obstacles.length).toBeGreaterThan(0);
    const { g, first, again } = await generateAndRecheck(job, { mount }, mount);
    let compared = 0;
    for (const program of g.programs) {
      const original = first.get(program.nc);
      if (original === undefined) continue;
      expect(original.mountObstacles?.obstacles.length ?? 0).toBeGreaterThan(0);
      expect(again.get(program.nc)!.mountObstacles).toEqual(original.mountObstacles);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });
});
