// #744 — THE SHARED PER-PROGRAM SWEEP. These run REAL sweeps through a session: the rule under
// test is the machine's, not a mock's. Every program is swept in cut order, each on the stock the
// earlier ones left, with its own cutter and its own drill point; a program's refusal or an error
// in its diagnostics stops the walk and names that program.

import { afterEach, describe, it, expect } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { createSimSession, type SimSession } from '@/workers/sim/session';
import { stubSetup } from '@/engine/cnc';
import { rectProfile } from '@/engine/compiler/profile';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
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
/**
 * A DENSE FLAT program (#746): more separate runs of cuts at one (segment, Z) than the exact
 * sweep's `MAX_CHECKPOINTS`. It alternates two depths along the same channel, which is a legal
 * (if pointless) 2.5D cut — and the shape a real 17-item program can reach. The column engine is
 * the engine for a flat job this dense, but it cannot be handed a seed.
 */
const DENSE_FLAT = (() => {
  const lines = ['S1000 M3', 'G0 X10 Y10 Z2'];
  for (let i = 0; i < 1200; i++) {
    const z = i % 2 === 0 ? -0.5 : -1;
    const x = i % 2 === 0 ? 30 : 10;
    lines.push(`G1 Z${z} F100`, `G1 X${x}`);
  }
  lines.push('G0 Z2', 'M5');
  return lines.join('\n');
})();

/** #817 — a V-bit, the column engine's own cone cutter, and a groove it cuts along the channel. */
const V_BIT: Tool = {
  ...flatEndMill(0.3),
  name: '30° V-bit',
  typeText: 'Engraving',
  shape: 'engraving',
  tipDiameter: 0.3,
  halfAngle: 15,
  angle: 30,
};
const V_CHANNEL = ['S1000 M3', 'G0 X10 Y10 Z2', 'G1 Z-0.5 F100', 'G1 X30', 'G0 Z2', 'M5'].join('\n');

const POINT = { deg: 118, source: 'the drill plan' };

function program(toolKey: string, nc: string, drill?: { simDrillPoint: { deg: number; source: string } | null }): SweepProgram {
  return drill === undefined ? { kind: 'engrave', toolKey, nc } : { kind: 'engrave', toolKey, nc, drill };
}

/** Sweep one list of programs on a real session, with the realm's own load and tool lookup. */
async function sweep(
  programs: readonly SweepProgram[],
  tools: ReadonlyMap<string, Tool>,
  opts: {
    initialRemoval?: readonly NodeMeshOutput[];
    shopDrillPoint?: { deg: number; source: string } | null;
    /** #1040 — read the run's goal fold after each program, while it is still the live one. */
    afterLoad?: (index: number) => void;
  } = {},
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
          // #817 — the earlier column programs' remaining tops; the column engine seeds from them.
          ...(args.priorFields.length === 0 ? {} : { priorFields: args.priorFields }),
          ...(args.priorExactRemoval === undefined ? {} : { priorExactRemoval: args.priorExactRemoval }),
          // #1040 — both production call sites state that the walk's own from-blank retry belongs
          // to the run in flight; the session must keep the run-wide goal fold across it.
          continueRun: args.fromBlank === true,
          ...(args.drillPoint === null ? {} : { drillPointDefault: args.drillPoint }),
        });
      },
      afterLoad: opts.afterLoad === undefined ? undefined : ({ index }) => opts.afterLoad!(index),
      initialRemoval: opts.initialRemoval,
    });
    return { outcome, calls };
  } finally {
    session.dispose();
  }
}

