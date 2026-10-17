// @vitest-environment jsdom
// #451 — the simulation's STARTING values move into the location database: the playback multiplier a
// session starts at, the blank a form starts with when a file states none, and the wall-clock budget
// a load starts with. The maintainer's rule (2026-10-16) is that a number somebody chose for this
// bench lives in `location.json`'s `defaults` section, and code keeps only a LABELLED fallback for
// the no-service build.
//
// Pinned here: the registry's rules and fallbacks, the location fixture's seeds (`house.rs`
// round-trips that document), and the three readers — `simStore` (speed and budget), `simSetupStore`
// (stock) and `simClient`'s no-opts budget.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_DEFAULTS, ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import { resetShopDefaultsStore, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { DEFAULT_SIM_BUDGET_MS, SIM_SPEEDS, setSimClientLoader, useSimStore, type SimClient } from '@/store/simStore';
import { DEFAULT_STOCK, useSimSetupStore } from '@/store/simSetupStore';
import { SIM_BUDGET_MS } from '@/engine/jobs/simClient';
import { useSettingsStore } from '@/store/settingsStore';
import { flatEndMill } from '@/engine/cnc/tool';
import { stubSetup } from '@/engine/cnc/setup';

const KEYS = [
  'sim.playbackSpeed',
  'sim.defaultStockLengthMm',
  'sim.defaultStockWidthMm',
  'sim.defaultStockThicknessMm',
  'sim.budgetMs',
] as const;

const HERE = dirname(fileURLToPath(import.meta.url));
const SEEDED: ShopDefaults = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);

/** A location that chose these numbers, parsed through the section's own schema. */
function choose(values: Record<string, number>): void {
  const section = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { value, source: 'chosen' as const, setAt: '2026-10-17T00:00:00.000Z', unit: null, note: null },
    ]),
  );
  useShopDefaultsStore.setState({ status: 'present', defaults: ShopDefaultsSchema.parse(section) });
}

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const setup = () => stubSetup(SLAB, { kind: 'tape-down', contact: SLAB.outline });

/** A client that records each load's budget and refuses at once: no worker, no wasm. */
function captureClient(): { client: SimClient; budgets: Array<number | undefined> } {
  const budgets: Array<number | undefined> = [];
  const client = {
    setSimSinks: () => {},
    loadSim: async (...a: Parameters<SimClient['loadSim']>) => {
      budgets.push(a[4]?.budgetMs);
      return { ok: false, pathOnly: false, diagnostics: [] };
    },
    requestFrame: () => {},
    simPath: async () => ({ xyz: new Float32Array(), step: new Uint32Array(), kind: new Uint8Array(), t: new Float32Array() }),
    disposeSim: async () => {},
  } as unknown as SimClient;
  return { client, budgets };
}

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
  resetShopDefaultsStore();
});

afterEach(() => {
  setSimClientLoader(null);
  resetShopDefaultsStore();
});

describe('the sim’s starting values as shop defaults (#451)', () => {
  it('every registry fallback is the compiled no-service value', () => {
    expect(KNOWN_DEFAULTS['sim.playbackSpeed']!.fallback).toBe(20);
    expect(SIM_SPEEDS).toContain(20);
    expect(KNOWN_DEFAULTS['sim.defaultStockLengthMm']!.fallback).toBe(DEFAULT_STOCK.length);
    expect(KNOWN_DEFAULTS['sim.defaultStockWidthMm']!.fallback).toBe(DEFAULT_STOCK.width);
    expect(KNOWN_DEFAULTS['sim.defaultStockThicknessMm']!.fallback).toBe(DEFAULT_STOCK.thickness);
    // ONE seed, two readers: the store and the client keep the same labelled fallback.
    expect(KNOWN_DEFAULTS['sim.budgetMs']!.fallback).toBe(DEFAULT_SIM_BUDGET_MS);
    expect(SIM_BUDGET_MS).toBe(DEFAULT_SIM_BUDGET_MS);
    for (const key of KEYS) expect(KNOWN_DEFAULTS[key]!.rule.safeParse(KNOWN_DEFAULTS[key]!.fallback).success, key).toBe(true);
  });

  it('the location fixture carries every seed, at the fallback, saying it is not measured', () => {
    for (const key of KEYS) {
      const d = SEEDED[key];
      expect(d, key).toBeDefined();
      expect(d!.source, key).toBe('seeded');
      expect(d!.value, key).toBe(KNOWN_DEFAULTS[key]!.fallback);
      expect(d!.note ?? '', key).toContain('not measured');
    }
  });

  it('the playback speed is one of the transport’s multipliers, and nothing else', () => {
    const rule = KNOWN_DEFAULTS['sim.playbackSpeed']!.rule;
    for (const n of SIM_SPEEDS) expect(rule.safeParse(n).success, String(n)).toBe(true);
    expect(rule.safeParse(2).success).toBe(false);
    expect(rule.safeParse(50).success).toBe(false);
    expect(rule.safeParse(0).success).toBe(false);
  });

  it('a fresh sim session takes the located speed and budget; a retry doubles only the budget', async () => {
    choose({ 'sim.playbackSpeed': 5, 'sim.budgetMs': 90_000 });
    const { client, budgets } = captureClient();
    setSimClientLoader(async () => client);

    await useSimStore.getState().loadProgram('G0 X0 Y0 Z1\n', setup(), flatEndMill(1), null);
    expect(budgets).toEqual([90_000]);
    expect(useSimStore.getState().speed).toBe(5);

    await useSimStore.getState().retryWithLongerBudget();
    expect(budgets).toEqual([90_000, 180_000]);

    // A session ends; the NEXT load is fresh again and reads the seed, not the doubled budget.
    await useSimStore.getState().dispose();
    expect(useSimStore.getState().budgetMs).toBe(90_000);
    expect(useSimStore.getState().speed).toBe(5);
    await useSimStore.getState().loadProgram('G0 X0 Y0 Z1\n', setup(), flatEndMill(1), null);
    expect(budgets).toEqual([90_000, 180_000, 90_000]);
  });

  it('a form with no file stock starts from the located blank, and reset returns to it', () => {
    choose({ 'sim.defaultStockLengthMm': 120, 'sim.defaultStockWidthMm': 80, 'sim.defaultStockThicknessMm': 6 });
    useSimSetupStore.getState().reset();
    expect(useSimSetupStore.getState().stock).toEqual({ length: 120, width: 80, thickness: 6 });
    expect(useSimSetupStore.getState().stockSource).toEqual({ length: 'default', width: 'default', thickness: 'default' });

    // A headerless file states no stock, so the located blank stands.
    useSimSetupStore.getState().openFile('plain.nc', 'G0 X0 Y0 Z1\n');
    expect(useSimSetupStore.getState().stock).toEqual({ length: 120, width: 80, thickness: 6 });
    expect(useSimSetupStore.getState().stockSource).toEqual({ length: 'default', width: 'default', thickness: 'default' });
  });
});
