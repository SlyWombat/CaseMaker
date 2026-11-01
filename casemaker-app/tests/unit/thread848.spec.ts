// #848 — A BOSS THE JOB CUTS, THEN ITS THREAD. A job that raises an ⌀8 mm boss (a cutaway around a
// reference circle) and threads it M8×1.25 externally used to be refused by the thread job's
// one-tool rule. It now posts TWO programs in cut order — the boss with the flat the plan picks,
// then the thread mill — and each verifies and passes its own oracle. The boss detection names the
// cut that raises it; a short boss and a hand-built thread-first order inform.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { applyCutterPlanToJob } from '@/engine/cnc/engrave/measuredPick';
import { ORACLE_AREA_FLOOR } from '@/engine/cnc/engrave/oracle';
import { jobForSetup, setupPrograms } from '@/engine/cnc/engrave/programs';
import { setupProgramFindings, toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { candidatePlans } from '@/engine/cnc/engrave/smartPick';
import { bossBeforeThread, threadBoss } from '@/engine/cnc/engrave/threadFit';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { resetRegistry, setInventoryEntries } from '@/engine/cnc/toolRegistry';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { EngraveCombinedShape, EngraveJob } from '@/types/engraveJob';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import { createSimSession } from '@/workers/sim/session';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';

const M8: ToolLibraryEntry = {
  key: 'inv:m8-mill',
  provenance: 'typed here for the #848 boss thread',
  tool: flatEndMill(6, { name: 'Thread mill M8x1.25 (d6mm)', typeText: 'Thread Mill', shape: 'thread', tipDiameter: 6, diameter: 6, fluteLength: 20 }),
};
const FLAT: ToolLibraryEntry = { key: 'inv:flat-3', provenance: 'typed here for the #848 boss thread', tool: flatEndMill(3, { name: '3 mm flat', fluteLength: 20 }) };
const TOOLS = [M8, FLAT];

const DEFAULTS = Object.fromEntries(
  Object.entries({
    radialStepoverMm: 0.2,
    entryRampMm: 0.5,
    bottomClearancePitches: 1,
    pilotTipClearanceMm: 0.5,
    feed: 300,
    plungeFeed: 100,
    spindleRpm: 10000,
    chordToleranceMm: 0.01,
  }).map(([k, v]) => [`thread.${k}`, { value: v, source: 'seeded' }]),
) as unknown as ShopDefaults;

const BOSS = { kind: 'circle', id: 'boss', name: 'boss', position: { x: 20, y: 20 }, rotation: 0, depth: 8, enabled: true, diameter: 8, construction: true };
const FIELD = { kind: 'rect', id: 'field', name: 'field', position: { x: 20, y: 20 }, rotation: 0, depth: 8, enabled: true, width: 30, height: 30, cornerRadius: 0, construction: true };
const RING = { kind: 'cutaway', id: 'ring', name: 'ring', position: { x: 20, y: 20 }, rotation: 0, depth: 8, enabled: true, outer: 'field', islands: ['boss'] } as EngraveCombinedShape;

/**
 * A 40 × 40 × 20 mm block: a cutaway clears a 30 mm square 8 mm deep around a ⌀8 mm reference
 * circle, which stands as the boss, and an M8×1.25 external thread 6 mm long is milled on it.
 */
function bossJob(named: ToolLibraryEntry, over: { ringDepth?: number; bossDiameter?: number } = {}): EngraveJob {
  const b = defaultEngraveJob();
  return {
    ...b,
    name: 'M8 boss in a block',
    stock: { ...b.stock, length: 40, width: 40, thickness: 20 },
    labels: [],
    traces: [],
    drills: [],
    shapes: [{ ...BOSS, diameter: over.bossDiameter ?? 8 }, FIELD] as EngraveJob['shapes'],
    combined: [{ ...RING, depth: over.ringDepth ?? 8 }],
    threads: [
      { kind: 'thread', id: 'thr', position: { x: 20, y: 20 }, enabled: true, size: 'M8', standard: 'metric', classFit: '6h', side: 'external', depth: 6, through: false },
    ],
    toolKey: named.key,
    tool: named.tool,
    sources: { tool: 'user' },
  };
}

describe('#848 the boss the job cuts', () => {
  it('a cutaway around the reference circle raises it, as tall as the cut is deep', () => {
    const boss = threadBoss(bossJob(M8), { x: 20, y: 20 });
    expect(boss?.diameterMm).toBe(8);
    expect(boss?.raisedBy).toEqual({ id: 'ring', what: 'the cutaway "ring"', heightMm: 8, earlier: false });
  });

  it('a frame on the circle raises it widened by its gap; a prism raises itself; a bare reference is not a cut', () => {
    const job = bossJob(M8);
    const framed: EngraveJob = {
      ...job,
      combined: [{ kind: 'frame', id: 'rim', position: { x: 20, y: 20 }, rotation: 0, depth: 9, enabled: true, around: 'boss', gap: 0.25, width: 6 } as EngraveCombinedShape],
    };
    const f = threadBoss(framed, { x: 20, y: 20 });
    expect(f?.diameterMm).toBe(8.5);
    expect(f?.raisedBy).toMatchObject({ id: 'rim', what: 'the frame', heightMm: 9 });

    const prism: EngraveJob = { ...job, combined: [], shapes: [{ ...BOSS, construction: false, prism: {} }] as EngraveJob['shapes'] };
    expect(threadBoss(prism, { x: 20, y: 20 })?.raisedBy).toMatchObject({ id: 'boss', what: 'its own prism', heightMm: 8 });

    const bare: EngraveJob = { ...job, combined: [] };
    expect(threadBoss(bare, { x: 20, y: 20 })?.raisedBy).toBeNull();
    // A construction cutaway is a reference too: nothing in this job cuts it.
    const refOnly: EngraveJob = { ...job, combined: [{ ...RING, construction: true }] };
    expect(threadBoss(refOnly, { x: 20, y: 20 })?.raisedBy).toBeNull();
  });

  it('the finding says the job raises the boss, instead of asking for one that already stands', () => {
    const f = validateJob(bossJob(FLAT)).filter((x) => x.code.startsWith('thread-boss'));
    expect(f.map((x) => [x.severity, x.code])).toEqual([['info', 'thread-boss-raised']]);
    expect(f[0]!.message).toBe(
      'Thread M8×1.25 external is cut on circle "boss" (⌀8 mm), which the cutaway "ring" raises 8 mm tall in its own program, before the thread.',
    );
  });

  it('a boss shorter than the thread and its run-out informs', () => {
    const f = validateJob(bossJob(FLAT, { ringDepth: 5 })).find((x) => x.code === 'thread-boss-short');
    expect(f?.severity).toBe('warning');
    expect(f?.message).toBe(
      'Thread M8×1.25 external reaches 7.25 mm with its run-out, and the cutaway "ring" raises the boss 5 mm: the tooth cuts 2.25 mm into the floor around it. Generate cuts it as it is.',
    );
  });
});

describe('#848 the plan cuts the boss first, then the thread', () => {
  beforeEach(() => setInventoryEntries(TOOLS));
  afterEach(() => resetRegistry());

  it.each([
    ['the thread mill', M8],
    ['the flat', FLAT],
  ])('named %s: every candidate plan puts the boss cutter before the thread mill', (_, named) => {
    const plans = candidatePlans(bossJob(named), TOOLS, []);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      const keys = plan.cutters.map((c) => c.key);
      expect(keys.indexOf(FLAT.key)).toBeLessThan(keys.indexOf(M8.key));
      expect(plan.cutters.find((c) => c.key === M8.key)?.items).toEqual(['thr']);
      expect(plan.cutters.find((c) => c.key === FLAT.key)?.items).toEqual(['ring']);
    }
  });

  it('a plan with no raised boss is returned as it was', () => {
    const cutters = [{ key: M8.key, items: ['thr'] }, { key: FLAT.key, items: ['ring'] }];
    const bare: EngraveJob = { ...bossJob(M8), combined: [] };
    expect(bossBeforeThread(bare, cutters)).toBe(cutters);
  });

  it('the applied split: no one-tool refusal, two programs in cut order, and one line says so', () => {
    const job = bossJob(M8);
    expect(validateJob(job).some((f) => f.code === 'thread-mixed-tools')).toBe(true);
    const applied = applyCutterPlanToJob(job, candidatePlans(job, TOOLS, [])[0]!);
    const findings = validateJob(applied);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(findings.some((f) => f.code === 'thread-boss-order')).toBe(false);
    expect(setupPrograms(applied).map((r) => [r.toolKey, r.itemIds])).toEqual([
      [FLAT.key, ['ring']],
      [M8.key, ['thr']],
    ]);
    expect(setupProgramFindings(applied).find((f) => f.code === 'setup-programs-split')?.message).toBe(
      'Split into 2 programs: the ⌀ 3 mm flat end for ring, the thread mill for the thread on the boss the cutaway "ring" raises.',
    );
    // The thread program's own sub-job knows its boss was raised by the program before it.
    const threadRef = setupPrograms(applied)[1]!;
    const sub = jobForSetup(applied, threadRef, M8.tool);
    expect(sub.cutEarlier).toEqual(['ring']);
    expect(sub.combined?.find((c) => c.id === 'ring')?.construction).toBe(true);
    const subBoss = validateJob(sub).filter((f) => f.code.startsWith('thread-boss'));
    expect(subBoss.map((f) => [f.severity, f.code])).toEqual([['info', 'thread-boss-raised']]);
    expect(subBoss[0]!.message).toMatch(/raises 8 mm tall in an earlier program\.$/);
  });

  it('a hand-built thread-first order informs, naming both programs', () => {
    const job = bossJob(M8);
    const reversed = applyCutterPlanToJob(job, {
      cutters: [
        { key: M8.key, items: ['thr'] },
        { key: FLAT.key, items: ['ring'] },
      ],
    });
    const f = validateJob(reversed).find((x) => x.code === 'thread-boss-order');
    expect(f?.severity).toBe('warning');
    expect(f?.message).toBe(
      'Thread M8×1.25 external is program 1, and the cutaway "ring" that raises its boss is program 2: the thread would be cut into stock that is not a boss yet. Put the thread mill after the cutter that raises the boss.',
    );
  });

  it('an ⌀8 mm boss threaded M8×1.25 posts two programs, and both verify and pass their own oracle', async () => {
    const job = bossJob(M8);
    const applied = applyCutterPlanToJob(job, candidatePlans(job, TOOLS, [])[0]!);
    const g = await generate(tl, applied, null, [], undefined, { tools: TOOLS, defaults: DEFAULTS });
    expect(g.errors).toEqual([]);
    expect(g.ok, JSON.stringify(g.findings.filter((f) => f.severity === 'error'))).toBe(true);
    expect(g.programs.map((p) => p.toolKey)).toEqual([FLAT.key, M8.key]);
    // The boss is never reported missing or unproven by the thread's own program.
    expect(g.findings.filter((f) => f.code.startsWith('thread-boss') && f.severity !== 'info')).toEqual([]);
    for (const program of g.programs) expect(program.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    // Each program carries its own predictions, and only the thread mill's carries thread plans.
    expect(g.programs[0]!.threads).toBeNull();
    expect(g.programs[1]!.threads?.[0]?.external).toBe(true);
    expect(g.programs[1]!.nc).toContain('Thread M8×1.25 external');
    expect(g.programs[0]!.nc).not.toContain('Thread M8×1.25 external');

    // Sweep IN ORDER, as the run does: the flat on the blank, then the thread mill on what it left
    // (the column engine cannot start from a removal mesh, so it is swept from the blank, exactly as
    // `sweepPrograms` retries it). Each program's oracle judges its OWN predictions.
    const setup = toSetup(applied, Z1);
    let prior: NodeMeshOutput | null = null;
    for (const [i, program] of g.programs.entries()) {
      const tool: Tool = program.toolKey === M8.key ? M8.tool : FLAT.tool;
      const threads = program.threads?.flatMap((t) => t.simThreads) ?? [];
      const session = createSimSession(tl);
      try {
        let load = session.load(program.nc, setup, tool, Z1.id, { threads, ...(prior === null ? {} : { priorRemoval: prior }) });
        if (!load.ok && load.diagnostics.some((d) => d.code === 'prior-removal-column')) load = session.load(program.nc, setup, tool, Z1.id, { threads });
        expect(load.ok, `program ${i + 1}: ${JSON.stringify(load.ok ? null : load.diagnostics)}`).toBe(true);
        if (!load.ok) return;
        if (load.meshes.removal !== null) prior = load.meshes.removal;
        expect(program.predicted?.length).toBeGreaterThan(0);
        const report = session.oracle(program.predicted!);
        expect(report.ok, `program ${i + 1} oracle: ${JSON.stringify(report.worst)}`).toBe(true);
        expect(report.worst.underCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
        expect(report.worst.overCut).toBeLessThanOrEqual(ORACLE_AREA_FLOOR);
      } finally {
        session.dispose();
      }
    }
  }, 180_000);
});

describe('#848 existing thread outputs are byte-identical', () => {
  beforeEach(() => setInventoryEntries(TOOLS));
  afterEach(() => resetRegistry());
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  // sha256 of the posted programs, computed on main at 376589b0 before #848.
  // #879 — THE FIXTURE PINS ITS MATERIAL. These bytes were taken on a softwood blank; since #879
  // the shipped default is hardwood, whose feeds row steps down and feeds differently. The pin is
  // about the THREAD code being unchanged, so the material it was computed on is stated here.
  it('the #841 M8 rod and the #786 4c thread-plus-pocket split post the same bytes', async () => {
    const b = defaultEngraveJob();
    const rod: EngraveJob = {
      ...b,
      stock: { ...b.stock, length: 8, width: 8, thickness: 20, shape: 'cylinder', diameter: 8, material: 'softwood' },
      workholding: b.workholding.kind === 'vise' ? { ...b.workholding, vise: { ...b.workholding.vise, stockProud: 12 } } : b.workholding,
      labels: [],
      shapes: [],
      traces: [],
      drills: [],
      tool: M8.tool,
      toolKey: M8.key,
      threads: [{ kind: 'thread', id: 'thr-ext', position: { x: 4, y: 4 }, enabled: true, size: 'M8', standard: 'metric', classFit: '6h', side: 'external', depth: 6, through: false }],
    };
    const g1 = await generate(tl, rod, null, [], undefined, { defaults: DEFAULTS });
    expect(g1.ok).toBe(true);
    expect(sha(g1.nc!)).toBe('b2a740f275be6175fa41f092d31c1922fb6d925a6aa863c48e028a4e34c33fd8');

    // A thread mill beside a pocket that raises no boss keeps the named mill FIRST (#786 4c).
    const pocketJob: EngraveJob = {
      ...b,
      stock: { ...b.stock, length: 60, width: 40, thickness: 20, material: 'softwood' },
      labels: [],
      traces: [],
      drills: [],
      shapes: [{ kind: 'circle', id: 'pocket', name: 'pocket', position: { x: 40, y: 25 }, rotation: 0, depth: 2, enabled: true, diameter: 10 }],
      threads: [{ kind: 'thread', id: 'thr', position: { x: 15, y: 15 }, enabled: true, size: 'M8', standard: 'metric', classFit: '6h', side: 'external', depth: 6, through: false }],
      toolKey: M8.key,
      tool: M8.tool,
      sources: { tool: 'user' },
    };
    const plan = candidatePlans(pocketJob, TOOLS, [])[0]!;
    expect(plan.cutters.map((c) => c.key)).toEqual([M8.key, FLAT.key]);
    const g2 = await generate(tl, applyCutterPlanToJob(pocketJob, plan), null, [], undefined, { tools: TOOLS, defaults: DEFAULTS });
    expect(g2.programs.map((p) => sha(p.nc))).toEqual([
      'b8590983e6746fd5c95ea00a1540642fca17ab9ff2a1b9fe48684008f8ad1962',
      '570812a4b165d00e4bdb81009676dbcbea6ca36cee310a59099d18f4e1bbb5d7',
    ]);
  }, 120_000);
});
