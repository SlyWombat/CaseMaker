// #526 — the one status-line parser. The strip, the viewport and the registration runner all read
// the same `?` reply through `readStatusLine`, so they cannot disagree about what the machine said.
// This pins the parsing of a full line and the nulls for a partial one.

import { describe, expect, it } from 'vitest';
import { readStatusLine, workOffset } from '../../src/platform/desktop/protocol';

describe('#526 readStatusLine', () => {
  it('parses a running line: state, positions, rates, tool and progress', () => {
    const s = readStatusLine(
      '<Run|MPos:-10.0,20.0,1.0991|WPos:12.350,38.000,-0.120|F:900,900,100|S:12000,12000,100|T:6|P:412,1890,108>',
    );
    expect(s.state).toBe('Run');
    expect(s.wpos).toEqual({ x: 12.35, y: 38.0, z: -0.12, a: null, b: null });
    expect(s.mpos).toEqual({ x: -10.0, y: 20.0, z: 1.0991, a: null, b: null });
    expect(s.feed).toEqual({ actual: 900, set: 900, override: 100 });
    expect(s.spindle).toEqual({ actual: 12000, set: 12000, override: 100 });
    expect(s.tool).toBe(6);
    expect(s.progress).toEqual({ state: 'Run', line: 412, percent: 1890, elapsedS: 108 });
  });

  it('reads the A and B axes when the rotary is fitted', () => {
    const s = readStatusLine('<Run|MPos:0,0,0,10.5,20.5|WPos:1,2,3,4,5|F:100,100,100|S:0,0,100>');
    expect(s.mpos).toEqual({ x: 0, y: 0, z: 0, a: 10.5, b: 20.5 });
    expect(s.wpos).toEqual({ x: 1, y: 2, z: 3, a: 4, b: 5 });
  });

  it('leaves absent fields null — an idle machine has no P and no T', () => {
    const s = readStatusLine('<Idle|MPos:-1,-1,-1|WPos:180.2,183.1,55.2>');
    expect(s.state).toBe('Idle');
    expect(s.tool).toBeNull();
    expect(s.feed).toEqual({ actual: null, set: null, override: null });
    expect(s.progress).toEqual({ state: 'Idle', line: null, percent: null, elapsedS: null });
  });

  it('reads an override that is not 100', () => {
    const s = readStatusLine('<Run|MPos:0,0,0|WPos:0,0,0|F:450,900,50|S:6000,12000,50|P:10,100,5>');
    expect(s.feed).toEqual({ actual: 450, set: 900, override: 50 });
    expect(s.spindle).toEqual({ actual: 6000, set: 12000, override: 50 });
  });
});

describe('#567 workOffset', () => {
  it('is MPos − WPos per axis — the G54 offset on X and Y', () => {
    const off = workOffset(readStatusLine('<Run|MPos:-10.0,20.0,1.0991|WPos:12.350,38.000,-0.120>'));
    expect(off).toEqual({ x: -22.35, y: -18.0, z: 1.2191, a: null, b: null });
  });

  it('reads the homed-rest offset from MPos -1 and the work position', () => {
    const off = workOffset(readStatusLine('<Idle|MPos:-1,-1,-1|WPos:180.2,183.1,55.2>'));
    expect(off).toEqual({ x: -181.2, y: -184.1, z: -56.2, a: null, b: null });
  });

  it('leaves an axis null when one side is missing', () => {
    const off = workOffset(readStatusLine('<Idle|MPos:-1,-1,-1|WPos:180.2,183.1>'));
    expect(off).toEqual({ x: -181.2, y: -184.1, z: null, a: null, b: null });
  });
});

