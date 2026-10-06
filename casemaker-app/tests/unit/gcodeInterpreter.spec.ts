// The modal state machine (#174, #182). Hand-written fixtures only: each one pins a dialect
// fact from /Z1-Firmware-Dialect.md, or a defect the adversarial review found in this
// parser (and says so), or an invariant the emulator relies on.

import { describe, it, expect } from 'vitest';
import { parseGcode, hasErrors } from '@/engine/cnc/gcode';
import type { GcodeEvent, MoveEvent, ParseResult } from '@/engine/cnc/gcode';

const moves = (r: ParseResult) => r.events.filter((e): e is MoveEvent => e.kind === 'move');
const kinds = (r: ParseResult) => r.events.map((e) => e.kind);
const errors = (r: ParseResult) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
const codes = (r: ParseResult) => r.diagnostics.map((d) => d.code);

describe('UNKNOWN IS A STATE: the parser never invents a coordinate', () => {
  it('a program that opens `T1 M6` then rapids with no Z must not get Z = 0', () => {
    // The opening of a real Z1 job (Studio's TopClamp.nc). The tool-change macro leaves the
    // head at a safe height the file cannot see, so the first G0 has no known Z.
    const r = parseGcode('T1 M6\nM7\nG0 X70.11 Y6.42\nS12000 M3\nG0 Z5\n');
    const m = moves(r);
    expect(m[0]?.from).toEqual([null, null, null]);
    expect(m[0]?.to).toEqual([70.11, 6.42, null]);
    expect(m[1]?.from).toEqual([70.11, 6.42, null]);
    expect(m[1]?.to).toEqual([70.11, 6.42, 5]);
    expect(kinds(r)).toEqual(['tool-change', 'air', 'move', 'spindle', 'move']);
  });

  it('an axis that was never set stays null through relative moves', () => {
    const r = parseGcode('G91\nG1 X5 F100\n');
    // X is relative to a position nobody established, so it is still unknown: not 5.
    expect(moves(r)[0]?.to).toEqual([null, null, null]);
  });

  it('G28, G38 and M491 make the position unknown again', () => {
    for (const cmd of ['G28', 'G38.2 Z-5 F50', 'M491']) {
      const r = parseGcode(`G0 X1 Y2 Z3\n${cmd}\nG0 X5\n`);
      const last = moves(r).at(-1)!;
      expect(last.from, cmd).toEqual([null, null, null]);
    }
  });
});

describe('M6, as the firmware executes it (§2)', () => {
  it('keeps X and Y — the head returns to the SAVED position — and forgets only Z', () => {
    // The dialect document first said the head ends "at the far corner". The firmware
    // rapids back to the saved X,Y at clearance Z; Z is a machine constant.
    const r = parseGcode('G0 X10 Y20 Z5\nT2M6\nG0 X30\n');
    expect(moves(r).at(-1)?.from).toEqual([10, 20, null]);
    expect(moves(r).at(-1)?.to).toEqual([30, 20, null]);
  });

  it('does NOTHING for the already-active tool: no change, position kept', () => {
    const r = parseGcode('T1M6\nG0 X1 Y2 Z3\nT1M6\nG0 X4\n');
    const tcs = r.events.filter((e) => e.kind === 'tool-change');
    expect(tcs.map((e) => (e.kind === 'tool-change' ? e.noOp : null))).toEqual([false, true]);
    expect(moves(r).at(-1)?.from).toEqual([1, 2, 3]); // Z survives a no-op
  });

  it('REGRESSION (review #174): M6 with the spindle on stops the spindle; it is NOT an error', () => {
    // The first version, and the dialect document, said the firmware halts. It turns the
    // spindle off first and halts only if it is STILL running afterwards. Makera's own
    // concatenated samples run `M30` then `T1M6` with no `M5` between, and the parser
    // raised 7 false errors on 6 of them.
    const r = parseGcode('S10000 M3\nT1M6\n');
    expect(hasErrors(r)).toBe(false);
    expect(kinds(r)).toEqual(['spindle', 'spindle', 'tool-change']);
    const off = r.events[1];
    expect(off).toMatchObject({ kind: 'spindle', state: 'off' });
    expect(r.events[2]).toMatchObject({ kind: 'tool-change', tool: 1, stoppedSpindle: true });
  });

  it('M6 with no T in the same command does nothing, and says so', () => {
    expect(errors(parseGcode('M6\n'))).toEqual(['m6-without-t']);
    // T on one line and M6 on the next is the same mistake: T alone does nothing.
    const r = parseGcode('T2\nM6\n');
    expect(codes(r)).toEqual(['t-without-m6', 'm6-without-t']);
    expect(r.summary.toolChanges).toBe(0);
  });

  it('M490.1 / M490.2 / M600 are pauses; M491 recalibrates', () => {
    const r = parseGcode('M490.1\nM490.2\nM600\nM491\n');
    expect(kinds(r)).toEqual(['pause', 'pause', 'pause', 'tlo-calibrate']);
    expect(r.events.filter((e) => e.kind === 'pause').map((e) => (e.kind === 'pause' ? e.reason : ''))).toEqual([
      'M490.1',
      'M490.2',
      'M600',
    ]);
  });
});

