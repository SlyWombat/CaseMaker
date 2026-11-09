// #1123-40 — THE REGISTRATION MEMO: the registration record kept on the house's machine record so
// a reload (or another browser) does not force a full re-register.
//
// THE KEY IS THE SETUP, NOT THE JOB. Side 1 and side 2 of a flip job are two registrations against
// two G54s; a side-2 restore must never pick up side 1's memo, or the reverse.
//
// THE CHECK IS THE WRITTEN X/Y. The memo carries the G54 X/Y the `G10 L2` line wrote; a restore is
// offered only while the machine's live work offset — `MPos − WPos` (#933) — still matches them.
// Z is not storable honestly (the written Z0 is the cutter's PRB reading at the write, and the live
// work offset's Z carries TLO), so the card says the scope out loud: X/Y verified, Z as written.
import { describe, expect, it } from 'vitest';
import { MachineRecordSchema, type MachineRecord } from '@/platform/locationClient';
import {
  G54_RESTORE_TOLERANCE_MM,
  REGISTRATION_MEMO_LIMIT,
  assessRegistrationMemo,
  g54Matches,
  isRegistrationMemo,
  registrationMemoFor,
  restoredRegistration,
  withRegistrationMemo,
  type RegistrationMemo,
} from '@/platform/registrationMemo';
import type { RegistrationOutcome } from '@/engine/cnc/registration/outcome';
import type { RegistrationPlan } from '@/engine/cnc/registration/plan';

const TARGET = { host: '192.0.2.10', port: 2222 };

const PLAN = {
  stock: { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 },
  surfacePoint: { x: 24, y: 43 },
  scans: [],
  at: { x: 24, y: 43 },
} as unknown as RegistrationPlan;

const OUTCOME = {
  correctedG54: { x: 9.344, y: 3.001 },
  currentG54: { x: 9.1, y: 3.0 },
  surfaceZ: -55.131,
  usable: true,
  problems: [],
  notes: [],
  measured: { x: true, y: true },
} as unknown as RegistrationOutcome;

const SURFACE = { plane: { offset: -55.131, slopeX: 0, slopeY: 0 }, z0: -55.131 };

function memo(over: Partial<RegistrationMemo> = {}): RegistrationMemo {
  return {
    jobId: 'job-1',
    setupId: 'setup-1',
    setupIndex: 1,
    writtenG54: { x: 9.344, y: 3.001 },
    writtenAt: '2026-11-09T14:00:00.000Z',
    registration: { plan: PLAN, outcome: OUTCOME, surface: SURFACE, measuredAt: '2026-11-09T13:59:00.000Z' },
    ...over,
  };
}

function machine(registrations?: RegistrationMemo[]): MachineRecord {
  return {
    id: 'm1',
    profileId: 'Z1',
    address: { host: TARGET.host, port: TARGET.port },
    updatedAt: '2026-11-09T14:00:00.000Z',
    ...(registrations === undefined ? {} : { registrations }),
  } as unknown as MachineRecord;
}

