// #962 — STAY-DOWN LINKING (red-first).
//
// A link joins one pass's exit to the next pass's entry. It stays down at the cut depth only when
// the cutter's swept link lies inside material ALREADY removed at that depth, and only under the
// two prior-art guards: Kiri:Moto's short hop (2 × the cutter's diameter) and FreeCAD's
// KeepToolDownRatio (a detour at most that many times the direct distance). Otherwise it retracts
// to the region's clearance plane (feed replaced by a rapid both ways here — the manager's ruling
// refining #956 §5, Review B's F8), then rapids down again to the material field's own report at
// the landing plus the default 1 mm hop clearance (`DEFAULT_HOP_CLEARANCE_MM`, these fixtures pass
// no `hopClearanceMm` of their own), feeding only the part of the down leg below that — but ONLY
// when the caller PROVES the landing is cut at that z (#1002): `opts()` below states the proof,
// and the unproven case pins the stock-top rule the merge made universal.
import { describe, expect, it } from 'vitest';

import type { CamMove } from '@/engine/cnc/cam/ir';
import {
  DEFAULT_KEEP_TOOL_DOWN_RATIO,
  link,
  linkIsClear,
  linkPasses,
  orderPasses,
  type LinkOptions,
  type LinkPoint,
  type MaterialField,
} from '@/engine/cnc/cam/model/linking';

function field(topAt: (x: number, y: number) => number): MaterialField {
  return { topAt };
}

/** Everything within the footprint has already been cut to `z`. */
function clearedTo(z: number): MaterialField {
  return field(() => z);
}

function opts(over: Partial<LinkOptions> = {}): LinkOptions {
  return {
    material: clearedTo(-5),
    clearanceZ: 5,
    tool: { radiusMm: 1.5 },
    feeds: { feed: 800, plungeFeed: 200 },
    // #1002 — these fixtures' fields describe ground already cut, so the caller's landing proof
    // (the deep ops' `passes[].cleared` membership test) is stated here as `true`: without it the
    // down leg's rapid floor is the STOCK TOP, which is the rule the unproven case below pins.
    landingCut: () => true,
    ...over,
  };
}

const P = (x: number, y: number, z = -5): LinkPoint => ({ x, y, z });

function feedMoves(moves: readonly CamMove[]): { x: number; y: number; z: number; f: number }[] {
  return moves.flatMap((m) => (m.kind === 'feed' ? [{ x: m.x, y: m.y, z: m.z, f: m.f }] : []));
}

/** A dense, deliberately independent capsule test: the spec's own reading of "standing material". */
function denseClear(from: LinkPoint, to: LinkPoint, topAt: (x: number, y: number) => number, radius: number): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(length / 0.1));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const nx = length > 0 ? -dy / length : 0;
  const ny = length > 0 ? dx / length : 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const z = from.z + (to.z - from.z) * t;
    const cx = from.x + dx * t;
    const cy = from.y + dy * t;
    for (let ox = -radius; ox <= radius + 1e-9; ox += radius / 3) {
      for (let oy = -radius; oy <= radius + 1e-9; oy += radius / 3) {
        if (Math.hypot(ox, oy) > radius + 1e-9) continue;
        const top = topAt(cx + nx * ox + (dx / (length || 1)) * oy, cy + ny * ox + (dy / (length || 1)) * oy);
        if (top > z + 1e-6) return false;
      }
    }
  }
  return true;
}

