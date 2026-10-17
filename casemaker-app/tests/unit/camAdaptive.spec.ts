// #433 phase 1 — adaptive clearing for metal pockets, with helical and ramped entry.
//
// THE METER IS THE SPEC'S OWN. Nothing here reads the planner's grid or its step engagements: the
// emitted moves are walked on an independent, finer grid, and "engagement" is measured the way the
// plan comment on #433 defines it — the new area a move removes per mm of travel, over windows of
// 0.5 mm. The cap applies to clearing AND link moves; entry moves (helix, ramp) are stamped but not
// metered, and are checked instead for staying on their helix or ramp line at the ramp angle.
//
// THE REFERENCES ARE MANIFOLD'S. Where the centre may go (the region shrunk by the cutter radius) and
// what must end up cleared (that shrunk region grown back — the region's OPENING, which leaves only
// inside corners tighter than the cutter) are built with Clipper2's real offset, never with the
// planner's own distance test.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { adaptiveIR, adaptivePlanIR, adaptiveSettings, planAdaptive, type AdaptivePlan, type AdaptiveSettings } from '@/engine/cnc/cam/adaptive';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { HOP_Z } from '@/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1 } from '@/engine/cnc/post/z1';
import { stubSetup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';
import { stockDepthLimit, verifyProgram } from '@/engine/cnc/verify';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = ShopDefaultsSchema.parse((JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults);
const { settings: S, sources } = adaptiveSettings(DEFAULTS);
const offset = makeClipperOffset(tl);

const D = 3.175;
const R = D / 2;
const MILL: Tool = flatEndMill(D);
const CAP = S.engagementFraction * D;
const DEPTH = 1.5;

const rect = (x0: number, y0: number, w: number, h: number): [number, number][] => [
  [x0, y0],
  [x0 + w, y0],
  [x0 + w, y0 + h],
  [x0, y0 + h],
];
const circle = (cx: number, cy: number, rad: number, n = 96): [number, number][] =>
  Array.from({ length: n }, (_, i) => [cx + rad * Math.cos((2 * Math.PI * i) / n), cy + rad * Math.sin((2 * Math.PI * i) / n)] as [number, number]);

const SHAPES: Record<string, Polygons> = {
  rectangle: [rect(5, 5, 9, 7)],
  // An L: the inside corner at (10, 10) is where offset clearing spikes.
  'L shape': [
    [
      [5, 5],
      [15, 5],
      [15, 10],
      [10, 10],
      [10, 15],
      [5, 15],
    ],
  ],
  circle: [circle(10, 10, 5)],
  // A pocket round an island (the hole is CW).
  'pocket with an island': [rect(5, 5, 12, 10), rect(9.5, 9, 3, 2).reverse()],
};

// ---- the spec's own geometry: even-odd inside, on Manifold's polygons --------------------------

function inside(poly: Polygons, x: number, y: number): boolean {
  let inn = false;
  for (const c of poly) {
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const [xi, yi] = c[i]!;
      const [xj, yj] = c[j]!;
      if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inn = !inn;
    }
  }
  return inn;
}

function bbox(poly: Polygons): { minX: number; minY: number; maxX: number; maxY: number } {
  const xs = poly.flat().map((p) => p[0]);
  const ys = poly.flat().map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** A fine grid of the material in one level's slice. */
class Slice {
  readonly cell = 0.04;
  readonly x0: number;
  readonly y0: number;
  readonly nx: number;
  readonly ny: number;
  readonly standing: Uint8Array;

  /** Standing cells under the disc, without removing them. */
  count(x: number, y: number, r: number): number {
    let n = 0;
    const j0 = Math.max(0, Math.floor((y - r - this.y0) / this.cell));
    const j1 = Math.min(this.ny - 1, Math.ceil((y + r - this.y0) / this.cell));
    for (let j = j0; j <= j1; j++) {
      const dy = this.cy(j) - y;
      if (dy * dy > r * r) continue;
      const w = Math.sqrt(r * r - dy * dy);
      const i0 = Math.max(0, Math.ceil((x - w - this.x0) / this.cell - 0.5));
      const i1 = Math.min(this.nx - 1, Math.floor((x + w - this.x0) / this.cell - 0.5));
      for (let i = i0; i <= i1; i++) n += this.standing[j * this.nx + i]!;
    }
    return n;
  }

  constructor(region: Polygons) {
    const b = bbox(region);
    this.x0 = b.minX - 0.1;
    this.y0 = b.minY - 0.1;
    this.nx = Math.ceil((b.maxX - b.minX + 0.2) / this.cell);
    this.ny = Math.ceil((b.maxY - b.minY + 0.2) / this.cell);
    this.standing = new Uint8Array(this.nx * this.ny);
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) if (inside(region, this.cx(i), this.cy(j))) this.standing[j * this.nx + i] = 1;
  }

  cx(i: number) {
    return this.x0 + (i + 0.5) * this.cell;
  }

  cy(j: number) {
    return this.y0 + (j + 0.5) * this.cell;
  }

  /** Remove the disc; the area it newly removed, mm². */
  disc(x: number, y: number, r: number): number {
    let n = 0;
    const j0 = Math.max(0, Math.floor((y - r - this.y0) / this.cell));
    const j1 = Math.min(this.ny - 1, Math.ceil((y + r - this.y0) / this.cell));
    for (let j = j0; j <= j1; j++) {
      const dy = this.cy(j) - y;
      if (dy * dy > r * r) continue;
      const w = Math.sqrt(r * r - dy * dy);
      const i0 = Math.max(0, Math.ceil((x - w - this.x0) / this.cell - 0.5));
      const i1 = Math.min(this.nx - 1, Math.floor((x + w - this.x0) / this.cell - 0.5));
      for (let i = i0; i <= i1; i++) {
        const k = j * this.nx + i;
        if (this.standing[k] === 1) {
          this.standing[k] = 0;
          n++;
        }
      }
    }
    return n * this.cell * this.cell;
  }
}

const DS = 0.05;
const WINDOW = 0.5;

interface Metered {
  /** Every 0.5 mm window's engagement over the clearing and link moves of the deepest level, mm. */
  windows: number[];
  /** Where each window ends, and the role of the move it ends on — for a failure to name. */
  at: string[];
  /**
   * Every move that goes DOWN into this level's slice without cutting its way there on a helix or ramp
   * — a rapid down, or a straight feed down — whose disc still has standing material under it: a plunge
   * into material. Also any rapid below the top face that moves in X or Y.
   */
  plunges: string[];
  slice: Slice;
}

/**
 * Walk the deepest level's slice: every feed that reaches below the level above cuts it. Entry moves
 * are stamped; clearing and link moves are metered in 0.5 mm windows of travel.
 */
function meter(plan: AdaptivePlan, region: Polygons): Metered {
  const levels = plan.levels;
  const sliceTop = levels.length > 1 ? levels[levels.length - 2]! : 0;
  const slice = new Slice(region);
  const windows: number[] = [];
  const at: string[] = [];
  const plunges: string[] = [];
  let acc: { area: number; len: number }[] = [];
  let prev: [number, number, number] | null = null;
  plan.moves.forEach((m, idx) => {
    const role = plan.roles[idx]!;
    const from = prev;
    prev = [m.x, m.y, m.z];
    if (from !== null) {
      const xy = Math.hypot(m.x - from[0], m.y - from[1]);
      const down = m.z < from[2] - 1e-9;
      if (m.kind === 'rapid' && m.z < 0 && xy > 1e-9) plunges.push(`move ${idx}: an XY rapid at Z${m.z}`);
      // A straight move down whose lower end is in this slice: the disc there must already be clear.
      if (down && xy < 1e-9 && m.z < sliceTop - 1e-6 && slice.count(m.x, m.y, R) > 0) plunges.push(`move ${idx}: ${m.kind} ${role} down to Z${m.z} at (${m.x}, ${m.y})`);
    }
    if (from === null || m.kind !== 'feed' || Math.min(from[2], m.z) >= sliceTop - 1e-6) {
      acc = [];
      return;
    }
    const len = Math.hypot(m.x - from[0], m.y - from[1], m.z - from[2]);
    const n = Math.max(1, Math.ceil(len / DS));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = from[0] + (m.x - from[0]) * t;
      const y = from[1] + (m.y - from[1]) * t;
      const z = from[2] + (m.z - from[2]) * t;
      if (z >= sliceTop) continue;
      const area = slice.disc(x, y, R);
      if (role === 'entry') continue;
      acc.push({ area, len: Math.hypot(m.x - from[0], m.y - from[1]) / n });
      let L = 0;
      let A = 0;
      for (let k = acc.length - 1; k >= 0 && L < WINDOW - 1e-9; k--) {
        L += acc[k]!.len;
        A += acc[k]!.area;
      }
      if (L >= WINDOW - 1e-9) {
        windows.push(A / L);
        at.push(`${role} move ${idx} at (${x.toFixed(2)}, ${y.toFixed(2)})`);
      }
    }
    if (role === 'entry') acc = [];
  });
  return { windows, at, plunges, slice };
}

