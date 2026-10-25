// #475 — the registration executor measures the cut's extents, not just the registration point;
// #608 — the verdict is the RESIDUAL after a plane fit, so a tilt is followed; #631 — a dome is
// no longer refused: the origin is still written and the machine levels the top itself.
//
// Two blanks, both against a FAKE controller and today's numbers:
//
//   - the badge of Appendix C, whose dome (the centre 0.33 mm above every extent) a plane cannot
//     explain — its residual exceeds the 0.2 mm band, so the `dome` verdict, origin written;
//   - the bench's thin laminate (76 × 25.35 × 1.5, 0.075 mm cap), whose 0.08 mm near-linear ramp
//     fits its 0.225 mm band — a pass, with Z0 at the lowest touch.
//
// Nothing here reaches a machine.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  surfaceSpreadPlan,
  type SurfaceSpreadPlan,
} from '@/engine/cnc/engrave/surfaceSpread';
import {
  planRegistration,
  registrationSettings,
  runRegistration,
  type ExpectedStock,
  type PlanInput,
  type RegistrationPlan,
} from '@/engine/cnc/registration';
import { defaultBadgeParams } from '@/types/badge';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  defaults: unknown;
};
const { settings: S } = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults));

/** The badge blank of Appendix C, origin at its front-left corner. */
const BADGE_STOCK: ExpectedStock = { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 };
/** The bench's thin two-colour laminate. */
const LAMINATE_STOCK: ExpectedStock = { xMin: 0, yMin: 0, xMax: 76, yMax: 25.35, cornerRadius: 1.5 };

const G54 = { x: -181.55, y: -184.8 };
const COLOUR_0_2 = { kind: 'printed' as const, capMm: 0.81, layerHeight: 0.2, firstLayerHeight: 0.2 };

/** The badge's own blank, with the demo line placed over the magnet pocket (nearJaw's x = 24). */
function badgeJob(): EngraveJob {
  const blank = badgeBlankFor(defaultBadgeParams({ print: undefined }));
  const base = defaultEngraveJob();
  const line = base.labels[0] as EngraveLabel;
  return {
    ...base,
    stock: { ...blank.stock, colour: COLOUR_0_2 },
    workholding: { kind: 'vise', vise: { ...base.workholding.vise, stockProud: 1.905 } },
    keepOuts: blank.pocket ? [blank.pocket] : [],
    labels: [{ ...line, position: { x: 24, y: 43 }, depth: 1.1 }],
  };
}

/** The bench's thin film: 1.5 mm laminate with a 0.075 mm cap, one line inside its width. */
function laminateJob(): EngraveJob {
  const base = defaultEngraveJob();
  const line = base.labels[0] as EngraveLabel;
  return {
    ...base,
    stock: {
      ...base.stock,
      length: 76,
      width: 25.35,
      thickness: 1.5,
      material: 'petg',
      colour: { kind: 'laminate', capMm: 0.075 },
    },
    workholding: {
      ...base.workholding,
      kind: 'vise',
      vise: { ...base.workholding.vise, stockProud: -1.6 },
    },
    labels: [{ ...line, text: 'CASE', size: 10, position: { x: 38, y: 12.675 }, depth: 0.1 }],
    keepOuts: [],
  };
}

function registrationPlan(
  stock: ExpectedStock,
  surfaceZ: number,
  cutCentre: { x: number; y: number },
): RegistrationPlan {
  const input: PlanInput = {
    stock,
    mount: 'vise',
    expectedSurface: { machineZ: surfaceZ, from: 'the blank as the setup holds it' },
    seekFromMachineZ: -3,
    fixtureBelowSurfaceMm: 0.72,
    cutCentre,
  };
  const planned = planRegistration(input, S);
  if (!planned.ok) throw new Error(planned.reason);
  return planned.plan;
}

/** One reading the fake surface answers at a work XY. */
interface PointReading {
  x: number;
  y: number;
  z: number;
}

/**
 * A fake Z1 honouring G90/G91, with a surface that can vary by XY. `readings` are answered at their
 * own points; everywhere else on the stock reads `surface`. A jaw top 0.47 below the surface lies
 * 10 mm left of the stock, so the edge scans bracket and classify as #430's fake does. Every XY move
 * records the Z it happened at.
 */
