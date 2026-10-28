// #744 — THE SHARED PER-PROGRAM SWEEP. These run REAL sweeps through a session: the rule under
// test is the machine's, not a mock's. Every program is swept in cut order, each on the stock the
// earlier ones left, with its own cutter and its own drill point; a program's refusal or an error
// in its diagnostics stops the walk and names that program.

import { describe, it, expect } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { createSimSession, type SimSession } from '@/workers/sim/session';
import { stubSetup } from '@/engine/cnc';
import { rectProfile } from '@/engine/compiler/profile';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import {
  attributedDiagnostics,
  programLabel,
  sweepPrograms,
  type ProgramLoadArgs,
  type ProgramSweepSummary,
  type SweepProgram,
} from '@/engine/cnc/engrave/programSweep';

// A 100 x 60 x 5 slab, work origin on its top-front-left corner: work z in [-5, 0] (the same
// blank `cncSweep.spec.ts` uses, so `Z-1` is a millimetre inside the stock).
const SETUP = stubSetup(
  { kind: 'prism', outline: rectProfile(100, 60), thickness: 5 },
  { kind: 'tape-down', contact: rectProfile(100, 60) },
);

const FLAT_2 = flatEndMill(2, { shoulderLength: 5, fluteLength: 5 });
const FLAT_1 = flatEndMill(1, { shoulderLength: 5, fluteLength: 5 });
/** #382's drill: the column engine's cone, and a point angle it must be given (#434). */
const DRILL: Tool = {
  ...flatEndMill(2),
  name: '2 mm drill',
  typeText: 'Drill',
  shape: 'drill',
  angle: null,
  halfAngle: null,
  tipDiameter: 2,
  diameter: 2,
  cornerRadius: null,
};

/** Program 1: a 2 mm channel down the Y = 10 line, from Z 0 to Z −2. */
const CHANNEL = ['S1000 M3', 'G0 X10 Y10 Z2', 'G1 Z-2 F100', 'G1 X30', 'G0 Z2', 'M5'].join('\n');
/** Program 2: a rapid down the channel, at Z −1 — inside the material program 1 removed. */
const RAPID_IN_CHANNEL = ['S1000 M3', 'G0 X12 Y10 Z2', 'G0 Z-1', 'G0 X28', 'G0 Z2', 'M5'].join('\n');
/** A rapid at Y 40, where nothing has been cut: the same move through untouched stock. */
const RAPID_IN_STOCK = ['S1000 M3', 'G0 X12 Y40 Z2', 'G0 Z-1', 'G0 X28', 'G0 Z2', 'M5'].join('\n');
/** A drill program: one plunge, whose point is stated only in `drill.simDrillPoint`. */
const DRILL_HOLE = ['S9000 M3', 'G0 X20 Y40 Z2', 'G1 Z-3 F100', 'G0 Z2', 'M5'].join('\n');

const POINT = { deg: 118, source: 'the drill plan' };

function program(toolKey: string, nc: string, drill?: { simDrillPoint: { deg: number; source: string } | null }): SweepProgram {
  return drill === undefined ? { kind: 'engrave', toolKey, nc } : { kind: 'engrave', toolKey, nc, drill };
}

/** Sweep one list of programs on a real session, with the realm's own load and tool lookup. */
async function sweep(
  programs: readonly SweepProgram[],
  tools: ReadonlyMap<string, Tool>,
  opts: { initialRemoval?: readonly NodeMeshOutput[]; shopDrillPoint?: { deg: number; source: string } | null } = {},
) {
  const session: SimSession = createSimSession(tl);
  try {
    const calls: ProgramLoadArgs[] = [];
    const outcome = await sweepPrograms({
      programs,
      shopDrillPoint: opts.shopDrillPoint ?? null,
      cutterFor: (p) => tools.get(p.toolKey) ?? null,
      load: async (args) => {
        calls.push(args);
        return session.load(args.program.nc, SETUP, args.cutter, null, {
          ...(args.priorRemoval.length === 0 ? {} : { priorRemoval: args.priorRemoval }),
          ...(args.drillPoint === null ? {} : { drillPointDefault: args.drillPoint }),
        });
      },
      initialRemoval: opts.initialRemoval,
    });
    return { outcome, calls };
  } finally {
    session.dispose();
  }
}

