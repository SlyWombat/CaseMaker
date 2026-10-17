// #449 — the probe, scan, console, stop and power timing as shop defaults, and the bench tools reading
// the same values. Three things are pinned here, because each is a copy that could drift silently:
//
//   1. every compiled number that stayed behind as a labelled NO-SERVICE fallback (`PROBE_SPEC`, the
//      scan's, the console's, the stop's, `power.sh`'s) equals its key's `KNOWN_DEFAULTS` fallback —
//      and the location fixture's seed;
//   2. `tools/z1/benchDefaults.mjs` — the bench tools' restatement, plain Node, no zod — accepts and
//      refuses at exactly the bounds `KNOWN_DEFAULTS` does, with the same fallbacks;
//   3. what the values DO: a location's numbers reach the console, the stop and the power flows, and
//      the compiled 2000 ms floors still hold underneath whatever a location says.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_DEFAULTS, ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import { BENCH_DEFAULTS, accepts, readBenchDefaults, describeBenchDefaults } from '../../tools/z1/benchDefaults.mjs';
import { CONSOLE_TIMING, STATUS_POLL_TIMING, consoleTimingFrom, statusPollTimingFrom } from '@/platform/machineConsole';
import { STOP_ABORT_REPLY_MS, STOP_FALLBACK, STOP_IDLE_POLLS, STOP_IDLE_POLL_MS, STOP_POLL_FLOOR_MS, stopOnSession, stopSettings } from '@/platform/machineStop';
import { runSettings } from '@/platform/machineRun';
import { POWER_POLL_FLOOR_MS, powerSettings, probeSettled } from '@/store/powerStore';
import { PROBE_SPEC } from '@/engine/cnc/engrave/registration';
import { materialScanSettingsFrom, SCAN_FALLBACK } from '@/engine/cnc/engrave/materialScan';
import { MAX_IDLE_POLLS } from '@/engine/cnc/registration/execute';
import { registrationSettings, settingsProblem } from '@/engine/cnc/registration/settings';
import { runRegistration } from '@/engine/cnc/registration/execute';
import type { RegistrationPlan } from '@/engine/cnc/registration/plan';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };
const SEEDED: ShopDefaults = ShopDefaultsSchema.parse(DOC.defaults);

const NEW_KEYS = [
  'registration.surfaceSlowSeekMm',
  'registration.idlePollLimit',
  'registration.scanMissMarginMm',
  'registration.readingResolutionMm',
  'console.firstReplyMs',
  'console.quietMs',
  'console.maxMs',
  'run.statusReplyMs',
  'stop.idlePolls',
  'stop.idlePollMs',
  'stop.abortReplyMs',
  'power.probeTries',
  'power.probeGapSeconds',
  'power.cyclePauseSeconds',
  'power.pollSeconds',
];

const fallback = (key: string): number => KNOWN_DEFAULTS[key]!.fallback;

/** A location whose values are all `chosen` — what a person who changed them in Manage would hold. */
function chosen(values: Record<string, number>): ShopDefaults {
  const map: ShopDefaults = { ...SEEDED };
  for (const [k, value] of Object.entries(values)) {
    map[k] = { value, source: 'chosen', setAt: '2026-10-16T00:00:00.000Z', unit: null, note: null };
  }
  return ShopDefaultsSchema.parse(map);
}

