// The program runner (#182): machine state, pauses, segments and checkpoints.
// Hand-written fixtures only; the vendor corpus is opt-in at the bottom.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEvent, buildTimeline, initialState, parseGcode, stubSetup, type Setup } from '@/engine/cnc';
import type { GcodeEvent } from '@/engine/cnc/gcode';

const part = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [76.2, 38.1] as [number, number] }, thickness: 3.81 };
const hold = { kind: 'tape-down' as const, contact: part.outline };
const setupWith = (o: Partial<Setup> = {}): Setup => stubSetup(part, hold, o);
const run = (src: string, o: Partial<Setup> = {}) => buildTimeline(parseGcode(src), setupWith(o));
const codes = (src: string, o: Partial<Setup> = {}) => run(src, o).diagnostics.map((d) => d.code);

describe('machine state: what the controller holds after each step', () => {
  it('starts from the setup: starting tool, spindle off, nothing known', () => {
    const s = initialState(setupWith({ startingTool: 3 }));
    expect(s).toMatchObject({ tool: 3, spindle: 'off', air: false, laser: false, wcs: 0 });
    expect(s.work).toEqual([null, null, null]);
    expect(s.machine).toEqual([null, null, null]);
  });

  it('spindle, air and laser follow their events', () => {
    const tl = run('S12000 M3\nM7\nM5\nM9\nM321\n');
    expect(tl.stateAt(0)).toMatchObject({ spindle: 'cw', rpm: 12000 });
    expect(tl.stateAt(1)).toMatchObject({ air: true });
    expect(tl.stateAt(2)).toMatchObject({ spindle: 'off' });
    expect(tl.stateAt(3)).toMatchObject({ air: false });
    expect(tl.stateAt(4)).toMatchObject({ laser: true });
  });

  it('work position maps to MACHINE through the WCS: machine = work + wcs.origin', () => {
    // stubSetup puts the work origin at (0, 0, thickness) = (0, 0, 3.81).
    const tl = run('G0 X10 Y20 Z-0.6\n');
    const s = tl.stateAt(0);
    expect(s.work).toEqual([10, 20, -0.6]);
    expect(s.machine[0]).toBeCloseTo(10, 12);
    expect(s.machine[1]).toBeCloseTo(20, 12);
    expect(s.machine[2]).toBeCloseTo(3.21, 12);
  });

  it('a G53 move sets the MACHINE position and derives the work one', () => {
    const tl = run('G90 G0 G53 Z-3\nG53 G0 X-5 Y-6\n');
    expect(tl.stateAt(0).machine).toEqual([null, null, -3]);
    expect(tl.stateAt(1).machine).toEqual([-5, -6, -3]);
    expect(tl.stateAt(1).work[0]).toBeCloseTo(-5, 12);
    expect(tl.stateAt(1).work[2]).toBeCloseTo(-3 - 3.81, 12);
  });

  it('an unknown axis stays unknown through the frame conversion', () => {
    const s = run('G0 X10 Y20\n').stateAt(0);
    expect(s.work).toEqual([10, 20, null]);
    expect(s.machine[2]).toBeNull();
  });

  it('G10 L2 P0 in the FILE overrides the stubbed work offset (the WCS lives in the controller)', () => {
    const tl = run('G10L2P0X-300Y-210Z-50\nG0 X1 Y2 Z3\n');
    expect(tl.stateAt(0).wcsOrigin).toEqual([-300, -210, -50]);
    expect(tl.stateAt(1).machine).toEqual([-299, -208, -47]);
  });

  it('G10 L2 for an offset OTHER than G54 is ignored, not guessed', () => {
    expect(run('G10L2P1X-9Y-9Z-9\n').stateAt(0).wcsOrigin).toEqual([0, 0, 3.81]);
  });

  it('G28, a probe and M491 forget the position', () => {
    for (const cmd of ['G28', 'G38.2 Z-5 F50', 'M491']) {
      const s = run(`G0 X1 Y2 Z3\n${cmd}\n`).stateAt(1);
      expect(s.work, cmd).toEqual([null, null, null]);
      expect(s.machine, cmd).toEqual([null, null, null]);
    }
  });

  it('selecting a work offset the setup was not given makes positions unknown, and warns ONCE', () => {
    const tl = run('G0 X1 Y2 Z3\nG55\nG0 X5\nG55\n');
    expect(tl.stateAt(1).wcs).toBe(1);
    expect(tl.stateAt(2).machine).toEqual([null, null, null]);
    expect(tl.diagnostics.filter((d) => d.code === 'wcs-unmodelled')).toHaveLength(1);
  });

  it('M2 / M30 reset the work offset to G54', () => {
    // M30 emits an air-off event BEFORE program-end, so the reset lands on the LAST step.
    const tl = run('G55\nM30\n');
    expect(tl.stateAt(0).wcs).toBe(1);
    expect(tl.stateAt(tl.events.length - 1).wcs).toBe(0);
  });

  it('the reducer never mutates its input', () => {
    const s0 = initialState(setupWith());
    const frozen = JSON.stringify(s0);
    const ev: GcodeEvent = { kind: 'move', line: 1, mode: 'rapid', frame: 'work', from: [null, null, null], to: [1, 2, 3], a: null, feed: null, power: null, fromArc: false, commanded: [true, true, true], values: [1, 2, 3], relative: false };
    applyEvent(s0, ev, setupWith());
    expect(JSON.stringify(s0)).toBe(frozen);
  });
});