const meters = new Map<AdaptivePlan, Metered>();
/** The meter's reading of a plan, walked once however many specs read it. */
function metered(plan: AdaptivePlan, region: Polygons): Metered {
  const m = meters.get(plan) ?? meter(plan, region);
  meters.set(plan, m);
  return m;
}

const plans = new Map<string, AdaptivePlan>();
function planFor(name: string, region: Polygons, settings: AdaptiveSettings = S): AdaptivePlan {
  const key = `${name}|${JSON.stringify(settings)}`;
  const cached = plans.get(key);
  if (cached) return cached;
  const r = planAdaptive({ tool: MILL, region, depth: DEPTH, settings });
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  plans.set(key, r.plan);
  return r.plan;
}

describe('#433 the settings are the location’s', () => {
  it('reads every adaptive.* key, seeded and labelled — the feeds as placeholders, none a vendor number', () => {
    expect(S).toEqual({
      engagementFraction: 0.1,
      stepDownMm: 1,
      helixDiameterFraction: 0.5,
      rampAngleDeg: 2,
      entryClearanceMm: 0.5,
      maxCells: 12_000_000,
      residualShare: 0.005,
      neckAreaMm2: 0.05,
      cutFeed: 600,
      entryFeed: 200,
      spindleRpm: 12000,
    });
    expect(Object.values(sources).every((v) => v === 'seeded')).toBe(true);
    for (const k of ['cutFeed', 'entryFeed', 'spindleRpm']) expect(DEFAULTS[`adaptive.${k}`]?.note).toContain('placeholder, not measured; not a vendor number');
    for (const k of ['engagementFraction', 'stepDownMm', 'helixDiameterFraction', 'rampAngleDeg', 'entryClearanceMm', 'maxCells', 'residualShare', 'neckAreaMm2']) {
      expect(DEFAULTS[`adaptive.${k}`]?.note).toContain('chosen, not measured');
    }
    expect(S.cutFeed).toBeLessThanOrEqual(Z1.maxCutFeed);
    expect(S.spindleRpm).toBeLessThanOrEqual(Z1.maxRpm);
  });
});

