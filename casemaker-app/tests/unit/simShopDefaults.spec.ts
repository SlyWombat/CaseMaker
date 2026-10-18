// @vitest-environment jsdom
// #451 — the simulation's remaining chosen numbers move into the location database: the exact
// sweeper's spindle-off proximity margin (`sweep.ts`'s `PROXIMITY_MARGIN_MM`), and the column
// engine's X and rotary θ pitches (`columnEngine.ts`'s `COLUMN_SIM_RESOLUTION`). The maintainer's
// rule (2026-10-16) is that a number somebody chose for this bench lives in `location.json`'s
// `defaults` section, and the code keeps only a LABELLED fallback for the no-service build.
//
// So this spec pins the three halves that could drift apart:
//   1. the registry (`KNOWN_DEFAULTS`), its rules and its fallbacks — the no-service numbers;
//   2. the location fixture's seeds, which `house.rs` round-trips as a whole document;
//   3. the use sites: simStore reads the location and sends the numbers to the worker, and the
//      column engine builds its grid from them (and from the labelled fallbacks when it has none).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_DEFAULTS, ShopDefaultsSchema, readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import { resetShopDefaultsStore, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { setSimClientLoader, useSimStore, type SimClient } from '@/store/simStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  COLUMN_FLAT_PITCH_Y_FALLBACK_MM,
  COLUMN_PITCH_X_FALLBACK_MM,
  COLUMN_ROTARY_PITCH_FALLBACK_DEG,
  COLUMN_SIM_RESOLUTION,
  columnSweep,
  type CutMove,
} from '@/workers/geometry/columnEngine';
import { SPINDLE_OFF_PROXIMITY_FALLBACK_MM } from '@/workers/geometry/sweep';
import { flatEndMill } from '@/engine/cnc/tool';
import { stubSetup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';
import type { Timeline } from '@/engine/cnc/emulator/timeline';

const KEYS = ['sim.spindleOffProximityMm', 'sim.columnPitchXMm', 'sim.rotaryPitchDeg'] as const;

const HERE = dirname(fileURLToPath(import.meta.url));

/** The location fixture's `defaults`, through the section's own schema. */
const SEEDED: ShopDefaults = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);

/** A location that chose these numbers, parsed through the section's own schema. */
function chosen(values: Record<string, number>): void {
  const section = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { value, source: 'chosen', setAt: '2026-10-17', unit: null, note: null }]),
  );
  useShopDefaultsStore.setState({ status: 'present', defaults: ShopDefaultsSchema.parse(section) });
}

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
  resetShopDefaultsStore();
});

afterEach(() => {
  setSimClientLoader(null);
  resetShopDefaultsStore();
});

/** A client that records the load options and refuses at once: no worker, no wasm. */
function captureClient(): { client: SimClient; seen: Array<Parameters<SimClient['loadSim']>[4]> } {
  const seen: Array<Parameters<SimClient['loadSim']>[4]> = [];
  const client = {
    setSimSinks: () => {},
    loadSim: async (...a: Parameters<SimClient['loadSim']>) => {
      seen.push(a[4]);
      return { ok: false, pathOnly: false, diagnostics: [] };
    },
    requestFrame: () => {},
    simPath: async () => ({ xyz: new Float32Array(), step: new Uint32Array(), kind: new Uint8Array(), t: new Float32Array() }),
    disposeSim: async () => {},
  } as unknown as SimClient;
  return { client, seen };
}

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const setup = () => stubSetup(SLAB, { kind: 'tape-down', contact: SLAB.outline });
const load = () => useSimStore.getState().loadProgram('G0 X0 Y0 Z1\n', setup(), flatEndMill(1), null);