describe('#449 the new keys are seeded, and each seed is its fallback', () => {
  it('every key is in the fixture, seeded with a "not measured" note, at the fallback', () => {
    for (const key of NEW_KEYS) {
      const d = SEEDED[key];
      expect(d, key).toBeDefined();
      expect(d!.source, key).toBe('seeded');
      expect(d!.value, key).toBe(fallback(key));
      expect(d!.note ?? '', key).toContain('not measured');
      expect(KNOWN_DEFAULTS[key]!.rule.safeParse(fallback(key)).success, key).toBe(true);
    }
  });

  it('the compiled fallbacks left in code are the same numbers', () => {
    expect(PROBE_SPEC.tipDiameter).toBe(fallback('registration.tipDiameterMm'));
    expect(SCAN_FALLBACK).toEqual({
      coarseStepMm: fallback('registration.coarseStepMm'),
      startGapMm: fallback('registration.parkAboveSurfaceMm'),
      missMarginMm: fallback('registration.scanMissMarginMm'),
      readingResolutionMm: fallback('registration.readingResolutionMm'),
      tipDiameterMm: fallback('registration.tipDiameterMm'),
      touchFeed: fallback('registration.touchFeed'),
    });
    expect(MAX_IDLE_POLLS).toBe(fallback('registration.idlePollLimit'));
    expect(CONSOLE_TIMING).toEqual(consoleTimingFrom(null));
    expect(STATUS_POLL_TIMING).toEqual(statusPollTimingFrom(null));
    expect(STOP_IDLE_POLLS).toBe(fallback('stop.idlePolls'));
    expect(STOP_IDLE_POLL_MS).toBe(fallback('stop.idlePollMs'));
    expect(stopSettings(null)).toEqual(STOP_FALLBACK);
    // The seeded location reads the same as no location at all: nothing moved by being seeded.
    expect(consoleTimingFrom(SEEDED)).toEqual(CONSOLE_TIMING);
    expect(stopSettings(SEEDED)).toEqual(STOP_FALLBACK);
    expect(powerSettings(SEEDED)).toEqual({ waitSeconds: 180, pollMs: 3000, probeTries: 3, probeGapMs: 2000, pauseMs: 10_000 });
  });

  it('#452: the run sheet’s scan steps by the planner’s own coarse step, from the same settings', () => {
    const reg = registrationSettings(SEEDED);
    expect(reg.fallbacks).toEqual([]);
    const scan = materialScanSettingsFrom(reg.settings);
    expect(scan.coarseStepMm).toBe(reg.settings.coarseStepMm);
    expect(scan.coarseStepMm).toBe(1);
    expect(scan).toEqual(SCAN_FALLBACK);
    const moved = materialScanSettingsFrom(registrationSettings(chosen({ 'registration.coarseStepMm': 0.75 })).settings);
    expect(moved.coarseStepMm).toBe(0.75);
  });
});

describe('#449 the bench tools’ restatement (tools/z1/benchDefaults.mjs)', () => {
  it('reads only keys the app knows, with the same fallback and units', () => {
    for (const [key, rule] of Object.entries(BENCH_DEFAULTS)) {
      const known = KNOWN_DEFAULTS[key];
      expect(known, key).toBeDefined();
      expect(rule.fallback, key).toBe(known!.fallback);
      expect(rule.unit, key).toBe(known!.unit);
    }
  });

  it('accepts and refuses at exactly the app’s bounds', () => {
    for (const [key, rule] of Object.entries(BENCH_DEFAULTS)) {
      const app = KNOWN_DEFAULTS[key]!.rule;
      const probes = [rule.min, rule.max, rule.min - 0.001, rule.max + 0.001, rule.min + 0.5, (rule.min + rule.max) / 2, -1, Number.NaN];
      for (const v of probes) {
        expect(accepts(key, v), `${key} ${v}`).toBe(app.safeParse(v).success);
      }
    }
  });

  it('power.sh’s own fallbacks are the same three numbers', () => {
    const sh = readFileSync(join(APP, 'tools', 'z1', 'power.sh'), 'utf8');
    const line = (name: string, key: string) => {
      const m = new RegExp(`^${name}=([0-9.]+)\\s+# ${key.replace('.', '\\.')}$`, 'm').exec(sh);
      expect(m, `${name} in power.sh`).not.toBeNull();
      return Number(m![1]);
    };
    expect(line('wait_s', 'power.onWaitSeconds')).toBe(fallback('power.onWaitSeconds'));
    expect(line('cycle_pause_s', 'power.cyclePauseSeconds')).toBe(fallback('power.cyclePauseSeconds'));
    expect(line('poll_s', 'power.pollSeconds')).toBe(fallback('power.pollSeconds'));
  });

  it('reads a location’s values with their source, refuses one out of bounds, and says when it fell back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'casemaker-449-'));
    const path = join(dir, 'location.json');
    writeFileSync(
      path,
      JSON.stringify({
        kind: 'location',
        defaults: {
          ...(DOC.defaults as object),
          'power.onWaitSeconds': { value: 240, source: 'chosen', setAt: '2026-10-16T00:00:00.000Z', unit: 's' },
          // Under the 2 s floor: never used, whatever the file says.
          'run.pollMs': { value: 600, source: 'chosen', setAt: '2026-10-16T00:00:00.000Z', unit: 'ms' },
          // A source the section does not know: refused for THAT reason, not called out of bounds.
          'run.missLimit': { value: 4, source: 'guessed', setAt: '2026-10-16T00:00:00.000Z', unit: 'polls' },
        },
      }),
    );
    const read = readBenchDefaults({ location: path });
    expect(read.path).toBe(path);
    expect(read.values['power.onWaitSeconds']).toEqual({ value: 240, source: 'chosen', unit: 's' });
    expect(read.values['stop.idlePolls']).toEqual({ value: 3, source: 'seeded', unit: 'polls' });
    expect(read.values['run.pollMs']!.value).toBe(2000);
    expect(read.values['run.pollMs']!.source).toBe('fallback');
    expect(read.values['run.pollMs']!.note).toContain('not used');
    expect(read.values['run.pollMs']!.note).toContain('is outside 2000 to 60000');
    expect(read.values['run.missLimit']).toMatchObject({ value: 3, source: 'fallback' });
    expect(read.values['run.missLimit']!.note).toContain('source "guessed"');
    expect(read.values['run.missLimit']!.note).not.toContain('outside');
    expect(describeBenchDefaults(read).find((l) => l.startsWith('power.onWaitSeconds'))).toBe(`power.onWaitSeconds = 240 s (chosen, from ${path})`);

    const none = readBenchDefaults({ location: 'none' });
    expect(none.path).toBeNull();
    for (const [key, v] of Object.entries(none.values)) {
      expect(v, key).toEqual({ value: BENCH_DEFAULTS[key]!.fallback, source: 'fallback', unit: BENCH_DEFAULTS[key]!.unit });
    }
    const missing = readBenchDefaults({ location: join(dir, 'absent.json') });
    expect(missing.path).toBeNull();
    expect(missing.note).toContain('does not exist');
    expect(() => readBenchDefaults({ location: 'none', keys: ['shop.notAKey'] })).toThrow();
  });
});

