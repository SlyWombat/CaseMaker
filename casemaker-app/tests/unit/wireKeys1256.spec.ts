/**
 * #1256 — THE SIX KEYS WITH NO READER NOW HAVE ONE. For each: a shop value that differs from the
 * recommendation changes what the reader returns, and no location (null) answers the old constant,
 * so nothing moves for a shop that has changed nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { bedTapeHold } from '@/components/welcome/holdingMounts';
import { traceStartFrom } from '@/components/panels/traceStart';
import { TRACE_DEFAULTS } from '@/engine/import/outlineImport';
import { TAPE_DEFAULTS, tapeDefaultsFor } from '@/engine/cnc/engrave/jobSetup';
import { catalogueRefusal, shopRefuseFraction } from '@/engine/cnc/feeds';
import { CLAMP_REFUSE_FRACTION_FALLBACK, Z1 } from '@/engine/cnc/machine';
import { GOAL_MAX_CELLS } from '@/engine/cnc/goalLimits';
import { KNOWN_DEFAULTS, installShopDefaults, readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import type { BedProfile } from '@/platform/locationClient';

const set = (key: string, value: number): ShopDefaults => ({ [key]: { value, source: 'chosen', setAt: null, unit: null, note: null } }) as ShopDefaults;

afterEach(() => installShopDefaults(() => null));

describe('#1256 import.trace* — the dialog starts from the shop', () => {
  it('no location → the tracer’s own defaults; a shop value → that value, invert untouched', () => {
    expect(traceStartFrom(null)).toEqual(TRACE_DEFAULTS);
    expect(traceStartFrom(set('import.traceThreshold', 90)).threshold).toBe(90);
    expect(traceStartFrom(set('import.traceDespecklePx', 20)).despeckle).toBe(20);
    expect(traceStartFrom(set('import.traceSimplifyPx', 3)).simplify).toBe(3);
    expect(traceStartFrom(set('import.traceThreshold', 90)).invert).toBe(TRACE_DEFAULTS.invert);
  });
});

describe('#1256 tape.stripWidthMm — the tape a bed job starts from', () => {
  it('the recommendation is the constant', () => {
    expect(readDefault(null, 'tape.stripWidthMm').value).toBe(TAPE_DEFAULTS.widthMm);
    expect(tapeDefaultsFor(null).widthMm).toBe(TAPE_DEFAULTS.widthMm);
  });
  it('a shop width reaches the hold a bed with no roll starts from; a profile’s own roll still wins', () => {
    expect(tapeDefaultsFor(set('tape.stripWidthMm', 30)).widthMm).toBe(30);
    expect(bedTapeHold(null, null, 2, 30).width).toBe(30);
    expect(bedTapeHold(null, null).width).toBe(TAPE_DEFAULTS.widthMm);
    const roll = { widthMm: 48, thicknessMm: 0.2, provenance: 'house roll' };
    const profile = { consumables: { tape: roll }, placements: [] } as unknown as BedProfile;
    expect(bedTapeHold(profile, null, 2, 30).width).toBe(48);
  });
});

describe('#1256 clamp.refuseFraction — one band for the panel, the pick and the generator', () => {
  it('the recommendation is the fallback constant', () => {
    expect(shopRefuseFraction()).toBe(CLAMP_REFUSE_FRACTION_FALLBACK);
  });
  it('a tighter shop band refuses a feed the default band only clamps', () => {
    const over = Z1.maxCutFeed * 1.2; // 20 % past the ceiling
    expect(catalogueRefusal('feed', over, Z1)).toBeNull();
    installShopDefaults(() => set('clamp.refuseFraction', 0.1));
    expect(shopRefuseFraction()).toBe(0.1);
    expect(catalogueRefusal('feed', over, Z1)).not.toBeNull();
  });
});

describe('#1256 goal.maxCells — the registry key and its fallback', () => {
  it('is registered, and its fallback equals the sampler constant', () => {
    expect(KNOWN_DEFAULTS['goal.maxCells']?.fallback).toBe(GOAL_MAX_CELLS);
    expect(readDefault(null, 'goal.maxCells').value).toBe(GOAL_MAX_CELLS);
    expect(readDefault(set('goal.maxCells', 1_000_000), 'goal.maxCells').value).toBe(1_000_000);
  });
});