afterEach(() => resetRegistry());

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
    // #887 — the note names the cutter in words; the registry is what the label resolves `inv:`
    // keys through, so the row is registered exactly as the app's inventory loads it.
    setRegistry([{ key: 'inv:drill-2', tool: DRILL, provenance: 'spec' }]);
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
    expect(drill.notes[0]?.message).toContain('program 2 (⌀ 2 mm drill) was swept from the blank');
    // The point the plan used is the one the cone was swept with (#434).
    expect(drill.diagnostics.find((d) => d.code === 'drill-point-angle')?.message).toContain('118°');
    expect(drill.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  // #817 — a COLUMN program is not refused when the material it must start from is a column
  // program's: the field carries it. The drill starts where the V-groove left the stock, not on
  // the blank, and the walk reports no old refusal.
  it('#817 a drill after a column program seeds from its field, not from the blank', async () => {
    const tools = new Map<string, Tool>([
      ['vbit', V_BIT],
      ['inv:drill-2', DRILL],
    ]);
    const { outcome, calls } = await sweep(
      [program('vbit', V_CHANNEL), program('inv:drill-2', DRILL_HOLE, { simDrillPoint: POINT })],
      tools,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(calls[1]!.priorFields.length).toBeGreaterThan(0);
    expect(calls[1]!.priorExactRemoval).toHaveLength(0);
    expect(outcome.sweeps[1]!.fromBlank).toBe(false);
  });

  it('a dense flat program is swept from the blank, on its own engine, instead of stopping the run (#746)', async () => {
    const tools = new Map<string, Tool>([
      ['flat-2', FLAT_2],
      ['flat-1', FLAT_1],
    ]);
    const { outcome, calls } = await sweep([program('flat-2', CHANNEL), program('flat-1', DENSE_FLAT)], tools);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.failed?.diagnostics));
    const dense = outcome.sweeps[1]!;
    // Seeded, the exact engine is the only one left and it refuses the checkpoint count. From
    // the blank the flat job routes to the column engine, which is the engine for a dense flat
    // file — and the note says the seed was dropped.
    expect(dense.engine).toBe('column');
    expect(dense.fromBlank).toBe(true);
    expect(dense.fromBlankCode).toBe('dense-3d-refused');
    expect(dense.notes[0]?.message).toContain('program 2 (flat-1) was swept from the blank');
    expect(calls.filter((c) => c.index === 1).map((c) => c.priorRemoval.length)).toEqual([1, 0]);
  }, 120_000);

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

  it('#887 — a catalogue cutter’s raw id never reaches the label or a diagnostic prefix', () => {
    // The bench's own case: a job on a catalogue cutter, labelled `program 1 (cat:019c049a-…)` on
    // the Cut panel after the simulation stopped.
    const key = 'cat:019c049a-8169-73ea-abe6-1076f4779fb6';
    setRegistry([{ key, tool: flatEndMill(3.175, { name: '3.175*12mm Flat End(Metal)' }), provenance: 'spec' }]);
    const programs: SweepProgram[] = [{ kind: 'engrave', toolKey: key, nc: '' }];
    expect(programLabel(programs, 0)).toBe('program 1 (⌀ 3.175 mm flat end)');
    // And the prefix `attributedDiagnostics` puts on a later program's sentence is the same words.
    const summary: ProgramSweepSummary = {
      index: 0,
      program: 1,
      label: programLabel(programs, 0),
      toolKey: key,
      outcome: 'swept',
      engine: 'exact',
      count: 1,
      removedVolume: 1,
      errorCount: 1,
      diagnostics: [{ source: 'sweep', severity: 'error', code: 'sweep-budget-exceeded', message: 'the simulation was stopped after 60 s' }],
      notes: [],
      fromBlank: false,
      fromBlankCode: null,
      gridPitchMm: null,
    };
    const [sentence] = attributedDiagnostics([summary], true);
    expect(sentence!.message).toBe('program 1 (⌀ 3.175 mm flat end): the simulation was stopped after 60 s');
    expect(sentence!.message).not.toContain('cat:');
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

// #1040 — THE RUN-WIDE GOAL FOLD ACROSS A FROM-BLANK RETRY. The goal check stamps every program of
// a run onto one goal field; the session folds each program's stamp in as the oracle reads it
// (`afterLoad`, while the program is still the live one). A from-blank retry is a limitation of the
// sweep, not a new run: it must keep the fold. A genuinely new load — the Simulate panel's own —
// must start it clean, or a run would inherit its predecessor's cuts.
describe('#1040 the run-wide goal fold', () => {
  /** The goal the run is checked against: a 100 x 60 mm grid at 0.5 mm, work frame. */
  const GOAL = { nx: 201, ny: 121, x0: 0, y0: 0, pitch: 0.5 };
  const cellAt = (field: Float32Array, x: number, y: number): number =>
    field[Math.round(y / GOAL.pitch) * GOAL.nx + Math.round(x / GOAL.pitch)]!;
  /** A channel at Y 40 to Z −1: a new run's own cut, away from the Y 10 channel. */
  const FRESH_CHANNEL = ['S1000 M3', 'G0 X10 Y40 Z2', 'G1 Z-1 F100', 'G1 X30', 'G0 Z2', 'M5'].join('\n');
  const TOOLS = new Map<string, Tool>([
    ['flat-2', FLAT_2],
    ['flat-1', FLAT_1],
  ]);

  /** The walk, wired as both production call sites are; the session stays the caller's. */
  async function walkOn(session: SimSession, programs: readonly SweepProgram[], afterLoad?: (index: number) => void) {
    return sweepPrograms({
      programs,
      shopDrillPoint: null,
      cutterFor: (p) => TOOLS.get(p.toolKey) ?? null,
      load: async (args) =>
        session.load(args.program.nc, SETUP, args.cutter, null, {
          ...(args.priorRemoval.length === 0 ? {} : { priorRemoval: args.priorRemoval }),
          ...(args.priorFields.length === 0 ? {} : { priorFields: args.priorFields }),
          ...(args.priorExactRemoval === undefined ? {} : { priorExactRemoval: args.priorExactRemoval }),
          continueRun: args.fromBlank === true,
        }),
      afterLoad: afterLoad === undefined ? undefined : ({ index }) => afterLoad(index),
    });
  }

  it('a from-blank retry inside the run keeps the fold — program 1’s channel stays in the run’s field', async () => {
    const session = createSimSession(tl);
    try {
      const fields: (Float32Array | null)[] = [];
      const outcome = await walkOn(session, [program('flat-2', CHANNEL), program('flat-1', DENSE_FLAT)], (index) => {
        fields[index] = session.sweptFieldExact(GOAL);
      });
      if (!outcome.ok) throw new Error(JSON.stringify(outcome.failed?.diagnostics));
      // The walk really did retry the dense flat from the blank — the tape run's condition.
      expect(outcome.sweeps[1]!.fromBlank).toBe(true);
      expect(outcome.sweeps[1]!.fromBlankCode).toBe('dense-3d-refused');
      // Program 1 alone leaves the channel floor at Z −2.
      expect(cellAt(fields[0]!, 20, 10)).toBeLessThanOrEqual(-1.99);
      // After the retry, the run's field must still carry that floor. The retry itself only
      // reaches Z −1 on the same line, so a fold reset by the retry reads −1 here.
      expect(cellAt(fields[1]!, 20, 10)).toBeLessThanOrEqual(-1.99);
      // The retry's own cut is folded in too: the dense pass reaches Z −1 where it alone cut,
      // and the fold keeps either program's deeper stamp at every cell.
      expect(cellAt(fields[1]!, 20, 10)).toBeGreaterThanOrEqual(-2.01);
    } finally {
      session.dispose();
    }
  }, 120_000);

  it('a genuinely new load — the Simulate panel’s own — starts the fold clean', async () => {
    const session = createSimSession(tl);
    try {
      // A run first: its fold carries the channel at Y 10.
      const first = await walkOn(session, [program('flat-2', CHANNEL)]);
      if (!first.ok) throw new Error(JSON.stringify(first.failed?.diagnostics));
      expect(cellAt(session.sweptFieldExact(GOAL)!, 20, 10)).toBeLessThanOrEqual(-1.99);
      // The panel's own Simulate load: no prior material and no continue-run statement.
      const fresh = session.load(FRESH_CHANNEL, SETUP, FLAT_2, null);
      if (!fresh.ok) throw new Error(JSON.stringify(fresh.diagnostics));
      const field = session.sweptFieldExact(GOAL)!;
      // The new run's own cut is stamped...
      expect(cellAt(field, 20, 40)).toBeLessThanOrEqual(-0.99);
      // ...and the previous run's channel is gone: untouched stock reads 0, not Z −2.
      expect(cellAt(field, 20, 10)).toBe(0);
    } finally {
      session.dispose();
    }
  }, 120_000);
});
