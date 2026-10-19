// #526 — the one status-line parser. The strip, the viewport and the registration runner all read
// the same `?` reply through `readStatusLine`, so they cannot disagree about what the machine said.
// This pins the parsing of a full line and the nulls for a partial one.

import { describe, expect, it } from 'vitest';
import { readStatusLine } from '../../src/platform/desktop/protocol';

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
