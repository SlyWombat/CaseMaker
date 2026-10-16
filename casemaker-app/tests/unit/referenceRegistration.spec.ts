// #429 — registration on features cut in an earlier setup: an opening a through-cut left reads as a miss
// to the Z-only probe, so its walls are found by #430's stepped scan. A fake Z1 holds the stock, where it
// really sits (shifted, turned), and its openings — with floors, burrs and chips when a test asks.
// Nothing reaches a machine.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import {
  applyCorrection,
  planReferences,
  registrationSettings,
  runRegistration,
  summarizePlan,
  widthTolerance,
  type ReferenceOpening,
  type ReferencePlanInput,
  type RegistrationPlan,
} from '@/engine/cnc/registration';
import { planSetups, referenceOpenings, referenceRegistrationFor, setupsSettings, type Removal } from '@/engine/cnc/setups';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = ShopDefaultsSchema.parse((JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults);
const { settings: S, fallbacks } = registrationSettings(DEFAULTS);

const G54 = { x: -150, y: -150 };
const SURFACE = -56;
const STOCK = { xMin: 0, yMin: 0, xMax: 80, yMax: 60, cornerRadius: 0 };
const A: ReferenceOpening = { itemId: 'a', name: 'hole A', min: [10, 26], max: [18, 34], depth: 10 };
const B: ReferenceOpening = { itemId: 'b', name: 'hole B', min: [62, 26], max: [70, 34], depth: 10 };

const input = (over: Partial<ReferencePlanInput> = {}): ReferencePlanInput => ({
  stock: STOCK,
  mount: 'vise',
  expectedSurface: { machineZ: SURFACE, from: 'the vise ledge + 10 mm' },
  fixtureBelowSurfaceMm: 6.9,
  openings: [A, B],
  ...over,
});
function plan(over: Partial<ReferencePlanInput> = {}): RegistrationPlan {
  const r = planReferences(input(over), S);
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
}

type Patch = { min: [number, number]; max: [number, number]; z: number };
/**
 * A fake Z1. The part — 0..80 × 0..60 with its openings — sits shifted by `shift` and turned `turnDeg`
 * (counter-clockwise from above) about its centre. The stock reads the probe out to the rim offset past
 * its edge; an opening is a MISS once the probe's centre is more than the rim offset inside it, unless a
 * `patch` (a floor, a burr, a chip — in the part's own frame) says what is there.
 */
function fakeZ1(opts: { holes?: ReferenceOpening[]; shift?: { x: number; y: number }; turnDeg?: number; patches?: Patch[] } = {}) {
  const RIM = 0.7;
  const holes = opts.holes ?? [A, B];
  const t = ((opts.turnDeg ?? 0) * Math.PI) / 180;
  const d = opts.shift ?? { x: 0, y: 0 };
  let mode: 'G90' | 'G91' = 'G90';
  const pos = { x: 0, y: 0, z: -3 };
  let alarmed = false;
  let lowestTouch = Infinity;
  const lines: string[] = [];
  const xyAtZ: number[] = [];
  const reply = (text: string): ConsoleSendResult => ({ kind: 'sent', line: '', text, frames: 1, elapsedMs: 1 });
  const zAt = (wx: number, wy: number): number | null => {
    // Into the part's frame: undo the shift, then the turn about the centre.
    const px = wx - d.x - 40;
    const py = wy - d.y - 30;
    const x = Math.cos(-t) * px - Math.sin(-t) * py + 40;
    const y = Math.sin(-t) * px + Math.cos(-t) * py + 30;
    const patch = opts.patches?.find((p) => x >= p.min[0] - RIM && x <= p.max[0] + RIM && y >= p.min[1] - RIM && y <= p.max[1] + RIM);
    if (patch) return SURFACE + patch.z;
    const onStock = x >= -RIM && x <= 80 + RIM && y >= -RIM && y <= 60 + RIM;
    const inHole = holes.some((h) => x > h.min[0] + RIM && x < h.max[0] - RIM && y > h.min[1] + RIM && y < h.max[1] - RIM);
    return onStock && !inHole ? SURFACE : null;
  };
  const console = {
    async send(line: string): Promise<ConsoleSendResult> {
      lines.push(line);
      if (line === '?') return reply(alarmed ? '<Alarm|MPos:0,0,0>' : '<Idle|MPos:0,0,0>');
      if (line === '$X') return (alarmed = false), reply('ok');
      if (alarmed) return reply('error:Alarm lock');
      if (['$H', 'G54', 'G92.1'].includes(line) || /^G10 L2 P1 /.test(line)) return reply('ok');
      if (line === 'M491') return reply('[PRB:-9.890,-12.830,-76.063:1]\nok');
      if (line === 'G90' || line === 'G91') return (mode = line), reply('ok');
      let m = /^G53 G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z = Number(m[1])), reply('ok');
      m = /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) {
        xyAtZ.push(pos.z);
        pos.x = Number(m[1]) + G54.x;
        pos.y = Number(m[2]) + G54.y;
        return reply('ok');
      }
      m = /^G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z += Number(m[1])), reply('ok');
      m = /^G38\.2 Z-([\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('probed in absolute mode');
        const target = pos.z - Number(m[1]);
        const hit = zAt(pos.x - G54.x, pos.y - G54.y);
        if (hit !== null && hit >= target && hit <= pos.z) {
          pos.z = hit;
          lowestTouch = Math.min(lowestTouch, hit);
          return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${hit.toFixed(3)}:1]\nok`);
        }
        pos.z = target;
        lowestTouch = Math.min(lowestTouch, target);
        alarmed = true;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\nALARM: Probe fail`);
      }
      return reply(`error:unexpected line ${line}`);
    },
  };
  return { console, lines, xyAtZ, lowest: () => lowestTouch };
}
const yes = async () => true;
async function run(p: RegistrationPlan, fake = fakeZ1()) {
  const r = await runRegistration(p, { console: fake.console, operator: yes });
  if (!r.ok) throw new Error(r.reason);
  return { ...r, fake };
}