// #769 — THE REST OF THE FRAME: F:, S:, T: and A:, pinned against frames recorded on the bench (no
// invented frames where the corpus has one). None of the 5 689 recorded frames in docs/ and .scratch
// carries `A:` — the Z1 has the ATC bit clear and its firmware writes the field only when it is set —
// so the A: case is shaped from the firmware's own `|A:%d` write and marked synthetic.
describe('#769 readStatusLine — the F:, S:, T: and A: fields', () => {
  it('reads a recorded idle frame: rates at rest, tool 1, no ATC field', () => {
    // docs/bench/traces/2026-10-24-run1-status-trail.log 15:17:58.
    const s = readStatusLine(
      '<Idle|MPos:-1.0000,-1.0000,-1.0000,0.0000,0.0000|WPos:180.2000,198.1250,57.1727,0.0000,0.0000|F:0.0,2000.0,100.0|S:0.0,10000.0,100.0,0,19.4,20.5,0,0,0,0|T:1,0.050,-1|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|E:0,0,0,702,7610|OTA:0,0>',
    );
    expect(s.feed).toEqual({ actual: 0, set: 2000, override: 100 });
    // S: value 1 is the vacuum mode and value 4/5 the temperatures (#659); the rate is the first 3.
    expect(s.spindle).toEqual({ actual: 0, set: 10000, override: 100 });
    expect(s.tool).toBe(1);
    // The firmware writes -1 in the third slot when no change is pending (the field is `T:a,off,x`).
    expect(s.toolWaiting).toBe(-1);
    expect(s.atcState).toBeNull();
    expect(s.monitor.spindleTempC).toBe(19.4);
  });

  it('reads a recorded cutting frame: the feed moved, the spindle at speed', () => {
    // docs/bench/traces/2026-10-12-cut-rowA.log — mid-cut, spindle at 11 677.9 of 12 000.
    const s = readStatusLine(
      '<Run|MPos:-162.0500,-162.2000,-5.7381,0.0000,0.0000|WPos:18.4500,20.0000,50.8059,0.0000,0.0000|F:600.0,2000.0,100.0|S:11677.9,12000.0,100.0,1,37.6,24.9,0,0,0,0|T:1,0.000,1|L:0, 0, 0, 0.0,100.0|P:0,17,10|C:3,1,0,1|E:0,0,0,692,7610|OTA:0,0>',
    );
    expect(s.feed).toEqual({ actual: 600, set: 2000, override: 100 });
    expect(s.spindle).toEqual({ actual: 11677.9, set: 12000, override: 100 });
    expect(s.tool).toBe(1);
    expect(s.toolWaiting).toBe(1);
  });

  it('reads the recorded waiting-for-cutter frame: T:0 is no active tool, T:1 is awaited', () => {
    // docs/bench/traces/2026-10-08-console.log — stopped at an M6, T:0,-9.757,1.
    const s = readStatusLine(
      '<Tool|MPos:-10.0900,-12.8300,-3.0000,0.0000,0.0000|WPos:138.3100,111.9700,71.8750,0.0000,0.0000|F:0.0,2000.0,100.0|S:0.0,10000.0,100.0,0,24.8,23.7,0,0,0,0|T:0,-9.757,1|L:0, 0, 0, 0.0,100.0|C:3,1,0,0|E:0,0,0,692,7610|OTA:0,0>',
    );
    expect(s.tool).toBe(0);
    expect(s.toolWaiting).toBe(1);
    expect(s.feed).toEqual({ actual: 0, set: 2000, override: 100 });
  });

  it('reads a reduced feed and spindle override where a frame carries one (synthetic — the corpus has none)', () => {
    // Every F:/S: override in the 5 689 recorded frames is 100.0; this line exercises the non-100 case.
    const s = readStatusLine('<Run|MPos:0,0,0|WPos:0,0,0|F:250,500,50|S:6000,12000,80|T:1>');
    expect(s.feed).toEqual({ actual: 250, set: 500, override: 50 });
    expect(s.spindle).toEqual({ actual: 6000, set: 12000, override: 80 });
  });

  it('reads A: as the ATC state (synthetic, from the firmware’s |A:%d write), never as an angle', () => {
    // `Kernel::get_query_string` writes `|A:%d` (or `|A:%d,%d`) inside the ATC-bit guard; take its
    // first value. The fourth axis is the `a` in WPos/MPos and is unaffected by this field.
    const one = readStatusLine('<Idle|MPos:0,0,0,12.5|WPos:0,0,0,12.5|A:3>');
    expect(one.atcState).toBe(3);
    expect(one.wpos.a).toBe(12.5);
    const two = readStatusLine('<Idle|MPos:0,0,0|WPos:0,0,0|A:2,1>');
    expect(two.atcState).toBe(2);
    // An unreadable value is null, not 0: the frame did not say 0.
    const bad = readStatusLine('<Idle|MPos:0,0,0|WPos:0,0,0|A:x>');
    expect(bad.atcState).toBeNull();
  });
});
