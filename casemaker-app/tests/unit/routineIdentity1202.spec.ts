/**
 * #1202 — A MOTION ROUTINE'S IDENTITY, AND WHAT THIS MACHINE HAS RUN.
 *
 * The identity is the routine id plus the SHAPE of its line sequence — which moves, in which order,
 * at which named heights — never the coordinates. The record keeps the shapes that have COMPLETED
 * on a machine, so a card can say "this has not run here before" before the press.
 */
import { describe, expect, it } from 'vitest';

import { lineShapeOf, routineIdentityOf, routineShapeOf } from '@/engine/cnc/registration/routineIdentity';
import { MachineRecordSchema } from '@/platform/locationClient';
import {
  routineRecordLimit,
  RoutineCompletionsSchema,
  routineCompleted,
  routineCompletionFor,
  withRoutineCompletion,
  type RoutineCompletion,
} from '@/platform/routineRecord';

/** The c8fa03a6 seat press's own motion, as #1199's trace states it (the accident's sequence). */
const SEAT_LINES = ['G53 G0 Z-81.25', 'G53 G0 X-175 Y-35', 'G38.3 Z-11 F150', 'G38.5 Z3 F150'];
const SEAT_HEIGHTS = { clearance: -81.25, seek: -11, retract: 3 };

function machine() {
  return MachineRecordSchema.parse({ id: 'm-1', updatedAt: '2026-11-11T09:00:00.000Z' });
}

function completion(over: Partial<RoutineCompletion> = {}): RoutineCompletion {
  return {
    routine: 'seat-press',
    shape: '0f3c9a11',
    at: '2026-11-11T09:12:00.000Z',
    build: { version: '1.0.0', commit: 'abc1234' },
    ...over,
  };
}

describe('#1202 — the line shapes', () => {
  it('names each move by its command, its axes and its named height — never its coordinates', () => {
    expect(lineShapeOf('G53 G0 Z-81.25', SEAT_HEIGHTS)).toEqual({ op: 'G53 G0', axis: 'Z', height: 'clearance' });
    expect(lineShapeOf('G53 G0 X-175 Y-35', SEAT_HEIGHTS)).toEqual({ op: 'G53 G0', axis: 'XY', height: null });
    expect(lineShapeOf('G38.3 Z-11 F150', SEAT_HEIGHTS)).toEqual({ op: 'G38.3', axis: 'Z', height: 'seek' });
    expect(lineShapeOf('M491')).toEqual({ op: 'M491', axis: '', height: null });
    expect(lineShapeOf('$H')).toEqual({ op: '$H', axis: '', height: null });
    // A Z word that matches no named height is honestly 'unnamed' — the identity does not read
    // coordinates, so it cannot call two nameless heights different.
    expect(lineShapeOf('G53 G0 Z-60.788', SEAT_HEIGHTS).height).toBe('unnamed');
  });

  it('the same moves at different coordinates are the SAME routine', () => {
    const moved = ['G53 G0 Z-81.25', 'G53 G0 X-100 Y20', 'G38.3 Z-11 F150', 'G38.5 Z3 F150'];
    expect(routineIdentityOf('seat-press', SEAT_LINES, SEAT_HEIGHTS)).toEqual(
      routineIdentityOf('seat-press', moved, SEAT_HEIGHTS),
    );
    expect(routineShapeOf(SEAT_LINES, SEAT_HEIGHTS).map((s) => s.axis)).toEqual(['Z', 'XY', 'Z', 'Z']);
  });

  it('a changed sequence shape — one move reordered — is a DIFFERENT routine', () => {
    const reordered = ['G53 G0 Z-81.25', 'G38.3 Z-11 F150', 'G53 G0 X-175 Y-35', 'G38.5 Z3 F150'];
    const a = routineIdentityOf('seat-press', SEAT_LINES, SEAT_HEIGHTS);
    const b = routineIdentityOf('seat-press', reordered, SEAT_HEIGHTS);
    expect(b.shape).not.toBe(a.shape);
    // ... and so is a sequence that gained a move.
    const longer = routineIdentityOf('seat-press', [...SEAT_LINES, 'G53 G0 Z-81.25'], SEAT_HEIGHTS);
    expect(longer.shape).not.toBe(a.shape);
    // The SHAPE is the line sequence alone; the routine id is the identity's other half, and the
    // record keys on both (a completion under one id never satisfies another — the record spec).
    expect(routineIdentityOf('registration', SEAT_LINES, SEAT_HEIGHTS)).toEqual({
      ...a,
      routine: 'registration',
    });
  });
});

describe('#1202 — the completed-routines record', () => {
  it('a routine absent from the machine has not run here; adding its completion marks it run', () => {
    const record = machine();
    const identity = routineIdentityOf('seat-press', SEAT_LINES, SEAT_HEIGHTS);
    const done = completion({ shape: identity.shape });
    expect(routineCompleted(record, identity)).toBe(false);
    const next = withRoutineCompletion(record, done);
    expect(routineCompleted(next, identity)).toBe(true);
    expect(routineCompletionFor(next, identity)?.at).toBe(done.at);
    // The same shape under another routine id is a different fact.
    expect(routineCompleted(next, routineIdentityOf('mount-tap', SEAT_LINES, SEAT_HEIGHTS))).toBe(false);
  });

  it('one entry per shape: a later completion replaces the earlier, and the cap prunes the oldest', () => {
    const identity = routineIdentityOf('seat-press', SEAT_LINES, SEAT_HEIGHTS);
    let record = machine();
    record = withRoutineCompletion(record, completion({ shape: identity.shape, at: '2026-11-11T09:12:00.000Z' }));
    record = withRoutineCompletion(
      record,
      completion({ shape: identity.shape, at: '2026-11-12T10:00:00.000Z', build: { version: '1.0.1', commit: 'def5678' } }),
    );
    const mine = (record.completedRoutines ?? []).filter((c) => c.routine === 'seat-press');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.at).toBe('2026-11-12T10:00:00.000Z');
    expect(mine[0]!.build.version).toBe('1.0.1');

    // The cap keeps the newest sixty.
    let many = machine();
    const limit = routineRecordLimit();
    for (let i = 0; i < limit + 5; i++) {
      many = withRoutineCompletion(many, completion({ shape: `shape-${String(i).padStart(4, '0')}`, at: `2026-11-${String(1 + (i % 28)).padStart(2, '0')}T09:00:00.000Z` }));
    }
    expect((many.completedRoutines ?? []).length).toBe(limit);
  });

  it('an unreadable entry is dropped, never the whole machine', () => {
    const parsed = RoutineCompletionsSchema.parse([
      completion(),
      { routine: 'not-a-routine', shape: 'x', at: '2026-11-11T09:12:00.000Z', build: { version: '1', commit: null } },
      { routine: 'seat-press', shape: '', at: '2026-11-11T09:12:00.000Z', build: { version: '1', commit: null } },
      { routine: 'seat-press', shape: 'abc', at: 'not a date', build: { version: '1', commit: null } },
      { routine: 'seat-press', shape: 'abc', at: '2026-11-11T09:12:00.000Z' },
      'nonsense',
    ]);
    expect(parsed ?? []).toHaveLength(1);
    expect(parsed![0]!.shape).toBe('0f3c9a11');
    // A record written before the section existed parses without it.
    expect(MachineRecordSchema.parse({ id: 'm-2', updatedAt: '2026-11-11T09:00:00.000Z' }).completedRoutines).toBeUndefined();
  });
});
