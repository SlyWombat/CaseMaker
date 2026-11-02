/**
 * The run sheet on a 3D goal job and on a two-setup job: a surface program's missing air-trace
 * frame is by design (its check is the material sweep) and never reads as "do not run", while a
 * genuinely failed program still does; the turn between setups is its own step; and a goal turned
 * over to cut its other side says the part comes free.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRunSheet,
  type RunSheet,
  type RunSheetGenerated,
  type RunSheetProgram,
  type RunSheetSim,
} from '@/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { orient } from '@/engine/cnc/setups/orient';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';

const NOW = new Date('2026-11-02T00:00:00Z');
const NO_SIM: RunSheetSim = { diagnostics: [] };
const NC1 = 'G21 G90\nT1 M6\nS12000\nG1 Z-2.000 F200\nM2';
const NC2 = 'G21 G90\nT1 M6\nS12000\nG1 Z-3.000 F200\nM2';

const FACTS = {
  resolutionNote: 'sampled on a 0.1 mm grid',
  gridPitchMm: 0.1,
  gridCells: 1000,
  stepDownMm: 0.25,
  roughStepOverMm: 1.2,
  finishStepOverMm: 0.15,
  stockToLeaveMm: 0.3,
  roughingLayers: 4,
  notes: [],
};

function job(): EngraveJob {
  const j = defaultEngraveJob();
  j.toolKey = 'flat-1.0';
  return j;
}

const SURFACE = { kind: 'surface' as const };

function program(nc: string, setupIndex: number, extra: Partial<RunSheetProgram> = {}): RunSheetProgram {
  return { setupIndex, toolKey: 'flat-1.0', nc, frameNc: null, cam: null, ...extra };
}

/** A goal result: no verifier report, no frame, the surface facts, and the run's programs. */
function goalGenerated(programs: RunSheetProgram[]): RunSheetGenerated {
  return {
    findings: [],
    feeds: null,
    cam: { operations: 1, cuttingMoves: 100, estimatedSeconds: 60, passes: 1 },
    nc: NC1,
    verify: null,
    frameNc: null,
    frameError: null,
    surface3d: FACTS,
    programs,
  };
}

/** An item job's result: verified, with its frame. */
function itemGenerated(programs?: RunSheetProgram[], ok = true): RunSheetGenerated {
  return {
    findings: [],
    feeds: null,
    cam: { operations: 1, cuttingMoves: 10, estimatedSeconds: 30, passes: 1 },
    nc: NC1,
    verify: { ok, findings: [], stats: { lines: 5, cuttingMoves: 1, deepestZ: -2, bbox: { min: [0, 0, -2], max: [10, 10, 0] } } },
    frameNc: ok ? `${NC1}\n;frame\n` : null,
    ...(programs === undefined ? {} : { programs }),
  };
}

const text = (sheet: RunSheet, id: string): string =>
  (sheet.sections.find((s) => s.id === id)?.steps ?? []).map((s) => s.text).join('\n');
const all = (sheet: RunSheet): string => sheet.sections.flatMap((s) => s.steps.map((st) => st.text)).join('\n');

/** Two setups, top then turned over in the vise, the second on the flip's two pins. */
function flipped(j: EngraveJob, pins = true): EngraveJob {
  const size = { x: j.stock.length, y: j.stock.width, z: j.stock.thickness };
  const down = orient('bottom', { kind: 'vise' }, size);
  if (!down.ok) throw new Error(down.reason);
  const top = orient('top', { kind: 'vise' }, size);
  if (!top.ok) throw new Error(top.reason);
  const setups: JobSetup[] = [
    { id: 's1', orientation: top.orientation, mount: { kind: 'vise' }, itemIds: [], tools: ['flat-1.0'] },
    {
      id: 's2',
      orientation: down.orientation,
      mount: { kind: 'vise' },
      itemIds: [],
      tools: ['flat-1.0'],
      ...(pins ? { pins: { at: [{ x: 10, y: 4 }, { x: 30, y: 4 }] as [{ x: number; y: number }, { x: number; y: number }] } } : {}),
    },
  ];
  return { ...j, setups };
}