describe('the runner knows MORE than the parser, and must not be overwritten by its nulls', () => {
  // The parser cannot know the starting tool, so it treats `T1M6` as a real change and forgets
  // Z. The runner, told the tool is already T1, correctly keeps it. These fixtures failed
  // when the runner adopted the parser's `to` wholesale: the NEXT move's null Z overwrote
  // the Z the runner had kept, and a known-good setup raised a false `cut-unknown-z`. They
  // were found in review; a test that only looked right after the change could not see them.
  it('a stated starting tool: Z survives the no-op M6 AND the move after it', () => {
    const tl = run('G0 X1 Y2 Z3\nT1M6\nS1000 M3\nG1 X4 F100\n', { startingTool: 1 });
    expect(tl.diagnostics.map((d) => d.code)).not.toContain('cut-unknown-z');
    expect(tl.stateAt(3).work).toEqual([4, 2, 3]);
  });

  it('...whereas with the starting tool UNKNOWN the change is real and Z is genuinely lost', () => {
    const tl = run('G0 X1 Y2 Z3\nT1M6\nS1000 M3\nG1 X4 F100\n', { startingTool: 'unknown' });
    expect(tl.diagnostics.map((d) => d.code)).toContain('cut-unknown-z');
    expect(tl.stateAt(3).work).toEqual([4, 2, null]);
  });

  it('a G53 move keeps the work X, Y it knows nothing about, and the derived work Z', () => {
    // Before the fix the work position after the G53 Z move was [null, null, -6.81]: it lost
    // X and Y as well as the next move's Z.
    const tl = run('G0 X1 Y2 Z3\nG53 G0 Z-3\nS1000 M3\nG1 X9 F100\n');
    expect(tl.stateAt(1).work[0]).toBe(1);
    expect(tl.stateAt(1).work[1]).toBe(2);
    expect(tl.stateAt(1).work[2]).toBeCloseTo(-3 - 3.81, 12); // machine Z -3, minus the 3.81 WCS height
    expect(tl.diagnostics.map((d) => d.code)).not.toContain('cut-unknown-z');
    expect(tl.stateAt(3).work[0]).toBe(9);
    expect(tl.stateAt(3).work[1]).toBe(2);
    expect(tl.stateAt(3).work[2]).toBeCloseTo(-6.81, 12);
  });

  it('a RELATIVE move resolves against the runner\'s base even when the parser\'s was unknown', () => {
    // The parser forgot Z at the (to it, real) T1M6, so G91 G1 Z-1 has an unknown base THERE.
    // The runner knows Z = 3, so the move lands at 2 and is a proper checkpoint.
    const tl = run('G0 X1 Y2 Z3\nT1M6\nS1000 M3\nG91\nG1 Z-1 F100\n', { startingTool: 1 });
    expect(tl.diagnostics.map((d) => d.code)).not.toContain('cut-unknown-z');
    expect(tl.stateAt(tl.events.length - 1).work[2]).toBe(2);
    expect(tl.checkpoints.map((c) => c.zKey)).toEqual([2000]);
  });

  it('a relative move from a base NOBODY knows stays unknown: nothing is invented', () => {
    const tl = run('S1000 M3\nG91\nG1 Z-1 F100\n');
    expect(tl.diagnostics.map((d) => d.code)).toContain('cut-unknown-z');
  });

  it('only the axes a line COMMANDED change; the rest are the runner\'s own', () => {
    const tl = run('G0 X1 Y2 Z3\nG0 Y9\n');
    expect(tl.stateAt(1).work).toEqual([1, 9, 3]);
  });

  it('a tessellated arc is taken as the parser resolved it', () => {
    const tl = run('G0 X0 Y0 Z0\nS1000 M3\nG2 X10 Y0 I5 J0 F100\n');
    expect(tl.stateAt(tl.events.length - 1).work).toEqual([10, 0, 0]);
  });
});