function fakeZ1(opts: {
  actual: ExpectedStock;
  surface: number;
  readings?: readonly PointReading[];
  jaw?: boolean;
}) {
  const a = opts.actual;
  let mode: 'G90' | 'G91' = 'G90';
  const pos = { x: 0, y: 0, z: -3 };
  let tool: 'probe' | 'cutter' = 'probe';
  let alarmed = false;
  let lowest = Infinity;
  const lines: string[] = [];
  const xyMovesAtZ: number[] = [];
  const reply = (text: string): ConsoleSendResult => ({ kind: 'sent', line: '', text, frames: 1, elapsedMs: 1 });
  const RIM = 0.7;

  const zAt = (wx: number, wy: number): number | null => {
    // A point reading is a spot on the blank. The executor places the extent touches by the offset
    // the scans FOUND (#591), which is only as exact as the scan's fine step and rim correction, so
    // a touch within that resolution of the point reads it — as the real blank would.
    const MATCH_MM = 0.6;
    const point = opts.readings?.find((r) => Math.abs(r.x - wx) <= MATCH_MM && Math.abs(r.y - wy) <= MATCH_MM);
    if (point !== undefined) return point.z;
    if (wx >= a.xMin - RIM && wx <= a.xMax + RIM && wy >= a.yMin - RIM && wy <= a.yMax + RIM) {
      return opts.surface;
    }
    if (opts.jaw === true && wx < a.xMin && wx > a.xMin - 10) return opts.surface - 0.47;
    return null;
  };

  const console = {
    async send(line: string): Promise<ConsoleSendResult> {
      lines.push(line);
      if (line === '?') {
        return reply(alarmed ? '<Alarm|MPos:0,0,0>' : '<Idle|MPos:0,0,0>');
      }
      if (line === '$X') return (alarmed = false), reply('ok');
      // The Z1 refuses everything but `$X` (and `?`) in alarm — `G90` included (Z1-Firmware-Dialect.md).
      if (alarmed) return reply('error:Alarm lock');
      if (line === '$H') return (pos.x = -1), (pos.y = -1), (pos.z = -1), reply('ok');
      if (line === 'G54' || line === 'G92.1') return reply('ok');
      if (line === 'M119') return reply('X_min:0 Y_min:0 Z_min:0 X_max:0 Y_max:0 Z_max:0 Probe:0');
      if (line === 'M491') {
        const z = tool === 'probe' ? -76.063 : -79.163;
        return reply(`[PRB:-9.890,-12.830,${z - 0.011}:1]\nok\n[PRB:-9.890,-12.830,${z}:1]\nDone ATC`);
      }
      if (line === 'G90' || line === 'G91') return (mode = line), reply('ok');
      let m = /^G53 G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z = Number(m[1])), reply('ok');
      m = /^G53 G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) {
        xyMovesAtZ.push(pos.z);
        pos.x = Number(m[1]);
        pos.y = Number(m[2]);
        return reply('ok');
      }
      m = /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) {
        xyMovesAtZ.push(pos.z);
        if (mode === 'G90') {
          pos.x = Number(m[1]) + G54.x;
          pos.y = Number(m[2]) + G54.y;
        } else {
          pos.x += Number(m[1]);
          pos.y += Number(m[2]);
        }
        return reply('ok');
      }
      m = /^G0 Z(-?[\d.]+)$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('a Z move in absolute work coordinates');
        return (pos.z += Number(m[1])), reply('ok');
      }
      m = /^G38\.3 Z-([\d.]+) F[\d.]+$/.exec(line);
      if (m) {
        if (mode !== 'G91') throw new Error('the executor probed in absolute mode');
        const target = pos.z - Number(m[1]);
        const hit = zAt(pos.x - G54.x, pos.y - G54.y);
        if (hit !== null && hit >= target && hit <= pos.z) {
          pos.z = hit;
          lowest = Math.min(lowest, pos.z);
          return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${hit.toFixed(3)}:1]\nok`);
        }
        pos.z = target;
        lowest = Math.min(lowest, pos.z);
        // #518 — a G38.3 miss is a reading and `ok`, never an alarm.
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\nok`);
      }
      if (/^G10 L2 P1 /.test(line)) return reply('ok');
      return reply(`error:unexpected line ${line}`);
    },
  };
  return {
    console,
    lines,
    xyMovesAtZ,
    lowest: () => lowest,
    fitCutter: () => (tool = 'cutter'),
  };
}

