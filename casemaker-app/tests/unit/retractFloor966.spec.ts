/**
 * #966 — A RETRACT'S DOWN LEG MAY ONLY RAPID TO PROVEN-CLEAR MATERIAL.
 *
 * The band skim's join landed on the next row's start and handed `link()` a field that reports the
 * surface the skim WILL leave; the retract took that as the floor and sent a rapid 0.739 mm below
 * the stock top through standing stock (`rapid-through-stock`, 18.347 mm³ on the CLI's job). The
 * rule now lives in `link()`'s own retract: a landing the caller cannot prove cut descends only to
 * the stock top plus the hop clearance, then feeds; a caller that PROVES the landing is cut (a ring
 * band's own mask) keeps today's fast floor.
 *
 * Red at f9f063d3 (the down-leg rapid reaches −0.739); green at the fix.
 */
import { describe, expect, it } from 'vitest';

import { link, type LinkOptions } from '@/engine/cnc/cam/model/linking';

const base = (over: Partial<LinkOptions> = {}): LinkOptions => ({
  // A LIE, on purpose: the field reports ground 1.739 mm below the stock top, as the skim's
  // cut-surface field does for a row it has not cut yet.
  material: { topAt: () => -1.739 },
  clearanceZ: 5,
  tool: { radiusMm: 3 },
  feeds: { feed: 400, plungeFeed: 150 },
  hopClearanceMm: 1,
  ...over,
});

describe('#966 a retract never rapids below the stock top unless the landing is proven cut', () => {
  it('RED-FIRST: an unproven landing descends only to the stock top + hop, then feeds', () => {
    const moves = link({ x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: -2.3 }, base());
    // No rapid may enter the stock: the stock top is 0 (the plan's datum), the hop 1.
    const subStockRapids = moves.filter((m) => m.kind === 'rapid' && m.z < -1e-9);
    expect(subStockRapids, JSON.stringify(moves)).toEqual([]);
    const downRapids = moves.filter((m) => m.kind === 'rapid' && Math.abs(m.x - 10) < 1e-9);
    expect(downRapids.at(-1)!.z).toBeCloseTo(1, 9);
    // And the rest of the descent is a feed at the plunge rate.
    const last = moves.at(-1)!;
    expect(last.kind).toBe('feed');
    expect(last.z).toBeCloseTo(-2.3, 9);
    expect(last.kind === 'feed' ? last.f : null).toBe(150);
  });

  it('a proven landing keeps the fast floor: the rapid descends to the field’s report + the hop', () => {
    const moves = link({ x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: -2.3 }, base({ landingCut: () => true }));
    const downRapids = moves.filter((m) => m.kind === 'rapid' && Math.abs(m.x - 10) < 1e-9);
    expect(downRapids.at(-1)!.z).toBeCloseTo(-0.739, 9);
  });

  it('a landing on a proven-cut level below the stock top still rapids to its own z', () => {
    // The pocket/rough case: the landing is cut at the target level, so the floor is that level
    // (the field claims it), not the stock top.
    const moves = link({ x: 0, y: 0, z: 5 }, { x: 10, y: 0, z: -5 }, base({ material: { topAt: () => -6 }, landingCut: () => true }));
    const downRapids = moves.filter((m) => m.kind === 'rapid' && Math.abs(m.x - 10) < 1e-9);
    // The floor IS the landing: the rapid lands on it and there is nothing left to feed.
    expect(downRapids.at(-1)!.z).toBeCloseTo(-5, 9);
    expect(moves.at(-1)!.kind).toBe('rapid');
    expect(moves.at(-1)!.z).toBeCloseTo(-5, 9);
  });
});
