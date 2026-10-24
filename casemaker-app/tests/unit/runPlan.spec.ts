// #421 — the run plan (§5.8): phases with times and where each time came from, and the machine strip's
// switches with their defaults and reasons (Q13, Q14, Q18, the vacuum). Pure; no machine.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_DEFAULTS, ShopDefaultsSchema } from '@/platform/defaultsClient';
import { Z1 } from '@/engine/cnc/machine';
import type { RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import { planRegistration, registrationSettings } from '@/engine/cnc/registration';
import { planSetups, setupsSettings, type Removal } from '@/engine/cnc/setups';
import {
  Z1_CAPABILITIES,
  autoLevelRule,
  cutClockFrom,
  machineFeatures,
  planRun,
  planSettings,
  planSetupsFrom,
  registrationTouches,
  type FeatureInput,
  type RunPlanInput,
} from '@/engine/cnc/plan';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };
const DEFAULTS = ShopDefaultsSchema.parse(DOC.defaults);

/** A toolpath with one 100 mm rapid and one 120 mm feed at 600 mm/min — only `moves` is timed. */
function ir(): ToolpathIR {
  return {
    operations: [
      {
        moves: [
          { kind: 'rapid', x: 0, y: 0, z: 5 },
          { kind: 'rapid', x: 100, y: 0, z: 5 },
          { kind: 'feed', x: 100, y: 0, z: -0.5, f: 600 },
          { kind: 'feed', x: 100, y: 120, z: -0.5, f: 600 },
        ],
      },
    ],
  } as unknown as ToolpathIR;
}

const ONE_SETUP = [{ index: 1, mountStep: false, faced: false, registration: null }];

function input(over: Partial<RunPlanInput> = {}): RunPlanInput {
  return {
    setups: ONE_SETUP,
    programs: [{ id: 't1', setupIndex: 1, label: 'T1 ⌀2 flat', hash: 'aaaa1111', ir: ir() }],
    machine: Z1,
    mount: 'vise',
    stock: { flatness: 'domed' },
    shallowestCutMm: 0.2,
    finishedHashes: [],
    defaults: DEFAULTS,
    ...over,
  };
}

describe('#421 the phase times come from the location', () => {
  it('reads every plan.* key; $H and M491 are MEASURED with a dated note, the touch is CHOSEN', () => {
    const s = planSettings(DEFAULTS);
    expect(s.homeSeconds).toEqual({ value: 27.5, source: 'measured', key: 'plan.homeSeconds' });
    expect(s.toolLengthSeconds).toEqual({ value: 31.4, source: 'measured', key: 'plan.toolLengthSeconds' });
    // The touch series came from a console script, not the app runner: chosen, citing the series.
    expect(s.touchSeconds).toEqual({ value: 15, source: 'chosen', key: 'plan.touchSeconds' });
    expect(s.fitProbeSeconds).toEqual({ value: 45, source: 'chosen', key: 'plan.fitProbeSeconds' });
    expect(s.fitCutterSeconds).toEqual({ value: 60, source: 'chosen', key: 'plan.fitCutterSeconds' });
    expect(s.clearanceSeconds).toMatchObject({ value: 10, source: 'chosen' });
    expect(s.finishSeconds).toMatchObject({ value: 15, source: 'chosen' });
    expect(s.autoLevelPoints).toMatchObject({ value: 9, source: 'chosen' });
    expect(s.autoLevelPointSeconds).toMatchObject({ value: 10, source: 'chosen' });
    expect(s.autoLevelShallowMm).toMatchObject({ value: 0.5, source: 'chosen' });
    // The remount is the setups planner's key, in minutes there.
    expect(s.remountSeconds).toEqual({ value: 180, source: 'chosen', key: 'setups.remountMinutes' });
    expect(s.reregisterSeconds).toEqual({ value: 120, source: 'chosen', key: 'setups.reregisterMinutes' });
    for (const k of ['plan.homeSeconds', 'plan.toolLengthSeconds']) {
      expect(DEFAULTS[k]!.source, k).toBe('measured');
      expect(DEFAULTS[k]!.setAt, k).toMatch(/^2026-10-15T/);
      expect(DEFAULTS[k]!.note, k).toContain('2026-10-15');
    }
    expect(DEFAULTS['plan.toolLengthSeconds']!.note).toContain('31.36, 31.25, 32.18 and 31.35 s');
    const touch = DEFAULTS['plan.touchSeconds']!;
    expect(touch.source).toBe('seeded');
    expect(touch.setAt).toBeNull();
    expect(touch.note).toContain('32 touch-to-touch intervals');
    expect(touch.note).toContain('not the app runner');
    const phase = planRun(input()).phases.find((p) => p.kind === 'home')!;
    expect(phase.source).toBe('measured');
  });

  it('each fallback is the seed, and is labelled fallback with no location', () => {
    const s = planSettings(null);
    expect(Object.values(s).every((v) => v.source === 'fallback')).toBe(true);
    for (const [k, d] of Object.entries(DEFAULTS).filter(([k]) => k.startsWith('plan.'))) {
      expect(KNOWN_DEFAULTS[k]!.fallback, k).toBe(d.value);
      expect(KNOWN_DEFAULTS[k]!.rule.safeParse(d.value).success, k).toBe(true);
    }
    expect(KNOWN_DEFAULTS['plan.autoLevelPoints']!.rule.safeParse(9.5).success).toBe(false);
    const plan = planRun(input({ defaults: null }));
    expect(plan.findings.map((f) => f.code)).toContain('plan-defaults-fallback');
    expect(plan.phases[0]!.source).toBe('fallback');
  });
});