// A 7 × 7 pocket with an 8 mm channel off its right side, a little wider than the cutter. (At
// 0.2 mm wider the planner does clear it within the cap — the independent meter read 0.26 mm — by a
// thousand short restarts across the 0.2 mm the centre can move; at 0.1 mm no step can. At 0.01 mm
// no grid cell lands where the centre may stand at all, and the neck check is what refuses it.)
const channel = (extra: number): Polygons => [
  [
    [0, 0],
    [7, 0],
    [7, 2],
    [15, 2],
    [15, 2 + D + extra],
    [7, 2 + D + extra],
    [7, 7],
    [0, 7],
  ],
];

describe.each(Object.entries(SHAPES))('#433 %s', (name, region) => {
  const allowedRef = offset(region, -R); // the centre's room, exactly: no slack, so a micron's overcut shows
  const openingRef = offset(offset(region, -R), R - 0.1); // what must be cleared, 0.1 mm in from its edge

  it('levels: equal, at most the step-down, the last on the floor', () => {
    const plan = planFor(name, region);
    expect(plan.levels).toEqual([-0.75, -1.5]);
  });

  it('engagement never exceeds the cap on any clearing or link move (0.5 mm windows, the spec’s own meter)', () => {
    const { windows, at } = metered(planFor(name, region), region);
    expect(windows.length).toBeGreaterThan(500);
    const over = windows.map((w, i) => [w, at[i]] as const).filter(([w]) => w > CAP);
    expect(over.slice(0, 8)).toEqual([]);
  });

  it('the load is constant, not a skim: the median window is a real share of the cap, the path not much longer than area / target', () => {
    const plan = planFor(name, region);
    const { windows } = metered(plan, region);
    const sorted = [...windows].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeGreaterThan(0.35 * CAP);
    expect(plan.stats.clearingLength).toBeLessThan((2 * plan.stats.targetArea) / (0.7 * CAP));
  });

  it('clears the whole region the cutter can reach, at the floor', () => {
    const { slice } = metered(planFor(name, region), region);
    const left: [number, number][] = [];
    for (let j = 0; j < slice.ny; j++) {
      for (let i = 0; i < slice.nx; i++) {
        if (slice.standing[j * slice.nx + i] === 1 && inside(openingRef, slice.cx(i), slice.cy(j))) left.push([slice.cx(i), slice.cy(j)]);
      }
    }
    expect(left.slice(0, 5)).toEqual([]);
  });

  it('no gouge: every point along every cutting move keeps the cutter inside the region', () => {
    const plan = planFor(name, region);
    let prev: [number, number, number] | null = null;
    const out: string[] = [];
    for (const m of plan.moves) {
      if (prev !== null && m.kind === 'feed' && Math.min(prev[2], m.z) < 0) {
        const len = Math.hypot(m.x - prev[0], m.y - prev[1]);
        const n = Math.max(1, Math.ceil(len / DS));
        for (let i = 0; i <= n; i++) {
          const x = prev[0] + ((m.x - prev[0]) * i) / n;
          const y = prev[1] + ((m.y - prev[1]) * i) / n;
          if (!inside(allowedRef, x, y)) out.push(`(${x.toFixed(3)}, ${y.toFixed(3)})`);
        }
      }
      prev = [m.x, m.y, m.z];
    }
    expect(out.slice(0, 5)).toEqual([]);
  });

  it('enters by a helix on its circle at the ramp angle; never plunges into material', () => {
    const plan = planFor(name, region);
    expect(metered(plan, region).plunges.slice(0, 5)).toEqual([]);
    expect(plan.entries.length).toBeGreaterThanOrEqual(1);
    const e = plan.entries[0]!;
    if (e.kind !== 'helix') throw new Error('expected a helix');
    expect(e.radius).toBeCloseTo((S.helixDiameterFraction * D) / 2, 9);
    const tan = Math.tan((S.rampAngleDeg * Math.PI) / 180);
    let prev: [number, number, number] | null = null;
    plan.moves.forEach((m, idx) => {
      const role = plan.roles[idx]!;
      if (prev !== null && m.kind === 'feed') {
        const xy = Math.hypot(m.x - prev[0], m.y - prev[1]);
        const dz = prev[2] - m.z;
        if (role === 'entry') {
          expect(Math.abs(Math.hypot(m.x - e.centre[0], m.y - e.centre[1]) - e.radius)).toBeLessThan(2e-3);
          // Descending on the helix: no steeper than the ramp angle (chords are a hair short of the arc).
          if (dz > 1e-9 && xy > 1e-9) expect(dz / xy).toBeLessThanOrEqual(tan * 1.02 + 1e-3 / xy);
        }
        // A pure-Z feed down is only ever into a cleared column (a link's last leg) or above the stock.
        if (xy < 1e-9 && dz > 0) expect(role === 'link' || prev[2] > 0).toBe(true);
      }
      prev = [m.x, m.y, m.z];
    });
  });
});