describe('#1123-40 — the memo is keyed by job AND setup', () => {
  it('keeps side 1 and side 2 of one job apart, and restores only the asked-for setup', () => {
    const sideOne = memo({ setupId: 'setup-1', setupIndex: 1, writtenG54: { x: 1, y: 2 } });
    const sideTwo = memo({ setupId: 'setup-2', setupIndex: 2, writtenG54: { x: 70, y: 5 } });
    let record = withRegistrationMemo(machine(), sideOne);
    record = withRegistrationMemo(record, sideTwo);
    expect(record.registrations).toHaveLength(2);
    expect(registrationMemoFor(record, 'job-1', 'setup-1')?.writtenG54).toEqual({ x: 1, y: 2 });
    expect(registrationMemoFor(record, 'job-1', 'setup-2')?.writtenG54).toEqual({ x: 70, y: 5 });
    // A side-2 restore asking for setup 2 must never be handed side 1's memo.
    expect(registrationMemoFor(record, 'job-1', 'setup-2')?.setupId).toBe('setup-2');
  });

  it('replaces the memo for the same (job, setup) and keeps another job’s memo', () => {
    const first = memo({ writtenAt: '2026-11-09T10:00:00.000Z', writtenG54: { x: 1, y: 1 } });
    const other = memo({ jobId: 'job-2', setupId: 'setup-1', writtenAt: '2026-11-09T11:00:00.000Z' });
    const again = memo({ writtenAt: '2026-11-09T12:00:00.000Z', writtenG54: { x: 2, y: 2 } });
    let record = withRegistrationMemo(machine(), first);
    record = withRegistrationMemo(record, other);
    record = withRegistrationMemo(record, again);
    expect(record.registrations).toHaveLength(2);
    expect(registrationMemoFor(record, 'job-1', 'setup-1')?.writtenG54).toEqual({ x: 2, y: 2 });
    expect(registrationMemoFor(record, 'job-2', 'setup-1')?.writtenAt).toBe('2026-11-09T11:00:00.000Z');
  });

  it('prunes to the newest ten memos, oldest written first', () => {
    let record = machine();
    for (let i = 0; i < REGISTRATION_MEMO_LIMIT + 3; i++) {
      record = withRegistrationMemo(
        record,
        memo({ jobId: `job-${i}`, writtenAt: `2026-11-09T${String(10 + i).padStart(2, '0')}:00:00.000Z` }),
      );
    }
    expect(record.registrations).toHaveLength(REGISTRATION_MEMO_LIMIT);
    // The three oldest are gone; the newest is first.
    expect(record.registrations?.[0]?.jobId).toBe(`job-${REGISTRATION_MEMO_LIMIT + 2}`);
    expect(record.registrations?.some((m) => m.jobId === 'job-0')).toBe(false);
  });

  it('leaves every other field of the machine record untouched', () => {
    const base = machine();
    const next = withRegistrationMemo(base, memo());
    const { registrations: _ignored, ...rest } = next;
    expect(rest).toEqual(base);
  });

  it('reads nothing from a machine that is absent or holds no memo for this setup', () => {
    expect(registrationMemoFor(null, 'job-1', 'setup-1')).toBeNull();
    expect(registrationMemoFor(machine(), 'job-1', 'setup-1')).toBeNull();
    expect(registrationMemoFor(machine([memo()]), 'job-1', 'setup-2')).toBeNull();
    expect(registrationMemoFor(machine([memo()]), 'job-2', 'setup-1')).toBeNull();
  });

  it('ignores a malformed entry instead of handing it to a restore', () => {
    const record = machine();
    // A hand-edited or half-written document: the section is there, one entry is not a memo.
    (record as { registrations?: unknown }).registrations = [{ jobId: 'job-1', setupId: 'setup-1' }, memo()];
    expect(isRegistrationMemo({ jobId: 'job-1' })).toBe(false);
    expect(registrationMemoFor(record, 'job-1', 'setup-1')?.writtenG54).toEqual({ x: 9.344, y: 3.001 });
  });

  it('survives the machine record schema, and an older record without the section still parses', () => {
    const parsed = MachineRecordSchema.parse(JSON.parse(JSON.stringify(machine([memo()]))));
    expect(parsed.registrations).toHaveLength(1);
    expect(parsed.registrations?.[0]?.registration.plan).toEqual(PLAN);
    expect(parsed.registrations?.[0]?.registration.outcome).toEqual(OUTCOME);
    const older = MachineRecordSchema.parse(JSON.parse(JSON.stringify(machine())));
    expect(older.registrations).toBeUndefined();
  });
});

describe('#1123-40 — the G54 check', () => {
  it('matches the written X/Y within a thousandth of a millimetre, never an axis the line did not state', () => {
    expect(G54_RESTORE_TOLERANCE_MM).toBe(0.01);
    const written = { x: 9.344, y: 3.001 };
    expect(g54Matches(written, { x: 9.344, y: 3.001 })).toBe(true);
    expect(g54Matches(written, { x: 9.35, y: 3.001 })).toBe(true);
    expect(g54Matches(written, { x: 9.36, y: 3.001 })).toBe(false);
    expect(g54Matches(written, { x: 9.344, y: null })).toBe(false);
    expect(g54Matches(written, null)).toBe(false);
  });
});

