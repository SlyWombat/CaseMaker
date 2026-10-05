// Restart from a step (#249). The generator RE-LOWERS the original text through the same pure
// halves the verifier uses (`parseGcode` + `buildTimeline`) and re-emits the tail, so the
// acceptance is mechanical: the restart's moves must land where the original's did, and the
// generated text must pass the SAME verifier with no exemption.
//
// No wasm: the restart never needs the sweep.

import { describe, it, expect } from 'vitest';
import { generateRestart, restartFileName, stockFromSetup, RESTART_TOOL_LENGTH_NOTE } from '@/engine/cnc/restart';
import { parseGcode } from '@/engine/cnc/gcode';
import { buildTimeline, type Timeline } from '@/engine/cnc/emulator/timeline';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';

const STOCK = { length: 20, width: 10, thickness: 5 };
const TOOL = flatEndMill(1);

function setupFor(stock = STOCK, startingTool: number | 'unknown' = 1): Setup {
  return stubSetup(
    { kind: 'prism', outline: rectProfile(stock.length, stock.width), thickness: stock.thickness },
    { kind: 'tape-down', contact: rectProfile(stock.length, stock.width) },
    { startingTool },
    Z1,
  );
}

/** Two open strokes on a 20 × 10 × 5 block, our own dialect: real T1 M6 is a no-op (startingTool 1). */
const PROGRAM = [
  'G90 G21',
  'T1 M6',
  'M7',
  'S12000 M3',
  'G0 X2 Y2 Z5',
  'G0 Z1',
  'G1 Z-1 F200',
  'G1 X10 Y2',
  'G1 X10 Y6',
  'G1 X2 Y6',
  'G0 Z15',
  'M9',
  'M5',
  'G28',
  'M02',
].join('\n');

const timelineOf = (text: string, setup = setupFor()): Timeline => buildTimeline(parseGcode(text), setup, Z1);

/** The index of the first non-synthetic move whose endpoint, in the work frame, is `target`. */
function moveIndexTo(tl: Timeline, target: [number, number, number]): number {
  for (let i = 0; i < tl.events.length; i++) {
    const e = tl.events[i];
    if (e === undefined || e.kind !== 'move' || e.synthetic !== undefined) continue;
    const w = tl.stateAt(i).work;
    if (w[0] === target[0] && w[1] === target[1] && w[2] === target[2]) return i;
  }
  return -1;
}

/** Every non-synthetic move's `mode:workX,workY,workZ` at or after `step`, in order. */
function movesFrom(tl: Timeline, step: number): string[] {
  const out: string[] = [];
  for (let i = step; i < tl.events.length; i++) {
    const e = tl.events[i];
    if (e === undefined || e.kind !== 'move' || e.synthetic !== undefined) continue;
    const w = tl.stateAt(i).work;
    out.push(`${e.mode}:${w[0]},${w[1]},${w[2]}`);
  }
  return out;
}

/** Every non-synthetic cutting move's work-frame endpoint at or after `step`, in order. */
function cutEndsFrom(tl: Timeline, step: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = step; i < tl.events.length; i++) {
    const e = tl.events[i];
    if (e === undefined || e.kind !== 'move' || e.mode !== 'cut' || e.synthetic !== undefined) continue;
    const w = tl.stateAt(i).work;
    if (w[0] === null || w[1] === null || w[2] === null) continue;
    out.push([w[0], w[1], w[2]]);
  }
  return out;
}

