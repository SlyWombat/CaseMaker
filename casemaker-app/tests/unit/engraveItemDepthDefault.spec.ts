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
import { BLANK_BAND_FILL_FALLBACK } from '@/engine/cnc/engrave/blankLabelSeed';
import { useSettingsStore } from '@/store/settingsStore';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';

/**
 * A location that chose these numbers, parsed through the section's own schema. Takes the whole set
 * at once: the section is one map, so a second call would replace the first key rather than add to it.
 */
function store(entries: Record<string, number>, unit = 'mm'): void {
  const section = Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      key,
      { value, source: 'chosen', setAt: '2026-10-16', unit, note: null },
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

  it('starts at the stock kind’s recommendation on a colour blank (#492)', () => {
    // The location's number is still the plain-stock recommendation; a laminate overrides it with
    // cap + margin, because that is the depth the blank's own colour plane asks for.
    store({ [NEW_ITEM_DEPTH_KEY]: 3, [NEW_DRILL_DEPTH_KEY]: 2 });
    const base = defaultEngraveJob();

    act(() => {
      useEngraveJobStore.setState({
        job: {
          ...base,
          stock: {
            ...base.stock,
            material: 'plastic',
            thickness: 1.5,
            colour: { kind: 'laminate', capMm: 0.075 },
          },
        },
      });
    });
    useEngraveJobStore.getState().addLabel();
    expect(lastDepth(useEngraveJobStore.getState().job.labels)).toBe(0.1);
    useEngraveJobStore.getState().addShape('rect');
    expect(lastDepth(useEngraveJobStore.getState().job.shapes)).toBe(0.1);

    // Back on plain stock the field arrives at the shop's chosen number again — the stock kind only
    // set the recommendation, never a rule that the operator cannot override.
    act(() => {
      useEngraveJobStore.setState({ job: defaultEngraveJob() });
    });
    useEngraveJobStore.getState().addLabel();
    expect(lastDepth(useEngraveJobStore.getState().job.labels)).toBe(3);
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

// #451 — the seeded line's SIZE is the shop's too. `blankLabelSeed` is pure and must stay so (it is
// also called from the worker side of the app), so the two store routes that seed a blank read
// `engrave.blankBandFill` and pass it in. This walks the real route rather than the module: if the
// store forgot the hand-off, the default and the shop's own number would seed the same line.
describe('the seeded line’s band fill (#451)', () => {
  /** A bare blank of a footprint that is NOT the demo plank, so `takeBlankStock` re-lays the set. */
  const BLANK = { enabled: true, width: 60, height: 40, thickness: 12, cornerRadius: 0 };

  /** Take that blank as the job's stock and answer the size of the one line the route seeded. */
  function seededSize(): number {
    useEngraveJobStore.getState().takeBlankStock(BLANK);
    const labels = useEngraveJobStore.getState().job.labels;
    expect(labels).toHaveLength(1);
    return labels[0]!.size;
  }

  /** Start the next case from the shipped demo job again (the route replaces its label set). */
  function resetJob(): void {
    act(() => {
      useEngraveJobStore.setState({ job: defaultEngraveJob() });
    });
  }

  it('takes the share the location holds, not the fallback', () => {
    // No location: the labelled fallback, 0.7 of the band.
    const fallback = seededSize();
    expect(BLANK_BAND_FILL_FALLBACK).toBe(0.7);

    // A shop that seeds a smaller line gets a smaller line: 0.5 of the same band cannot round up.
    resetJob();
    store({ 'engrave.blankBandFill': 0.5 }, 'x');
    expect(seededSize()).toBeLessThan(fallback);

    // …and a fuller band seeds a line no smaller — never the fallback by accident.
    resetJob();
    store({ 'engrave.blankBandFill': 0.9 }, 'x');
    expect(seededSize()).toBeGreaterThanOrEqual(fallback);
  });

  it('falls back rather than seeding from a share the rule refuses', () => {
    // A location holding a value outside `KNOWN_DEFAULTS`'s rule must not be what a line is sized
    // from: zero of the band floors to no cap at all, so `blankLabelSeed` keeps its labelled number.
    const fallback = seededSize();
    resetJob();
    useShopDefaultsStore.setState({
      status: 'present',
      defaults: {
        'engrave.blankBandFill': { value: 0, source: 'chosen', setAt: '2026-10-17', unit: 'x', note: null },
      },
    });
    expect(seededSize()).toBe(fallback);
  });
});