describe('#429 the plan', () => {
  it('reads the probe’s measured diameter and rim spread from the location', () => {
    expect(fallbacks).toEqual([]);
    expect(S).toMatchObject({ tipDiameterMm: 2, tipRadiusUncertaintyMm: 0.25 });
    expect(DEFAULTS['registration.tipDiameterMm']?.source).toBe('measured');
  });

  it('scans both walls of each axis on the opening’s mid-line, capped at its centre; the turn’s resolution is worked out', () => {
    const p = plan();
    expect(p.references!.map((r) => [r.name, r.xScans.length, r.yScans.length])).toEqual([
      ['hole A', 2, 2],
      ['hole B', 2, 2],
    ]);
    expect(p.scans[0]).toMatchObject({ label: 'the left wall of hole A', expectedAt: 10, along: 30, outward: 1, start: 10 - S.scanInsideMm, limit: 14 });
    for (const [i, sc] of p.scans.entries()) {
      const ref = p.references!.find((r) => [...r.xScans, ...r.yScans].includes(i))!;
      const c = sc.edge === 'left' || sc.edge === 'right' ? ref.centre.x : ref.centre.y;
      expect(sc.outward * (c - sc.limit)).toBeGreaterThanOrEqual(0);
    }
    // 52 mm apart, centres to ±0.125: a turn is read to ±0.385 mm across the 80 mm stock.
    expect(p.referenceRotation).toEqual({ between: ['a', 'b'], separation: 52, resolutionMm: 0.385 });
    expect(summarizePlan(p)).toContain('the left wall of hole A, the right wall of hole A');
    expect(summarizePlan(p)).not.toContain('right edge');
  });

  it('touches the surface at the cut area’s centre when it is clear, and moves it off an opening when not', () => {
    expect(plan({ cutCentre: { x: 30, y: 15 } }).surfacePoint).toEqual({ x: 30, y: 15 });
    const middle: ReferenceOpening = { itemId: 'm', name: 'centre bore', min: [35, 25], max: [45, 35], depth: 10 };
    const { x, y } = plan({ openings: [middle], cutCentre: { x: 40, y: 30 } }).surfacePoint;
    expect(x > 32 && x < 48 && y > 22 && y < 38).toBe(false);
  });

  it('refuses what it cannot read: a hole narrower than the tip allows, one shallower than the cap, the bracket', () => {
    const tiny: ReferenceOpening = { itemId: 't', name: 'a 2.5 mm hole', min: [38.75, 28.75], max: [41.25, 31.25], depth: 10 };
    expect(planReferences(input({ openings: [tiny] }), S)).toMatchObject({ ok: false, reason: expect.stringContaining('too small to probe with the 2 mm tip') });
    expect(planReferences(input({ openings: [{ ...A, depth: 0.4 }] }), S)).toMatchObject({ ok: false, reason: expect.stringContaining('within the touch cap') });
    expect(planReferences(input({ mount: 'bracket' }), S)).toMatchObject({ ok: false, reason: expect.stringContaining('datum') });
  });

  it('one wall alone is not a measurement: an axis is planned only with both its walls', () => {
    const notch: ReferenceOpening = { itemId: 'n', name: 'the edge notch', min: [0, 26], max: [8, 34], depth: 10 };
    const p = plan({ openings: [notch, B] });
    expect(p.references![0]).toMatchObject({ name: 'the edge notch', xScans: [] });
    expect(p.references![0]!.yScans).toHaveLength(2);
    expect(p.notes.join(' ')).toContain('the edge notch across X: only one wall has solid stock outside it');
  });

  it('tape: one reference, or two too close together, cannot read the turn — refused', () => {
    expect(planReferences(input({ mount: 'tape', fixtureBelowSurfaceMm: undefined, openings: [A] }), S)).toMatchObject({ ok: false, reason: expect.stringContaining('needs two references') });
    const near = { ...B, min: [26, 26] as [number, number], max: [34, 34] as [number, number] };
    expect(planReferences(input({ mount: 'tape', fixtureBelowSurfaceMm: undefined, openings: [A, near] }), S)).toMatchObject({ ok: false, reason: expect.stringContaining('only 16 mm apart') });
  });

  it('blind cuts on the face now up are kept clear of', () => {
    const pocket = { min: [0, 0] as [number, number], max: [9, 60] as [number, number] };
    const p = plan({ blind: [pocket] });
    // The left wall of hole A would start at X 7, inside the pocket: hole A is not read across X.
    expect(p.references![0]!.xScans).toEqual([]);
  });
});

