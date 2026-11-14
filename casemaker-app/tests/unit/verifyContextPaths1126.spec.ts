// #1126 slice 2 — A STORED PROGRAM CARRIES THE CONTEXT ITS OWN FIRST VERIFICATION USED.
//
// `verifyContext` is not a default and not a reconstruction by guesswork: each posting path (the
// model plan, the item pipeline, the rotary frame, the facing skim) stores the inputs it handed to
// the verifier when it first checked the program. The proof is end to end and per path: spy on the
// real `verifyProgram`, generate, then (1) the stored context equals the context that program's
// FIRST verification ran with (hop, outside allowances, item flag), and (2) the re-check, run on the
// stored result alone (JSON round trip, plan reduced to its summary), builds a verifier context
// that agrees with the first one — including the depth limit, sampled across the blank.
import { describe, expect, it, vi } from 'vitest';

const seen: { text: string; ctx: import('@/engine/cnc/verify').VerifyContext }[] = [];
vi.mock('@/engine/cnc/verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/cnc/verify')>();
  return {
    ...actual,
    verifyProgram: (text: string, ctx: import('@/engine/cnc/verify').VerifyContext) => {
      seen.push({ text, ctx });
      return actual.verifyProgram(text, ctx);
    },
  };
});

import { jobMachine } from '@/engine/cnc/calibration';
import { defaultEngraveJob, newEngraveLabelId } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { recheckStoredPrograms } from '@/engine/cnc/engrave/restoredRun';
import { TOOL_LIBRARY } from '@/engine/cnc/toolLibrary';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import {
  generateGoalProgram,
  trimGenerated,
  type EngraveGeneratedFull,
  type EngraveGenerated,
  type EngraveProgram,
  type EngraveShopOpts,
} from '@/workers/sim/engraveGenerate';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';
import { binaryStl } from './helpers/meshes';

/** Every verification the engine (or the re-check) runs, by program text, first one wins. */
function firstContexts(from: number): Map<string, import('@/engine/cnc/verify').VerifyContext> {
  const out = new Map<string, import('@/engine/cnc/verify').VerifyContext>();
  for (const { text, ctx } of seen.slice(from)) if (!out.has(text)) out.set(text, ctx);
  return out;
}

/**
 * The per-path proof. `programs` is what the posting path produced; `generated` the whole result.
 * Returns how many programs were compared so a path that compared nothing fails by name.
 */
function proveStoredContext(job: EngraveJob, programs: readonly EngraveProgram[], stored: EngraveGenerated, firstFrom: number): number {
  const first = firstContexts(firstFrom);
  const afterGeneration = seen.length;
  // The re-check works from what a store would hold: JSON, the plan a summary.
  const restored: EngraveGenerated = JSON.parse(JSON.stringify(stored));
  const machine = jobMachine(job, null);
  const out = recheckStoredPrograms({
    job,
    generated: restored,
    machine,
    mount: null,
    setup: toSetup(job, machine, undefined, null, undefined, null),
    defaults: null,
  });
  expect(out.regenerate).toBe(false);
  const again = firstContexts(afterGeneration);
  let compared = 0;
  programs.forEach((program, index) => {
    const original = first.get(program.nc);
    if (original === undefined) return; // a surface program runs no verifier
    const context = restored.programs[index]!.verifyContext;
    expect(context, `program ${index + 1} stores its context`).toBeDefined();
    expect(context!.minRapidZ).toBe(original.minRapidZ);
    expect(context!.outsideAllowancesMm).toEqual([...(original.outsideAllowancesMm ?? [])]);
    expect(context!.itemProgram).toBe(original.itemProgram);
    const rechecked = again.get(program.nc);
    expect(rechecked, `program ${index + 1} is re-verified`).toBeDefined();
    expect(rechecked!.minRapidZ).toBe(original.minRapidZ);
    expect([...(rechecked!.outsideAllowancesMm ?? [])]).toEqual([...(original.outsideAllowancesMm ?? [])]);
    expect(rechecked!.itemProgram).toBe(original.itemProgram);
    for (let i = 0; i <= 6; i++) {
      for (let j = 0; j <= 6; j++) {
        const x = (job.stock.length * i) / 6;
        const y = (job.stock.width * j) / 6;
        expect(rechecked!.depthLimit(x, y), `depth limit at ${x},${y}`).toBe(original.depthLimit(x, y));
      }
    }
    compared++;
  });
  return compared;
}