describe('M2 / M30 end of program (grbl mode: M30 is M2)', () => {
  it('stops the spindle and air, resets the modal motion to G1 and distance to absolute', () => {
    const r = parseGcode('G91\nS1000 M3\nM7\nM30\nG1 X5 F100\n');
    expect(kinds(r)).toEqual(['spindle', 'air', 'spindle', 'air', 'program-end', 'move']);
    expect(r.events[2]).toMatchObject({ kind: 'spindle', state: 'off' });
    expect(r.events[3]).toMatchObject({ kind: 'air', on: false });
    // Distance mode is absolute again: X5 is the position X5, not "5 from unknown".
    expect(moves(r)[0]?.to[0]).toBe(5);
  });

  it('a bare X line after M30 is a CUT: the firmware sets the modal motion to G1', () => {
    const r = parseGcode('G0 X1\nM2\nX5\n');
    expect(moves(r).map((m) => m.mode)).toEqual(['rapid', 'cut']);
  });

  it('M2 and M30 behave identically', () => {
    const a = parseGcode('S100 M3\nM2\n');
    const b = parseGcode('S100 M3\nM30\n');
    expect(kinds(a)).toEqual(kinds(b));
  });

  it('a concatenated program does not leak the spindle into the next one', () => {
    const r = parseGcode('S10000 M3\nG1 X1 F100\nM30\n\nT1M6\nS10000 M3\n');
    expect(hasErrors(r)).toBe(false);
  });
});

describe('N-numbered lines (§10): the firmware strips the number but keeps testing "N"', () => {
  it('`N10 G1 X5` is IGNORED by the firmware, so the parser must not execute it', () => {
    const r = parseGcode('N10 G1 X5 F100\n');
    expect(moves(r)).toHaveLength(0);
    expect(errors(r)).toEqual(['n-line-ignored']);
  });
  it('...but `N10 X5` survives, via the bare-axis path', () => {
    const r = parseGcode('N10 X5\n');
    expect(moves(r)).toHaveLength(1);
    expect(hasErrors(r)).toBe(false);
  });
  it('a lone line number is a blank line', () => {
    expect(codes(parseGcode('N20\n'))).toEqual([]);
  });
});

