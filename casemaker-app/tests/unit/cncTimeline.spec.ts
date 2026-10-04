// The program runner (#182): machine state, pauses, segments and checkpoints.
// Hand-written fixtures only; the vendor corpus is opt-in at the bottom.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEvent, buildTimeline, initialState, parseGcode, stubSetup, Z1, DIAGNOSTIC_CAP, type Setup } from '@/engine/cnc';
import type { GcodeEvent } from '@/engine/cnc/gcode';

const part = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [76.2, 38.1] as [number, number] }, thickness: 3.81 };
const hold = { kind: 'tape-down' as const, contact: part.outline };
const setupWith = (o: Partial<Setup> = {}): Setup => stubSetup(part, hold, o);
const run = (src: string, o: Partial<Setup> = {}) => buildTimeline(parseGcode(src), setupWith(o));
const codes = (src: string, o: Partial<Setup> = {}) => run(src, o).diagnostics.map((d) => d.code);
/** Positions through the 3.81 mm stub accumulate float noise; compare to 1e-9, nulls exactly. */
const expectPos = (actual: readonly (number | null)[], expected: readonly (number | null)[]): void => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((e, i) => (e === null ? expect(actual[i]).toBeNull() : expect(actual[i]).toBeCloseTo(e, 9)));
};

describe('machine state: what the controller holds after each step', () => {
  it('starts from the setup: starting tool, spindle off, nothing known', () => {
    const s = initialState(setupWith({ startingTool: 3 }));
    expect(s).toMatchObject({ tool: 3, spindle: 'off', air: false, laser: false, wcs: 0, a: null });
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

  it('REGRESSION (review #4): P1 is G54 — the firmware does `--n` — and P2 is another offset, ignored', () => {
    expect(run('G10L2P1X-9Y-9Z-9\n').stateAt(0).wcsOrigin).toEqual([-9, -9, -9]);
    const other = run('G10L2P2X-9Y-9Z-9\n');
    expect(other.stateAt(0).wcsOrigin).toEqual([0, 0, 3.81]);
    expect(other.diagnostics.map((d) => d.code)).toContain('wcs-set-unmodelled');
  });

  it('G10 without P is ignored by the firmware, so the parser emits nothing and the runner sees nothing', () => {
    const tl = run('G10L2X-9Y-9Z-9\nG0 X1 Y2 Z3\n');
    expect(tl.stateAt(tl.events.length - 1).wcsOrigin).toEqual([0, 0, 3.81]);
    expectPos(tl.stateAt(tl.events.length - 1).machine, [1, 2, 6.81]);
  });

  it('G10 L20 sets the offset so the CURRENT position reads as the given values', () => {
    // At work (1, 2, 3) = machine (1, 2, 6.81), "read as (0, 0, 0)" puts the origin at the head.
    const tl = run('G0 X1 Y2 Z3\nG10L20P1X0Y0Z0\nG0 X5\n');
    expectPos(tl.stateAt(1).wcsOrigin, [1, 2, 6.81]);
    expect(tl.stateAt(1).work).toEqual([0, 0, 0]);
    expectPos(tl.stateAt(2).machine, [6, 2, 6.81]);
  });

  it('G10 L20 from an unknown position leaves that origin axis unknown — and everything through it', () => {
    const s = run('G0 X1\nG10L20P1X0Y0Z0\n').stateAt(1);
    expect(s.wcsOrigin).toEqual([1, null, null]);
    expect(s.work).toEqual([0, null, null]);
  });

  describe('G92 shifts an offset the frame maths must carry (review #4: it was ignored)', () => {
    it('G92 X.. Y.. Z..: the current position READS as the values; the machine does not move', () => {
      const tl = run('G0 X10 Y20 Z3\nG92 X0 Y0 Z0\nG0 X5\n');
      expect(tl.stateAt(1).work).toEqual([0, 0, 0]);
      expectPos(tl.stateAt(1).machine, [10, 20, 6.81]);
      expectPos(tl.stateAt(1).g92, [-10, -20, -3]); // g92 = v − machine + origin: 0 − 6.81 + 3.81
      // A later move is in the SHIFTED frame: work X5 is machine X15.
      expectPos(tl.stateAt(2).machine, [15, 20, 6.81]);
    });

    it('a bare G92, G92.1 and G92.2 RESET the offset: the work position jumps back', () => {
      for (const reset of ['G92', 'G92.1', 'G92.2']) {
        const tl = run(`G0 X10 Y20 Z3\nG92 X0 Y0 Z0\n${reset}\n`);
        expect(tl.stateAt(2).g92, reset).toEqual([0, 0, 0]);
        expectPos(tl.stateAt(2).work, [10, 20, 3]);
      }
    });

    it('G92.3 sets the offset to the raw values', () => {
      expect(run('G92.3 X1 Y2 Z3\n').stateAt(0).g92).toEqual([1, 2, 3]);
    });

    it('G92.4 is a manual homing: the MACHINE position is redefined, so nothing is known, and it warns', () => {
      const tl = run('G0 X1 Y2 Z3\nG92.4 X0 Y0 Z0\n');
      expect(tl.stateAt(1).machine).toEqual([null, null, null]);
      expect(tl.diagnostics.map((d) => d.code)).toContain('g92-4-manual-home');
    });

    it('a shift from an UNKNOWN position: the work axis is the value written, the offset is unknown', () => {
      const s = run('G92 X0\n').stateAt(0);
      expect(s.work[0]).toBe(0);
      expect(s.g92[0]).toBeNull();
      expect(s.machine[0]).toBeNull();
    });
  });

  it('G28 and M491 make the whole position unknown again', () => {
    for (const cmd of ['G28', 'M491']) {
      const s = run(`G0 X1 Y2 Z3\n${cmd}\n`).stateAt(1);
      expect(s.work, cmd).toEqual([null, null, null]);
      expect(s.machine, cmd).toEqual([null, null, null]);
    }
  });

  it('a probe forgets ONLY the axes it moved: a Z probe leaves X,Y where they were', () => {
    const s = run('G0 X1 Y2 Z3\nG38.2 Z-5 F50\n').stateAt(1);
    expect(s.work).toEqual([1, 2, null]);
    expect(s.machine[2]).toBeNull();
    expect(s.machine[0]).toBeCloseTo(1, 12);
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

  it('REGRESSION (review #4): an arc after a no-op M6 keeps the runner\'s Z and stays an arc', () => {
    // The parser lost Z at `T1M6`; the runner, told T1 is active, did not. Arc points used to
    // bypass resolveMove and overwrite the runner's Z with the parser's null — then the cut was
    // "from unknown Z" and the sweep drew nothing. Now they resolve like any other move.
    const tl = run('G0 X0 Y0 Z3\nT1M6\nS1000 M3\nG2 X10 Y0 I5 J0 F100\n', { startingTool: 1 });
    const codes = tl.diagnostics.map((d) => d.code);
    expect(codes).not.toContain('cut-unknown-z');
    expect(codes).not.toContain('arc-from-unknown');
    expect(tl.events.filter((e) => e.kind === 'move' && e.fromArc).length).toBeGreaterThan(1);
    expect(tl.stateAt(tl.events.length - 1).work).toEqual([10, 0, 3]);
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

describe('the tool-change macro, animated from the machine profile (#182 Q14, #184)', () => {
  const M = Z1;
  const prog = 'G0 X-50 Y-60 Z-10\nS1000 M3\nT2M6\nG0 X-55\n';

  it('without a profile: a pause, X,Y kept, Z unknown (the un-expanded change)', () => {
    const tl = run(prog, { startingTool: 1 });
    expect(tl.events.filter((e) => e.synthetic)).toHaveLength(0);
    // The parser emits a `spindle off` BEFORE the change (the spindle was on), so the change
    // is not at the index a naive count gives: find it.
    const tc = tl.events.findIndex((e) => e.kind === 'tool-change');
    expect(tl.stateAt(tc).machine).toEqual([-50, -60, null]);
  });

  it('with the Z1 profile: the macro\'s steps are inserted, in the firmware\'s order', () => {
    const tl = buildTimeline(parseGcode(prog), setupWith({ startingTool: 1 }), M);
    const synth = tl.events.filter((e) => e.synthetic === 'tool-change-macro');
    expect(synth.map((e) => e.kind)).toEqual([
      'move', 'move', // lift to clearance Z, park at the change position
      'move', // to the sensor, AT clearance Z (fill_cali_scripts with clear_z = true)
      'probe', 'move', 'probe', 'tlo-calibrate', // probe fast, retract, probe slow, save the offset
      'move', 'move', 'move', // safe Z, clearance Z, back to the saved X,Y
    ]);
    // Every synthetic step carries the M6 line, and is a machine-frame rapid.
    expect(synth.every((e) => e.line === 3)).toBe(true);
    expect(synth.filter((e) => e.kind === 'move').every((e) => e.kind === 'move' && e.frame === 'machine' && e.mode === 'rapid')).toBe(true);
  });

  it('the tool-change event itself sits between the park and the probe, and is the pause point', () => {
    const tl = buildTimeline(parseGcode(prog), setupWith({ startingTool: 1 }), M);
    const tcIdx = tl.events.findIndex((e) => e.kind === 'tool-change');
    expect(tl.events[tcIdx - 1]).toMatchObject({ kind: 'move', synthetic: 'tool-change-macro' });
    expect(tl.events[tcIdx + 1]).toMatchObject({ kind: 'move', synthetic: 'tool-change-macro' });
    expect(tl.pauses).toHaveLength(1);
    expect(tl.pauses[0]?.step).toBe(tcIdx);
    expect(tl.events[tcIdx]).toMatchObject({ kind: 'tool-change', expanded: true });
  });

  it('the head goes where the firmware sends it: clearance, change position, safe, sensor, and BACK', () => {
    const tl = buildTimeline(parseGcode(prog), setupWith({ startingTool: 1 }), M);
    // The program's work (-50, -60, -10) with the stub WCS at (0, 0, 3.81) is machine (-50, -60, -6.19).
    const steps = tl.events.map((_, i) => tl.stateAt(i).machine);
    const tc = M.toolChange;
    const first = tl.events.findIndex((e) => e.synthetic === 'tool-change-macro'); // the lift
    expect(steps[first]).toEqual([-50, -60, tc.clearanceZ]);
    expect(steps[first + 1]).toEqual([tc.changePosition[0], tc.changePosition[1], tc.clearanceZ]);
    expect(tl.events[first + 2]?.kind).toBe('tool-change');
    // REGRESSION (review #4): the traverse to the sensor is at CLEARANCE Z, not safe Z.
    expect(steps[first + 3]).toEqual([tc.sensor[0], tc.sensor[1], tc.clearanceZ]);
    expect(steps[first + 4]).toEqual([tc.sensor[0], tc.sensor[1], null]); // after the fast probe: Z is at contact
    expect(steps[first + 5]).toEqual([tc.sensor[0], tc.sensor[1], null]); // the 1 mm retract from an unknown Z is unknown
    expect(steps[first + 6]).toEqual([tc.sensor[0], tc.sensor[1], null]); // after the slow probe
    expect(steps[first + 8]).toEqual([tc.sensor[0], tc.sensor[1], tc.safeZ]);
    expect(steps[first + 9]).toEqual([tc.sensor[0], tc.sensor[1], tc.clearanceZ]);
    expect(steps[first + 10]).toEqual([-50, -60, tc.clearanceZ]); // back to the saved X,Y, at clearance
  });

  it('after the macro ALL THREE axes are known, so the next move is drawable', () => {
    const tl = buildTimeline(parseGcode(prog), setupWith({ startingTool: 1 }), M);
    const last = tl.events.length - 1;
    expect(tl.events[last]).toMatchObject({ kind: 'move', frame: 'work' });
    const s = tl.stateAt(last);
    expect(s.work[0]).toBeCloseTo(-55, 12);
    expect(s.work[1]).toBeCloseTo(-60, 12);
    expect(s.work[2]).toBeCloseTo(M.toolChange.clearanceZ - 3.81, 12);
    expect(tl.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('G28 with a profile is "go to the clearance position": Z first, then X,Y — all three known after', () => {
    const tl = buildTimeline(parseGcode('G0 X-50 Y-60 Z-10\nG28\nG0 X-55\n'), setupWith(), M);
    const synth = tl.events.filter((e) => e.synthetic === 'g28-clearance');
    expect(synth.map((e) => e.kind)).toEqual(['move', 'move']);
    const home = tl.events.findIndex((e) => e.kind === 'home');
    expect(tl.events[home]).toMatchObject({ expanded: true });
    expect(tl.stateAt(home + 1).machine).toEqual([-50, -60, M.toolChange.clearanceZ]);
    expect(tl.stateAt(home + 2).machine).toEqual([M.toolChange.clearanceXY[0], M.toolChange.clearanceXY[1], M.toolChange.clearanceZ]);
    expect(tl.diagnostics.map((d) => d.code)).not.toContain('cut-unknown-z');
  });

  it('M491 with a profile is the calibration half of the macro, returning to where it started', () => {
    const tl = buildTimeline(parseGcode('G0 X-50 Y-60 Z-10\nM491\nG0 X-55\n'), setupWith(), M);
    const synth = tl.events.filter((e) => e.synthetic === 'tlo-calibrate');
    expect(synth.map((e) => e.kind)).toEqual(['move', 'move', 'probe', 'move', 'probe', 'tlo-calibrate', 'move', 'move', 'move']);
    const last = tl.events.length - 1;
    expect(tl.stateAt(last - 1).machine).toEqual([-50, -60, M.toolChange.clearanceZ]);
    expect(tl.stateAt(last).work[0]).toBeCloseTo(-55, 12);
  });

  it('a NO-OP change inserts nothing, with or without a profile', () => {
    expect(buildTimeline(parseGcode('G0 X1\nT1M6\n'), setupWith({ startingTool: 1 }), M).events.filter((e) => e.synthetic)).toHaveLength(0);
  });

  it('a change from an unknown position still animates, returning to an unknown X,Y', () => {
    const tl = buildTimeline(parseGcode('T2M6\n'), setupWith({ startingTool: 1 }), M);
    const last = tl.stateAt(tl.events.length - 1).machine;
    expect(last).toEqual([null, null, M.toolChange.clearanceZ]);
  });

  it('synthetic moves never make checkpoints: they are rapids, not cuts', () => {
    const tl = buildTimeline(parseGcode('S1000 M3\nG1 X1 Y1 Z-1 F100\nT2M6\n'), setupWith({ startingTool: 1 }), M);
    expect(tl.summary.checkpoints).toBe(1);
  });
});

describe('stubSetup with a machine (review #4: the default stub sat at the Z1\'s origin, outside its envelope)', () => {
  it('places the part inside the envelope: a whole job runs with no outside-envelope error', () => {
    const setup = stubSetup(part, hold, { startingTool: 1 }, Z1);
    const tl = buildTimeline(parseGcode('G0 X0 Y0 Z5\nS1000 M3\nG1 Z-0.5 F100\nG1 X70 Y30\nG0 Z5\nG28\n'), setup, Z1);
    expect(tl.diagnostics.filter((d) => d.code === 'outside-envelope')).toEqual([]);
    expect(setup.wcs.origin[2]).toBe(Z1.toolChange.safeZ);
    expect(setup.placement.origin[2]).toBeCloseTo(Z1.toolChange.safeZ - part.thickness, 12);
  });

  it('...whereas the machine-less stub does leave it on the first +X move', () => {
    const tl = buildTimeline(parseGcode('G0 X1 Y0 Z5\n'), stubSetup(part, hold), Z1);
    expect(tl.diagnostics.map((d) => d.code)).toContain('outside-envelope');
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
    const tl = run('G0 X0 Y0 Z0\nS1000 M3\nG1 Z-1 F100\nG1 X5\nT2M6\nS1000 M3\nG0 X0 Y0\nG1 Z-1 F100\nG1 X9\n', { startingTool: 1 });
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

  it('carries the resolved WORK-frame X,Y of each cutting move, for the sweep', () => {
    const tl = run('S1000 M3\nG0 X1 Y2 Z0\nG1 Z-1 F100\nG1 X5\nG1 Y7\n');
    const cp = tl.checkpoints[0]!;
    expect(cp.steps).toHaveLength(3);
    expect(cp.xy).toEqual([1, 2, 1, 2, 1, 2, 5, 2, 5, 2, 5, 7]);
  });

  it('a cut from an UNKNOWN X,Y is swept as a plunge at its end (zero-length), noted once', () => {
    const tl = run('S1000 M3\nG1 X3 Y4 Z-1 F100\n');
    expect(tl.checkpoints[0]?.xy).toEqual([3, 4, 3, 4]);
    expect(tl.diagnostics.filter((d) => d.code === 'cut-from-unknown-xy')).toHaveLength(1);
  });

  it('a cut to an UNKNOWN X,Y is an error and is not swept', () => {
    const tl = run('G0 Z0\nS1000 M3\nG91\nG1 X3 Z-1 F100\n');
    expect(tl.diagnostics.map((d) => d.code)).toContain('cut-unknown-xy');
    expect(tl.summary.unsweptMoves).toBe(1);
    expect(tl.checkpoints.every((c) => c.xy.length === 0)).toBe(true);
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
  it('a cutting move at a position the program never established is a WARNING and a counted gap: nothing is invented', () => {
    // Not an error: the MACHINE knows where it is; the emulator was not told. The vendor's own
    // rotary samples open with `G01 Z30` before any X,Y is set and run fine.
    const tl = run('S1000 M3\nG1 X5 F100\n');
    expect(tl.diagnostics.find((d) => d.code === 'cut-unknown-z')?.severity).toBe('warning');
    expect(tl.summary.unsweptMoves).toBe(1);
    expect(tl.checkpoints).toHaveLength(0);
  });

  it('a feed move with the spindle off is NOT reported here: nearness is geometry', () => {
    // Maintainer's rule: neither an error nor a warning unless the tool is near the material,
    // the fixture or the bed. The state machine cannot know that; the sweep can. The vendor's
    // own fatigue-test-air.nc feeds down with the spindle off before its first M3.
    expect(codes('G0 X0 Y0 Z5\nG1 Z-1 F100\n')).toEqual([]);
    expect(codes('S1000 M3\nG0 X0 Y0 Z5\nT2M6\nG0 Z5\nG1 Z-1 F100\n', { startingTool: 1 }).filter((c) => c.includes('spindle'))).toEqual([]);
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

describe('the envelope check (#184): only with a machine, only on known axes, capped', () => {
  it("goto-pack-pos.nc's Carvera coordinates are OUTSIDE the Z1's envelope", () => {
    const tl = buildTimeline(parseGcode('G90 G0 G53 Z-3\nG53 G0 X-295 Y-205\nG53 Z-50\n'), setupWith(), Z1);
    const errs = tl.diagnostics.filter((d) => d.code === 'outside-envelope');
    expect(errs.map((d) => d.line)).toEqual([2, 3]);
    expect(errs[0]?.severity).toBe('error');
  });

  it('a work-frame move is checked in MACHINE coordinates through the WCS', () => {
    // Machine coordinates run negative on the Z1 (home to max, 0 there). The stub WCS at the
    // machine origin puts any +X job off the bed; a realistic WCS at (-150, -150) does not.
    const off = buildTimeline(parseGcode('G0 X10 Y10 Z-1\n'), setupWith(), Z1);
    expect(off.diagnostics.map((d) => d.code)).toContain('outside-envelope');
    const on = buildTimeline(parseGcode('G0 X10 Y10 Z-1\n'), setupWith({ wcs: { origin: [-150, -150, -10], source: 'stub', uncertainty: 0.05 } }), Z1);
    expect(on.diagnostics.map((d) => d.code)).not.toContain('outside-envelope');
  });

  it('without a machine there is no envelope to check', () => {
    expect(codes('G53 G0 X-295 Y-205\n')).not.toContain('outside-envelope');
  });

  it('unknown axes are not checked: only what the program established', () => {
    const tl = buildTimeline(parseGcode('G53 G0 Z-3\n'), setupWith(), Z1);
    expect(tl.diagnostics.map((d) => d.code)).not.toContain('outside-envelope');
  });

  it("the tool-change macro's own positions are inside the envelope", () => {
    const tl = buildTimeline(parseGcode('G0 X-50 Y-60 Z-10\nT2M6\n'), setupWith({ startingTool: 1, wcs: { origin: [0, 0, 0], source: 'stub', uncertainty: 0 } }), Z1);
    expect(tl.diagnostics.filter((d) => d.code === 'outside-envelope')).toEqual([]);
  });

  it('a job entirely off the bed gives DIAGNOSTIC_CAP errors and one "…and N more", not thousands', () => {
    const lines: string[] = [];
    for (let i = 0; i < 40; i++) lines.push(`G0 X${10 + i} Y10 Z-1`);
    const tl = buildTimeline(parseGcode(lines.join('\n')), setupWith(), Z1);
    expect(tl.diagnostics.filter((d) => d.code === 'outside-envelope')).toHaveLength(DIAGNOSTIC_CAP);
    const more = tl.diagnostics.find((d) => d.code === 'outside-envelope-more');
    expect(more?.message).toMatch(/and 15 more/);
  });
});

describe('air moves: what the sweep checks against the stock and the bed', () => {
  it('a rapid with both ends known is an air move; a spindle-off feed too; a cut is not', () => {
    const tl = run('G0 X0 Y0 Z5\nG0 Z1\nG1 Z-1 F100\nS1000 M3\nG1 X5\n');
    expect(tl.airMoves.map((m) => [m.line, m.kind])).toEqual([
      [2, 'rapid'],
      [3, 'feed-spindle-off'],
    ]);
    expect(tl.summary.cuttingMoves).toBe(1); // only the G1 X5, spindle on
    expect(tl.summary.airMoves).toBe(2);
  });

  it('an air move from an UNKNOWN position is not collected: nothing can be checked', () => {
    expect(run('G0 X0 Y0 Z5\n').airMoves).toHaveLength(0);
  });

  it('a spindle-off feed move is NOT a cut and makes no checkpoint', () => {
    const tl = run('G0 X0 Y0 Z1\nG1 Z-1 F100\n');
    expect(tl.checkpoints).toHaveLength(0);
    expect(tl.airMoves[0]?.kind).toBe('feed-spindle-off');
  });

  it('laser-mode moves are neither cuts nor air moves; the job is flagged', () => {
    const tl = run('M321\nG0 X0 Y0 Z0\nG1 X1 S0.5 F100\n');
    expect(tl.summary.laser).toBe(true);
    expect(tl.summary.cuttingMoves).toBe(0);
    expect(tl.airMoves).toHaveLength(0);
  });

  it('an A word flags rotary', () => {
    expect(run('G1 X1 A90 F100\n').summary.rotary).toBe(true);
  });
});

describe('summary', () => {
  it('counts steps, segments, pauses, checkpoints and cutting moves', () => {
    const tl = run('T1M6\nS1000 M3\nG0 X0 Y0 Z0\nG1 Z-1 F100\nG1 X5\nG0 Z5\n', { startingTool: 'unknown' });
    expect(tl.summary).toEqual({ steps: 6, segments: 1, pauses: 1, checkpoints: 1, cuttingMoves: 2, unsweptMoves: 0, airMoves: 1, laser: false, rotary: false });
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

  it("fatigue-test-air.nc's feed moves before M3 raise nothing at all (the vendor's own height test)", () => {
    const tl = buildTimeline(load('Tests/fatigue-test-air.nc'), setupWith());
    expect(tl.diagnostics.filter((d) => d.code.includes('spindle'))).toEqual([]);
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