describe('#421 the phases', () => {
  it('one setup, one program: home, probe in, registration, bit change, air run, cut, finish', () => {
    const plan = planRun(input());
    expect(plan.phases.map((p) => p.id)).toEqual(['home', 's1.probe-in', 's1.registration', 's1.p1.bit-change', 's1.p1.air-run', 's1.p1.cut', 'finish']);
    // The head has not moved since the job's own home: no second $H before the probe.
    expect(plan.phases[1]!.parts.map((q) => q.label)).toEqual(['fit the probe', 'M491 on the probe']);
    // The bit change homes first (the bench rule), and needs its own "done" (Q17).
    const bit = plan.phases[3]!;
    expect(bit.parts[0]!.label).toContain('$H');
    expect(bit.needsDone).toBe(true);
    expect(bit.who).toBe('you + machine');
    expect(bit.seconds).toBe(27.5 + 60 + 31.4);
    expect(plan.totalIsLowerBound).toBe(false);
    expect(plan.totalSeconds).toBeCloseTo(plan.phases.reduce((n, p) => n + p.seconds!, 0), 5);
  });

  it('times the cut on the MACHINE’s own rapid model, not an assumed 3000 mm/min (#281)', () => {
    const cut = (rapid: RapidEstimate) =>
      planRun(input({ machine: { rapidEstimate: rapid } })).phases.find((p) => p.kind === 'cut')!.parts[0]!;
    const z1 = cut(Z1.rapidEstimate);
    const fast = cut({ ...Z1.rapidEstimate, xyMmPerMin: 3000, source: 'an assumed 3000' });
    expect(z1.seconds).not.toBe(fast.seconds);
    expect(z1.seconds!).toBeGreaterThan(fast.seconds!);
    expect(z1.source).toBe('estimated');
    expect(z1.from).toContain(Z1.rapidEstimate.source);
    // The air run is ≈ the cut, and says so.
    const air = planRun(input()).phases.find((p) => p.kind === 'air-run')!;
    expect(air.seconds).toBe(z1.seconds);
    expect(air.parts[0]!.from).toContain('≈ the cut');
  });

  it('a program with no estimate leaves the total a lower bound, and says so', () => {
    const plan = planRun(input({ programs: [{ id: 't1', setupIndex: 1, label: 'T1', hash: null }] }));
    const cut = plan.phases.find((p) => p.kind === 'cut')!;
    expect(cut.seconds).toBeNull();
    expect(plan.totalIsLowerBound).toBe(true);
    expect(plan.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['plan-cut-unestimated', 'plan-air-run-unhashed']));
  });

  it('counts registration touches from the #430 plan, as an upper bound; with none, the shop’s estimate', () => {
    const S = registrationSettings(DEFAULTS).settings;
    const reg = planRegistration(
      {
        stock: { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 },
        mount: 'vise',
        expectedSurface: { machineZ: -56.172, from: 'test' },
        seekFromMachineZ: -3,
        fixtureBelowSurfaceMm: 0.72,
      },
      S,
    );
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const touches = registrationTouches(reg);
    expect(touches).toBeGreaterThan(1);
    const plan = planRun(input({ setups: [{ index: 1, mountStep: false, faced: false, registration: reg }] }));
    const phase = plan.phases.find((p) => p.kind === 'registration')!;
    expect(phase.seconds).toBe(touches * 15);
    expect(phase.source).toBe('estimated');
    expect(phase.parts[0]!.label).toContain('at most');
    expect(plan.findings.map((f) => f.code)).not.toContain('plan-registration-unplanned');

    const none = planRun(input());
    expect(none.phases.find((p) => p.kind === 'registration')!.parts[0]).toMatchObject({ seconds: 120, from: 'setups.reregisterMinutes' });
    expect(none.findings.map((f) => f.code)).toContain('plan-registration-unplanned');
    const refused = planRun(input({ setups: [{ ...ONE_SETUP[0]!, registration: { ok: false, reason: 'no origin' } }] }));
    expect(refused.findings.find((f) => f.code === 'plan-registration-unplanned')!.text).toContain('no origin');
  });

  it('two setups from #428: a remount, probe in again (homing after the cut), one program each', () => {
    const top: Removal = { id: 'pocket', name: 'pocket', volume: 1000, box: { min: [10, 10, 6], max: [40, 40, 10] }, opensTo: ['top'] };
    const bottom: Removal = { id: 'chamfer', name: 'chamfer', volume: 100, box: { min: [10, 10, 0], max: [40, 40, 2] }, opensTo: ['bottom'] };
    const sp = planSetups({ stock: { x: 60, y: 60, z: 10 }, removals: [top, bottom], mount: { kind: 'vise', viseOpeningMm: 120 } }, setupsSettings(DEFAULTS));
    expect(sp.setups).toHaveLength(2);
    const setups = planSetupsFrom(sp.setups);
    expect(setups.map((s) => s.mountStep)).toEqual([false, true]);
    const plan = planRun(
      input({
        setups,
        programs: [
          { id: 'a', setupIndex: 1, label: 'T1', hash: 'h1', ir: ir() },
          { id: 'b', setupIndex: 2, label: 'T2', hash: 'h2', estimatedSeconds: 90 },
        ],
      }),
    );
    expect(plan.phases.map((p) => p.id)).toEqual([
      'home',
      's1.probe-in',
      's1.registration',
      's1.p1.bit-change',
      's1.p1.air-run',
      's1.p1.cut',
      's2.remount',
      's2.probe-in',
      's2.registration',
      's2.p1.bit-change',
      's2.p1.air-run',
      's2.p1.cut',
      'finish',
    ]);
    expect(plan.phases.find((p) => p.id === 's2.remount')!.title).toBe('Remount for setup 2');
    const remount = plan.phases.find((p) => p.id === 's2.remount')!;
    expect(remount).toMatchObject({ seconds: 180, who: 'you', needsDone: true, source: 'chosen' });
    expect(plan.phases.find((p) => p.id === 's2.probe-in')!.parts[0]!.label).toContain('$H');
    expect(plan.phases.find((p) => p.id === 's2.p1.cut')!.parts[0]!).toMatchObject({ seconds: 90, from: 'the CAM cycle estimate' });
  });

  it('a first setup that is not top-up opens with "Mount the stock", a directed step', () => {
    const plan = planRun(input({ setups: [{ index: 1, mountStep: true, faced: false, registration: null }] }));
    expect(plan.phases.map((p) => p.id).slice(0, 3)).toEqual(['home', 's1.remount', 's1.probe-in']);
    const mount = plan.phases[1]!;
    expect(mount).toMatchObject({ title: 'Mount the stock (setup 1)', who: 'you', needsDone: true, seconds: 180 });
    // The head has not moved since the job's home: the probe goes in with no second $H.
    expect(plan.phases[2]!.parts.map((q) => q.label)).toEqual(['fit the probe', 'M491 on the probe']);
  });

  it('a phase is labelled by the part carrying most of its time', () => {
    const plan = planRun(input({ programs: [{ id: 't1', setupIndex: 1, label: 'T1', hash: 'x', estimatedSeconds: 600 }] }));
    const cut = plan.phases.find((p) => p.kind === 'cut')!;
    expect(cut.parts.map((q) => q.source)).toEqual(['estimated', 'chosen']);
    expect(cut.source).toBe('estimated');
  });

  it('shows the last run’s wall clock beside the estimate, never in place of it (#277)', () => {
    const clocks = cutClockFrom('s1.p1.cut', { kind: 'finished', last: { elapsedS: 52 } });
    expect(clocks).toEqual({ 's1.p1.cut': 52 });
    expect(cutClockFrom('s1.p1.cut', { kind: 'aborted', last: { elapsedS: 20 } })).toEqual({});
    const plan = planRun(input({ lastRun: { at: '2026-10-15T17:00:00Z', seconds: clocks } }));
    const cut = plan.phases.find((p) => p.kind === 'cut')!;
    expect(cut.lastRun).toEqual({ seconds: 52, at: '2026-10-15T17:00:00Z' });
    expect(cut.seconds).not.toBe(52);
    expect(plan.phases.find((p) => p.kind === 'home')!.lastRun).toBeNull();
  });
});