describe('#962 link decisions', () => {
  it('stays down on a cleared floor: one feed move at the cutting feed', () => {
    const moves = link(P(0, 0), P(5, 0), opts());
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: 'feed', x: 5, y: 0, z: -5, f: 800 });
  });

  it('retracts over standing material: rapid up, rapid across, rapid down to the floor, feed the rest', () => {
    // A rib at x ∈ (2, 3) left standing at the stock top. The landing (5, 0) itself reads cleared
    // to -5, so the down leg's floor is -5 + 1 (the default hop clearance) = -4.
    const material = field((x) => (x > 2 && x < 3 ? 0 : -5));
    const moves = link(P(0, 0), P(5, 0), opts({ material }));
    expect(moves).toHaveLength(4);
    expect(moves[0]).toMatchObject({ kind: 'rapid', x: 0, y: 0, z: 5 });
    expect(moves[1]).toMatchObject({ kind: 'rapid', x: 5, y: 0, z: 5 });
    expect(moves[2]).toMatchObject({ kind: 'rapid', x: 5, y: 0, z: -4 });
    expect(moves[3]).toMatchObject({ kind: 'feed', x: 5, y: 0, z: -5, f: 200 });
  });

  it('without a landing proof the down leg stops at the stock top plus the hop and feeds the rest (#966/#1002)', () => {
    // The same retract as above, but the caller states no proof and states the datum's stock top
    // (2 mm): the rapid may descend only to 2 + the default 1 mm hop, never to the material
    // field's own report — the merge's rule, which the deep ops now opt out of with their proof.
    const material = field((x) => (x > 2 && x < 3 ? 0 : -5));
    const moves = link(P(0, 0), P(5, 0), opts({ material, landingCut: undefined, stockTopZMm: 2 }));
    expect(moves).toHaveLength(4);
    expect(moves[0]).toMatchObject({ kind: 'rapid', x: 0, y: 0, z: 5 });
    expect(moves[1]).toMatchObject({ kind: 'rapid', x: 5, y: 0, z: 5 });
    expect(moves[2]).toMatchObject({ kind: 'rapid', x: 5, y: 0, z: 3 }); // stock top 2 + hop 1
    expect(moves[3]).toMatchObject({ kind: 'feed', x: 5, y: 0, z: -5, f: 200 });
  });

  it('a cleared LEVEL lifts the down leg above a same-level landing: rapid to the ground + hop, feed the step (#1002)', () => {
    // The deep ops' own form of the proof: the ground under the landing was cut to -4 by the
    // level just finished, and the link is descending to -5 at the same level — the rapid stops
    // one hop above the GROUND (-3), then feeds the single step to the landing.
    const material = field((x) => (x > 2 && x < 3 ? 0 : -5)); // the rib forces the retract
    const moves = link(P(0, 0), P(5, 0), opts({ material, landingClearedZMm: () => -4 }));
    expect(moves).toHaveLength(4);
    expect(moves[2]).toMatchObject({ kind: 'rapid', x: 5, y: 0, z: -3 });
    expect(moves[3]).toMatchObject({ kind: 'feed', x: 5, y: 0, z: -5, f: 200 });
  });

  it('the down leg rapids no lower than the material under the WHOLE disc at the landing, not just its own point (the manager\'s #962 footprint audit)', () => {
    // The landing (10, 0) itself reads cleared to -5 — but a ridge stands at (10.5, 0) and
    // (11, 0), both inside the ⌀3 cutter's radius of the landing. A floor computed from the
    // landing's own point alone (-5 + 1 = -4) rapids straight through the ridge's top (0) on the
    // way down; the floor must come from the tallest point anywhere under the disc.
    const material = field((x, y) =>
      x > 10.4 && x < 11.1 && Math.abs(y) < 0.3 ? 0 : -5,
    );
    const moves = link(P(0, 0), P(10, 0), opts({ material }));
    expect(moves).toHaveLength(4);
    expect(moves[2]).toMatchObject({ kind: 'rapid', x: 10, y: 0, z: 1 }); // ridge top 0 + 1 mm hop
    expect(moves[3]).toMatchObject({ kind: 'feed', x: 10, y: 0, z: -5, f: 200 });
  });

  it("Kiri's guard: a clear link longer than 2 × the cutter diameter retracts", () => {
    const moves = link(P(0, 0), P(15, 0), opts());
    expect(moves).toHaveLength(4); // rapid up, rapid across, rapid down to the floor, feed the rest
    expect(moves.filter((m) => m.kind === 'rapid')).toHaveLength(3);
    const fed = feedMoves(moves);
    expect(fed).toHaveLength(1); // only the down leg's final approach, below the floor
    expect(fed.every((m) => m.f === 200)).toBe(true);
  });

  it('tests the cutter radius, not only the centreline: a wall within the disc blocks the link', () => {
    const material = field((x) => (x > 2.5 ? 0 : -5));
    expect(linkIsClear(P(0, 0), P(2, 0), opts({ material }))).toBe(false);
    expect(link(P(0, 0), P(2, 0), opts({ material }))).toHaveLength(4);
  });

  it("FreeCAD's ratio guard: a clear dogleg may stay down within the ratio", () => {
    // A short rib across the direct line, limited in Y; the detour goes around it (⌀6 cutter:
    // the short hop is 12 mm, so the 10 mm gap may stay down at all).
    const material = field((x, y) => (x > 4 && x < 6 && Math.abs(y) < 1 ? 0 : -5));
    const moves = link(P(0, 0), P(10, 0), opts({ material, tool: { radiusMm: 3 } }));
    expect(moves).toHaveLength(2); // two feeds through the waypoint, no retract
    expect(moves.every((m) => m.kind === 'feed' && m.f === 800)).toBe(true);
  });

  it('refuses the same dogleg when the ratio cannot pay for it', () => {
    const material = field((x, y) => (x > 4 && x < 6 && Math.abs(y) < 1 ? 0 : -5));
    const moves = link(
      P(0, 0),
      P(10, 0),
      opts({ material, tool: { radiusMm: 3 }, keepToolDownRatio: 1.1 }),
    );
    expect(moves).toHaveLength(4);
  });

  it('follows a sloped link the material has been cut under', () => {
    const material = field((x) => -5.7 - 0.4 * x);
    const moves = link(P(0, 0, -5), P(5, 0, -7), opts({ material }));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: 'feed', x: 5, y: 0, z: -7, f: 800 });
  });

  it('never emits a horizontal feed through standing material (deterministic sweep)', () => {
    let seed = 20261104;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const topAt = (x: number, y: number): number => {
      // A rolling field: some regions cleared to -5, some standing, some half-cut.
      return Math.sin(x * 0.7) + Math.cos(y * 0.9) > 0.4 ? 0 : -5;
    };
    for (let i = 0; i < 40; i++) {
      const from = P(rnd() * 20 - 10, rnd() * 20 - 10);
      const to = P(rnd() * 20 - 10, rnd() * 20 - 10);
      const moves = link(from, to, opts({ material: { topAt } }));
      // Any non-vertical feed the linker emits must lie in material cut to its own plane.
      let prev: LinkPoint = from;
      for (const m of moves) {
        if (m.kind === 'feed') {
          const next = { x: m.x, y: m.y, z: m.z };
          const horizontal = Math.hypot(next.x - prev.x, next.y - prev.y) > 1e-9;
          if (horizontal) {
            expect(denseClear(prev, next, topAt, 1.5)).toBe(true);
          }
          prev = next;
        } else {
          prev = { x: m.x, y: m.y, z: m.z };
        }
      }
    }
  });

  it('exports the prior-art defaults (FreeCAD 3, Kiri 2 diameters)', () => {
    expect(DEFAULT_KEEP_TOOL_DOWN_RATIO).toBe(3);
    // A 16 mm link at a ⌀6 cutter (shortHop 12) retracts; a 10 mm one stays down.
    expect(link(P(0, 0), P(10, 0), opts({ tool: { radiusMm: 3 } }))).toHaveLength(1);
    expect(link(P(0, 0), P(13, 0), opts({ tool: { radiusMm: 3 } }))).toHaveLength(4);
  });
});

