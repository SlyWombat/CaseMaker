/**
 * #1202 — THE TOOL CHANGE'S DRY LINE VIEW AND ITS RECORD.
 *
 * The firmware stops in `Tool` after `T<n> M6`; the app's Continue sends `M490.2`. The card shows
 * exactly that line (read from the same function the run sends), marks the shape a first run on a
 * machine that has never completed it, and the completion is recorded once the controller leaves
 * `Tool` after our line.
 */
import { describe, expect, it } from 'vitest';

import { pauseResumeCommands } from '@/platform/machinePause';
import { dryToolChange, toolChangeIdentity, toolChangeLines } from '@/platform/toolChangeDry';
import { MachineRecordSchema } from '@/platform/locationClient';
import { routineCompleted, withRoutineCompletion } from '@/platform/routineRecord';

function machine() {
  return MachineRecordSchema.parse({ id: 'm-1', updatedAt: '2026-11-11T09:00:00.000Z' });
}

describe('#1202 — the tool change’s own dry line view', () => {
  it('shows exactly the lines the Continue sends, in order, clean under the guard', () => {
    // SHOWN == SENT: the card reads the one function the run's send reads.
    const sent = pauseResumeCommands('continue-tool').lines;
    expect(toolChangeLines()).toEqual([...sent]);
    const dry = dryToolChange(-3);
    expect(dry.lines.map((l) => l.line)).toEqual([...sent]);
    expect(dry.lines.every((l) => l.refused === null)).toBe(true);
    expect(dry.refused).toBe(false);
    expect(dry.identity.routine).toBe('tool-change');
    expect(dry.identity.shape).toMatch(/^[0-9a-f]{8}$/);
  });

  it('the shape is the sequence, not the machine’s numbers: the same routine at any clearance', () => {
    expect(dryToolChange(-3).identity.shape).toBe(dryToolChange(-81.25).identity.shape);
    expect(toolChangeIdentity().shape).toBe(dryToolChange(-3).identity.shape);
  });

  it('an unknown clearance is refused, never guessed at zero', () => {
    // D's #1199 rule: `liveClearanceZ` is REQUIRED — an unread clearance cannot be reviewed. The
    // card must say so and hold the press, not hand the guard a clearance of 0 (#1207: no hidden
    // literal standing in for a real reading).
    const dry = dryToolChange(null);
    expect(dry.refused).toBe(true);
    expect(dry.error).toContain('clearance unknown');
    expect(dry.lines.length).toBeGreaterThan(0);
    expect(
      dry.lines.every((l) => l.refused !== null && l.refused.includes('clearance unknown')),
      'every shown line carries the unknown-clearance refusal',
    ).toBe(true);
  });

  it('a recorded completion is the permission: the card is unmarked only for that exact shape', () => {
    const identity = toolChangeIdentity();
    expect(routineCompleted(machine(), identity)).toBe(false);
    const recorded = withRoutineCompletion(machine(), {
      routine: 'tool-change',
      shape: identity.shape,
      at: '2026-11-11T10:00:00.000Z',
      build: { version: '1.0.0', commit: null },
    });
    expect(routineCompleted(recorded, identity)).toBe(true);
    // A different sequence under the same id is a different routine.
    expect(routineCompleted(recorded, { ...identity, shape: 'deadbeef' })).toBe(false);
  });
});