describe('#433 entry: the helix refused, the ramp, and no entry at all', () => {
  // A slot 0.4 mm wider than the cutter: the helix's 4.76 mm bore does not fit; a ramp line does.
  const slot: Polygons = [rect(5, 5, 16, D + 0.4)];

  it('a slot too narrow for the helix ramps in instead, says so, and still clears', () => {
    const r = { plan: planFor('slot', slot) };
    expect(r.plan.findings.map((f) => f.code)).toEqual(['adaptive-helix-refused']);
    expect(r.plan.findings[0]!.message).toMatch(/4\.762 mm bore/);
    const e = r.plan.entries[0]!;
    expect(e.kind).toBe('ramp');
    if (e.kind !== 'ramp') return;
    // Every entry move lies on the ramp line, no steeper than the ramp angle.
    const tan = Math.tan((S.rampAngleDeg * Math.PI) / 180);
    const [ax, ay] = e.a;
    const [bx, by] = e.b;
    const L = Math.hypot(bx - ax, by - ay);
    let prev: [number, number, number] | null = null;
    r.plan.moves.forEach((m, idx) => {
      if (prev !== null && m.kind === 'feed' && r.plan.roles[idx] === 'entry') {
        const cross = Math.abs((bx - ax) * (m.y - ay) - (by - ay) * (m.x - ax)) / L;
        expect(cross).toBeLessThan(2e-3);
        const xy = Math.hypot(m.x - prev[0], m.y - prev[1]);
        if (xy > 1e-9) expect((prev[2] - m.z) / xy).toBeLessThanOrEqual(tan + 1e-3 / xy);
      }
      prev = [m.x, m.y, m.z];
    });
    const { windows, slice, plunges } = meter(r.plan, slot);
    expect(plunges).toEqual([]);
    if (windows.length > 0) expect(Math.max(...windows)).toBeLessThanOrEqual(CAP);
    const opening = offset(offset(slot, -R), R - 0.1);
    let left = 0;
    for (let j = 0; j < slice.ny; j++) for (let i = 0; i < slice.nx; i++) if (slice.standing[j * slice.nx + i] === 1 && inside(opening, slice.cx(i), slice.cy(j))) left++;
    expect(left).toBe(0);
  });

  it('a pocket with room for neither a helix nor a cutter-length ramp is refused, not plunged', () => {
    const r = planAdaptive({ tool: MILL, region: [circle(10, 10, R + 0.3)], depth: 1, settings: S });
    expect(r).toMatchObject({ ok: false, code: 'adaptive-no-entry' });
    if (!r.ok) expect(r.reason).toMatch(/not plunged/);
  });

  it('a pocket narrower than the cutter is refused', () => {
    expect(planAdaptive({ tool: MILL, region: [circle(10, 10, R - 0.1)], depth: 1, settings: S })).toMatchObject({ ok: false, code: 'adaptive-no-room' });
  });

  it.each([0.1, 0.01])('a channel %s mm wider than the cutter cannot be cleared within the cap: refused, not slotted, not left', (extra) => {
    const r = planAdaptive({ tool: MILL, region: channel(extra), depth: 1, settings: S });
    expect(r).toMatchObject({ ok: false, code: 'adaptive-engagement-exceeded' });
  });
});