describe('run sheet — a 3D surface program has no frame by design', () => {
  it('a 3D goal job never says "do not run": the job’s own step and every later program', () => {
    const j = job();
    const sheet = buildRunSheet(
      j,
      goalGenerated([program(NC1, 1, { surfaceCheck: SURFACE }), program(NC2, 1, { surfaceCheck: SURFACE })]),
      NO_SIM,
      NOW,
    );
    expect(all(sheet)).not.toContain('Do not run');
    expect(all(sheet)).not.toContain('did not pass verification');
    expect(text(sheet, 'dry-run')).toContain(
      'A 3D surface program carries no air-trace frame; its check is the material sweep.',
    );
    expect(text(sheet, 'cut-2')).toContain(
      'A 3D surface program carries no air-trace frame; its check is the material sweep.',
    );
    expect(text(sheet, 'cut-2')).toContain(`Load ${NC2} and run it`);
  });

  it('a 2D job is unchanged: a later program that failed verification still says do not run', () => {
    const j = job();
    const sheet = buildRunSheet(j, itemGenerated([program(NC1, 1, { frameNc: 'f1' }), program(NC2, 1)]), NO_SIM, NOW);
    const cut2 = text(sheet, 'cut-2');
    expect(cut2).toContain('There is no frame file for program 2: it did not pass verification');
    expect(cut2).toContain(`Do not run ${NC2}`);
    expect(cut2).not.toContain('material sweep');
    // And a verified job with its frame keeps its trace step.
    expect(text(sheet, 'dry-run')).toContain("traces the job's outline in the air");
  });

  it('a job that genuinely failed verification still says do not run, even beside surface facts', () => {
    const j = job();
    const plain = buildRunSheet(j, itemGenerated(undefined, false), NO_SIM, NOW);
    expect(text(plain, 'dry-run')).toContain('did not pass verification');
    expect(text(plain, 'dry-run')).toContain('Do not run this file');
    // A failed verifier report is a failure whatever else the result carries.
    const failed = buildRunSheet(j, { ...itemGenerated(undefined, false), surface3d: FACTS }, NO_SIM, NOW);
    expect(text(failed, 'dry-run')).toContain('Do not run this file');
    expect(text(failed, 'dry-run')).not.toContain('material sweep');
  });

  it('a later 2D program in a goal run is not excused by the surface marker it lacks', () => {
    const j = job();
    const sheet = buildRunSheet(j, goalGenerated([program(NC1, 1, { surfaceCheck: SURFACE }), program(NC2, 1)]), NO_SIM, NOW);
    expect(text(sheet, 'cut-2')).toContain(`Do not run ${NC2}`);
  });
});

describe('run sheet — the turn between setups', () => {
  it('a two-setup goal job turns the part over before setup 2: what, about which axis, and on what', () => {
    const j = flipped(job());
    const sheet = buildRunSheet(
      j,
      goalGenerated([program(NC1, 1, { surfaceCheck: SURFACE }), program(NC2, 2, { surfaceCheck: SURFACE })]),
      NO_SIM,
      NOW,
    );
    const steps = sheet.sections.find((s) => s.id === 'cut-2')!.steps;
    const turn = steps[0]!;
    expect(turn.bold).toBe(true);
    expect(turn.text).toContain('Turn the part over for setup 2.');
    expect(turn.text).toContain('about the machine’s X axis');
    expect(turn.text).toContain('the face now up goes DOWN');
    expect(turn.text).toContain('Register it on the two locating pins');
    expect(turn.text).toContain('X 10, Y 4');
    // Side 2 of a turned-over goal frees the part: said plainly, right after the turn.
    expect(steps[1]!.text).toBe(
      'Side 2 cuts the part free; it will be loose in the vise — hold it or stop before the last pass.',
    );
  });

  it('with no pins the turn registers on the fixed jaw and asks for the origin again', () => {
    const j = flipped(job(), false);
    const sheet = buildRunSheet(
      j,
      goalGenerated([program(NC1, 1, { surfaceCheck: SURFACE }), program(NC2, 2, { surfaceCheck: SURFACE })]),
      NO_SIM,
      NOW,
    );
    expect(text(sheet, 'cut-2')).toContain('Register it on the vise’s fixed jaw');
  });

  it('a 2D two-setup job gets the turn but no free-part warning', () => {
    const j = flipped(job());
    const sheet = buildRunSheet(j, itemGenerated([program(NC1, 1, { frameNc: 'f1' }), program(NC2, 2, { frameNc: 'f2' })]), NO_SIM, NOW);
    expect(text(sheet, 'cut-2')).toContain('Turn the part over for setup 2.');
    expect(all(sheet)).not.toContain('cuts the part free');
  });

  it('programs in one setup get no turn', () => {
    const j = job();
    const sheet = buildRunSheet(
      j,
      goalGenerated([program(NC1, 1, { surfaceCheck: SURFACE }), program(NC2, 1, { surfaceCheck: SURFACE })]),
      NO_SIM,
      NOW,
    );
    expect(all(sheet)).not.toContain('Turn the part over');
    expect(all(sheet)).not.toContain('cuts the part free');
  });
});