describe('#449 the values reach the code, and the floors still hold', () => {
  it('a location’s console window reaches a console; the ceiling never drops under the first reply', () => {
    const t = consoleTimingFrom(chosen({ 'console.firstReplyMs': 90_000, 'console.quietMs': 1000, 'console.maxMs': 60_000 }));
    expect(t).toEqual({ firstReplyMs: 90_000, quietMs: 1000, maxMs: 90_000 });
    expect(statusPollTimingFrom(chosen({ 'run.statusReplyMs': 4000 }))).toEqual({ firstReplyMs: 4000, quietMs: 800, maxMs: 6000 });
    // Below the bench's slowest timed line (M491 ~32 s): refused, so the fallback is used.
    expect(KNOWN_DEFAULTS['console.firstReplyMs']!.rule.safeParse(30_000).success).toBe(false);
  });

  it('the run carries the status window and the stop settings', () => {
    const r = runSettings(chosen({ 'run.statusReplyMs': 4000, 'stop.idlePolls': 5 }));
    expect(r.statusTiming!.firstReplyMs).toBe(4000);
    expect(r.stop!.idlePolls).toBe(5);
  });

  it('Stop polls by the location, never under the 2 s floor, and always sends abort', async () => {
    const sent: { line: string; first?: number }[] = [];
    const slept: number[] = [];
    let polls = 0;
    const session = {
      send: async (line: string, timing?: { firstReplyMs?: number }) => {
        sent.push({ line, first: timing?.firstReplyMs });
        if (line === '?') {
          polls += 1;
          return { kind: 'sent' as const, line, text: '<Run|MPos:0,0,0|P:5,40,10>', frames: 1, elapsedMs: 700 };
        }
        return { kind: 'sent' as const, line, text: 'ok', frames: 1, elapsedMs: 10 };
      },
    };
    // A hand-built setting under the floor (not one a location can hold): the floor still wins.
    const out = await stopOnSession(session, async (ms) => void slept.push(ms), {
      idlePolls: 4,
      idlePollMs: 500,
      abortReplyMs: 45_000,
      statusTiming: { firstReplyMs: 4000, quietMs: 800, maxMs: 6000 },
    });
    expect(out.kind).toBe('draining');
    expect(sent.filter((s) => s.line === 'abort')).toHaveLength(1);
    // `abort` is given the shop's window, not a console line's (#449).
    expect(sent.find((s) => s.line === 'abort')!.first).toBe(45_000);
    expect(polls).toBe(1 + 4);
    expect(sent.find((s) => s.line === '?')!.first).toBe(4000);
    expect(slept.every((ms) => ms >= STOP_POLL_FLOOR_MS)).toBe(true);
    expect(slept).toEqual([STOP_POLL_FLOOR_MS, 2000, 2000, 2000]);
  });

  it('the power probes and checks never poll faster than the 2 s floor', () => {
    for (const key of ['power.probeGapSeconds', 'power.pollSeconds']) {
      expect(KNOWN_DEFAULTS[key]!.rule.safeParse(1.9).success, key).toBe(false);
      expect(KNOWN_DEFAULTS[key]!.rule.safeParse(2).success, key).toBe(true);
    }
    // A map that skipped the schema (not one a location can hold): the floor still holds in code.
    const raw = { ...SEEDED, 'power.probeGapSeconds': { ...SEEDED['power.probeGapSeconds']!, value: 0.5 } };
    expect(powerSettings(raw).probeGapMs).toBeGreaterThanOrEqual(POWER_POLL_FLOOR_MS);
    expect(powerSettings(chosen({ 'power.probeGapSeconds': 4, 'power.pollSeconds': 5 }))).toMatchObject({ probeGapMs: 4000, pollMs: 5000 });
    // The harness does not read the app's between-polls wait after a Stop: its own idle polls are paced
    // by `run.pollMs`, and its compiled number there is a reply window (#449).
    expect(BENCH_DEFAULTS['stop.idlePollMs']).toBeUndefined();
  });

  it('a silent machine is never decided on fewer than one probe', async () => {
    let probes = 0;
    const deps = { probe: async () => ((probes += 1), { answered: false, status: null }), sleep: async () => {} };
    expect(await probeSettled(deps, { tries: 0 })).toBeNull();
    expect(probes).toBe(3);
    probes = 0;
    await probeSettled(deps, { tries: powerSettings(chosen({ 'power.probeTries': 5 })).probeTries });
    expect(probes).toBe(5);
  });

  it('the registration refuses a slow surface touch that cannot reach the surface, before anything is sent', async () => {
    const s = registrationSettings(SEEDED).settings;
    expect(settingsProblem(s)).toBeNull();
    expect(settingsProblem({ ...s, surfaceSlowSeekMm: 1 })).toContain('more than the 1 mm lift');
    expect(settingsProblem({ ...s, surfaceSlowSeekMm: 2.5 })).toContain('more than 1 mm past');
    // At most 1 mm past the fast hit: the key stops at 2 (review: 3 let it go 2 mm past).
    expect(KNOWN_DEFAULTS['registration.surfaceSlowSeekMm']!.rule.safeParse(2).success).toBe(true);
    expect(KNOWN_DEFAULTS['registration.surfaceSlowSeekMm']!.rule.safeParse(2.01).success).toBe(false);
    expect(settingsProblem({ ...s, idlePollLimit: 0 })).toContain('whole number');
    // And the executor itself: nothing reaches the console. The refusal is decided before any other
    // field of the plan is read, so a plan carrying only the settings is enough to prove it.
    const sent: string[] = [];
    const r = await runRegistration({ settings: { ...s, surfaceSlowSeekMm: 1 } } as unknown as RegistrationPlan, {
      console: { send: async (line: string) => (sent.push(line), { kind: 'sent' as const, line, text: 'ok', frames: 1, elapsedMs: 1 }) },
      operator: async () => true,
    });
    expect(r).toMatchObject({ ok: false, transcript: [] });
    expect(sent).toEqual([]);
  });

  it('Stop’s first `?` and the abort keep windows above what the bench needed (#449 review)', async () => {
    // A status reply window under 3 s is refused: Stop's first `?` timing out returns before `abort`.
    expect(KNOWN_DEFAULTS['run.statusReplyMs']!.rule.safeParse(2999).success).toBe(false);
    expect(KNOWN_DEFAULTS['run.statusReplyMs']!.rule.safeParse(3000).success).toBe(true);
    // The abort's reply window stays above the ~18 s drain observed (#303).
    expect(KNOWN_DEFAULTS['stop.abortReplyMs']!.rule.safeParse(19_999).success).toBe(false);
    expect(KNOWN_DEFAULTS['stop.abortReplyMs']!.rule.safeParse(20_000).success).toBe(true);
    // A hand-built shorter window still gets the compiled one on Stop's polls.
    const windows: number[] = [];
    const session = {
      send: async (line: string, timing?: { firstReplyMs?: number }) => {
        if (line === '?') windows.push(timing?.firstReplyMs ?? -1);
        return { kind: 'sent' as const, line, text: '<Idle|MPos:0,0,0>', frames: 1, elapsedMs: 700 };
      },
    };
    await stopOnSession(session, async () => {}, { ...STOP_FALLBACK, statusTiming: { firstReplyMs: 500, quietMs: 800, maxMs: 900 } });
    expect(windows).toEqual([STATUS_POLL_TIMING.firstReplyMs]);
  });

  it('Stop gives `abort` the shop’s `stop.abortReplyMs` window (#449)', async () => {
    const windows: { line: string; first?: number }[] = [];
    const session = {
      send: async (line: string, timing?: { firstReplyMs?: number }) => {
        windows.push({ line, first: timing?.firstReplyMs });
        return { kind: 'sent' as const, line, text: '<Run|MPos:0,0,0|P:5,40,10>', frames: 1, elapsedMs: 700 };
      },
    };
    // A location that moved the key: `abort` gets its number, not the console's 60 s.
    await stopOnSession(session, async () => {}, stopSettings(chosen({ 'stop.abortReplyMs': 25_000 })));
    expect(windows.find((w) => w.line === 'abort')!.first).toBe(25_000);
    // Seeded (or no location): the compiled 60 s, the window the app always used.
    windows.length = 0;
    await stopOnSession(session, async () => {}, stopSettings(SEEDED));
    expect(windows.find((w) => w.line === 'abort')!.first).toBe(STOP_ABORT_REPLY_MS);
    expect(STOP_ABORT_REPLY_MS).toBe(fallback('stop.abortReplyMs'));
  });

  it('the Rust and the zod bounds of every #449 key are the same numbers', () => {
    // `defaults.rs`'s `known_rule` arms inside the #449 block, read as text: the inclusive range, and
    // whether it is held to whole numbers. Each is checked against the zod rule AT its edges.
    const rs = readFileSync(join(APP, 'src-tauri', 'src', 'defaults.rs'), 'utf8');
    const start = rs.indexOf('// ── #449 (begin) — the probe, scan, console, stop and power timing (`defaultsClient.ts` states');
    const block = rs.slice(start, rs.indexOf('// ── #449 (end)', start));
    const arms = [...block.matchAll(/"([a-zA-Z.]+)" => Some\(need\(\s*n\.is_some_and\(\|v\| \(([\d.]+)\.\.=([\d.]+)\)\.contains\(&v\)( && v\.fract\(\) == 0\.0)?/g)];
    expect(arms.map((m) => m[1]).sort()).toEqual([...NEW_KEYS].sort());
    for (const [, key, lo, hi, whole] of arms) {
      const rule = KNOWN_DEFAULTS[key!]!.rule;
      const [min, max] = [Number(lo), Number(hi)];
      const eps = Math.max(1e-6, (max - min) * 1e-6);
      expect(rule.safeParse(min).success, `${key} min`).toBe(true);
      expect(rule.safeParse(max).success, `${key} max`).toBe(true);
      expect(rule.safeParse(min - eps).success, `${key} below`).toBe(false);
      expect(rule.safeParse(max + eps).success, `${key} above`).toBe(false);
      // Whole-number keys refuse a fraction inside the range; the others take one.
      const inside = whole === undefined ? (min + max) / 2 : Math.floor(min) + 0.5;
      expect(rule.safeParse(inside).success, `${key} fraction`).toBe(whole === undefined);
    }
  });
});