describe('#421 the machine strip', () => {
  const base: FeatureInput = {
    programs: [{ label: 'T1', hash: 'aaaa1111' }],
    finishedHashes: [],
    stock: { flatness: 'domed' },
    mount: 'vise',
    faced: false,
    shallowestCutMm: 0.2,
    autoLevelShallowMm: { value: 0.5, source: 'chosen', key: 'plan.autoLevelShallowMm' },
  };
  const get = (over: Partial<FeatureInput>, k: string) => machineFeatures({ ...base, ...over }).find((f) => f.feature === k)!;

  it('vacuum: on for every cut, the maintainer’s default — LOCKED until #419 wires it to the run', () => {
    const v = get({}, 'vacuum');
    expect(v).toMatchObject({ shown: true, available: false, defaultOn: true, on: true, overridden: false });
    expect(v.reason).toContain('every cut');
    expect(v.note).toContain('job flow');
    // An override cannot turn it off: the runner sends M331 regardless, so the plan must not claim otherwise.
    expect(get({ overrides: { vacuum: false } }, 'vacuum')).toMatchObject({ on: true, overridden: false });
    const plan = planRun(input({ overrides: { vacuum: false } }));
    expect(plan.phases.find((p) => p.kind === 'cut')!.title).toContain('M331');
  });

  it('air run (Q14): on for a program this machine has not finished, off for an identical repeat', () => {
    expect(get({}, 'air-run')).toMatchObject({ defaultOn: true, on: true });
    const repeat = get({ finishedHashes: ['aaaa1111'] }, 'air-run');
    expect(repeat).toMatchObject({ defaultOn: false, on: false });
    expect(repeat.reason).toContain('unchanged');
    expect(get({ finishedHashes: ['aaaa1111'], overrides: { airRun: true } }, 'air-run')).toMatchObject({ on: true, overridden: true });
    // Per program in the plan: only the new one gets an air run, unless switched for the whole job.
    const two: RunPlanInput['programs'] = [
      { id: 'a', setupIndex: 1, label: 'T1', hash: 'old', estimatedSeconds: 10 },
      { id: 'b', setupIndex: 1, label: 'T2', hash: 'new', estimatedSeconds: 10 },
    ];
    expect(planRun(input({ programs: two, finishedHashes: ['old'] })).airRunFor).toEqual([false, true]);
    expect(planRun(input({ programs: two, finishedHashes: ['old'], overrides: { airRun: true } })).airRunFor).toEqual([true, true]);
    // Switched on for the whole job: the repeat gets one too, and the strip says it is not the default.
    const both = planRun(input({ programs: two, finishedHashes: ['old'], overrides: { airRun: true } }));
    expect(both.features.find((f) => f.feature === 'air-run')!.overridden).toBe(true);
    expect(planRun(input({ programs: two, finishedHashes: ['old'] })).features.find((f) => f.feature === 'air-run')!.overridden).toBe(false);
    expect(planRun(input({ programs: two, finishedHashes: ['old'], overrides: { airRun: false } })).phases.some((p) => p.kind === 'air-run')).toBe(false);
  });

  it('auto-level (Q13): locked off until #501 proves it, saying what it will choose once proven', () => {
    expect(Z1_CAPABILITIES.autoLevel.proven).toBe(false);
    const a = get({ overrides: { autoLevel: true } }, 'auto-level');
    expect(a).toMatchObject({ shown: true, available: false, on: false, overridden: false });
    expect(a.reason).toContain('Off until auto-level is proven');
    expect(a.reason).toContain('would have it on');
    expect(planRun(input({ overrides: { autoLevel: true } })).phases.find((p) => p.kind === 'registration')!.parts).toHaveLength(1);
  });

  it('auto-level, once proven: by the stock’s flatness and the mount', () => {
    const s = base.autoLevelShallowMm;
    expect(autoLevelRule({ ...base, autoLevelShallowMm: s }).on).toBe(true);
    expect(autoLevelRule({ ...base, faced: true }).on).toBe(false);
    expect(autoLevelRule({ ...base, stock: { flatness: 'flat' } }).on).toBe(false);
    expect(autoLevelRule({ ...base, stock: { flatness: 'flat' }, mount: 'tape' }).on).toBe(true);
    expect(autoLevelRule({ ...base, shallowestCutMm: 1 }).on).toBe(false);
    expect(autoLevelRule({ ...base, stock: { flatness: 'unknown' }, shallowestCutMm: null }).on).toBe(true);
    const proven = { ...Z1_CAPABILITIES, autoLevel: { ...Z1_CAPABILITIES.autoLevel, proven: true } };
    expect(get({ capabilities: proven }, 'auto-level')).toMatchObject({ available: true, defaultOn: true, on: true });
    const plan = planRun(input({ capabilities: proven }));
    const reg = plan.phases.find((p) => p.kind === 'registration')!;
    expect(reg.parts[1]).toMatchObject({ label: expect.stringContaining('9 points'), seconds: 90 });
    expect(plan.phases.at(-1)!.title).toContain('M370');
  });

  it('light (Q18): an unproven capability is modelled but not shown; proven, it is on during a run', () => {
    const l = get({ overrides: { light: true } }, 'light');
    expect(l).toMatchObject({ shown: false, available: false, on: false });
    expect(l.reason).toContain('bench check');
    const proven = { ...Z1_CAPABILITIES, light: { ...Z1_CAPABILITIES.light, proven: true } };
    expect(get({ capabilities: proven }, 'light')).toMatchObject({ shown: true, available: true, defaultOn: true });
  });
});
