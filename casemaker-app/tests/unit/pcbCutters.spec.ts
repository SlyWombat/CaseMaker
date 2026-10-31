/**
 * §3.4's hole rule (#743 P-4b): drill where an owned cutter IS the hole's size, bore where a flat
 * must helix it, and say nothing the job's own checks will not say better.
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { PCB_DRILL_SLACK_MM, pcbHoleAssignment } from '@/engine/import/pcbCutters';

const entry = (key: string, shape: 'flat' | 'drill' | 'engraving', d: number): ToolLibraryEntry => ({
  key,
  provenance: 'test',
  tool: flatEndMill(d, { shape, tipDiameter: d, diameter: d }),
});

const drill = (id: string, diameter: number): { id: string; diameter: number } => ({ id, diameter });

describe('§3.4 — a board hole and the cutter it asks for (#743 P-4b)', () => {
  it('drills with an owned drill of the hole size, and with a mill up to +0.1 mm over', () => {
    expect(PCB_DRILL_SLACK_MM).toBe(0.1);
    const exact = pcbHoleAssignment([drill('a', 0.8)], [entry('user:d', 'drill', 0.8)]);
    expect(exact.modes.get('a')).toBe('drill');

    const over = pcbHoleAssignment([drill('a', 1.0)], [entry('user:m', 'flat', 1.1)]);
    expect(over.modes.get('a')).toBe('drill');

    // Over by more than the slack is not the hole's cutter.
    const tooBig = pcbHoleAssignment([drill('a', 1.0)], [entry('user:m', 'flat', 1.11)]);
    expect(tooBig.modes.get('a')).toBe('drill');
    // (no narrower flat either, so the mode stays a plunge and the job's checks name the gap)
    expect(tooBig.notes).toEqual([]);
  });

  it('never drills UNDER the hole, and bores with a flat narrower than it, saying so once', () => {
    const out = pcbHoleAssignment(
      [drill('a', 0.8), drill('b', 0.8), drill('c', 1.0)],
      [entry('user:v', 'engraving', 0.1), entry('user:f', 'flat', 0.5), entry('user:dr', 'drill', 0.79)],
    );
    // 0.79 is under 0.8, so the 0.8 holes are bored; so is the 1.0 hole.
    expect(out.modes.get('a')).toBe('bore');
    expect(out.modes.get('b')).toBe('bore');
    expect(out.modes.get('c')).toBe('bore');
    expect(out.notes).toHaveLength(2);
    expect(out.notes[0]).toContain('the 2 ⌀0.8 holes are bored');
    expect(out.notes[1]).toContain('the 1 ⌀1 hole is bored');
  });

  it('a drill of exactly the size wins over boring', () => {
    const out = pcbHoleAssignment(
      [drill('a', 0.8)],
      [entry('user:f', 'flat', 0.5), entry('user:dr', 'drill', 0.8)],
    );
    expect(out.modes.get('a')).toBe('drill');
    expect(out.notes).toEqual([]);
  });
});