describe('#429 the run', () => {
  it('a flip that landed 0.4 mm right and 0.3 mm forward is found and corrected — after the operator confirms', async () => {
    const { outcome: o, fake } = await run(plan(), fakeZ1({ shift: { x: 0.4, y: -0.3 } }));
    expect(o.usable).toBe(true);
    expect(Math.abs(o.offset.x - 0.4)).toBeLessThanOrEqual(0.125);
    expect(Math.abs(o.offset.y + 0.3)).toBeLessThanOrEqual(0.125);
    // Never below the surface − cap on a scan touch (the surface seek is bounded by its own band).
    expect(fake.lowest()).toBeGreaterThanOrEqual(SURFACE - Math.max(S.capBelowSurfaceMm, S.surfaceToleranceMm) - 1e-9);
    const park = SURFACE + S.parkAboveSurfaceMm;
    for (const z of fake.xyAtZ) expect(z === -3 || Math.abs(z - park) < 1e-6).toBe(true);
    expect(await applyCorrection(o, { console: fake.console, operator: yes }, { confirmed: false })).toMatchObject({ ok: false });
    expect(fake.lines.some((l) => l.startsWith('G10'))).toBe(false);
    const applied = await applyCorrection(o, { console: fake.console, operator: yes }, { confirmed: true });
    expect(applied.ok && applied.line).toMatch(new RegExp(`^G10 L2 P1 X${(G54.x + o.offset.x).toFixed(3)} Y${(G54.y + o.offset.y).toFixed(3)} `));
  });

  it('a scan touch never goes below the surface − cap', async () => {
    const { fake } = await run(plan(), fakeZ1());
    expect(fake.lowest()).toBeGreaterThanOrEqual(SURFACE - S.capBelowSurfaceMm - 1e-9);
  });

  it('a real turn, with its sign: 1° counter-clockwise is past the margin and unusable', async () => {
    const { outcome: o, fake } = await run(plan(), fakeZ1({ turnDeg: 1 }));
    expect(o.rotationDeg).toBeGreaterThan(0.6);
    expect(o.rotationDeg).toBeLessThan(1.4);
    expect(o.usable).toBe(false);
    expect(o.problems.join(' ')).toContain('re-seat it square');
    expect(await applyCorrection(o, { console: fake.console, operator: yes }, { confirmed: true })).toMatchObject({ ok: false });
    const cw = (await run(plan(), fakeZ1({ turnDeg: -1 }))).outcome;
    expect(cw.rotationDeg).toBeLessThan(-0.6);
  });

  it('a small turn within the margin is usable — and never a false “re-seat it”', async () => {
    const { outcome: o } = await run(plan(), fakeZ1({ turnDeg: 0.15 }));
    expect(o.usable).toBe(true);
    expect(Math.abs(o.rotationShiftMm!)).toBeLessThanOrEqual(S.edgeMarginMm + 0.385);
  });

  it('a burr on the exit edge, or a chip in the hole, moves a wall: the width check makes it unusable', async () => {
    const burr: Patch = { min: [10, 26], max: [11.2, 34], z: 0.05 }; // within the band: reads as stock
    const b = (await run(plan(), fakeZ1({ patches: [burr] }))).outcome;
    expect(b.usable).toBe(false);
    expect(b.problems.join(' ')).toMatch(/hole A measures [\d.]+ mm across X, not its 8 mm .*burr/);
    expect(widthTolerance(S)).toBe(0.75);
    const chip: Patch = { min: [63.5, 29], max: [65, 31], z: 0 };
    expect((await run(plan(), fakeZ1({ patches: [chip] }))).outcome.problems.join(' ')).toContain('hole B measures');
    // A taller burr reads above the surface: named as something in the way.
    const tall: Patch = { min: [10, 26], max: [11.2, 34], z: 0.8 };
    expect((await run(plan(), fakeZ1({ patches: [tall] }))).outcome.problems.join(' ')).toContain('higher than the stock');
  });

  it('a floor in the hole above the cap still reads as off the stock', async () => {
    const floors: Patch[] = [
      { min: [11.5, 27.5], max: [16.5, 32.5], z: -0.3 },
      { min: [63.5, 27.5], max: [68.5, 32.5], z: -0.3 },
    ];
    expect((await run(plan(), fakeZ1({ patches: floors }))).outcome.usable).toBe(true);
  });

  it('a hole shifted so far the first touch is already in it: not where the job expects', async () => {
    const { outcome: o } = await run(plan(), fakeZ1({ shift: { x: -4, y: 0 } }));
    expect(o.usable).toBe(false);
    expect(o.problems.join(' ')).toContain('was already off the stock');
  });

  it('a part misplaced so the surface touch falls into a hole stops before any scan', async () => {
    const p = plan();
    const fake = fakeZ1({ shift: { x: p.surfacePoint.x - 14, y: p.surfacePoint.y - 30 } });
    const r = await runRegistration(p, { console: fake.console, operator: yes });
    // The bounded seek finds nothing down to the band, and the run stops there, saying how low the probe may be.
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('the surface seek') });
    expect(fake.lines.filter((l) => l.startsWith('G38.2'))).toHaveLength(1);
  });

  it('a hole that is not there makes the result unusable, by its label', async () => {
    const { outcome: o } = await run(plan(), fakeZ1({ holes: [A] }));
    expect(o.usable).toBe(false);
    expect(o.problems.join(' ')).toContain('the left wall of hole B was not found');
  });
});

