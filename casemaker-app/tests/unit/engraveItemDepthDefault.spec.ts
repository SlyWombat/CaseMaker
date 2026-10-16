// @vitest-environment jsdom
// #451 — where a newly added item starts. The two numbers were compiled into `engraveJobStore`
// (`depth: 0.5` at four sites, `depth: 1.0` on a hole, and one more in the panel's outline import),
// which is exactly what the maintainer's 2026-10-16 rule moves out of the code: a starting value is
// a value somebody chose for this bench, so it belongs in the location's shop `defaults` beside the
// other chosen numbers, and what is left in the code is a FALLBACK that says it is one.
//
// So this spec pins both halves: with a location that holds the keys the item follows it, and with
// no location at all — the hosted web build — the item still starts somewhere, at the labelled
// fallback rather than at a number that reads as the shop's own.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import {
  NEW_DRILL_DEPTH_KEY,
  NEW_ITEM_DEPTH_KEY,
  newDrillDepthMm,
  newItemDepthMm,
  useEngraveJobStore,
} from '@/store/engraveJobStore';
import { resetShopDefaultsStore, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { KNOWN_DEFAULTS, ShopDefaultsSchema, readDefault } from '@/platform/defaultsClient';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useSettingsStore } from '@/store/settingsStore';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';

/**
 * A location that chose these numbers, parsed through the section's own schema. Takes the whole set
 * at once: the section is one map, so a second call would replace the first key rather than add to it.
 */
function store(entries: Record<string, number>): void {
  const section = Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      key,
      { value, source: 'chosen', setAt: '2026-10-16', unit: 'mm', note: null },
    ]),
  );
  useShopDefaultsStore.setState({ status: 'present', defaults: ShopDefaultsSchema.parse(section) });
}

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
  resetShopDefaultsStore();
  act(() => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });
  useEngravePreviewStore.getState().dispose();
});

afterEach(() => {
  cleanup();
  resetShopDefaultsStore();
  useEngravePreviewStore.getState().dispose();
});

/** The item the store just appended to `list`, by its last id. */
function lastDepth(list: readonly { depth: number }[]): number {
  return list[list.length - 1]!.depth;
}

describe('a new item’s starting depth (#451)', () => {
  it('starts at the location’s own number when the location holds one', () => {
    store({ [NEW_ITEM_DEPTH_KEY]: 3, [NEW_DRILL_DEPTH_KEY]: 2 });

    const s = useEngraveJobStore.getState();
    const labelId = s.addLabel();
    expect(lastDepth(useEngraveJobStore.getState().job.labels)).toBe(3);
    expect(useEngraveJobStore.getState().job.labels.at(-1)!.id).toBe(labelId);

    // Every kind of item, not just the label: one number, read by all of them, or a shape added
    // beside a label would begin at a depth the shop had nothing to do with.
    useEngraveJobStore.getState().addShape('rect');
    expect(lastDepth(useEngraveJobStore.getState().job.shapes)).toBe(3);
    useEngraveJobStore.getState().addCombined('border');
    expect(lastDepth(useEngraveJobStore.getState().job.combined ?? [])).toBe(3);
    useEngraveJobStore.getState().addTrace('line');
    expect(lastDepth(useEngraveJobStore.getState().job.traces ?? [])).toBe(3);

    // …and a hole has its own key: a hole that begins as shallow as a label shows nothing.
    useEngraveJobStore.getState().addDrill('drill');
    expect(lastDepth(useEngraveJobStore.getState().job.drills ?? [])).toBe(2);
  });

  it('starts at the labelled fallback when there is no location to read', () => {
    // `resetShopDefaultsStore` leaves `defaults: null`, which is what the hosted web build has.
    const reader = newItemDepthMm();
    expect(reader).toBe(0.5);
    expect(newDrillDepthMm()).toBe(1.0);

    act(() => {
      useEngraveJobStore.getState().addLabel();
      useEngraveJobStore.getState().addDrill('drill');
    });
    expect(lastDepth(useEngraveJobStore.getState().job.labels)).toBe(0.5);
    expect(lastDepth(useEngraveJobStore.getState().job.drills ?? [])).toBe(1.0);
  });

  it('reads the fallback through the registry, so the number is labelled where it is used', () => {
    // The fallback is not a private literal in the store: it is the registry's, and `readDefault`
    // answers it with `source: 'fallback'` — which is what stops it passing as the shop's own.
    for (const key of [NEW_ITEM_DEPTH_KEY, NEW_DRILL_DEPTH_KEY]) {
      const d = readDefault(null, key);
      expect(d.value, key).toBe(KNOWN_DEFAULTS[key]!.fallback);
      expect(d.source, key).toBe('fallback');
      expect(KNOWN_DEFAULTS[key]!.rule.safeParse(d.value).success, key).toBe(true);
    }
    expect(KNOWN_DEFAULTS[NEW_ITEM_DEPTH_KEY]!.fallback).toBe(0.5);
    expect(KNOWN_DEFAULTS[NEW_DRILL_DEPTH_KEY]!.fallback).toBe(1.0);
  });

  it('refuses a stored starting depth the job could not accept', () => {
    // The rule is not decoration: the job's schema rejects a depth of 0 or less, so a location
    // holding one must not be what a new item is built from.
    expect(KNOWN_DEFAULTS[NEW_ITEM_DEPTH_KEY]!.rule.safeParse(0).success).toBe(false);
    expect(KNOWN_DEFAULTS[NEW_ITEM_DEPTH_KEY]!.rule.safeParse(-1).success).toBe(false);
    expect(KNOWN_DEFAULTS[NEW_ITEM_DEPTH_KEY]!.rule.safeParse(0.05).success).toBe(true);
    expect(KNOWN_DEFAULTS[NEW_ITEM_DEPTH_KEY]!.rule.safeParse(21).success).toBe(false);

    // A location holding a value outside the rule renders the key unusable, so the item falls back
    // rather than being built at a number the document should never have carried.
    useShopDefaultsStore.setState({
      status: 'present',
      defaults: { [NEW_ITEM_DEPTH_KEY]: { value: 0, source: 'chosen', setAt: '2026-10-16', unit: 'mm', note: null } },
    });
    expect(newItemDepthMm()).toBe(0.5);
  });
});