describe('firmware hazards (§6) are reported, not silently obeyed', () => {
  it('G90/G91 are HOISTED out of a comment: the distance mode really changes', () => {
    const r = parseGcode('G0 X1\nG91\nG1 X5 ; back to G90\nG1 X1\n');
    expect(errors(r)).toContain('comment-contains-g90-g91');
    // Under G91, X5 would be 1+5 = 6. The hoisted G90 makes it absolute: 5.
    expect(moves(r)[1]?.to[0]).toBe(5);
  });

  it('REGRESSION (review #4): the hoist also runs on a BARE-AXIS line, after the G prefix', () => {
    // The firmware prefixes `G<n> ` and re-dispatches the whole line, comment included, so
    // the hoist sees it. The first version prefixed after stripping the comment and missed it.
    const r = parseGcode('G0 X1\nG91\nX5 ; back to G90\nX1\n');
    expect(errors(r)).toContain('comment-contains-g90-g91');
    expect(moves(r)[1]?.to[0]).toBe(5);
    expect(moves(r)[2]?.to[0]).toBe(1);
  });

  it('text after a "(" comment is DISCARDED, not executed as RS274 would', () => {
    const r = parseGcode('G0 (hop) X5\n');
    expect(errors(r)).toEqual(['paren-comment-truncates']);
    expect(moves(r)).toHaveLength(0);
  });

  it('a lone F line switches the modal motion to G1: later bare-X lines become CUTS', () => {
    const r = parseGcode('G0 X1\nF500\nX5\n');
    expect(codes(r)).toContain('lone-f-switches-g1');
    expect(moves(r).map((m) => m.mode)).toEqual(['rapid', 'cut']);
    expect(moves(r)[1]?.feed).toBe(500);
  });

  it('a lowercase line is a console command and does nothing', () => {
    const r = parseGcode('g1 x5\necho hello\n');
    expect(moves(r)).toHaveLength(0);
    expect(errors(r)).toEqual(['console-line']); // echo is fine; g1 x5 is not
  });

  it('trailing remark text after a command is one WARNING and the command still runs', () => {
    const r = parseGcode('M7 # air on\n');
    expect(r.events[0]).toMatchObject({ kind: 'air', on: true });
    expect(hasErrors(r)).toBe(false);
    expect(codes(r)).toEqual(['ignored-text']);
  });
});

describe('G53 (§4)', () => {
  it('`G90 G0 G53 Z-3` — the G53 axes use the modal G0, in MACHINE coordinates', () => {
    const r = parseGcode('G90 G0 G53 Z-3\nG53 G0 X-295 Y-205\nG53 Z-50\n');
    expect(moves(r).map((m) => [m.mode, m.frame])).toEqual([
      ['rapid', 'machine'],
      ['rapid', 'machine'],
      ['rapid', 'machine'],
    ]);
    expect(moves(r)[0]?.to).toEqual([null, null, -3]);
    expect(moves(r)[1]?.to).toEqual([-295, -205, -3]);
    expect(moves(r)[2]?.from).toEqual([-295, -205, -3]);
    expect(moves(r)[2]?.to).toEqual([-295, -205, -50]);
  });

  it('machine coordinates are absolute even under G91', () => {
    const r = parseGcode('G91\nG53 G0 X5\nG53 G0 X5\n');
    expect(moves(r).at(-1)?.to[0]).toBe(5);
  });

  it('G53 followed by anything but G0/G1 is "Invalid G53" and ignored', () => {
    const r = parseGcode('G53 G2 X1\n');
    expect(errors(r)).toContain('g53-invalid');
    expect(moves(r)).toHaveLength(0);
  });

  it('REGRESSION (review #4): a BARE G53 after a modal G2 is an ARC in machine coordinates', () => {
    // The firmware's only check is `modal_group_1 > 3`; a modal arc passes. The first version
    // refused this as "an arc here", which is not what the machine does.
    // The parser does not know the WCS, so it cannot know the arc's MACHINE-frame start and
    // reports that honestly (`arc-from-unknown`, one straight machine-frame move) rather than
    // the false `g53-invalid`. KNOWN LIMIT: the runner, which does know the WCS, receives the
    // chord, not the arc; nobody writes this form, so it is documented, not solved.
    const r = parseGcode('G0 X0 Y0 Z0\nG2 X10 Y0 I5 J0 F100\nG53 X0 Y0 I-5 J0\n');
    expect(errors(r)).not.toContain('g53-invalid');
    expect(errors(r)).toContain('arc-from-unknown');
    const mcs = moves(r).filter((m) => m.frame === 'machine');
    expect(mcs).toHaveLength(1);
  });

  it('a machine-frame move invalidates ONLY the work axes it moved', () => {
    // The G53 move changed Z, so the work-frame Z is no longer known; X and Y were not
    // touched, so they still are. (Over-invalidating would lose a rapid the emulator can
    // draw; under-invalidating would draw a rapid from a Z the head is no longer at.)
    const r = parseGcode('G0 X1 Y2 Z3\nG53 G0 Z-3\nG0 X9\n');
    expect(moves(r)[2]?.from).toEqual([1, 2, null]);
    expect(moves(r)[2]?.to).toEqual([9, 2, null]);
  });
});