describe('#429 from the setups engine', () => {
  const pocket: Removal = { id: 'p', name: 'pocket', volume: 1000, box: { min: [40, 10, 6], max: [70, 50, 10] }, opensTo: ['top'] };
  const chamfer: Removal = { id: 'ch', name: 'back chamfer', volume: 100, box: { min: [40, 20, 0], max: [60, 40, 2] }, opensTo: ['bottom'] };
  const setup2 = (hole: Removal) =>
    planSetups({ stock: { x: 100, y: 60, z: 10 }, removals: [pocket, hole, chamfer], mount: { kind: 'vise', viseOpeningMm: 120 } }, setupsSettings(DEFAULTS)).setups[1]!;

  it('one connected through hole: mirrored by the flip, with its own depth, and planned as a reference', () => {
    const bore: Removal = { id: 'bore', name: 'the bore', volume: 200, box: { min: [10, 20, 0], max: [20, 30, 10] }, opensTo: ['top', 'bottom'], connected: true };
    const two = setup2(bore);
    const { openings, blind } = referenceOpenings(two);
    // The vise flip turns about X: Y mirrors (20..30 → 30..40), X stays.
    expect(openings).toEqual([{ itemId: 'bore', name: 'the bore', min: [10, 30], max: [20, 40], depth: 10 }]);
    // The pocket was cut into the face now DOWN, and the chamfer is this setup's own: nothing blind on this face.
    expect(blind).toEqual([]);
    const r = referenceRegistrationFor(two, { kind: 'vise' }, { seatMachineZ: -66, cornerRadius: 0 }, S);
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.scans.every((sc) => sc.label?.includes('the bore'))).toBe(true);
  });

  it('a group of holes is not one opening: refused as a reference, by name', () => {
    const four: Removal = { id: 'h4', name: 'the four holes', volume: 200, box: { min: [10, 10, 0], max: [30, 50, 10] }, opensTo: ['top', 'bottom'] };
    const r = referenceRegistrationFor(setup2(four), { kind: 'vise' }, { seatMachineZ: -66, cornerRadius: 0 }, S);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('the four holes: not marked as one connected opening') });
  });
});
