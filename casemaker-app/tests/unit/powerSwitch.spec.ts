// #416 — the power switch's guards and flows, against a FAKE provider. Nothing here reaches Home
// Assistant or a plug: the switch, the plug's state and the machine check are all functions the test
// owns. These stand in for the issue's e2e (on; off refused while running; off after Idle and a home)
// — the Playwright run against the desktop build is not covered from here.

import { describe, expect, it } from 'vitest';
import {
  cycleConfirmed,
  jobEndOffAllowed,
  manualOffAllowed,
  powerOffGuarded,
  powerOnAndWait,
  probeSettled,
  type PowerDeps,
} from '@/store/powerStore';
import { PowerSwitchSchema } from '@/platform/powerClient';

const IDLE = '<Idle|MPos:0.000,0.000,0.000|WPos:0.000,0.000,0.000>';
const RUNNING = '<Run|MPos:1.000,2.000,-3.000|P:120,45,30>';
const IDLE_MID_JOB = '<Idle|MPos:1.000,2.000,-3.000|P:400,98,60>';

/** A plug and a machine. The machine answers `answersAfter` probes after the plug comes on. */
function fakeWorld(opts: { plugOn?: boolean; answersAfter?: number; neverAnswers?: boolean; status?: string } = {}) {
  let plugOn = opts.plugOn ?? false;
  let probesSinceOn = 0;
  let clock = 0;
  const calls: string[] = [];
  const deps: PowerDeps = {
    switchPlug: async (on) => {
      calls.push(on ? 'on' : 'off');
      plugOn = on;
      probesSinceOn = 0;
      return { ok: true };
    },
    plugIsOn: async () => plugOn,
    probe: async () => {
      calls.push('probe');
      if (!plugOn || opts.neverAnswers) return { answered: false, status: null };
      probesSinceOn += 1;
      return probesSinceOn > (opts.answersAfter ?? 2) ? { answered: true, status: opts.status ?? IDLE } : { answered: false, status: null };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, calls, plug: () => plugOn };
}

describe('#416 on', () => {
  it('switches on and waits until the controller answers', async () => {
    const w = fakeWorld({ answersAfter: 2 });
    const r = await powerOnAndWait(w.deps, { waitSeconds: 180, pollMs: 1000 });
    expect(r).toEqual({ ok: true, status: IDLE });
    expect(w.calls).toEqual(['on', 'probe', 'probe', 'probe']);
  });

  it('does nothing to a plug that is on with the machine answering', async () => {
    const w = fakeWorld({ plugOn: true, answersAfter: 0 });
    const r = await powerOnAndWait(w.deps, { waitSeconds: 180 });
    expect(r.ok && w.calls).toEqual(['probe']);
  });

  it('NEVER cycles on its own: a plug that is on with the machine silent is reported, untouched (#416 review)', async () => {
    const w = fakeWorld({ plugOn: true, neverAnswers: true });
    const r = await powerOnAndWait(w.deps, { waitSeconds: 180, probeGapMs: 10 });
    expect(r).toMatchObject({ ok: false, needsCycle: true });
    // Several probes, and not one switch call: the plug was never touched.
    expect(w.calls).toEqual(['probe', 'probe', 'probe']);
    expect(w.plug()).toBe(true);
  });

  it('the cycle is its own confirmed action — and refuses a machine that answers on any probe', async () => {
    const silent = fakeWorld({ plugOn: true, neverAnswers: true });
    const r = await cycleConfirmed(silent.deps, { waitSeconds: 5, pollMs: 1000, probeGapMs: 10, pauseMs: 10 });
    expect(r.ok).toBe(false); // never answers, even after the cycle
    expect(silent.calls.filter((c) => c !== 'probe').slice(0, 2)).toEqual(['off', 'on']);
    expect(silent.plug()).toBe(true);

    // Answers on the THIRD probe: a talking machine is not cycled.
    let n = 0;
    const flaky = fakeWorld({ plugOn: true });
    flaky.deps.probe = async () => (++n >= 3 ? { answered: true, status: IDLE } : { answered: false, status: null });
    const r2 = await cycleConfirmed(flaky.deps, { waitSeconds: 5, probeGapMs: 10 });
    expect(r2).toEqual({ ok: false, reason: 'the machine answered, so it is not cycled' });
    expect(flaky.calls).toEqual([]);
  });

  it('calls a machine silent only after several probes', async () => {
    let n = 0;
    const answersSecond = { probe: async () => (++n >= 2 ? { answered: true, status: IDLE } : { answered: false, status: null }), sleep: async () => {} };
    expect(await probeSettled(answersSecond)).toBe(IDLE);
    let m = 0;
    const never = { probe: async () => (m++, { answered: false, status: null }), sleep: async () => {} };
    expect(await probeSettled(never, { tries: 3 })).toBeNull();
    expect(m).toBe(3);
  });

  it('times out after the shop’s wait and leaves the plug on', async () => {
    const w = fakeWorld({ neverAnswers: true });
    const r = await powerOnAndWait(w.deps, { waitSeconds: 30, pollMs: 10_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('within 30 s — it is left on');
    expect(w.plug()).toBe(true);
    expect(w.calls.filter((c) => c === 'off')).toEqual([]);
  });
});

describe('#416 off — the guards', () => {
  const base = { canReadStatus: true, status: IDLE, jobRunning: false, homedAfterLastRun: true };

  it('is refused while a job runs — by the flow, or by the status line’s own progress', async () => {
    const w = fakeWorld({ plugOn: true });
    for (const e of [{ ...base, jobRunning: true }, { ...base, status: RUNNING }, { ...base, status: IDLE_MID_JOB }]) {
      const v = await powerOffGuarded(w.deps, jobEndOffAllowed(e));
      expect(v.ok).toBe(false);
      expect(manualOffAllowed(e).ok).toBe(false);
    }
    expect(w.calls).toEqual([]);
    expect(w.plug()).toBe(true);
  });

  it('at a job’s end, is refused until the machine has homed, then switches off', async () => {
    const w = fakeWorld({ plugOn: true });
    const notHomed = await powerOffGuarded(w.deps, jobEndOffAllowed({ ...base, homedAfterLastRun: false }));
    expect(notHomed).toEqual({ ok: false, reason: 'the machine has not homed since the run — home it, then switch off' });
    expect(w.plug()).toBe(true);
    const homed = await powerOffGuarded(w.deps, jobEndOffAllowed(base));
    expect(homed.ok).toBe(true);
    expect(w.calls).toEqual(['off']);
    expect(w.plug()).toBe(false);
  });

  it('at a job’s end, a silent machine is left on; by hand, only after the person confirms (#416 review)', () => {
    expect(jobEndOffAllowed({ ...base, status: null }).ok).toBe(false);
    expect(manualOffAllowed({ ...base, status: null })).toMatchObject({ ok: false, needsConfirm: true });
    expect(manualOffAllowed({ ...base, status: null, confirmedSilent: true })).toEqual({
      ok: true,
      warning: 'the machine did not answer, so it was switched off without asking it',
    });
  });

  it('a window that cannot read the status cannot switch off', () => {
    expect(manualOffAllowed({ ...base, canReadStatus: false }).ok).toBe(false);
    expect(jobEndOffAllowed({ ...base, canReadStatus: false }).ok).toBe(false);
  });

  it('a machine in alarm, or not Idle, is not switched off', () => {
    expect(manualOffAllowed({ ...base, status: '<Alarm|MPos:0,0,0>' }).ok).toBe(false);
    expect(manualOffAllowed({ ...base, status: `${IDLE}\nALARM: Probe fail` }).ok).toBe(false);
  });
});

describe('#416 the switch config', () => {
  it('takes an http Home Assistant and a switch entity, and refuses the rest', () => {
    expect(PowerSwitchSchema.safeParse({ provider: 'home-assistant', baseUrl: 'http://ha.local:8123', entityId: 'switch.makera_cnc' }).success).toBe(true);
    for (const bad of [
      { provider: 'home-assistant', baseUrl: 'https://ha.local:8123', entityId: 'switch.x' },
      { provider: 'home-assistant', baseUrl: 'http://ha.local:8123/api', entityId: 'switch.x' },
      { provider: 'home-assistant', baseUrl: 'http://ha.local', entityId: 'light.x' },
      { provider: 'tasmota', baseUrl: 'http://ha.local', entityId: 'switch.x' },
      { provider: 'home-assistant', baseUrl: 'http://ha.local', entityId: 'switch.x', token: 'never-here' },
    ]) {
      expect(PowerSwitchSchema.safeParse(bad).success).toBe(false);
    }
  });
});