describe('motion, units and modes', () => {
  it('relative moves accumulate; absolute moves do not', () => {
    const r = parseGcode('G0 X10\nG91\nG1 X5 F100\nG1 X5\n');
    expect(moves(r).map((m) => m.to[0])).toEqual([10, 15, 20]);
  });

  it('G20 converts inches to millimetres at ingest', () => {
    const r = parseGcode('G20\nG0 X1\n');
    expect(moves(r)[0]?.to[0]).toBeCloseTo(25.4, 12);
    expect(r.summary.usesInches).toBe(true);
  });

  it('a feed rate sticks and is reported on cutting moves only', () => {
    const r = parseGcode('G1 X1 F250\nG1 X2\nG0 X3\n');
    expect(moves(r).map((m) => m.feed)).toEqual([250, 250, null]);
  });

  it('refuses a non-positive feed', () => {
    expect(errors(parseGcode('G1 X1 F0\n'))).toEqual(['bad-feed']);
  });

  it('S on a motion line is laser POWER only in laser mode', () => {
    const r = parseGcode('M321\nG1 X1 S0.5 F100\nM322\nG1 X2 S0.7\n');
    expect(r.summary.laser).toBe(true);
    expect(moves(r).map((m) => m.power)).toEqual([0.5, null]);
  });

  it('tracks the A axis without interpreting it', () => {
    const r = parseGcode('G1 X1 A90 F100\n');
    expect(r.summary.usesRotary).toBe(true);
    expect(moves(r)[0]?.a).toBe(90);
    expect(codes(r)).toContain('rotary-axis');
  });

  it('G10 L2 is carried raw and NOT applied (the WCS lives in the controller)', () => {
    const r = parseGcode('G10L2P0X-300Y-210Z-50\n');
    expect(r.events[0]).toMatchObject({ kind: 'wcs-set', l: 2, p: 0, values: [-300, -210, -50] });
  });

  it('G10 L20 is carried too; G10 without P is a warning and NO event (the firmware ignores it)', () => {
    expect(parseGcode('G10L20P1X0\n').events[0]).toMatchObject({ kind: 'wcs-set', l: 20, p: 1 });
    const r = parseGcode('G10L2X0\n');
    expect(r.events).toHaveLength(0);
    expect(r.diagnostics.map((d) => d.code)).toContain('g10-without-p');
  });

  it('G92 carries its values and says whether it is a reset', () => {
    expect(parseGcode('G92 X1 Y2\n').events[0]).toMatchObject({ kind: 'offset-set', subcode: 0, values: [1, 2, null], reset: false });
    expect(parseGcode('G92\n').events[0]).toMatchObject({ kind: 'offset-set', reset: true });
    expect(parseGcode('G92.1\n').events[0]).toMatchObject({ kind: 'offset-set', subcode: 1, reset: true });
    expect(parseGcode('G92.3 X1\n').events[0]).toMatchObject({ kind: 'offset-set', subcode: 3, reset: false, values: [1, null, null] });
    expect(parseGcode('G92.4 X0\n').diagnostics.map((d) => d.code)).toContain('g92-4-manual-home');
  });

  it('G92.4 A S/R is the rotary unwind, not a manual home (#237)', () => {
    // `S` drops whole turns; `R` resets. Both keep the value modulo 360 and leave XYZ alone.
    expect(parseGcode('G92.4 A-153720 S0\n').events[0]).toMatchObject({ kind: 'rotary-unwind', mode: 'shrink', a: -153720, value: 0 });
    expect(parseGcode('G92.4 A10 R5\n').events[0]).toMatchObject({ kind: 'rotary-unwind', mode: 'reset', a: 10, value: 5 });
    // A bare `G92.4` with only axis words is still the manual homing it always was.
    expect(parseGcode('G92.4 X0\n').events[0]).toMatchObject({ kind: 'offset-set', subcode: 4 });
    expect(parseGcode('G92.4 X0\n').diagnostics.map((d) => d.code)).toContain('g92-4-manual-home');
  });

  it('G4, G28, G38.x, G54..G59 and G92.x produce events', () => {
    const r = parseGcode('G4 P1\nG28\nG38.2 Z-5 F50\nG55\nG92.4A0S0\n');
    expect(kinds(r)).toEqual(['dwell', 'home', 'probe', 'wcs-select', 'rotary-unwind']);
    expect(r.events[2]).toMatchObject({ kind: 'probe', subcode: 2 });
    expect(r.events[3]).toMatchObject({ kind: 'wcs-select', wcs: 1 });
    expect(r.events[4]).toMatchObject({ kind: 'rotary-unwind', mode: 'shrink', a: 0, value: 0 });
  });
});