describe('#962 region tour', () => {
  const passes = [
    { entry: P(10, 0), exit: P(10, 5), regionId: 'r10' },
    { entry: P(0, 0), exit: P(0, 5), regionId: 'r0' },
    { entry: P(5, 5), exit: P(5, 0), regionId: 'r5' },
    { entry: P(6, 5), exit: P(6, 0), regionId: 'r6' },
  ];

  it('orders passes nearest-first deterministically', () => {
    const a = orderPasses(passes, [0, 0]);
    const b = orderPasses(passes, [0, 0]);
    expect(a.map((p) => p.regionId)).toEqual(b.map((p) => p.regionId));
    expect(a).toHaveLength(passes.length);
    expect(a[0]!.regionId).toBe('r0'); // nearest to the start
    expect(new Set(a.map((p) => p.regionId))).toEqual(new Set(passes.map((p) => p.regionId)));
  });

  it('links each pass to the next, and leaves the first without a link', () => {
    const linked = linkPasses(passes, opts());
    expect(linked[0]!.linkBefore).toEqual([]);
    for (let i = 1; i < linked.length; i++) {
      const next = linked[i]!.pass.entry;
      const moves = linked[i]!.linkBefore;
      expect(moves.length).toBeGreaterThan(0);
      const last = moves[moves.length - 1]!;
      expect(last.x).toBeCloseTo(next.x, 9);
      expect(last.y).toBeCloseTo(next.y, 9);
      expect(last.z).toBeCloseTo(next.z, 9);
    }
  });
});
