/**
 * #1073 line 4 — SIDE 2'S TAB RELEASE: the flipped setup's LAST shallow pass frees the part from
 * the band the two sides left — and the part NEVER goes free under a running cutter (Analyst's
 * binding ruling). The band is cut through everywhere except at 4 tab bridges, which the operator
 * cuts with a flush-cut saw after the machine is homed.
 *
 * THE FIXTURE is an 80 × 40 × 20 block on a 10 mm band, with two locating pins near the middle of
 * the long sides: the tab rule (4 tabs, 4 mm wide, 1 mm of material at the bottom of the cut, on
 * the long sides, ≥15 mm from a corner and ≥10 mm from a pin) has to MOVE the tabs off the pins
 * to place all four.
 *
 * RED at m1-land11 22d77f195: nothing plans or posts the release — the sheet only promised it.
 */
import { describe, expect, it } from 'vitest';

import { planTabRelease } from '@/engine/cnc/engrave/tabRelease';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import { tl } from './helpers/manifoldExec';
import type { CutParams } from '@/engine/cnc/feeds';
import type { EngraveTargetObject } from '@/types/engraveJob';

type V = [number, number, number];
type Tri = [V, V, V];

function stl(tris: Tri[]): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

/** A closed box, `halfX × halfY × depth` (top at z = 0, bottom at −depth). */
function boxTris(halfX: number, halfY: number, depth: number): Tri[] {
  const x = halfX;
  const y = halfY;
  const z0 = 0;
  const z1 = -depth;
  // Corner vertices: bottom (b) and top (t).
  const b: V[] = [[-x, -y, z1], [x, -y, z1], [x, y, z1], [-x, y, z1]];
  const t: V[] = [[-x, -y, z0], [x, -y, z0], [x, y, z0], [-x, y, z0]];
  const quad = (a: V, b2: V, c: V, d: V): Tri[] => [[a, b2, c], [a, c, d]];
  return [
    ...quad(b[3]!, b[2]!, t[2]!, t[3]!), // +y side
    ...quad(b[1]!, b[0]!, t[0]!, t[1]!), // −y side
    ...quad(b[2]!, b[1]!, t[1]!, t[2]!), // +x side
    ...quad(b[0]!, b[3]!, t[3]!, t[0]!), // −x side
    ...quad(t[0]!, t[1]!, t[2]!, t[3]!), // top
    ...quad(b[3]!, b[2]!, b[1]!, b[0]!), // bottom
  ];
}

