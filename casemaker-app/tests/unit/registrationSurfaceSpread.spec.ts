// #475 — the registration executor measures the cut's extents, not just the registration point.
//
// Two blanks, both against a FAKE controller and today's numbers:
//
//   - the badge of Appendix C, whose five readings are the issue's own and span 0.21 mm across a
//     0.2 mm band — the `blank-bowed` refusal;
//   - the bench's thin laminate (76 × 25.35 × 1.5, 0.075 mm cap), whose 0.08 mm spread fits its
//     0.225 mm band — a pass, with Z0 at the lowest touch.
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
    // The executor sends XY rounded to 0.001 mm, so a planned point is matched to the millimetre
    // it was actually sent to, not to the full-precision floating number.
    const point = opts.readings?.find((r) => Math.abs(r.x - wx) < 1e-3 && Math.abs(r.y - wy) < 1e-3);
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
      m = /^G38\.2 Z-([\d.]+) F[\d.]+$/.exec(line);
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
        alarmed = true;
        return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\nALARM: Probe fail`);
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
  return lines.filter((l) => l.startsWith('G38.2')).length;
}

describe('#475 the executor measures the cut extents', () => {
  it('REFUSES the bowed badge: 0.21 mm across a 0.2 mm band, no origin, Z0 still named', async () => {
    const job = badgeJob();
    const plan = registrationPlan(BADGE_STOCK, -55.131, { x: 24, y: 43 });
    const spreadPlan = surfaceSpreadPlan(job, {
      touchCount: plan.settings.surfaceTouchCount,
      margin: 0.2,
    })!;
    // The plan's first touch is the registration point itself, so the executor must reuse that
    // reading rather than touching the blank twice in the same spot.
    expect(spreadPlan.touches[0]).toMatchObject({ x: 24, y: 43 });

    // The issue's five readings, in the plan's order: centre, left, right, front, back.
    const zs = [-55.131, -55.269, -55.232, -55.315, -55.341];
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
    expect(r.spread!.min).toMatchObject({ z: -55.341, touchId: 'surface-5', source: 'probe' });
    expect(r.spread!.max).toMatchObject({ z: -55.131, touchId: 'surface-1', source: 'probe' });
    expect(r.spread!.spread).toBe(0.21);
    expect(r.spread!.ok).toBe(false);
    expect(r.spread!.landing).toBeNull();
    expect(r.spread!.across).toBe('width');
    expect(r.spread!.z0).toEqual({ z: -55.341, touchId: 'surface-5', rule: 'lowest' });
    expect(r.spread!.refusal).toMatchObject({ severity: 'error', code: 'blank-bowed' });
    expect(r.spread!.refusal?.message).toBe(
      'this blank is bowed 0.21 mm across the cut; the floors cannot stay past the colour line and clear of the pocket',
    );

    // A refusal is a completed measurement (the run is `ok`), but no origin may be written from it:
    // the outcome is unusable and carries the refusal as its problem, and Z0 is still the low touch.
    expect(r.outcome.usable).toBe(false);
    expect(r.outcome.surfaceZ).toBe(-55.341);
    expect(r.outcome.problems).toContain(r.spread!.refusal!.message);

    // Five planned readings: the registration seek (2 probes) and the four points not its own, plus
    // the two edge scans' own touches (8 each on this blank).
    expect(probeSeeks(z1.lines)).toBe(2 + 4 * 2 + 16);
    // #430's bounds are unchanged: nothing probed below the cap, and the run finished homed.
    expect(z1.lowest()).toBeGreaterThanOrEqual(-55.131 - S.capBelowSurfaceMm);
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
    expect(r.spread!.refusal).toBeNull();
    expect(r.spread!.z0).toEqual({ z: -55.08, touchId: 'surface-5', rule: 'lowest' });
    expect(r.spread!.landing).toEqual({ lower: 0.275, upper: 0.42 });
    expect(r.outcome.usable).toBe(true);
    // The origin the next step writes is the LOWEST touch, not the registration reading.
    expect(r.outcome.surfaceZ).toBe(-55.08);
    expect(probeSeeks(z1.lines)).toBe(2 + 4 * 2 + 16);
  });

  it('does not take the extents when the caller asks for no spread verdict', async () => {
    const plan = registrationPlan(BADGE_STOCK, -55.131, { x: 24, y: 43 });
    const z1 = fakeZ1({ actual: BADGE_STOCK, surface: -55.131, jaw: true });
    const r = await runRegistration(plan, { console: z1.console, operator: yes });
    if (!r.ok) throw new Error(r.reason);
    expect(r.spread).toBeUndefined();
    expect(r.outcome.surfaceZ).toBe(-55.131);
    expect(probeSeeks(z1.lines)).toBe(2 + 16);
  });
});