describe('MoveEvent says which axes were COMMANDED, and what was written (review of #182)', () => {
  it('a null in `to` is no longer ambiguous: commanded tells an unmentioned axis from an unknown base', () => {
    const [a, b] = moves(parseGcode('G0 X1 Y2 Z3\nG91\nG1 Z-1 F100\n'));
    expect(a?.commanded).toEqual([true, true, true]);
    expect(a?.values).toEqual([1, 2, 3]);
    expect(a?.relative).toBe(false);
    expect(b?.commanded).toEqual([false, false, true]);
    expect(b?.values).toEqual([null, null, -1]);
    expect(b?.relative).toBe(true);
  });

  it('values are in MILLIMETRES, converted at ingest', () => {
    expect(moves(parseGcode('G20\nG0 X1\n'))[0]?.values[0]).toBeCloseTo(25.4, 12);
  });

  it('a machine-frame move is never relative, even under G91', () => {
    const m = moves(parseGcode('G91\nG53 G0 X5\n'))[0];
    expect(m?.frame).toBe('machine');
    expect(m?.relative).toBe(false);
    expect(m?.commanded).toEqual([true, false, false]);
  });

  it('a relative move whose base the PARSER does not know still reports what was written', () => {
    const m = moves(parseGcode('G91\nG1 X5 F100\n'))[0];
    expect(m?.to[0]).toBeNull(); // the parser cannot compute it...
    expect(m?.values[0]).toBe(5); // ...but a consumer that CAN is told the delta
    expect(m?.relative).toBe(true);
  });

  it('tessellated arc points are resolved absolute; the plane axes are commanded, Z only if written', () => {
    const arc = moves(parseGcode('G0 X0 Y0 Z0\nG91\nG2 X10 Y0 I5 J0 F100\n')).filter((m) => m.fromArc);
    expect(arc.length).toBeGreaterThan(0);
    for (const m of arc) {
      expect(m.commanded).toEqual([true, true, false]);
      expect(m.relative).toBe(false);
      expect(m.values).toEqual([m.to[0], m.to[1], null]);
      expect(m.to[2]).toBe(0); // carried from the start, not interpolated
    }
    const helix = moves(parseGcode('G0 X0 Y0 Z0\nG2 X10 Y0 Z-2 I5 J0 F100\n')).filter((m) => m.fromArc);
    for (const m of helix) expect(m.commanded).toEqual([true, true, true]);
  });

  it('REGRESSION (review #4): an XY arc at a Z the PARSER lost to a tool change is still an arc', () => {
    // The parser treats `T1M6` as real and forgets Z. The arc only needs X and Y; it must not
    // be refused and must not collapse to a chord. Its points carry Z = null, uncommanded, so
    // a runner that knows Z keeps its own.
    const r = parseGcode('G0 X0 Y0 Z3\nT1M6\nS1000 M3\nG2 X10 Y0 I5 J0 F100\n');
    expect(errors(r)).not.toContain('arc-from-unknown');
    const arc = moves(r).filter((m) => m.fromArc);
    expect(arc.length).toBeGreaterThan(1);
    for (const m of arc) {
      expect(m.to[2]).toBeNull();
      expect(m.commanded[2]).toBe(false);
    }
    // ...but an arc that COMMANDS Z from an unknown Z is still refused: the helix has no base.
    expect(errors(parseGcode('G0 X0 Y0 Z3\nT1M6\nG2 X10 Y0 Z-1 I5 J0 F100\n'))).toContain('arc-from-unknown');
  });

  it('G0 with no axes emits no move, so no empty `commanded` event exists', () => {
    expect(moves(parseGcode('G0\n'))).toHaveLength(0);
  });
});

