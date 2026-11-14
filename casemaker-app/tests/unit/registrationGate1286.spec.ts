// #1286 (SAFETY) — NOTHING IS UPLOADED OR PLAYED FOR A SETUP THAT HAS NO REGISTRATION.
//
// Found by a no-seam walk (2026-11-14): with Register step 2 REFUSED the Cut card's Start went live
// once the cutter was ticked, and pressing it sent `upload`. Registration writes the work origin; a
// program played without one runs at whatever G54 the controller last held.
//
// The rule is `setupRunGate` (a code and a sentence) and every control that starts anything reads it:
// the Cut card (`cardStartBlocker`), the release's upload / start / walks, and — last line — the run
// store's `start` for any job-owned run. A registration counts only if it is this job's, this setup's
// (another setup's record never stands in), on this machine, usable, measured on this BLANK and this
// HOLD, and the LATEST origin written on the machine.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cardStartBlocker } from '@/components/panels/cutCardGate';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { holdKeyOf, resetEngraveRegistrationStore, setupRunGate, useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetMachineRunStore, useMachineRunStore } from '@/store/machineRunStore';
import type { EngraveJob } from '@/types/engraveJob';
import { runRegistration } from '@/engine/cnc/registration/execute';
import { markMachineChanged } from '@/store/engraveRegistrationStore';
import { registerForTest, testPlan } from '../tools/registeredJob';

const TARGET = { host: '192.0.2.10', port: 2222 };
const OTHER = { host: '192.0.2.99', port: 2222 };

const jobA: EngraveJob = { ...defaultEngraveJob(), id: 'job-A' };
const jobB: EngraveJob = { ...defaultEngraveJob(), id: 'job-B' };
const gate = (job: EngraveJob, idx: number | null, setupId: string | null, target = TARGET as typeof TARGET | null, blankId: string | null = null) =>
  setupRunGate({ job, setupIndex: idx, setupId, target, blankId });

beforeEach(() => {
  resetEngraveRegistrationStore();
  resetMachineRunStore();
});

