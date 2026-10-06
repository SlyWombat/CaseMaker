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
    // 1.51 mm of membrane, less the default 1 mm minimum floor: 0.51 mm over the pocket…
    expect(keepOutLimitAt(job, 38.1, 19.05)).toBeCloseTo(0.51, 6);
    // …and nothing reserved out at the blank's corner, where the limit is the stock's own.
    expect(keepOutLimitAt(job, 5, 5)).toBeNull();
    expect(jobDepthLimit(job)(5, 5)).toBeCloseTo(3.81 - 1, 6);
    // The membrane is thin: a 1 mm cut on the badge's engraved face breaks through it.
    expect(jobDepthLimit(job)(38.1, 19.05)).toBeLessThan(1);
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