describe('#1123-40 — the restore verdict, and the scope said out loud', () => {
  const live = { x: 9.344, y: 3.001 };
  const now = '2026-11-09T15:00:00.000Z';

  it('says nothing at all when the house holds no memo', () => {
    const verdict = assessRegistrationMemo({ memo: null, answer: 'target', liveG54: live, now });
    expect(verdict).toEqual({ kind: 'none', memo: null, g54Read: null, checkedAt: now, words: null });
  });

  it('waits while no heartbeat has answered this session', () => {
    const verdict = assessRegistrationMemo({ memo: memo(), answer: 'unknown', liveG54: null, now });
    expect(verdict.kind).toBe('waiting');
    expect(verdict.words).toContain('will be checked against the machine');
    expect(verdict.g54Read).toBeNull();
  });

  it('does not restore an uncheckable memo when the machine is unreachable', () => {
    const verdict = assessRegistrationMemo({ memo: memo(), answer: 'unreachable', liveG54: null, now });
    expect(verdict.kind).toBe('unreachable');
    expect(verdict.words).toContain('register again');
    expect(verdict.g54Read).toBeNull();
  });

  it('does not offer another machine’s answer as this job’s check', () => {
    const verdict = assessRegistrationMemo({ memo: memo(), answer: 'elsewhere', liveG54: live, now });
    expect(verdict.kind).toBe('elsewhere');
    expect(verdict.words).toContain('a different machine');
    expect(verdict.g54Read).toBeNull();
  });

  it('restores when the live G54 still matches, and states the scope: X/Y verified, Z as written', () => {
    const verdict = assessRegistrationMemo({ memo: memo(), answer: 'target', liveG54: live, now });
    expect(verdict.kind).toBe('restored');
    expect(verdict.g54Read).toEqual(live);
    expect(verdict.words).toContain(`G54 X/Y verified at ${now}`);
    expect(verdict.words).toContain('Z as written then');
    expect(verdict.words).toContain('2026-11-09T13:59:00.000Z');
  });

  it('refuses and names both G54s when the machine was moved since', () => {
    const verdict = assessRegistrationMemo({
      memo: memo(),
      answer: 'target',
      liveG54: { x: 9.7, y: 3.001 },
      now,
    });
    expect(verdict.kind).toBe('mismatch');
    expect(verdict.words).toContain('written at G54 X 9.344 Y 3.001');
    expect(verdict.words).toContain('now reads X 9.700 Y 3.001');
    expect(verdict.words).toContain('register again');
  });

  it('cannot check a status line that did not state both positions', () => {
    const verdict = assessRegistrationMemo({ memo: memo(), answer: 'target', liveG54: { x: 9.344, y: null }, now });
    expect(verdict.kind).toBe('unverifiable');
    expect(verdict.words).toContain('did not state both positions');
  });

  it('builds the restored record with the memo’s own measuredAt and a provenance that says how it was checked', () => {
    const verdict = assessRegistrationMemo({ memo: memo(), answer: 'target', liveG54: live, now });
    const record = restoredRegistration(verdict, TARGET);
    expect(record.jobId).toBe('job-1');
    expect(record.setupId).toBe('setup-1');
    expect(record.target).toEqual(TARGET);
    expect(record.plan).toBe(PLAN);
    expect(record.outcome).toBe(OUTCOME);
    expect(record.surface).toEqual(SURFACE);
    // The MEASUREMENT's clock, not the reload's: the record is what the touches found.
    expect(record.measuredAt).toBe('2026-11-09T13:59:00.000Z');
    expect(record.restored).toEqual({ checkedAt: now, g54: live, setupIndex: 1 });
  });
});