describe('#433 refusals before any planning', () => {
  it('a ball, a V or a bull nose is refused by name; a pocket with no depth; settings out of range', () => {
    const region = SHAPES.rectangle!;
    expect(planAdaptive({ tool: { ...MILL, shape: 'ball', typeText: 'Ball' }, region, depth: 1, settings: S })).toMatchObject({ ok: false, code: 'adaptive-not-flat' });
    expect(planAdaptive({ tool: { ...MILL, cornerRadius: 0.5 }, region, depth: 1, settings: S })).toMatchObject({ ok: false, code: 'adaptive-not-flat' });
    expect(planAdaptive({ tool: MILL, region, depth: 0, settings: S })).toMatchObject({ ok: false, code: 'adaptive-bad-settings' });
    expect(planAdaptive({ tool: MILL, region, depth: 1, settings: { ...S, helixDiameterFraction: 1.2 } })).toMatchObject({ ok: false, code: 'adaptive-bad-settings' });
    // #451 — the four new keys are held to the same bounds the location enforces on them.
    for (const bad of [{ entryClearanceMm: 0 }, { maxCells: 500 }, { maxCells: 1.5 }, { residualShare: 0.6 }, { neckAreaMm2: -1 }]) {
      expect(planAdaptive({ tool: MILL, region, depth: 1, settings: { ...S, ...bad } })).toMatchObject({ ok: false, code: 'adaptive-bad-settings' });
    }
  });
});