describe('the sim’s shop defaults (#451)', () => {
  it('every key is registered with the compiled number as its labelled fallback', () => {
    expect(KNOWN_DEFAULTS['sim.spindleOffProximityMm']!.fallback).toBe(SPINDLE_OFF_PROXIMITY_FALLBACK_MM);
    expect(KNOWN_DEFAULTS['sim.columnPitchXMm']!.fallback).toBe(COLUMN_PITCH_X_FALLBACK_MM);
    expect(KNOWN_DEFAULTS['sim.rotaryPitchDeg']!.fallback).toBe(COLUMN_ROTARY_PITCH_FALLBACK_DEG);
    expect(COLUMN_SIM_RESOLUTION).toEqual({ dx: COLUMN_PITCH_X_FALLBACK_MM, dThetaDeg: COLUMN_ROTARY_PITCH_FALLBACK_DEG });
    for (const key of KEYS) {
      const known = KNOWN_DEFAULTS[key]!;
      expect(known.rule.safeParse(known.fallback).success, key).toBe(true);
      expect(readDefault(null, key), key).toEqual({ value: known.fallback, source: 'fallback' });
    }
  });

  it('the location fixture carries every seed, at the fallback and saying it is not measured', () => {
    for (const key of KEYS) {
      const d = SEEDED[key];
      expect(d, key).toBeDefined();
      expect(d!.source, key).toBe('seeded');
      expect(d!.value, key).toBe(KNOWN_DEFAULTS[key]!.fallback);
      expect(d!.note ?? '', key).toContain('not measured');
    }
  });

  it('each rule refuses a value a grid or a sweep could not use', () => {
    expect(KNOWN_DEFAULTS['sim.spindleOffProximityMm']!.rule.safeParse(0).success).toBe(false);
    expect(KNOWN_DEFAULTS['sim.spindleOffProximityMm']!.rule.safeParse(6).success).toBe(false);
    expect(KNOWN_DEFAULTS['sim.columnPitchXMm']!.rule.safeParse(0.01).success).toBe(false);
    expect(KNOWN_DEFAULTS['sim.columnPitchXMm']!.rule.safeParse(1).success).toBe(false);
    expect(KNOWN_DEFAULTS['sim.rotaryPitchDeg']!.rule.safeParse(0.01).success).toBe(false);
    expect(KNOWN_DEFAULTS['sim.rotaryPitchDeg']!.rule.safeParse(6).success).toBe(false);
  });

  it('simStore sends the location’s numbers to the worker, once per load', async () => {
    chosen({ 'sim.spindleOffProximityMm': 0.4, 'sim.columnPitchXMm': 0.2, 'sim.rotaryPitchDeg': 0.5 });
    const { client, seen } = captureClient();
    setSimClientLoader(async () => client);
    await load();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ spindleOffProximityMm: 0.4, columnPitchXMm: 0.2, rotaryPitchDeg: 0.5 });
  });

  it('with no location the worker is sent the labelled fallbacks, not a number that reads as the shop’s own', async () => {
    const { client, seen } = captureClient();
    setSimClientLoader(async () => client);
    await load();
    expect(seen[0]).toMatchObject({
      spindleOffProximityMm: SPINDLE_OFF_PROXIMITY_FALLBACK_MM,
      columnPitchXMm: COLUMN_PITCH_X_FALLBACK_MM,
      rotaryPitchDeg: COLUMN_ROTARY_PITCH_FALLBACK_DEG,
    });
  });

  // #434 — a drill program hands over the point angle its PLAN used, so the sweep states the same
  // point the CAM planned rather than re-reading a setting that may have changed since.
  it('a caller’s drill point override reaches the worker and beats the shop’s own reading', async () => {
    chosen({ 'drill.pointAngleDeg': 135 });
    const { client, seen } = captureClient();
    setSimClientLoader(async () => client);
    const override = { deg: 118, source: 'the drill program’s plan' };
    await useSimStore.getState().loadProgram('G0 X0 Y0 Z1\n', setup(), flatEndMill(1), null, null, [], override);
    expect(seen[0]).toMatchObject({ drillPointDefault: override });
  });

  it('without an override the drill point is the location’s reading (#434)', async () => {
    chosen({ 'drill.pointAngleDeg': 135 });
    const { client, seen } = captureClient();
    setSimClientLoader(async () => client);
    await load();
    expect(seen[0]).toMatchObject({ drillPointDefault: { deg: 135, source: 'chosen' } });
  });
});