describe('arcs, through the interpreter (§8)', () => {
  it('G2 semicircle: CW, centre start+(I,J), every segment flagged and on the arc line', () => {
    const r = parseGcode('G0 X0 Y0 Z0\nG2 X10 Y0 I5 J0 F100\n');
    const arc = moves(r).filter((m) => m.fromArc);
    expect(arc.length).toBeGreaterThan(8);
    expect(arc.every((m) => m.mode === 'cut' && m.line === 2)).toBe(true);
    expect(arc.at(-1)?.to).toEqual([10, 0, 0]);
    // Clockwise from (0,0) about (5,0) passes THROUGH the top, (5,5).
    expect(Math.max(...arc.map((m) => m.to[1] as number))).toBeCloseTo(5, 2);
    expect(r.summary.usesArcs).toBe(true);
  });

  it('G3 is the other way round', () => {
    const r = parseGcode('G0 X0 Y0 Z0\nG3 X10 Y0 I5 J0 F100\n');
    expect(Math.min(...moves(r).filter((m) => m.fromArc).map((m) => m.to[1] as number))).toBeCloseTo(-5, 2);
  });

  it('a helical arc interpolates the linear axis', () => {
    const r = parseGcode('G0 X0 Y0 Z0\nG3 X0 Y10 Z6 I0 J5 F100\n');
    const arc = moves(r).filter((m) => m.fromArc);
    expect(arc.at(-1)?.to).toEqual([0, 10, 6]);
    const zs = arc.map((m) => m.to[2] as number);
    expect(zs).toEqual([...zs].sort((a, b) => a - b)); // monotone
  });

  it('there is NO R form: an R arc is refused, not guessed', () => {
    const r = parseGcode('G0 X0 Y0 Z0\nG2 X10 R5 F100\n');
    expect(errors(r)).toContain('arc-r-unsupported');
  });

  it('an arc from an unknown position is refused, not invented', () => {
    expect(errors(parseGcode('G2 X10 I5 F100\n'))).toContain('arc-from-unknown');
  });

  it('an arc with no feed alarms on the machine', () => {
    expect(errors(parseGcode('G0 X0 Y0 Z0\nG2 X10 Y0 I5 J0\n'))).toContain('no-feed');
  });

  it('a mismatched radius is a WARNING: the firmware runs it', () => {
    const r = parseGcode('G0 X0 Y0 Z0\nG3 X10 Y12 I10 J0 F100\n');
    expect(codes(r)).toContain('arc-radius-mismatch');
    expect(hasErrors(r)).toBe(false);
  });
});