describe('#1286 setupRunGate', () => {
  it('nothing on record: refused, with a code and a sentence that says what to do', () => {
    const g = gate(jobA, 1, 'setup-1');
    expect(g?.code).toBe('registration-missing');
    expect(g?.sentence).toContain('Register this job first');
  });

  it('no machine is a refusal, not "nothing to ask"; a program that names no setup is refused too', () => {
    registerForTest(jobA, TARGET, null);
    expect(gate(jobA, 1, null, null)?.code).toBe('registration-no-machine');
    expect(gate(jobA, null, null)?.code).toBe('registration-no-setup');
  });

  it('a registration of THIS job on THIS machine opens it; another machine’s, another job’s do not', () => {
    registerForTest(jobA, TARGET, null);
    expect(gate(jobA, 1, 'setup-1')).toBeNull();
    expect(gate(jobA, 1, 'setup-1', OTHER)?.code).toBe('registration-missing');
    expect(gate(jobB, 1, 'setup-1')?.code).toBe('registration-missing');
  });

  it('each setup needs its own: setup 1’s record does not stand in for side 2, nor side 2’s for setup 1', () => {
    registerForTest(jobA, TARGET, 'setup-1');
    registerForTest(jobA, TARGET, null);
    expect(gate(jobA, 2, 'setup-2')?.sentence).toContain('Register side 2 first');
    useEngraveRegistrationStore.getState().recordSetup(
      'job-A', 'setup-2', TARGET,
      useEngraveRegistrationStore.getState().records['job-A']!.plan,
      useEngraveRegistrationStore.getState().records['job-A']!.outcome,
      null,
      { blankId: null, holdKey: holdKeyOf(jobA) },
    );
    expect(gate(jobA, 2, 'setup-2')).toBeNull();
    // C — a record that NAMES a setup does not satisfy the job's first setup unless it is `job.setups[0]`
    // (the program's own setup id is not what decides): filed for another setup id, it is refused.
    resetEngraveRegistrationStore();
    const withSetups = { ...jobA, setups: [{ id: 'real-1' }] } as unknown as EngraveJob;
    registerForTest(withSetups, TARGET, 'other-setup');
    expect(gate(withSetups, 1, null)?.code).toBe('registration-missing');
    expect(gate(withSetups, 1, 'whatever-the-program-says')?.code).toBe('registration-missing');
    registerForTest(withSetups, TARGET, null); // filed under real-1
    expect(gate(withSetups, 1, null)).toBeNull();
    expect(gate(withSetups, 1, 'whatever-the-program-says')).toBeNull();
  });

  it('a registration that was not usable is not a registration', () => {
    registerForTest(jobA, TARGET, null);
    const rec = useEngraveRegistrationStore.getState().records['job-A']!;
    useEngraveRegistrationStore.setState({ records: { 'job-A': { ...rec, outcome: { ...rec.outcome, usable: false } } } });
    expect(gate(jobA, 1, null)?.code).toBe('registration-unusable');
  });

  it('BLANK: registered on blank A, now blank B → refused; a job that has no blank id keeps its session registration until it gets one', () => {
    registerForTest(jobA, TARGET, null); // stamped blankId null (legacy)
    expect(gate(jobA, 1, null, TARGET, null)).toBeNull();
    expect(gate(jobA, 1, null, TARGET, 'blank-1')?.code).toBe('registration-other-blank');
    // Measured on blank-1, now blank-2.
    const rec = useEngraveRegistrationStore.getState().records['job-A']!;
    useEngraveRegistrationStore.setState({ records: { 'job-A': { ...rec, stamp: { blankId: 'blank-1', holdKey: holdKeyOf(jobA) } } } });
    expect(gate(jobA, 1, null, TARGET, 'blank-1')).toBeNull();
    expect(gate(jobA, 1, null, TARGET, 'blank-2')?.code).toBe('registration-other-blank');
  });

  it('HOLD: a changed seat, mount or stock is not what was measured', () => {
    registerForTest(jobA, TARGET, null);
    const changed: EngraveJob = { ...jobA, stock: { ...jobA.stock, thickness: jobA.stock.thickness + 5 } };
    expect(gate(changed, 1, null)?.code).toBe('registration-other-hold');
    expect(gate(jobA, 1, null)).toBeNull();
  });

  it('SUPERSEDED: job A, then job B on the same machine, back to A → A’s Start refuses; side 1 after side 2 likewise', () => {
    registerForTest(jobA, TARGET, null);
    expect(gate(jobA, 1, null)).toBeNull();
    registerForTest(jobB, TARGET, null);
    expect(gate(jobB, 1, null)).toBeNull();
    expect(gate(jobA, 1, null)?.code).toBe('registration-superseded');
    // Re-registering A makes B's the stale one.
    registerForTest(jobA, TARGET, null);
    expect(gate(jobA, 1, null)).toBeNull();
    expect(gate(jobB, 1, null)?.code).toBe('registration-superseded');
    // Side 2 of A written after side 1: side 1 no longer describes the G54.
    const s = useEngraveRegistrationStore.getState();
    s.recordSetup('job-A', 'setup-2', TARGET, s.records['job-A']!.plan, s.records['job-A']!.outcome, null, { blankId: null, holdKey: holdKeyOf(jobA) });
    expect(gate(jobA, 2, 'setup-2')).toBeNull();
    expect(gate(jobA, 1, null)?.code).toBe('registration-superseded');
  });

  it('A — a clear must not erase "the origin is no longer A\u2019s": A, then B, then B cleared → A stays refused; and no mark at all refuses', () => {
    registerForTest(jobA, TARGET, null);
    registerForTest(jobB, TARGET, null);
    expect(gate(jobA, 1, null)?.code).toBe('registration-superseded');
    useEngraveRegistrationStore.getState().clear('job-B');
    expect(gate(jobA, 1, null)?.code).toBe('registration-superseded');
    expect(gate(jobB, 1, null)?.code).toBe('registration-missing');
    // A record with NO machine mark behind it (state restored some other way) is refused, not waved through.
    registerForTest(jobA, TARGET, null);
    expect(gate(jobA, 1, null)).toBeNull();
    useEngraveRegistrationStore.setState({ latest: {} });
    expect(gate(jobA, 1, null)?.code).toBe('registration-superseded');
  });

  it('B — the machine is marked when the origin write STARTS: A registered, B begins writing and is stopped → A is refused', () => {
    registerForTest(jobA, TARGET, null);
    expect(gate(jobA, 1, null)).toBeNull();
    useEngraveRegistrationStore.getState().markWriting(TARGET, 'job-B', null); // B's G10 is going out; no record ever follows
    expect(gate(jobA, 1, null)?.code).toBe('registration-superseded');
    expect(gate(jobB, 1, null)?.code).toBe('registration-missing');
  });

  it('B2 — the RUN marks the machine itself on its FIRST send: A registered, B\u2019s run starts and is stopped before any origin write → A refused', async () => {
    registerForTest(jobA, TARGET, null);
    expect(gate(jobA, 1, null)).toBeNull();
    const order: string[] = [];
    let sent = 0;
    const r = await runRegistration(testPlan(), {
      console: {
        send: async (line: string) => {
          order.push(`send ${line}`);
          sent += 1;
          return { kind: 'sent', line, text: 'ok', frames: 1, elapsedMs: 1 } as never;
        },
      },
      operator: async () => true,
      // The operator presses Stop the moment the first line has gone: B never reaches an origin write.
      stopRequested: () => sent >= 1,
      liveClearanceZ: -3,
      onFirstSend: () => {
        order.push('mark');
        markMachineChanged(TARGET);
      },
    });
    expect(r.ok).toBe(false);
    expect(order[0], 'the mark comes BEFORE the first line goes out').toBe('mark');
    expect(order.filter((o) => o === 'mark')).toHaveLength(1);
    expect(order.some((o) => o.includes('G10 L2'))).toBe(false); // no origin write happened
    expect(gate(jobA, 1, null)?.code).toBe('registration-superseded');
  });

  it('a record restored from the house’s note carries no blank stamp and never satisfies the gate', () => {
    registerForTest(jobA, TARGET, null);
    const rec = useEngraveRegistrationStore.getState().records['job-A']!;
    const { stamp: _stamp, ...unstamped } = rec;
    void _stamp;
    useEngraveRegistrationStore.setState({ records: { 'job-A': unstamped } });
    expect(gate(jobA, 1, null)?.code).toBe('registration-unstamped');
  });
});