/** A minimal Timeline good enough for `columnSweep` (it reads checkpoints, events, stateAt, airMoves). */
function fakeTimeline(moves: CutMove[], rotary = true, y = 0): Timeline {
  const cp = {
    segment: 0,
    tool: 1,
    zKey: Math.round((moves[0]?.z ?? 0) * 1000),
    z: moves[0]?.z ?? 0,
    run: 0,
    zs: moves.flatMap((m) => [m.z, m.z]),
    steps: moves.map((m) => m.step),
    xy: moves.flatMap((m) => [m.u0, y, m.u1, y]),
    nonConstantZ: false,
  };
  const events: unknown[] = [];
  for (const m of moves) events[m.step] = { kind: 'move', mode: 'cut', line: m.line };
  return {
    events: events as unknown as Timeline['events'],
    airMoves: [],
    segments: [],
    pauses: [],
    checkpoints: [cp],
    diagnostics: [],
    stateAt: (i: number) => ({ a: moves[Math.min(i, moves.length - 1)]?.v1 ?? 0 }) as ReturnType<Timeline['stateAt']>,
    summary: { steps: moves.length, segments: 1, pauses: 0, checkpoints: 1, cuttingMoves: moves.length, unsweptMoves: 0, airMoves: 0, laser: false, rotary, diagnosticCounts: {} },
  };
}

const move = (partial: Partial<CutMove>): CutMove => ({ step: 0, line: 1, u0: 0, u1: 0, v0: 0, v1: 0, z: 5, ...partial });
const cyl = () => stubSetup({ kind: 'cylinder', diameter: 20, length: 30 }, { kind: 'rotary-chuck', jawDiameter: 25, stickout: 30 });
const prism = () => stubSetup({ kind: 'prism', outline: rectProfile(40, 40), thickness: 5 }, { kind: 'tape-down', contact: rectProfile(40, 40) });

describe('the column engine’s pitches (#451)', () => {
  it('a rotary job builds its grid at the caller’s X and θ pitches', () => {
    const tl = fakeTimeline([move({ u0: 0, u1: 0, v0: 0, v1: 360, z: 5 })]);
    const out = columnSweep(tl, flatEndMill(3.175), cyl(), { columnPitchXMm: 0.2, rotaryPitchDeg: 0.5 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The grid snaps each pitch to a whole number of cells over the stock's extent, so the
    // reported pitch is the asked one to within that rounding. `resolution` is optional on the
    // shared stats type (only a column job carries one), hence the explicit guard.
    const res = out.stats.resolution;
    expect(res).toBeDefined();
    expect(res!.dx).toBeCloseTo(0.2, 3);
    expect(res!.dThetaDeg).toBeCloseTo(0.5, 6);
  });

  it('a flat job takes the X pitch and its own Y pitch, never the rotary one', () => {
    const tl = fakeTimeline([move({ u0: 5, u1: 30, v0: 20, v1: 20, z: -1 })], false, 20);
    const out = columnSweep(tl, flatEndMill(3.175), prism(), { columnPitchXMm: 0.2, rotaryPitchDeg: 0.5, flatPitchYMm: 0.4 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const res = out.stats.resolution;
    expect(res).toBeDefined();
    expect(res!.dx).toBeCloseTo(0.2, 3);
    expect(res!.dThetaDeg).toBeCloseTo(0.4, 3);
  });

  it('a missing or unusable pitch falls back to the labelled constant rather than building no grid', () => {
    const rot = fakeTimeline([move({ u0: 0, u1: 0, v0: 0, v1: 360, z: 5 })]);
    const rotary = columnSweep(rot, flatEndMill(3.175), cyl());
    expect(rotary.ok).toBe(true);
    if (!rotary.ok) return;
    const res = rotary.stats.resolution;
    expect(res).toBeDefined();
    expect(res!.dx).toBeCloseTo(COLUMN_PITCH_X_FALLBACK_MM, 3);
    expect(res!.dThetaDeg).toBeCloseTo(COLUMN_ROTARY_PITCH_FALLBACK_DEG, 6);

    const flat = fakeTimeline([move({ u0: 5, u1: 30, v0: 20, v1: 20, z: -1 })], false, 20);
    const bad = columnSweep(flat, flatEndMill(3.175), prism(), { columnPitchXMm: 0, rotaryPitchDeg: -1, flatPitchYMm: Number.NaN });
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    const badRes = bad.stats.resolution;
    expect(badRes).toBeDefined();
    expect(badRes!.dx).toBeCloseTo(COLUMN_PITCH_X_FALLBACK_MM, 3);
    expect(badRes!.dThetaDeg).toBeCloseTo(COLUMN_FLAT_PITCH_Y_FALLBACK_MM, 3);
  });
});