describe('#433 the refusal limits and entry clearance are the shop’s (#451)', () => {
  it('refuses a grid larger than the shop cap, naming the cap it actually used', () => {
    const r = planAdaptive({ tool: MILL, region: SHAPES.rectangle!, depth: 1, settings: { ...S, maxCells: 1000 } });
    expect(r).toMatchObject({ ok: false, code: 'adaptive-region-too-large' });
    if (r.ok) return;
    expect(r.reason).toContain('the cap is 1,000');
    // The message carries the configured number, not the shipped seed the code used to quote.
    expect(r.reason).not.toContain('12,000,000');
  });

  it('the residual tolerance is the shop share of the area to clear', () => {
    const base = planFor('circle', SHAPES.circle!);
    // The default plan leaves grid noise along the curved wall; without any, this test would assert nothing.
    expect(base.stats.residualArea).toBeGreaterThan(0);
    const share = base.stats.residualArea / base.stats.targetArea;
    const tight = planAdaptive({ tool: MILL, region: SHAPES.circle!, depth: DEPTH, settings: { ...S, residualShare: share * 0.5 } });
    expect(tight).toMatchObject({ ok: false, code: 'adaptive-engagement-exceeded' });
    if (!tight.ok) expect(tight.reason).toContain('cannot be cleared without passing');
    // A share above what the plan leaves accepts it: the check reads the number, not a margin.
    expect(planAdaptive({ tool: MILL, region: SHAPES.circle!, depth: DEPTH, settings: { ...S, residualShare: share * 1.1 } }).ok).toBe(true);
  });

  it('the neck area threshold is the shop’s', () => {
    // The 0.01 mm channel has no cell where the centre may stand: the neck check is what refuses it.
    const base = planAdaptive({ tool: MILL, region: channel(0.01), depth: 1, settings: S });
    expect(base).toMatchObject({ ok: false });
    if (!base.ok) expect(base.reason).toContain('lies in a part of the pocket within');
    // A threshold above the neck's measured 20.8 mm² stands the check down: whatever refusal remains
    // is a different one, so the number is read rather than the check being unavoidable.
    const loose = planAdaptive({ tool: MILL, region: channel(0.01), depth: 1, settings: { ...S, neckAreaMm2: 50 } });
    if (!loose.ok) expect(loose.reason).not.toContain('lies in a part of the pocket within');
  });
});

