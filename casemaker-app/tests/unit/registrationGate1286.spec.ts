// #1286 (SAFETY) — NOTHING IS UPLOADED OR PLAYED FOR A SETUP THAT HAS NO REGISTRATION.
//
// Found by a no-seam walk (2026-11-14): with Register step 2 REFUSED the Cut card's Start went live
// once the cutter was ticked, and pressing it sent `upload`. Registration writes the work origin; a
// program played without one runs at whatever G54 the controller last held.
//
// The rule is `setupRunGate` (a code and a sentence) and every control that starts anything reads it:
// the Cut card (`cardStartBlocker`), the release's upload / start / walks, and — last line — the run
// store's `start` for any job-owned run. A registration counts only if it is this job's, this setup's
// (each setup of a multi-setup job needs its own), on this machine, and usable.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cardStartBlocker } from '@/components/panels/cutCardGate';
import { resetEngraveRegistrationStore, setupRunGate, useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
import { resetMachineRunStore, useMachineRunStore } from '@/store/machineRunStore';
import { registerForTest } from '../tools/registeredJob';

const TARGET = { host: '192.0.2.10', port: 2222 };
const OTHER = { host: '192.0.2.99', port: 2222 };

beforeEach(() => {
  resetEngraveRegistrationStore();
  resetMachineRunStore();
});

describe('#1286 setupRunGate', () => {
  it('nothing on record: refused, with a code and a sentence that says what to do', () => {
    const gate = setupRunGate('job-1', 1, 'setup-1', TARGET);
    expect(gate?.code).toBe('registration-missing');
    expect(gate?.sentence).toContain('Register this job first');
  });

  it('a registration of THIS job on THIS machine opens it; another machine’s, another job’s do not', () => {
    registerForTest('job-1', TARGET, null);
    expect(setupRunGate('job-1', 1, 'setup-1', TARGET)).toBeNull();
    expect(setupRunGate('job-1', 1, 'setup-1', OTHER)?.code).toBe('registration-missing');
    expect(setupRunGate('job-2', 1, 'setup-1', TARGET)?.code).toBe('registration-missing');
  });

  it('each setup needs its own: setup 1’s record does not stand in for side 2', () => {
    registerForTest('job-1', TARGET, 'setup-1');
    registerForTest('job-1', TARGET, null);
    expect(setupRunGate('job-1', 2, 'setup-2', TARGET)?.sentence).toContain('Register side 2 first');
    registerForTest('job-1', TARGET, 'setup-2');
    expect(setupRunGate('job-1', 2, 'setup-2', TARGET)).toBeNull();
  });

  it('a registration that was not usable is not a registration', () => {
    registerForTest('job-1', TARGET, null);
    const rec = useEngraveRegistrationStore.getState().records['job-1']!;
    useEngraveRegistrationStore.setState({
      records: { 'job-1': { ...rec, outcome: { ...rec.outcome, usable: false } } },
    });
    expect(setupRunGate('job-1', 1, null, TARGET)?.code).toBe('registration-unusable');
  });
});

describe('#1286 the card carries the gate', () => {
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
    // A more specific reason leads.
    expect(cardStartBlocker({ ...clear, cutterChecklistBlocker: 'locate the cutter', registrationBlocker: 'Register' })).toBe('locate the cutter');
  });
});

describe('#1286 the run store is the last line', () => {
  it('a job-owned run with no registration is not started, and nothing is sent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'hash-1', { nc: 'G0 X0\nM02\n', jobId: 'job-1', setupIndex: 1, setupId: 'setup-1' });
    const started = useMachineRunStore.getState().start(TARGET, { pollMs: 2000, noProgressMs: 30000, missLimit: 3 });
    expect(started).toBe(false);
    expect(useMachineRunStore.getState().runs[`${TARGET.host}:${TARGET.port}`]?.running).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registration-missing'));
    warn.mockRestore();
  });

  it('a run with no job behind it (a loaded file) is not asked for a job origin', () => {
    useMachineRunStore.getState().prepare(TARGET, 'file.nc', 'hash-2', { nc: 'G0 X0\nM02\n' });
    // It is allowed to start; the transport here is absent, so only the refusal path is observable.
    const refused = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useMachineRunStore.getState().start(TARGET, { pollMs: 2000, noProgressMs: 30000, missLimit: 3 });
    expect(refused).not.toHaveBeenCalledWith(expect.stringContaining('registration-'));
    refused.mockRestore();
  });
});