describe('tool changes and pauses (the emulator stops where the machine stops)', () => {
  it('a real tool change is a pause point; the tool becomes active; the spindle is stopped', () => {
    const tl = run('S1000 M3\nT2M6\n', { startingTool: 1 });
    expect(tl.pauses).toHaveLength(1);
    expect(tl.pauses[0]).toMatchObject({ kind: 'tool-change', fromTool: 1, toTool: 2, step: 2 });
    expect(tl.stateAt(2)).toMatchObject({ tool: 2, spindle: 'off' });
  });

  it('after a change X and Y survive and ONLY Z is unknown, in both frames', () => {
    const s = run('G0 X10 Y20 Z5\nT2M6\n', { startingTool: 1 }).stateAt(1);
    expect(s.work).toEqual([10, 20, null]);
    expect(s.machine[0]).toBeCloseTo(10, 12);
    expect(s.machine[1]).toBeCloseTo(20, 12);
    expect(s.machine[2]).toBeNull();
  });

  it('M6 to the ALREADY-ACTIVE tool is not a pause, and leaves the position alone', () => {
    const tl = run('G0 X1 Y2 Z3\nT1M6\n', { startingTool: 1 });
    expect(tl.pauses).toHaveLength(0);
    expect(tl.diagnostics.map((d) => d.code)).toContain('tool-change-noop');
    expect(tl.stateAt(1).work).toEqual([1, 2, 3]); // Z survives a no-op
  });

  it('the STARTING TOOL decides whether the first T1 M6 is real', () => {
    // The firmware does nothing for M6 to the active tool, and a program cannot know the
    // machine's starting tool, so the setup has to say.
    expect(run('T1M6\n', { startingTool: 1 }).pauses).toHaveLength(0);
    expect(run('T1M6\n', { startingTool: 2 }).pauses).toHaveLength(1);
    const unknown = run('T1M6\n', { startingTool: 'unknown' });
    expect(unknown.pauses).toHaveLength(1); // cannot be ruled out, so it is treated as real
    expect(unknown.diagnostics.map((d) => d.code)).toContain('tool-change-ambiguous');
  });

  it('M490.1 and M600 are pauses; M490.2 (the resume) is not', () => {
    const tl = run('M490.1\nM490.2\nM600\n');
    expect(tl.pauses.map((p) => p.kind)).toEqual(['M490.1', 'M600']);
  });

  it('seven tool changes are seven pauses, none of them an error', () => {
    // Shaped like the vendor's atc-test.nc (T0M6 .. T6M6), hand-written here.
    const tl = run('T0M6\nT1M6\nT2M6\nT3M6\nT4M6\nT5M6\nT6M6\n');
    expect(tl.pauses).toHaveLength(7);
    expect(tl.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

describe('segments: the boundaries playback pauses and scrubs on', () => {
  const prog = [
    ';@MKR|TOOLPATH_START|toolpath_number=1',
    'T1 M6',
    'S10000 M3',
    'G0 X0 Y0 Z5',
    'G1 Z-1 F100',
    ';@MKR|TOOLPATH_START|toolpath_number=2',
    'G1 X10 F100',
    'T2 M6',
    'S10000 M3',
    'G0 Z5',
    'G1 Z-1 F100',
  ].join('\n');

  it('splits at a toolpath marker and at a real tool change, once a move has happened', () => {
    const tl = run(prog, { startingTool: 'unknown' });
    expect(tl.segments.map((s) => s.toolpath)).toEqual([1, 2, 2]);
    expect(tl.segments.length).toBe(3);
  });

  it('boundary events that stack with no work between them do NOT leave empty segments', () => {
    // Marker, then T1 M6, then spindle on, then the first move: all one segment.
    const tl = run(prog, { startingTool: 'unknown' });
    expect(tl.segments[0]?.start).toBe(0);
    expect(tl.segments[0]?.pause?.kind).toBe('tool-change');
    for (const s of tl.segments) expect(s.end).toBeGreaterThan(s.start);
  });

  it('segments tile the program exactly: contiguous, no gaps, no overlap', () => {
    const tl = run(prog, { startingTool: 'unknown' });
    expect(tl.segments[0]?.start).toBe(0);
    for (let i = 1; i < tl.segments.length; i++) expect(tl.segments[i]?.start).toBe(tl.segments[i - 1]?.end);
    expect(tl.segments.at(-1)?.end).toBe(tl.events.length);
  });

  it("a segment's tool is the tool in force at its FIRST MOVE, i.e. after the change", () => {
    const tl = run(prog, { startingTool: 1 });
    expect(tl.segments.map((s) => s.tool)).toEqual([1, 1, 2]);
  });
});

describe('checkpoints: keyed by (segment, Z), never by Z alone', () => {
  it('two cuts at the SAME depth either side of a tool change are TWO checkpoints', () => {
    // This is the defect the review found in §4.3's original keying: bucketing by Z across the
    // whole program merges them, destroys their order, and leaves the M6 pause nothing to show.
    const tl = run('S1000 M3\nG1 Z-1 F100\nG1 X5\nT2M6\nS1000 M3\nG1 Z-1 F100\nG1 X9\n', { startingTool: 1 });
    const atMinus1 = tl.checkpoints.filter((c) => c.zKey === -1000);
    expect(atMinus1).toHaveLength(2);
    expect(atMinus1.map((c) => c.segment)).toEqual([0, 1]);
    expect(atMinus1[0]?.steps.length).toBe(2); // the plunge and the traverse, in program order
  });

  it('buckets by quantised Z in micrometres', () => {
    const tl = run('S1000 M3\nG1 Z-0.5 F100\nG1 X1\nG1 X2 Z-0.5004\nG1 Z-0.6\n');
    const keys = tl.checkpoints.map((c) => c.zKey);
    expect(keys).toContain(-500);
    expect(new Set(keys).size).toBe(keys.length); // no duplicates within a segment
  });

  it('a move that changes Z uses its LOWEST Z, and is flagged non-constant', () => {
    // The conservative rule (§3.2): OVER-removes, so the over-cut oracle has to tolerate it.
    const tl = run('S1000 M3\nG1 X0 Y0 Z0 F100\nG1 X5 Z-1\n');
    const ramp = tl.checkpoints.find((c) => c.zKey === -1000);
    expect(ramp?.nonConstantZ).toBe(true);
    const flat = tl.checkpoints.find((c) => c.zKey === 0);
    expect(flat?.nonConstantZ).toBe(false);
  });

  it('a plunge from an UNKNOWN Z is a constant-Z column, not a ramp', () => {
    // After a tool change Z is unknown; `G1 Z-1` then plunges from the clearance height. That
    // is a vertical column from -1 up, which the lowest-Z rule removes exactly.
    const tl = run('S1000 M3\nG1 Z-1 F100\n');
    expect(tl.checkpoints[0]?.nonConstantZ).toBe(false);
  });

  it('only CUTTING moves make checkpoints: rapids and laser moves do not', () => {
    expect(run('G0 X1 Y1 Z-5\n').checkpoints).toHaveLength(0);
    expect(run('M321\nG1 X1 Y1 Z-5 S0.5 F100\n').checkpoints).toHaveLength(0);
  });

  it('checkpoints are in program order', () => {
    const tl = run('S1000 M3\nG1 Z-1 F100\nG1 Z-2\nG1 Z-3\n');
    expect(tl.checkpoints.map((c) => c.zKey)).toEqual([-1000, -2000, -3000]);
  });
});

describe('what a volumetric oracle cannot see, a state machine can', () => {
  it('a cutting move at a Z the program never established is an ERROR: nothing is invented', () => {
    expect(codes('S1000 M3\nG1 X5 F100\n')).toContain('cut-unknown-z');
    expect(run('S1000 M3\nG1 X5 F100\n').diagnostics.find((d) => d.code === 'cut-unknown-z')?.severity).toBe('error');
  });

  it('a feed move with the spindle off is reported, as a WARNING', () => {
    // An error would refuse the vendor's own fatigue-test-air.nc, which opens with exactly
    // this under the label "(Height Test)". It is an error only when it enters stock.
    const tl = run('G0 Z5\nG1 Z-1 F100\n');
    const d = tl.diagnostics.find((x) => x.code === 'cut-spindle-off');
    expect(d?.severity).toBe('warning');
    expect(d?.line).toBe(2);
  });

  it('no warning once the spindle is on, and none in laser mode', () => {
    expect(codes('G0 Z5\nS1000 M3\nG1 Z-1 F100\n')).not.toContain('cut-spindle-off');
    expect(codes('M321\nG1 X1 Y1 Z0 S0.5 F100\n')).not.toContain('cut-spindle-off');
  });

  it('a tool change stops the spindle, so cutting straight after one without M3 is reported', () => {
    const tl = run('S1000 M3\nG0 Z5\nT2M6\nG0 Z5\nG1 Z-1 F100\n', { startingTool: 1 });
    expect(tl.diagnostics.map((d) => d.code)).toContain('cut-spindle-off');
  });
});

describe('stateAt: scrubbing is exact at every snapshot boundary', () => {
  // 3000 steps with a changing state, folded sequentially, against stateAt at awkward indices.
  const lines: string[] = ['S1000 M3'];
  for (let i = 0; i < 3000; i++) lines.push(i % 700 === 699 ? 'T' + ((i % 5) + 1) + 'M6' : `G1 X${i % 97} Y${i % 53} Z${-(i % 11)} F100`);
  const setup = setupWith({ startingTool: 9 });
  const parsed = parseGcode(lines.join('\n'));
  const tl = buildTimeline(parsed, setup);

  it('matches a straight sequential fold at the awkward indices', () => {
    let s = initialState(setup);
    const folded: ReturnType<typeof initialState>[] = [];
    for (const ev of parsed.events) {
      s = applyEvent(s, ev, setup);
      folded.push(s);
    }
    for (const i of [0, 1, 510, 511, 512, 513, 1022, 1023, 1024, 1535, 1536, 2047, 2048, parsed.events.length - 1]) {
      expect(tl.stateAt(i), `step ${i}`).toEqual(folded[i]);
    }
  });

  it('stateAt(-1) is the state before the program; an index past the end clamps', () => {
    expect(tl.stateAt(-1)).toEqual(initialState(setup));
    expect(tl.stateAt(1e9)).toEqual(tl.stateAt(parsed.events.length - 1));
  });
});

describe('summary', () => {
  it('counts steps, segments, pauses, checkpoints and cutting moves', () => {
    const tl = run('T1M6\nS1000 M3\nG1 Z-1 F100\nG1 X5\nG0 Z5\n', { startingTool: 'unknown' });
    expect(tl.summary).toEqual({ steps: 5, segments: 1, pauses: 1, checkpoints: 1, cuttingMoves: 2 });
  });
});

// ---------------------------------------------------------------------------------------
// OPT-IN: Makera's reference corpus (`npm run reference-gcode:fetch`). Skipped when absent.
// ---------------------------------------------------------------------------------------
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reference-gcode');

describe.skipIf(!existsSync(CORPUS))('the runner on the vendor corpus', () => {
  const load = (rel: string) => parseGcode(readFileSync(join(CORPUS, rel), 'latin1'));

  it('atc-test.nc: seven tool changes are seven pauses — or six, if the spindle already holds T0', () => {
    const p = load('Tests/atc-test.nc');
    expect(buildTimeline(p, setupWith({ startingTool: 'unknown' })).pauses).toHaveLength(7);
    const six = buildTimeline(p, setupWith({ startingTool: 0 }));
    expect(six.pauses).toHaveLength(6);
    expect(six.diagnostics.map((d) => d.code)).toContain('tool-change-noop');
  });

  it('Z1/TopClamp.nc: three toolpaths, one tool change, no errors', () => {
    const tl = buildTimeline(load('Z1/TopClamp.nc'), setupWith({ startingTool: 'unknown' }));
    expect(tl.segments.map((s) => s.toolpath)).toEqual([1, 2, 3]);
    expect(tl.pauses).toHaveLength(1);
    expect(tl.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(tl.summary.cuttingMoves).toBe(9607);
    expect(tl.summary.checkpoints).toBeGreaterThan(300); // a ramping 3D job: many Z levels
  });

  it("fatigue-test-air.nc's feed moves before M3 are WARNINGS (the vendor's own height test)", () => {
    const tl = buildTimeline(load('Tests/fatigue-test-air.nc'), setupWith());
    expect(tl.diagnostics.filter((d) => d.code === 'cut-spindle-off').map((d) => d.severity)).toEqual(['warning', 'warning', 'warning']);
  });

  it('NO file in the corpus produces a state-level ERROR: all of them, not a hand-picked few', () => {
    // An earlier version looped over ten files chosen by eye. Whatever the hand picks is
    // whatever the author already believes works; the gate is every file.
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of readdirSync(d)) {
        const f = join(d, e);
        if (statSync(f).isDirectory()) walk(f, out);
        else if (f.endsWith('.nc')) out.push(f);
      }
      return out;
    };
    const files = walk(CORPUS);
    expect(files).toHaveLength(26);
    const bad: string[] = [];
    for (const f of files) {
      const tl = buildTimeline(parseGcode(readFileSync(f, 'latin1')), setupWith());
      for (const d of tl.diagnostics) if (d.severity === 'error') bad.push(`${f.slice(CORPUS.length + 1)}:${d.line} ${d.code}`);
    }
    expect(bad).toEqual([]);
  });
});