describe('#1126 — the stored verify context is the context the first verification used, per posting path', () => {
  it('item pipeline: a flat engraving job', async () => {
    const job: EngraveJob = { ...defaultEngraveJob(), toolKey: 'flat-1.0' };
    const from = seen.length;
    const g: EngraveGeneratedFull = await generate(tl, job);
    expect(g.ok).toBe(true);
    expect(proveStoredContext(job, g.programs, trimGenerated(g), from)).toBeGreaterThan(0);
  });

  it('rotary: a rod in the chuck', async () => {
    const job = {
      ...defaultEngraveJob(),
      name: 'rod',
      stock: { length: 100, width: 20, thickness: 20, material: 'pla', shape: 'cylinder', diameter: 20 },
      workholding: { kind: 'rotary-chuck', rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' } },
      labels: [
        { id: newEngraveLabelId(), text: 'Zoomba', font: DEFAULT_FONT_ID, weight: 'bold', size: 5, position: { x: 42.5, y: Math.PI * 10 }, rotation: 0, depth: 0.5, enabled: true },
      ],
      shapes: [],
      toolKey: 'flat-1.0',
    } as EngraveJob;
    const from = seen.length;
    const g = await generate(tl, job);
    expect(g.ok).toBe(true);
    expect(proveStoredContext(job, g.programs, trimGenerated(g), from)).toBeGreaterThan(0);
  });

  it('facing: the skim is its own program with its own context', async () => {
    // The built-in library only: the re-check resolves a program's cutter by key on this bench.
    const shop: EngraveShopOpts = { tools: [...TOOL_LIBRARY] };
    const job: EngraveJob = { ...defaultEngraveJob(), toolKey: 'flat-1.0', facing: { enabled: true, depth: 0.5 } };
    const from = seen.length;
    const g = await generate(tl, job, null, [], undefined, shop);
    expect(g.ok).toBe(true);
    expect(g.programs[0]!.kind).toBe('facing');
    expect(proveStoredContext(job, g.programs, trimGenerated(g), from)).toBeGreaterThanOrEqual(2);
  });

  it('model plan: a goal job posts through the planner', async () => {
    clearTargetObjectMeshCache();
    type Tri = [[number, number, number], [number, number, number], [number, number, number]];
    const p = (x: number, y: number): [number, number, number] => [x, y, -0.05 * x];
    const tris: Tri[] = [
      [p(0, 0), p(20, 0), p(20, 20)],
      [p(0, 0), p(20, 20), p(0, 20)],
    ];
    const target: EngraveTargetObject = {
      id: 'goal-1',
      name: 'goal.stl',
      format: 'stl',
      sha256: 'verify-context-1126',
      data: Buffer.from(new Uint8Array(binaryStl(tris))).toString('base64'),
      size: { x: 20, y: 20, z: 1 },
      position: { x: 50, y: 30, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
    };
    const base = defaultEngraveJob();
    const job: EngraveJob = { ...base, labels: [], shapes: [], stock: { ...base.stock, thickness: 12, material: 'pla' }, targetObject: target, toolKey: 'flat-1.0' };
    const from = seen.length;
    const g = await generateGoalProgram(job, target, jobTool(job), null, { shop: {} });
    expect(g.ok).toBe(true);
    expect(g.plan).toBeTruthy();
    expect(proveStoredContext(job, g.programs, trimGenerated(g), from)).toBeGreaterThan(0);
  });
});