/** The readings for a spread plan, in plan order, as the fake surface answers them. */
function readingsFor(plan: SurfaceSpreadPlan, zs: readonly number[]): PointReading[] {
  return plan.touches.map((t, i) => ({ x: t.x, y: t.y, z: zs[i]! }));
}

const yes = async () => true;

/** How many probe seeks the run makes: the registration's two, plus two per touch not reused. */
function probeSeeks(lines: readonly string[]): number {
  return lines.filter((l) => l.startsWith('G38.3')).length;
}

describe('#475 the executor measures the cut extents', () => {
  it('#631 — a DOME writes the origin: the outcome stays usable and Z0 is the low touch', async () => {
    const job = badgeJob();
    const plan = registrationPlan(BADGE_STOCK, -55.0, { x: 24, y: 43 });
    const spreadPlan = surfaceSpreadPlan(job, {
      touchCount: plan.settings.surfaceTouchCount,
      margin: 0.2,
    })!;
    // The plan's first touch is the registration point itself, so the executor must reuse that
    // reading rather than touching the blank twice in the same spot.
    expect(spreadPlan.touches[0]).toMatchObject({ x: 24, y: 43 });

    // A dome: the centre 0.33 mm above every extent (Appendix C's badge dome). A plane cannot
    // explain it — the residual (4/5 of the dome height) exceeds the 0.2 mm band.
    const zs = [-55.0, -55.33, -55.33, -55.33, -55.33];
    const z1 = fakeZ1({
      actual: BADGE_STOCK,
      surface: zs[0]!,
      readings: readingsFor(spreadPlan, zs),
      jaw: true,
    });

    const r = await runRegistration(plan, { console: z1.console, operator: yes }, spreadPlan);
    if (!r.ok) throw new Error(r.reason);

    expect(r.spread).toBeDefined();
    expect(r.spread!.touches.map((t) => t.z)).toEqual(zs);
    expect(r.spread!.min).toMatchObject({ z: -55.33, touchId: 'surface-2', source: 'probe' });
    expect(r.spread!.max).toMatchObject({ z: -55.0, touchId: 'surface-1', source: 'probe' });
    expect(r.spread!.spread).toBe(0.33);
    expect(r.spread!.fit).not.toBeNull();
    expect(r.spread!.fit!.residual).toBeGreaterThan(0.2);
    expect(r.spread!.ok).toBe(false);
    expect(r.spread!.verdict).toBe('dome');
    expect(r.spread!.landing).toBeNull();
    expect(r.spread!.z0).toEqual({ z: -55.33, touchId: 'surface-2', rule: 'lowest' });

    // #631 — a dome is a completed measurement (the run is `ok`) and the origin IS written from it:
    // the outcome stays usable and Z0 is the low touch; the machine levels the top itself.
    expect(r.outcome.usable).toBe(true);
    expect(r.outcome.surfaceZ).toBe(-55.33);

    // Five planned readings: the registration seek (2 probes) and the four points not its own, plus
    // the two edge scans' bracket-and-bisect touches (7 each on this blank, #594).
    expect(probeSeeks(z1.lines)).toBe(2 + 4 * 2 + 14);
    // #430's bounds are unchanged: nothing probed below the cap, and the run finished homed.
    expect(z1.lowest()).toBeGreaterThanOrEqual(-55.0 - S.capBelowSurfaceMm);
    expect(z1.lines.slice(-2)).toEqual(['G53 G0 Z-3', '$H']);
  });

  it('PASSES the thin laminate: 0.08 mm inside a 0.225 mm band, landing range and Z0 at the low touch', async () => {
    const job = laminateJob();
    const plan = registrationPlan(LAMINATE_STOCK, -55, { x: 38, y: 12.675 });
    const spreadPlan = surfaceSpreadPlan(job, {
      touchCount: plan.settings.surfaceTouchCount,
      margin: 0.2,
    })!;
    expect(spreadPlan.touches[0]).toMatchObject({ x: 38, y: 12.675 });
    expect(spreadPlan.band.width).toBe(0.225);
    expect(spreadPlan.band.lower).toMatchObject({ depth: 0.275, source: 'split' });
    expect(spreadPlan.band.upper).toMatchObject({ depth: 0.5, source: 'underside' });

    // A shallow bow across the width: 0.08 mm high-to-low, well inside the band.
    const zs = [-55, -55.02, -55.04, -55.06, -55.08];
    const z1 = fakeZ1({
      actual: LAMINATE_STOCK,
      surface: zs[0]!,
      readings: readingsFor(spreadPlan, zs),
      jaw: true,
    });

    const r = await runRegistration(plan, { console: z1.console, operator: yes }, spreadPlan);
    if (!r.ok) throw new Error(r.reason);

    expect(r.spread!.spread).toBe(0.08);
    expect(r.spread!.ok).toBe(true);
    expect(r.spread!.z0).toEqual({ z: -55.08, touchId: 'surface-5', rule: 'lowest' });
    // #608 — the 0.08 mm spread is a near-linear ramp the plane follows; its residual (0.04) is
    // what the landing range is left from, so the range is wider than the old spread-based one.
    expect(r.spread!.landing).toEqual({ lower: 0.275, upper: 0.46 });
    expect(r.outcome.usable).toBe(true);
    // The origin the next step writes is the LOWEST touch, not the registration reading.
    expect(r.outcome.surfaceZ).toBe(-55.08);
    expect(probeSeeks(z1.lines)).toBe(2 + 4 * 2 + 14);
  });

  it('#591 — a blank clamped 2 mm along the jaws: the scans find it, and the extent touches land on it', async () => {
    // Bench 2026-10-23, run 4: the badge sat +5 mm in Y from the saved origin; the front-extent
    // touch, placed from the EXPECTED stock before any scan, probed the air past its end and the run
    // stopped before the scans could find the offset. The touches now follow the scans. (The shift
    // here is within the scan's reach — `scanReachMm` outward; an edge moved INWARD past
    // `scanInsideMm` is #592, the scan's own limit, not this ordering.)
    const SHIFT = -2;
    const job = laminateJob();
    const plan = registrationPlan(LAMINATE_STOCK, -55, { x: 38, y: 12.675 });
    const spreadPlan = surfaceSpreadPlan(job, { touchCount: plan.settings.surfaceTouchCount, margin: 0.2 })!;
    const actual: ExpectedStock = { ...LAMINATE_STOCK, yMin: LAMINATE_STOCK.yMin + SHIFT, yMax: LAMINATE_STOCK.yMax + SHIFT };
    // The fake's point readings sit where the blank IS, so a touch only reads them when it is placed
    // by the found offset; the centre reading (reused) stays at the plan's own point.
    const zs = [-55, -55.02, -55.04, -55.06, -55.08];
    const shifted = spreadPlan.touches.map((t, i) => ({ x: t.x, y: t.y + (i === 0 ? 0 : SHIFT), z: zs[i]! }));
    const z1 = fakeZ1({ actual, surface: zs[0]!, readings: shifted, jaw: true });

    const r = await runRegistration(plan, { console: z1.console, operator: yes }, spreadPlan);
    if (!r.ok) throw new Error(r.reason);

    // The front scan found the edge 2 mm along (to the scan's fine step).
    expect(r.outcome.measured).toEqual({ x: true, y: true });
    expect(Math.abs(r.outcome.offset.y - SHIFT)).toBeLessThanOrEqual(0.5);
    // Every extent touch was placed on the shifted blank and read its own point.
    expect(r.spread!.touches.map((t) => t.z)).toEqual(zs);
    expect(r.spread!.ok).toBe(true);
    // Order: the extent touches come after the LAST scan touch, and are sent to the found Y.
    const scanTravel = `${S.parkAboveSurfaceMm + S.capBelowSurfaceMm}`;
    const lastScanTouch = z1.lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith(`G38.3 Z-${scanTravel} `)).at(-1)![1];
    const extentYs = z1.lines
      .slice(lastScanTouch + 1)
      .filter((l) => /^G0 X/.test(l))
      .map((l) => Number(/Y(-?[\d.]+)/.exec(l)![1]));
    expect(extentYs.length).toBe(4);
    const plannedYs = spreadPlan.touches.slice(1).map((t) => Math.round((t.y + r.outcome.offset.y) * 1000) / 1000);
    expect(extentYs).toEqual(plannedYs);
    expect(z1.lines.slice(-2)).toEqual(['G53 G0 Z-3', '$H']);
  });

  it('#593 — a blank clamped 5 mm INWARD along the jaws: the front scan searches inward and finds the edge', async () => {
    // Bench 2026-10-23, run 4: the badge sat +5 mm in Y, past `scanInsideMm` (3), so the front scan's
    // FIRST touch was already air and the scan never got to step. It now steps inward by the coarse
    // step until a touch lands on the stock, then runs the outward fine pass.
    const SHIFT = 5;
    const job = laminateJob();
    const plan = registrationPlan(LAMINATE_STOCK, -55, { x: 38, y: 12.675 });
    const spreadPlan = surfaceSpreadPlan(job, { touchCount: plan.settings.surfaceTouchCount, margin: 0.2 })!;
    const actual: ExpectedStock = { ...LAMINATE_STOCK, yMin: LAMINATE_STOCK.yMin + SHIFT, yMax: LAMINATE_STOCK.yMax + SHIFT };
    const zs = [-55, -55.02, -55.04, -55.06, -55.08];
    const shifted = spreadPlan.touches.map((t, i) => ({ x: t.x, y: t.y + (i === 0 ? 0 : SHIFT), z: zs[i]! }));
    const z1 = fakeZ1({ actual, surface: zs[0]!, readings: shifted, jaw: true });

    const r = await runRegistration(plan, { console: z1.console, operator: yes }, spreadPlan);
    if (!r.ok) throw new Error(r.reason);

    // The front edge was found inward of the expected start, so Y is measured and the offset is the
    // shift to within the scan's fine step — not the false "already off the stock" refusal.
    expect(r.outcome.measured).toEqual({ x: true, y: true });
    expect(Math.abs(r.outcome.offset.y - SHIFT)).toBeLessThanOrEqual(S.fineStepMm);
    // The run still completes with a valid spread verdict and homes at the end.
    expect(r.spread!.ok).toBe(true);
    expect(z1.lines.slice(-2)).toEqual(['G53 G0 Z-3', '$H']);
  });

  it('#594 — a blank 20 mm along the jaws: the bracket-and-bisect finds the edge within the fine step', async () => {
    // The badge is tall enough that a +20 mm shift still leaves the surface point on the stock, so
    // only the front scan has to search inward. The bisect costs ~log₂(40 / 0.25) ≈ 8 touches — more
    // than the ~7 for a near-expected blank, but it finds the edge whatever the offset.
    const SHIFT = 20;
    const plan = registrationPlan(BADGE_STOCK, -55.131, { x: 24, y: 43 });
    const actual: ExpectedStock = { ...BADGE_STOCK, yMin: BADGE_STOCK.yMin + SHIFT, yMax: BADGE_STOCK.yMax + SHIFT };
    const z1 = fakeZ1({ actual, surface: -55.131, jaw: true });

    const r = await runRegistration(plan, { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);

    expect(r.outcome.measured).toEqual({ x: true, y: true });
    expect(Math.abs(r.outcome.offset.y - SHIFT)).toBeLessThanOrEqual(S.fineStepMm);
  });

  it('#590 — only the first touch starts at the travel height; the extent touches start just above the band', async () => {
    const job = laminateJob();
    const plan = registrationPlan(LAMINATE_STOCK, -55, { x: 38, y: 12.675 });
    const spreadPlan = surfaceSpreadPlan(job, { touchCount: plan.settings.surfaceTouchCount, margin: 0.2 })!;
    const zs = [-55, -55.02, -55.04, -55.06, -55.08];
    const z1 = fakeZ1({ actual: LAMINATE_STOCK, surface: zs[0]!, readings: readingsFor(spreadPlan, zs), jaw: true });

    const r = await runRegistration(plan, { console: z1.console, operator: yes }, spreadPlan);
    if (!r.ok) throw new Error(r.reason);

    // #632 — the approach is the higher of the band's high bound and the MEASURED centre reading.
    const approachZ = Math.round((Math.max(plan.seek.band.max, zs[0]!) + S.parkAboveSurfaceMm) * 1000) / 1000;
    const fast = S.surfaceFastFeed;
    // Each surface seek is "G53 G0 Z<from>" … "G38.3 Z-<travel> F<fast>"; pair them up.
    const seeks: { from: number; travel: number }[] = [];
    let from: number | null = null;
    for (const l of z1.lines) {
      const z = /^G53 G0 Z(-?[\d.]+)$/.exec(l);
      if (z) from = Number(z[1]);
      const p = new RegExp(`^G38\\.3 Z-([\\d.]+) F${fast}$`).exec(l);
      if (p && from !== null) seeks.push({ from, travel: Number(p[1]) });
    }
    // The registration seek: from the travel height, the whole drop to the band's floor.
    expect(seeks[0]).toEqual({ from: -3, travel: Math.round((-3 - plan.seek.band.min) * 1000) / 1000 });
    // The four extent seeks: from just above the band, probing 2 × tolerance + park.
    const extents = seeks.slice(1);
    expect(extents.length).toBe(4);
    for (const s of extents) {
      expect(s.from).toBe(approachZ);
      expect(s.travel).toBe(Math.round((approachZ - plan.seek.band.min) * 1000) / 1000);
      expect(s.travel).toBeCloseTo(2 * S.surfaceToleranceMm + S.parkAboveSurfaceMm, 3);
    }
    // No extent seek went below the cap, and the run finished homed.
    expect(z1.lowest()).toBeGreaterThanOrEqual(-55 - S.capBelowSurfaceMm);
    expect(z1.lines.slice(-2)).toEqual(['G53 G0 Z-3', '$H']);
  });

  it('#632 — a blank PROUDER than the record expects: the extents approach from the measured surface', async () => {
    const job = laminateJob();
    // The DATUM path (#598/#619): the seek accepts a centre reading up to jaw top + the stock's full
    // thickness + tolerance, which sits well ABOVE the band's high bound. That is how a blank
    // standing prouder than the record expects gets this far — a 6 mm blank after a 3 mm one wrote
    // `surfaceTopZ`, so the plan's expected surface is 2 mm lower than the top in the jaws.
    const jawTopZ = -57;
    const mountDatum = { jawTopZ } as Parameters<typeof planRegistration>[0]['mountDatum'];
    const input: PlanInput = {
      stock: LAMINATE_STOCK,
      mount: 'vise',
      expectedSurface: { machineZ: -55, from: 'the blank as the setup holds it' },
      seekFromMachineZ: -3,
      fixtureBelowSurfaceMm: 0.72,
      cutCentre: { x: 38, y: 12.675 },
      mountDatum,
      stockThicknessMm: 6,
    };
    const planned = planRegistration(input, S);
    if (!planned.ok) throw new Error(planned.reason);
    const plan = planned.plan;
    const spreadPlan = surfaceSpreadPlan(job, { touchCount: plan.settings.surfaceTouchCount, margin: 0.2 })!;
    const measured = Math.round((plan.seek.band.max + 2) * 1000) / 1000;
    const zs = [measured, measured - 0.02, measured - 0.04, measured - 0.06, measured - 0.08];
    const z1 = fakeZ1({ actual: LAMINATE_STOCK, surface: measured, readings: readingsFor(spreadPlan, zs), jaw: true });

    const r = await runRegistration(plan, { console: z1.console, operator: yes }, spreadPlan);
    if (!r.ok) throw new Error(r.reason);

    const clear = Math.round((measured + S.parkAboveSurfaceMm) * 1000) / 1000;
    // Once the surface is read, NO rapid goes below the measured top + park: every absolute Z rapid
    // and every XY traverse the run makes is at or above it (approaching at the plan's `band.max +
    // park` would have put them 2 mm into the top).
    const rapids = z1.lines
      .map((l) => /^G53 G0 Z(-?[\d.]+)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    expect(rapids.length).toBeGreaterThan(1);
    for (const z of rapids) expect(z).toBeGreaterThanOrEqual(clear);
    for (const z of z1.xyMovesAtZ) expect(z).toBeGreaterThanOrEqual(clear);

    // And the extent seeks really start there — the measured reading + park, not the band's.
    const fast = S.surfaceFastFeed;
    const seeks: { from: number; travel: number }[] = [];
    let from: number | null = null;
    for (const l of z1.lines) {
      const z = /^G53 G0 Z(-?[\d.]+)$/.exec(l);
      if (z) from = Number(z[1]);
      const p = new RegExp(`^G38\\.3 Z-([\\d.]+) F${fast}$`).exec(l);
      if (p && from !== null) seeks.push({ from, travel: Number(p[1]) });
    }
    const extents = seeks.slice(1);
    expect(extents.length).toBeGreaterThan(0);
    for (const s of extents) expect(s.from).toBe(clear);
  });

  it('does not take the extents when the caller asks for no spread verdict', async () => {
    const plan = registrationPlan(BADGE_STOCK, -55.131, { x: 24, y: 43 });
    const z1 = fakeZ1({ actual: BADGE_STOCK, surface: -55.131, jaw: true });
    const r = await runRegistration(plan, { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(r.spread).toBeUndefined();
    expect(r.outcome.surfaceZ).toBe(-55.131);
    expect(probeSeeks(z1.lines)).toBe(2 + 14);
  });
});