describe('#744 one sweep per program, shared with the command line', () => {
  it('sweeps each program on the stock the earlier ones left — a rest-pair rapid in the channel is clean', async () => {
    const tools = new Map<string, Tool>([
      ['flat-2', FLAT_2],
      ['flat-1', FLAT_1],
    ]);
    const { outcome } = await sweep([program('flat-2', CHANNEL), program('flat-1', RAPID_IN_CHANNEL)], tools);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.failed?.diagnostics));
    expect(outcome.sweeps).toHaveLength(2);
    expect(outcome.sweeps.map((s) => s.label)).toEqual(['program 1 (flat-2)', 'program 2 (flat-1)']);
    // The second sweep started from the first's removal: the rapid at Z −1 is inside the channel.
    expect(outcome.sweeps[1]!.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
    expect(outcome.sweeps[0]!.removedVolume).toBeGreaterThan(0);
  });

  it('without that seed the SAME rapid is a rapid through stock — the seed is what changed the verdict', async () => {
    const tools = new Map<string, Tool>([['flat-1', FLAT_1]]);
    const { outcome } = await sweep([program('flat-1', RAPID_IN_CHANNEL)], tools);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failed?.kind).toBe('diagnostics');
    expect(outcome.failed?.sweep?.diagnostics.map((d) => d.code)).toContain('rapid-through-stock');
  });

  it('a later cutter’s rapid through stock stops the run and names that program', async () => {
    const tools = new Map<string, Tool>([
      ['flat-2', FLAT_2],
      ['flat-4', flatEndMill(4, { shoulderLength: 8, fluteLength: 8 })],
    ]);
    const { outcome } = await sweep([program('flat-2', CHANNEL), program('flat-4', RAPID_IN_STOCK)], tools);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Program 1 swept; program 2 is the one that stopped the walk, by name.
    expect(outcome.sweeps).toHaveLength(1);
    expect(outcome.failed).toMatchObject({
      index: 1,
      program: 2,
      label: 'program 2 (flat-4)',
      toolKey: 'flat-4',
      kind: 'diagnostics',
    });
    expect(outcome.failed?.diagnostics.map((d) => d.code)).toContain('rapid-through-stock');
    expect(outcome.failed?.sweep?.index).toBe(1);
  });

  it('a column program is retried from the blank with its own point, and the note says so', async () => {
    const tools = new Map<string, Tool>([
      ['flat-2', FLAT_2],
      ['inv:drill-2', DRILL],
    ]);
    const { outcome, calls } = await sweep(
      [program('flat-2', CHANNEL), program('inv:drill-2', DRILL_HOLE, { simDrillPoint: POINT })],
      tools,
      // No shop point reaches this walk: the program's own must be the one the drill swept with.
      { shopDrillPoint: null },
    );
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.failed?.diagnostics));
    expect(calls[1]?.drillPoint).toEqual(POINT);
    const drill = outcome.sweeps[1]!;
    expect(drill.engine).toBe('column');
    // The seed cannot start a column sweep, so the drill was re-swept from the blank — and said so.
    expect(drill.fromBlank).toBe(true);
    expect(drill.fromBlankCode).toBe('prior-removal-column');
    expect(drill.notes).toHaveLength(1);
    expect(drill.notes[0]?.message).toContain('program 2 (inv:drill-2) was swept from the blank');
    // The point the plan used is the one the cone was swept with (#434).
    expect(drill.diagnostics.find((d) => d.code === 'drill-point-angle')?.message).toContain('118°');
    expect(drill.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('the command line’s rest pass: a second walk seeded with the first walk’s removal', async () => {
    const tools = new Map<string, Tool>([['flat-2', FLAT_2], ['flat-1', FLAT_1]]);
    const first = await sweep([program('flat-2', CHANNEL)], tools);
    if (!first.outcome.ok) throw new Error('the first program should sweep');
    expect(first.outcome.priorRemoval).toHaveLength(1);

    const seeded = await sweep([program('flat-1', RAPID_IN_CHANNEL)], tools, { initialRemoval: first.outcome.priorRemoval });
    if (!seeded.outcome.ok) throw new Error(JSON.stringify(seeded.outcome.failed?.diagnostics));
    expect(seeded.outcome.sweeps[0]!.diagnostics.filter((d) => d.code === 'rapid-through-stock')).toEqual([]);
  });

  it('a program naming a cutter the bench does not have fails by name, before loading it', async () => {
    const tools = new Map<string, Tool>([['flat-2', FLAT_2]]);
    const { outcome, calls } = await sweep([program('flat-2', CHANNEL), program('missing-tool', RAPID_IN_STOCK)], tools);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(calls).toHaveLength(1); // only program 1 was loaded
    expect(outcome.failed?.kind).toBe('no-cutter');
    expect(outcome.failed?.label).toBe('program 2 (missing-tool)');
    expect(outcome.failed?.diagnostics[0]?.message).toBe(
      'program 2 (missing-tool) names missing-tool, which is not on this bench',
    );
  });

  it('stops between programs when the caller is superseded', async () => {
    const tools = new Map<string, Tool>([['flat-2', FLAT_2], ['flat-1', FLAT_1]]);
    const session = createSimSession(tl);
    try {
      let loads = 0;
      let superseded = false;
      const outcome = await sweepPrograms({
        programs: [program('flat-2', CHANNEL), program('flat-1', RAPID_IN_CHANNEL)],
        cutterFor: (p) => tools.get(p.toolKey) ?? null,
        load: async (args) => {
          loads += 1;
          return session.load(args.program.nc, SETUP, args.cutter, null);
        },
        // The caller is superseded WHILE program 1 is the live one (a newer run started after
        // its sweep): the walk keeps that program's result and never loads program 2.
        afterLoad: () => {
          superseded = true;
        },
        aborted: () => superseded,
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.cancelled).toBe(true);
      expect(outcome.failed).toBeNull();
      expect(outcome.sweeps).toHaveLength(1);
      expect(loads).toBe(1);
    } finally {
      session.dispose();
    }
  });

  it('numbers engraving programs around a facing pass, and labels it its own way', () => {
    const programs: SweepProgram[] = [
      { kind: 'facing', toolKey: 'fly-22', nc: '' },
      { kind: 'engrave', toolKey: 'flat-2', nc: '' },
      { kind: 'engrave', toolKey: 'flat-1', nc: '' },
    ];
    expect(programLabel(programs, 0)).toBe('the facing pass (fly-22)');
    expect(programLabel(programs, 1)).toBe('program 1 (flat-2)');
    expect(programLabel(programs, 2)).toBe('program 2 (flat-1)');
  });

  // #744 — the run's LENGTH, not the result count, decides attribution. A walk that stops at its
  // first program hands back one summary, and that program's sentence still has to name it.
  it('attributes a stopped first program when the RUN has more than one file', () => {
    const only: ProgramSweepSummary = {
      index: 0,
      program: null,
      label: 'the facing pass (fly-22)',
      toolKey: 'fly-22',
      outcome: 'swept',
      engine: 'exact',
      count: 1,
      removedVolume: 1,
      errorCount: 1,
      diagnostics: [
        { source: 'sweep', severity: 'error', code: 'holder-collision', message: 'the shank would rub (0.1 mm shoulder)' },
      ],
      notes: [],
      fromBlank: false,
      fromBlankCode: null,
      gridPitchMm: null,
    };
    // One result and no run count: a single-program run's sentence, byte for byte.
    expect(attributedDiagnostics([only]).map((d) => d.message)).toEqual(['the shank would rub (0.1 mm shoulder)']);
    // The same one result in a run of several: the failing program is named.
    expect(attributedDiagnostics([only], true).map((d) => d.message)).toEqual([
      'the facing pass (fly-22): the shank would rub (0.1 mm shoulder)',
    ]);
    // A message that already names its program is never prefixed twice.
    const named: ProgramSweepSummary = {
      ...only,
      diagnostics: [{ ...only.diagnostics[0]!, message: 'the facing pass (fly-22) names fly-22, which is not on this bench' }],
    };
    expect(attributedDiagnostics([named], true).map((d) => d.message)).toEqual([
      'the facing pass (fly-22) names fly-22, which is not on this bench',
    ]);
  });
});