describe('#1286 the card carries the gate (and the field is required)', () => {
  const clear = {
    step1Blocker: null,
    programBlocker: null,
    ackBlocker: null,
    releaseBlocker: null,
    uploadBlocker: null,
    missingReportBlocker: null,
    surfaceGate: null,
    domeG32Blocker: null,
    cutterChecklistBlocker: null,
    multiProgram: false,
  };
  it('every other gate clear, an unregistered setup still blocks Start, with its sentence', () => {
    expect(cardStartBlocker({ ...clear, registrationBlocker: 'Register this job first — …' })).toBe('Register this job first — …');
    expect(cardStartBlocker({ ...clear, registrationBlocker: null })).toBeNull();
    expect(cardStartBlocker({ ...clear, cutterChecklistBlocker: 'locate the cutter', registrationBlocker: 'Register' })).toBe('locate the cutter');
  });
});

describe('#1286 the run store is the last line, and it speaks', () => {
  const settings = { pollMs: 2000, noProgressMs: 30000, missLimit: 3 };
  const entry = () => useMachineRunStore.getState().runs[`${TARGET.host}:${TARGET.port}`];

  it('a job-owned run with no registration is not started, nothing is sent, and the run’s own transcript says why', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useEngraveJobStore.setState({ job: jobA });
    useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'hash-1', { nc: 'G0 X0\nM02\n', jobId: 'job-A', setupIndex: 1, setupId: 'setup-1' });
    expect(useMachineRunStore.getState().start(TARGET, settings)).toBe(false);
    expect(entry()?.running).toBe(false);
    expect(entry()?.lines.join('\n')).toContain('Not started: Register this job first');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registration-missing'));
    warn.mockRestore();
  });

  it('a job context that does not name its setup is refused (fail closed), registered or not', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useEngraveJobStore.setState({ job: jobA });
    registerForTest(jobA, TARGET, null);
    useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'hash-1', { nc: 'G0 X0\nM02\n', jobId: 'job-A' });
    expect(useMachineRunStore.getState().start(TARGET, settings)).toBe(false);
    expect(entry()?.lines.join('\n')).toContain('does not say which setup');
    warn.mockRestore();
  });

  it('a run for a job that is not the open document is refused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useEngraveJobStore.setState({ job: jobB });
    registerForTest(jobA, TARGET, null);
    useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'hash-1', { nc: 'G0 X0\nM02\n', jobId: 'job-A', setupIndex: 1, setupId: 'setup-1' });
    expect(useMachineRunStore.getState().start(TARGET, settings)).toBe(false);
    warn.mockRestore();
  });

  it('a run with no job behind it (a loaded file) is not asked for a job origin', () => {
    useMachineRunStore.getState().prepare(TARGET, 'file.nc', 'hash-2', { nc: 'G0 X0\nM02\n' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useMachineRunStore.getState().start(TARGET, settings);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('registration-'));
    warn.mockRestore();
  });
});
