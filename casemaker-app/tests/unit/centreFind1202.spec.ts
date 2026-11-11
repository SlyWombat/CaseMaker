/**
 * #1202 field 5 — THE CENTRE FIND'S OWN DRY LINES.
 *
 * The Find press runs `runCentreFind`; the card's preview runs the SAME executor against the
 * recording console, so the shown list is the sent list and every line carries the guard's verdict.
 * The routine's identity is the shown sequence's shape — what a completed run later unmarks.
 */
import { describe, expect, it } from 'vitest';

import { planCentreFind } from '@/engine/cnc/registration/centreFind';
import { dryCentreFind } from '@/engine/cnc/registration/dryRun';
import { routineCompleted, withRoutineCompletion } from '@/platform/routineRecord';
import { MachineRecordSchema } from '@/platform/locationClient';

function plan() {
  const made = planCentreFind({
    kind: 'bore',
    at: { x: 50, y: 40 },
    searchMm: 5,
    ballRadiusMm: 0.875,
    stockThicknessMm: 12,
    touchFeed: 120,
  });
  if (!made.ok) throw new Error(made.reason);
  return made.plan;
}

const options = () => ({
  plan: plan(),
  seekFromMachineZ: -3,
  bandMm: { min: -12, max: 0 },
  surfaceFeed: 60,
  parkAboveSurfaceMm: 2,
  topTouchAt: { x: 60, y: 40 },
});

describe('#1202 — the centre find’s dry line view', () => {
  it('shows the executor’s own sequence: the top touch, three pairs, and a release after each trigger', async () => {
    const dry = await dryCentreFind(options());
    expect(dry.error).toBeNull();
    expect(dry.refused).toBe(false);
    expect(dry.identity.routine).toBe('centre-find');
    expect(dry.lines.length).toBeGreaterThan(10);
    // The routine's contract: every trigger is released with G38.5 before any G0 (#790).
    expect(dry.lines.filter((l) => l.line.startsWith('G38.3')).length).toBeGreaterThanOrEqual(6);
    expect(dry.lines.some((l) => l.line.startsWith('G38.5'))).toBe(true);
    expect(dry.lines.every((l) => l.refused === null)).toBe(true);
  });

  it('a completed shape unmarks the press; a reordered sequence is a different routine', async () => {
    const dry = await dryCentreFind(options());
    const machine = MachineRecordSchema.parse({ id: 'm-1', updatedAt: '2026-11-11T09:00:00.000Z' });
    expect(routineCompleted(machine, dry.identity)).toBe(false);
    const recorded = withRoutineCompletion(machine, {
      routine: 'centre-find',
      shape: dry.identity.shape,
      at: '2026-11-11T10:00:00.000Z',
      build: { version: '1.0.0', commit: null },
    });
    expect(routineCompleted(recorded, dry.identity)).toBe(true);
    expect(routineCompleted(recorded, { ...dry.identity, shape: 'deadbeef' })).toBe(false);
  });
});