describe('dialect spellings the vendor tooling actually writes (#186 checklist)', () => {
  it('zero-padded codes are normal: M06, M03, M05, G00, G01', () => {
    // Makera's samples use both `M6` and `M06`, `M3` and `M03`, `G1` and `G01`: 53 vs 6 and
    // 101 vs 6 and 338k vs 142k lines respectively. A parser that matched the code as a
    // STRING would silently skip half of every file.
    const r = parseGcode('T1 M06\nM03 S12000\nG00 X1\nG01 X2 F100\nM05\n');
    expect(hasErrors(r)).toBe(false);
    expect(kinds(r)).toEqual(['tool-change', 'spindle', 'move', 'move', 'spindle']);
    expect(r.events[1]).toMatchObject({ kind: 'spindle', state: 'cw', rpm: 12000 });
    expect(r.events[4]).toMatchObject({ kind: 'spindle', state: 'off' });
    expect(moves(r).map((m) => m.mode)).toEqual(['rapid', 'cut']);
  });

  it('zero-padded and unpadded spellings are the SAME event', () => {
    const a = parseGcode('T1 M6\nM3 S9000\nG0 X1\nG1 X2 F50\nM5\n');
    const b = parseGcode('T1 M06\nM03 S9000\nG00 X1\nG01 X2 F50\nM05\n');
    expect(b.events.map((e) => ({ ...e, line: 0 }))).toEqual(a.events.map((e) => ({ ...e, line: 0 })));
  });

  it('G17 (plane) and G54 (work offset) are accepted, as on the opening line of most samples', () => {
    // `G00 G17 G40 G21 G54` — the first line LightBurn and Studio both write.
    const r = parseGcode('G00 G17 G40 G21 G54\nG90\nG0 X1\n');
    expect(hasErrors(r)).toBe(false);
    expect(r.events[0]).toMatchObject({ kind: 'wcs-select', wcs: 0 });
    expect(moves(r)).toHaveLength(1);
  });

  it('REGRESSION (review #3 §9): G91.1 does NOT select the distance mode — there is no arc-centre mode', () => {
    // `codeParts` splits the subcode, and the switch matched `case 91` on it, so a `G91.1`
    // silently made every following move INCREMENTAL — a code `/Z1-Firmware-Dialect.md` §8
    // says this firmware does not have ("there is no `R` form and no `G90.1`/`G91.1`"; the
    // 25-file corpus contains no `G90.1`, and `G91` only plain).
    const r = parseGcode('G0 X10\nG91.1\nG1 X5 F100\n');
    expect(errors(r)).toContain('no-arc-centre-mode');
    // Distance mode UNCHANGED, so X5 is absolute: 5, not 10 + 5.
    expect(moves(r).at(-1)?.to[0]).toBe(5);
  });

  it('...and G90.1 does not restore it either', () => {
    const r = parseGcode('G0 X10\nG91\nG90.1\nG1 X5 F100\n');
    expect(errors(r)).toContain('no-arc-centre-mode');
    // Still incremental, as G91 left it: 10 + 5.
    expect(moves(r).at(-1)?.to[0]).toBe(15);
  });

  it('G18 and G19 select the plane an arc is drawn in', () => {
    const xy = parseGcode('G17\nG0 X0 Y0 Z0\nG3 X0 Y10 I0 J5 F100\n');
    const xz = parseGcode('G18\nG0 X0 Y0 Z0\nG3 X10 Z0 I5 K0 F100\n');
    expect(xy.summary.usesArcs && xz.summary.usesArcs).toBe(true);
    // In G18 the arc is in XZ: Y never moves.
    expect(moves(xz).filter((m) => m.fromArc).every((m) => m.to[1] === 0)).toBe(true);
    expect(moves(xy).filter((m) => m.fromArc).every((m) => m.to[2] === 0)).toBe(true);
  });

  it('M851 / M852 (extended-port PWM) are accepted: the vendor FreeCAD post writes them', () => {
    // Makera's own Z1 post emits `M851 S<pct>` before M7 and `M852` before M9 when its
    // `ext_for_air` option is on. Refusing them would refuse the vendor's own output.
    expect(codes(parseGcode('M851 S80\nM7\nM852\nM9\n'))).toEqual([]);
  });

  it('G41 / G42 (cutter compensation) are NOT accepted: the vendor post itself warns they are unsupported', () => {
    // Evidence for keeping them errors: the same post raises "Tool radius compensation (G41)
    // ... not supported by the Makera" when a job uses them.
    expect(errors(parseGcode('G41 D1\nG42 D1\n'))).toEqual(['unknown-code', 'unknown-code']);
  });
});

describe('policy defaults pinned by tests (#174 questions): change the assertion to change the policy', () => {
  // Nobody answered the 16 design questions on #174. These are the defaults the parser
  // implements, each pinned by a NAMED test below so the maintainer can overturn one by
  // editing one assertion. They are decisions awaiting a yes, not decisions made.
  it('Q3: numbers are STRICT: a space between a letter and its number is rejected, though strtof accepts it', () => {
    const r = parseGcode('G1 X 5 F100\n');
    expect(errors(r).length).toBeGreaterThan(0);
  });
  it('Q4: a lone F line is a warning, not an error (the severity split)', () => {
    const r = parseGcode('G0 X1\nF500\nX5\n');
    expect(r.diagnostics.find((d) => d.code === 'lone-f-switches-g1')?.severity).toBe('warning');
  });
  it('Q6: unknown position is null, never 0', () => {
    expect(moves(parseGcode('G0 X5\n'))[0]?.from).toEqual([null, null, null]);
  });
  it('Q10: M0, M1 and M8 are errors: nothing read shows the Z1 implements them', () => {
    expect(errors(parseGcode('M0\nM1\nM8\n'))).toEqual(['unknown-code', 'unknown-code', 'unknown-code']);
  });
  it('Q11: a laser job is FLAGGED by the parser, not refused (refusal is the verifier\'s, unbuilt)', () => {
    const r = parseGcode('M321\nG1 X1 S0.5 F100\nM322\n');
    expect(r.summary.laser).toBe(true);
    expect(hasErrors(r)).toBe(false);
  });
  it('Q12: rotary A words are FLAGGED (info), not refused', () => {
    const r = parseGcode('G1 X1 A90 F100\n');
    expect(r.summary.usesRotary).toBe(true);
    expect(hasErrors(r)).toBe(false);
  });
});