describe('#433 posted and verified', () => {
  const STOCK = { length: 40, width: 30, thickness: 6 };
  const setup = stubSetup({ kind: 'prism', outline: rectProfile(40, 30), thickness: 6 }, { kind: 'tape-down', contact: rectProfile(40, 30) }, { startingTool: 1 }, Z1);

  const post = (ir: ReturnType<typeof adaptivePlanIR>) => {
    expect(ir.spindleRpm).toBe(12000);
    const p = postZ1(ir, { jobName: 'adaptive', stock: STOCK, materialName: 'Aluminium', zDatum: 'probed-top-face', origin: 'topFrontLeft', camVersion: 'test', toolKey: 'inv:kz-flat-3175' }, Z1);
    if (!p.ok) throw new Error(p.errors.join('; '));
    expect(p.text).toMatch(/S12000 M3/);
    return p.text;
  };
  const verify = (text: string) => verifyProgram(text, { setup, machine: Z1, tool: MILL, depthLimit: stockDepthLimit(STOCK, 1), minRapidZ: HOP_Z });

  const ctx = { tool: MILL, depth: DEPTH, settings: S, name: '[T1]Adaptive', labelId: 'pocket', air: true, rapid: Z1.rapidEstimate };

  it('a helix-entry pocket (the rectangle): the posted program passes every check', () => {
    const report = verify(post(adaptivePlanIR(planFor('rectangle', SHAPES.rectangle!), ctx)));
    expect(report.findings).toEqual([]);
    expect(report.stats.deepestZ).toBeCloseTo(-DEPTH, 3);
  });

  it('a ramp-entry pocket (the narrow slot): the posted program passes every check', () => {
    const report = verify(post(adaptivePlanIR(planFor('slot', [rect(5, 5, 16, D + 0.4)]), ctx)));
    expect(report.findings).toEqual([]);
    expect(report.stats.deepestZ).toBeCloseTo(-DEPTH, 3);
  });

  it('levels shallower than the entry clearance (step-down 0.4): no feed ends above the face, and it posts clean', () => {
    const r = adaptiveIR({ ...ctx, region: [rect(5, 5, 8, 6)], depth: 1, settings: { ...S, stepDownMm: 0.4 } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.levels).toEqual([-0.333, -0.667, -1]);
    for (const m of r.plan.moves) if (m.kind === 'feed') expect(m.z).toBeLessThanOrEqual(0);
    // The first level is approached at the entry feed from the hop height, not rapided onto the face.
    const firstFeed = r.plan.moves.findIndex((m) => m.kind === 'feed');
    expect(r.plan.moves[firstFeed - 1]).toMatchObject({ kind: 'rapid', z: HOP_Z });
    expect(r.plan.moves[firstFeed]).toMatchObject({ z: 0, f: S.entryFeed });
    const report = verify(post(r.ir));
    expect(report.findings).toEqual([]);
    expect(report.stats.deepestZ).toBeCloseTo(-1, 3);
  });

  it('an entry starts the shop clearance above the floor just cut (#451)', () => {
    const region = [rect(5, 5, 8, 6)];
    const custom = adaptiveIR({ ...ctx, region, depth: 0.4, settings: { ...S, stepDownMm: 0.2, entryClearanceMm: 0.1 } });
    if (!custom.ok) throw new Error(custom.reason);
    expect(custom.plan.levels).toEqual([-0.2, -0.4]);
    // The second level's entry travels down the cleared column to 0.1 mm above the −0.2 floor — a
    // rapid at −0.1 that the shipped 0.5 mm clearance (capped at the face) never writes.
    expect(custom.plan.moves.some((m) => m.kind === 'rapid' && m.z === -0.1)).toBe(true);
    const shipped = adaptiveIR({ ...ctx, region, depth: 0.4, settings: { ...S, stepDownMm: 0.2 } });
    if (!shipped.ok) throw new Error(shipped.reason);
    expect(shipped.plan.moves.some((m) => m.kind === 'rapid' && m.z === -0.1)).toBe(false);
    expect(verify(post(custom.ir)).findings).toEqual([]);
  });
});
