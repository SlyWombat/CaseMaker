// The badge blank as an engrave job (#271 route 1). Pure: `badgeBlankFor` reads `BadgeParams`
// and nothing else, and the job it describes is then asked through `jobDepthLimit` — the single
// owner of the limit #174's verifier refuses against. No wasm, no store.

import { describe, it, expect } from 'vitest';

import { BADGE_POCKET_KEEP_OUT_ID, badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultBadgeParams } from '@/types/badge';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobDepthLimit, keepOutLimitAt, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';

/** The job a caller gets by writing `badgeBlankFor(badge)` into a fresh default job. */
function jobForBadge(badge = defaultBadgeParams()): EngraveJob {
  const blank = badgeBlankFor(badge);
  return {
    ...defaultEngraveJob(),
    stock: blank.stock,
    keepOuts: blank.pocket ? [blank.pocket] : [],
  };
}

describe('badgeBlankFor (#271)', () => {
  it('reads the blank out of the badge, in the job’s own stock shape', () => {
    const blank = badgeBlankFor(defaultBadgeParams());
    // The badge's `width` is X and its `height` is Y — 3.0 in × 1.5 in, 0.15 in thick.
    expect(blank.stock).toEqual({ length: 76.2, width: 38.1, thickness: 3.81, material: 'pla' });
    expect(blank.notes[0]).toContain('76.2 × 38.1 × 3.81');
  });

  it('stamps the magnet pocket with a ceiling in the blank’s own datum', () => {
    const { pocket } = badgeBlankFor(defaultBadgeParams());
    expect(pocket).not.toBeNull();
    expect(pocket!.id).toBe(BADGE_POCKET_KEEP_OUT_ID);
    expect(pocket!.kind).toBe('rect');
    if (pocket!.kind !== 'rect') return;
    expect(pocket!.width).toBe(45);
    expect(pocket!.height).toBe(13);
    // Centred on the outline in the badge's frame -> the middle of the job's stock.
    expect(pocket!.position).toEqual({ x: 38.1, y: 19.05 });
    // `pocket.depth` is measured from the BACK face; so is `zCeiling` — machined pocket-down
    // (/Fabrication.md §7.2), the back face IS the bottom face. Copied, not recomputed.
    expect(pocket!.zCeiling).toBe(2.3);
    expect(pocket!.enabled).toBe(true);
  });

  it('states the membrane §7.2 names — 3.81 mm of blank less a 2.3 mm pocket', () => {
    const blank = badgeBlankFor(defaultBadgeParams());
    expect(blank.notes.join(' ')).toContain('1.51');
  });

  it('declares no void for a badge with no pocket, and says so', () => {
    const blank = badgeBlankFor(defaultBadgeParams({ magnetPocket: null }));
    expect(blank.pocket).toBeNull();
    expect(blank.notes.join(' ')).toMatch(/no magnet pocket/);
    // The blank is still the badge's blank — a pocket-less badge is a badge.
    expect(blank.stock.thickness).toBe(3.81);
  });

  it('produces a void the depth limit reads, and only over its footprint', () => {
    const job = jobForBadge();
    // The pocket's ceiling is an `above` bound like any other (#345), so what it reserves is the
    // margin its OWN rule keeps — and this badge states no print, so that is
    // `max(boundaryMargin, minFloor)` = 1.0, not the shipped 0.2 (#345 decision A: with no layer
    // grid the structural floor is the only number with a basis).
    // 1.51 mm of membrane, less 1.0: 0.51 mm over the pocket…
    expect(keepOutLimitAt(job, 38.1, 19.05)).toBeCloseTo(0.51, 6);
    // …and nothing reserved out at the blank's corner, where the limit is the stock's own.
    expect(keepOutLimitAt(job, 5, 5)).toBeNull();
    expect(jobDepthLimit(job)(5, 5)).toBeCloseTo(3.81 - 1, 6);
    // The membrane is thin: a 1.5 mm cut on the badge's engraved face breaks through it.
    expect(jobDepthLimit(job)(38.1, 19.05)).toBeLessThan(1.5);
  });

  it('survives the schema round-trip, at the same fixed id', () => {
    const reparsed = parseEngraveJob(JSON.parse(JSON.stringify(jobForBadge())) as unknown);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.job.keepOuts).toHaveLength(1);
    expect(reparsed.job.keepOuts![0]!.id).toBe(BADGE_POCKET_KEEP_OUT_ID);
    // The pocket reaches `toPartPlan`, which is what the run sheet and the findings read.
    const plan = toPartPlan(reparsed.job);
    expect(plan.stock.keepOuts.map((k) => k.id)).toEqual([BADGE_POCKET_KEEP_OUT_ID]);
  });
});

describe('the badge’s print becomes the job’s (#285)', () => {
  it('carries nothing when the badge states no print — the switches stay off', () => {
    // `BadgeParams.print` is #166's, and nothing in the app writes it yet, so this is the state
    // every badge is in today. The job must be exactly what it was before #285 existed.
    const blank = badgeBlankFor(defaultBadgeParams());
    expect(blank.stock.print).toBeUndefined();
    // …and the plan therefore has no colour layers at all, which is what keeps the depth limit
    // analytic and the `.nc` byte-identical.
    expect(toPartPlan(jobForBadge()).stock.split).toBeUndefined();
  });

  it('copies the split and the layer grid when the badge states its print', () => {
    const badge = defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } });
    const blank = badgeBlankFor(badge);
    // The split travels WITH the blank: a job document is standalone and must not have to look
    // back at the project's badge to know where its colour boundary is.
    expect(blank.stock.print).toEqual({ split: 3.0, layerHeight: 0.2, firstLayerHeight: 0.2 });
    // The blank itself is unchanged — the print adds a fact, it does not move a dimension.
    expect(blank.stock.thickness).toBe(3.81);
    expect(blank.notes.join(' ')).toContain('3 mm colour split');
    expect(blank.notes.join(' ')).toContain('0.2 mm layers');
  });

  it('reaches the plan, where the layer stack reads it', () => {
    const badge = defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } });
    const plan = toPartPlan(jobForBadge(badge));
    expect(plan.stock.split).toBe(3.0);
    expect(plan.stock.layerHeight).toBe(0.2);
    expect(plan.stock.firstLayerHeight).toBe(0.2);
  });

  it('keeps the print through the schema round-trip, and drops it for a job without one', () => {
    const badge = defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } });
    const withPrint = parseEngraveJob(JSON.parse(JSON.stringify(jobForBadge(badge))) as unknown);
    expect(withPrint.ok).toBe(true);
    if (!withPrint.ok) return;
    expect(withPrint.job.stock.print).toEqual({ split: 3.0, layerHeight: 0.2, firstLayerHeight: 0.2 });

    // The other direction: a plain job keeps no key, so it round-trips byte-for-byte.
    const without = parseEngraveJob(JSON.parse(JSON.stringify(jobForBadge())) as unknown);
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(without.job.stock.print).toBeUndefined();
    expect('print' in without.job.stock).toBe(false);
  });
});