describe('codes the machine does not know', () => {
  it('every unknown G or M code is an error NAMING THE LINE', () => {
    const r = parseGcode('G0 X1\nG999\nM777\nG81 Z-1\n');
    const errs = r.diagnostics.filter((d) => d.severity === 'error');
    expect(errs.map((d) => [d.line, d.code])).toEqual([
      [2, 'unknown-code'],
      [3, 'unknown-code'],
      [4, 'unsupported-code'],
    ]);
  });

  it('known accessory codes are accepted silently', () => {
    expect(codes(parseGcode('M811\nM812\nM331\nM332\nM106\nM220 S100\n'))).toEqual([]);
  });

  it('M0, M1 and M8 are NOT accepted: nothing read shows the Z1 implements them', () => {
    expect(errors(parseGcode('M0\nM1\nM8\n'))).toEqual(['unknown-code', 'unknown-code', 'unknown-code']);
  });

  it('collects EVERY diagnostic rather than stopping at the first', () => {
    const r = parseGcode('G999\nM777\nG1 X1e5\n');
    expect(new Set(r.diagnostics.map((d) => d.line))).toEqual(new Set([1, 2, 3]));
  });

  it('refuses an exponent and a nan, with the line', () => {
    const r = parseGcode('G1 X1e61 F100\nG1 XNAN F100\n');
    expect(r.diagnostics.filter((d) => d.code === 'bad-number').map((d) => d.line)).toEqual([1, 2]);
  });
});

describe('header, markers and robustness', () => {
  it('collects the header and emits a marker per TOOLPATH_START', () => {
    const r = parseGcode(
      ';@MKR|BEGIN\n;@MKR|TOOL|number=1|name=a\n;@MKR|END\nG90 G21\n;@MKR|TOOLPATH_START|toolpath_number=2\nG0 X1\n',
    );
    expect(r.header?.records.map((x) => x.tag)).toEqual(['BEGIN', 'TOOL', 'END', 'TOOLPATH_START']);
    const marker = r.events.find((e): e is Extract<GcodeEvent, { kind: 'toolpath-start' }> => e.kind === 'toolpath-start');
    expect(marker?.number).toBe(2);
    // A marker precedes the moves of its toolpath: it is the segment boundary.
    expect(kinds(r)).toEqual(['toolpath-start', 'move']);
  });

  it('a file with no header has header = null', () => {
    expect(parseGcode('G0 X1\n').header).toBeNull();
  });

  it('never throws, whatever it is fed', () => {
    const nasty = ['\u0000￿ G1 X\nXYZ\n(((\nT\nS\nM\nG\n', 'G'.repeat(2000), 'X'.repeat(5000), '\r\r\r', '%\n%\n', ';'.repeat(100)];
    for (const s of nasty) expect(() => parseGcode(s)).not.toThrow();
  });

  it('counts lines, code lines, moves and tool changes', () => {
    const r = parseGcode('; c\n\nG0 X1\nG1 X2 F10\nT1M6\n');
    expect(r.summary).toMatchObject({ lines: 6, codeLines: 3, moves: 2, rapids: 1, cuts: 1, toolChanges: 1 });
  });

  it('every event carries its 1-based source line', () => {
    const r = parseGcode('\n\nG0 X1\n\nM7\n');
    expect(r.events.map((e) => e.line)).toEqual([3, 5]);
  });
});