describe('restart (#249): generateRestart', () => {
  it('resumes at a step and the tail lands where the original did (acceptance 1)', () => {
    const original = timelineOf(PROGRAM);
    const step = moveIndexTo(original, [10, 2, -1]);
    expect(step).toBeGreaterThan(0);

    const r = generateRestart({
      gcodeText: PROGRAM,
      setup: setupFor(),
      tool: TOOL,
      machine: Z1,
      step,
      stock: STOCK,
      baseName: 'job',
    });

    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.nc).not.toBeNull();
    expect(r.verify?.ok).toBe(true);
    expect(r.verify?.findings).toEqual([]);
    expect(r.fileName).toBe('job-restart-step' + step + '.nc');
    // The state restored is the one AFTER step − 1: resuming AT a step means event `step` has
    // not run yet. Here that is the tool at [2, 2, −1] about to move to [10, 2, −1].
    const before = original.stateAt(step - 1);
    expect(r.resume).toEqual({ step, work: before.work, spindle: before.spindle, rpm: before.rpm, air: before.air, tool: before.tool });
    expect(before.work).toEqual([2, 2, -1]);

    // The restart's moves CONTINUE the original's: after the 3-move approach (retract, XY rapid,
    // descent), every move is the original's own, same mode and same work endpoint. This is
    // acceptance 1 in its strongest form — the simulated motion from the step on is identical.
    const restart = timelineOf(r.nc as string);
    const originalTail = movesFrom(original, step);
    const restartTail = movesFrom(restart, 0).slice(3);
    expect(originalTail.length).toBeGreaterThanOrEqual(3);
    expect(restartTail.slice(0, originalTail.length)).toEqual(originalTail);

    const restartCuts = cutEndsFrom(restart, 0);
    const cutsFromStep = cutEndsFrom(original, step);
    for (const p of cutsFromStep) expect(restartCuts).toContainEqual(p);
    const lastOriginal = original.stateAt(original.events.length - 1);
    const lastRestart = restart.stateAt(restart.events.length - 1);
    expect(lastRestart.spindle).toBe(lastOriginal.spindle);
    expect(lastRestart.air).toBe(lastOriginal.air);
  });

  it('re-establishes the accessory state before it moves (the field’s hard part)', () => {
    const original = timelineOf(PROGRAM);
    const step = moveIndexTo(original, [10, 2, -1]);
    const r = generateRestart({ gcodeText: PROGRAM, setup: setupFor(), tool: TOOL, machine: Z1, step, stock: STOCK, baseName: 'job' });
    const text = r.nc as string;
    const lines = text.split('\n');
    const airIdx = lines.indexOf('M7');
    const spindleIdx = lines.findIndex((l) => l === 'S12000 M3');
    const retractIdx = lines.findIndex((l) => l === 'G0 Z15');
    // The resume point is the state before the cut at `step`: here [2, 2, −1].
    const rapidIdx = lines.findIndex((l) => l === 'G0 X2 Y2');
    const descendIdx = lines.findIndex((l) => l === 'G1 Z-1 F200');
    expect(airIdx).toBeGreaterThan(-1);
    expect(spindleIdx).toBeGreaterThan(airIdx); // air before spindle
    expect(retractIdx).toBeGreaterThan(spindleIdx); // state restored before the retract
    expect(rapidIdx).toBeGreaterThan(retractIdx); // retract before the XY rapid
    expect(descendIdx).toBeGreaterThan(rapidIdx); // controlled descent last
  });

  it('descends at a FEED with the spindle on, never a rapid into material', () => {
    const original = timelineOf(PROGRAM);
    const step = moveIndexTo(original, [10, 6, -1]);
    const r = generateRestart({ gcodeText: PROGRAM, setup: setupFor(), tool: TOOL, machine: Z1, step, stock: STOCK, baseName: 'job' });
    const text = r.nc as string;
    // The resume Z is restored with G1 and a feed; a G0 into the material would be the plunge the
    // issue warns about.
    expect(text).toContain('G1 Z-1 F200');
    expect(text).not.toContain('G0 Z-1');
  });

  it('is REFUSED by the verifier under the same rules as any other file (acceptance 2)', () => {
    const deep = PROGRAM.replace('G1 Z-1 F200', 'G1 Z-11.5 F200');
    const original = timelineOf(deep);
    const step = moveIndexTo(original, [10, 2, -11.5]);
    expect(step).toBeGreaterThan(0);
    const r = generateRestart({ gcodeText: deep, setup: setupFor(), tool: TOOL, machine: Z1, step, stock: STOCK, baseName: 'deep' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/verifier refused/);
    expect(r.verify?.findings.some((f) => f.code === 'cut-too-deep')).toBe(true);
    // The text still comes back, so the panel can show WHY it was refused.
    expect(r.nc).not.toBeNull();
  });

  it('carries the tool-length sentence in the run sheet (acceptance 3)', () => {
    const original = timelineOf(PROGRAM);
    const step = moveIndexTo(original, [10, 2, -1]);
    const r = generateRestart({ gcodeText: PROGRAM, setup: setupFor(), tool: TOOL, machine: Z1, step, stock: STOCK, baseName: 'job' });
    expect(r.runSheet).toContain(RESTART_TOOL_LENGTH_NOTE);
    expect(RESTART_TOOL_LENGTH_NOTE).toMatch(/expected length/);
    expect(r.runSheet.join(' ')).toMatch(/coolant is not modelled/);
    // The header carries it too, so the warning survives a file copied off the machine.
    expect(r.nc as string).toContain(RESTART_TOOL_LENGTH_NOTE);
  });

  it('refuses a counter-clockwise spindle rather than dropping the M4', () => {
    const ccw = PROGRAM.replace('S12000 M3', 'S12000 M4');
    const original = timelineOf(ccw);
    const step = moveIndexTo(original, [10, 2, -1]);
    const r = generateRestart({ gcodeText: ccw, setup: setupFor(), tool: TOOL, machine: Z1, step, stock: STOCK, baseName: 'ccw' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/counter-clockwise/);
    expect(r.nc).toBeNull();
  });

  it('refuses a step with no known position to resume from', () => {
    const r = generateRestart({ gcodeText: PROGRAM, setup: setupFor(), tool: TOOL, machine: Z1, step: 0, stock: STOCK, baseName: 'job' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/outside 1/);
    expect(r.nc).toBeNull();
  });

  it('refuses an event the dialect cannot express, rather than silently dropping it', () => {
    const withPause = PROGRAM.replace('G1 X10 Y6', 'M600\nG1 X10 Y6');
    const original = timelineOf(withPause);
    const step = moveIndexTo(original, [10, 2, -1]);
    const r = generateRestart({ gcodeText: withPause, setup: setupFor(), tool: TOOL, machine: Z1, step, stock: STOCK, baseName: 'pause' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/program stop/);
  });
});

describe('restart (#249): helpers', () => {
  it('names the file from the original stem and the step, sanitised', () => {
    expect(restartFileName('job.nc', 12)).toBe('job-restart-step12.nc');
    expect(restartFileName('My Part (v2).nc', 3)).toBe('My-Part-v2-restart-step3.nc');
    expect(restartFileName('', 0)).toBe('job-restart-step0.nc');
  });

  it('reads the stock back off a prism setup, and gives up on anything else', () => {
    expect(stockFromSetup(setupFor())).toEqual({ length: 20, width: 10, thickness: 5 });
    const cylinder = stubSetup({ kind: 'cylinder', diameter: 12, length: 20 }, { kind: 'tape-down', contact: rectProfile(20, 20) }, { startingTool: 1 }, Z1);
    expect(stockFromSetup(cylinder)).toBeNull();
  });
});