/** The side-2 goal copy of the fixture; `bandMm` is the depth of the cut floor it was planned at. */
function goalOf(halfX = 40, halfY = 20, bandMm: number | undefined = 10): EngraveTargetObject {
  return {
    id: 'part',
    name: 'part.stl',
    format: 'stl',
    sha256: 'a'.repeat(64),
    data: stl(boxTris(halfX, halfY, 20)),
    size: { x: 2 * halfX, y: 2 * halfY, z: 20 },
    position: { x: 0, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...(bandMm === undefined ? {} : { bandMm }),
    underside: { kind: 'flipped-tabs', tabs: { thicknessMm: 1 } },
  };
}

const PARAMS: CutParams = { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 1, stepOver: 0.4, peck: 1, air: true };
const TOOL_R = 1.5875; // the ⌀3.175 contour flat
const TABS = { count: 4, widthMm: 4, heightMm: 1 };
const PINS = { at: [{ x: 0, y: -30 }, { x: 0, y: 30 }] as [{ x: number; y: number }, { x: number; y: number }] };

const plan = () => {
  const out = planTabRelease({
    goal: goalOf(),
    pins: PINS,
    toolRadiusMm: TOOL_R,
    tabs: TABS,
    params: PARAMS,
    offset: makeClipperOffset(tl),
  });
  if (!out.ok) throw new Error(`refused: ${out.reason}`);
  return out.plan;
};

/** Distance from `p` to the nearest point of the span `a`→`b` — the tab keeps its width off any pin. */
function distToSpan(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

describe('#1073 side 2’s tab release', () => {
  it('cuts the band to its bottom and keeps 4 tab bridges at the tab top', () => {
    const p = plan();
    // The band is the goal's `bandMm` (the floor) down 2 × the underside tab band.
    expect(p.bandTopZ).toBeCloseTo(-10, 9);
    expect(p.bandBottomZ).toBeCloseTo(-12, 9);
    expect(p.tabTopZ).toBeCloseTo(-11, 9); // 1 mm of material at the bottom of the cut
    expect(p.placement.spans).toHaveLength(4);
    // The bulk op cuts fully above the tab top; the FINAL lap is the tabbed one.
    expect(p.bulkMoves.some((m) => m.kind === 'rapid' && Math.abs(m.z - p.tabTopZ) < 1e-9)).toBe(false);
    const lifts = p.finalMoves.filter((m) => m.kind === 'rapid' && Math.abs(m.z - p.tabTopZ) < 1e-9);
    expect(lifts).toHaveLength(4);
    // The final lap's cutting moves are at the band's bottom, the crossings at the tab top.
    const feeds = p.finalMoves.filter((m) => m.kind === 'feed');
    expect(feeds.every((m) => Math.abs(m.z - p.bandBottomZ) < 1e-9 || Math.abs(m.z - p.tabTopZ) < 1e-9)).toBe(true);
    expect(feeds.filter((m) => Math.abs(m.z - p.tabTopZ) < 1e-9).length).toBeGreaterThan(0);
    expect(feeds.some((m) => Math.abs(m.z - p.bandBottomZ) < 1e-9)).toBe(true);
  });

  it('places every tab on the long sides, ≥15 mm from a corner and ≥10 mm from a pin', () => {
    const p = plan();
    const corners: [number, number][] = [[-40, -20], [40, -20], [40, 20], [-40, 20]];
    for (const span of p.placement.spans) {
      // Both ends of the tab (the span is wider than the 4 mm tab: the cutter's centre path
      // clears each side by its radius).
      for (const end of [span.start, span.end]) {
        for (const c of corners) expect(Math.hypot(end[0] - c[0], end[1] - c[1])).toBeGreaterThanOrEqual(15 - 1e-6);
        for (const pin of PINS.at) expect(Math.hypot(end[0] - pin.x, end[1] - pin.y)).toBeGreaterThanOrEqual(10 - 1e-6);
      }
      // On a straight run, not on a corner arc.
      expect(Math.abs(span.start[0] - span.end[0]) < 1e-6 || Math.abs(span.start[1] - span.end[1]) < 1e-6).toBe(true);
    }
    // The tabs moved OFF the pins: the whole span stands clear of each bore.
    for (const span of p.placement.spans) {
      for (const pin of PINS.at) expect(distToSpan([pin.x, pin.y], span.start, span.end)).toBeGreaterThan(10);
    }
  });

  it('follows the section one cutter radius outside the part', () => {
    const p = plan();
    const xs = p.path.flatMap((ring) => ring.map(([x]) => x));
    const ys = p.path.flatMap((ring) => ring.map(([, y]) => y));
    // The 80 × 40 section, offset outward by the flat's radius.
    expect(Math.min(...xs)).toBeCloseTo(-40 - TOOL_R, 1);
    expect(Math.max(...xs)).toBeCloseTo(40 + TOOL_R, 1);
    expect(Math.min(...ys)).toBeCloseTo(-20 - TOOL_R, 1);
    expect(Math.max(...ys)).toBeCloseTo(20 + TOOL_R, 1);
    expect(p.path).toHaveLength(1);
  });

  it('names the tab centres for the sheet', () => {
    const p = plan();
    expect(p.tabCentres).toHaveLength(4);
    for (const [x, y] of p.tabCentres) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    }
  });

  it('refuses by name when the goal states no band — there is nothing left to release', () => {
    const out = planTabRelease({
      goal: goalOf(40, 20, undefined),
      pins: PINS,
      toolRadiusMm: TOOL_R,
      tabs: TABS,
      params: PARAMS,
      offset: makeClipperOffset(tl),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('tab-release-no-band');
      expect(out.reason).toContain('band');
    }
  });

  it('refuses by name when four tabs cannot be placed on the outline', () => {
    const out = planTabRelease({
      goal: goalOf(3, 3, 10),
      pins: null,
      toolRadiusMm: TOOL_R,
      tabs: TABS,
      params: PARAMS,
      offset: makeClipperOffset(tl),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe('tab-release-no-tabs');
      expect(out.reason).toContain('4');
    }
  });
});
