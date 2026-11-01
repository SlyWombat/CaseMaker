/**
 * #840 — A SLOT ALONG A PATH: a line with a stated width wider than the cutter is cut as a region.
 *
 * The seams. THE RULE: absent is today's trace byte for byte; a width at or below the cutter is
 * the trace; wider is a region. THE REGION: the path buffered by width / 2 with round joins and
 * ends — checked against the analytic area and against the distance of every boundary vertex from
 * the path. THE FUNNEL: the region is a pocket in the posted program, and the oracle's prediction
 * is that region, which the simulated removal passes.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession } from '@/workers/sim/session';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { jobTool, toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { lineSlotWidth, slotFacts, slotOperationName, slotSentence } from '@/engine/cnc/engrave/slot';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob, EngraveLineItem } from '@/types/engraveJob';

const FLAT_3: Tool = flatEndMill(3, { id: null, name: '3 mm flat end', typeText: 'Flat End' });

/** An S: one period of a sine, 40 mm long, 6 mm amplitude — curvature radius ≥ 6.75 mm > 3 mm. */
const S_POINTS: [number, number][] = Array.from({ length: 41 }, (_, i) => {
  const x = -20 + i;
  return [x, Number((6 * Math.sin((x * Math.PI) / 20)).toFixed(4))];
});

/** A ring of radius 10 mm, 64 points. */
const RING_POINTS: [number, number][] = Array.from({ length: 64 }, (_, i) => {
  const t = (2 * Math.PI * i) / 64;
  return [Number((10 * Math.cos(t)).toFixed(4)), Number((10 * Math.sin(t)).toFixed(4))];
});

function line(extra: Partial<EngraveLineItem> = {}): EngraveLineItem {
  return {
    id: 'slot',
    name: 'groove',
    kind: 'line',
    position: { x: 30, y: 20 },
    rotation: 0,
    depth: 1,
    enabled: true,
    points: S_POINTS,
    closed: false,
    slotWidth: 6,
    ...extra,
  };
}

function slotJob(trace: EngraveLineItem = line(), over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 60, width: 40 },
    labels: [],
    shapes: [],
    traces: [trace],
    toolKey: 'flat-3',
    tool: FLAT_3,
    ...over,
  };
}

const lengthOf = (pts: readonly [number, number][], closed: boolean): number => {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  if (closed) total += Math.hypot(pts[0]![0] - pts.at(-1)![0], pts[0]![1] - pts.at(-1)![1]);
  return total;
};

/** Shortest distance from `p` to the (open or closed) polyline. */
function distanceToPath(p: readonly [number, number], pts: readonly [number, number][], closed: boolean): number {
  let best = Infinity;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
}

/** The plan's region for the job's one slot, evaluated: area and boundary vertices. */
function planRegion(job: EngraveJob): { area: number; vertices: [number, number][] } {
  const plan = toPartPlan(job);
  expect(plan.traces).toEqual([]);
  expect(plan.engraves).toHaveLength(1);
  const cs = executeProfile(tl, plan.engraves[0]!.profile);
  try {
    return { area: cs.area(), vertices: cs.toPolygons().flat() as [number, number][] };
  } finally {
    cs.delete();
  }
}

describe('the rule — absent, at or below the cutter, wider', () => {
  it('absent is the trace; width ≤ the cutter is the trace; wider is the region', () => {
    expect(lineSlotWidth(line({ slotWidth: undefined }), FLAT_3)).toBeNull();
    expect(lineSlotWidth(line({ slotWidth: 3 }), FLAT_3)).toBeNull();
    expect(lineSlotWidth(line({ slotWidth: 2 }), FLAT_3)).toBeNull();
    expect(lineSlotWidth(line({ slotWidth: 3.5 }), FLAT_3)).toBe(3.5);
    // A flute keeps its ramped trace.
    expect(lineSlotWidth(line({ flute: {} }), FLAT_3)).toBeNull();
    // No cutter yet: the stated width is the designer's, so it is a region.
    expect(lineSlotWidth(line(), null)).toBe(6);
  });

  it('names the operation a Slot with its width', () => {
    expect(slotOperationName(line(), 6)).toBe('Slot 6 mm along line "groove" (41 points)');
  });
});

describe('the plan — the buffered path is a region in the pocket funnel', () => {
  it('an S-curve 6 mm wide with a ⌀3 flat: the region is the path buffered by 3 mm', () => {
    const job = slotJob();
    const plan = toPartPlan(job);
    expect(plan.engraves[0]).toMatchObject({ id: 'slot', depth: 1, name: 'Slot 6 mm along line "groove" (41 points)' });
    const { area, vertices } = planRegion(job);
    // Round joins and ends, no self-overlap (the S's curvature radius exceeds 3 mm): L·w + π r².
    const expected = lengthOf(S_POINTS, false) * 6 + Math.PI * 9;
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.01);
    // Every boundary vertex is 3 mm from the path (in the job frame, offset by the position).
    const placed = S_POINTS.map(([x, y]): [number, number] => [x + 30, y + 20]);
    for (const v of vertices) expect(distanceToPath(v, placed, false)).toBeCloseTo(3, 1);
  });

  it('a closed ring slot is an annulus', () => {
    const job = slotJob(line({ points: RING_POINTS, closed: true, slotWidth: 4 }));
    const { area, vertices } = planRegion(job);
    const expected = lengthOf(RING_POINTS, true) * 4;
    expect(Math.abs(area - expected) / expected).toBeLessThan(0.01);
    const placed = RING_POINTS.map(([x, y]): [number, number] => [x + 30, y + 20]);
    for (const v of vertices) expect(distanceToPath(v, placed, true)).toBeCloseTo(2, 1);
    // A hole: the ring's middle is not cut.
    const cs = executeProfile(tl, toPartPlan(job).engraves[0]!.profile);
    try {
      expect(cs.toPolygons().length).toBe(2);
    } finally {
      cs.delete();
    }
  });

  it('a width at or below the cutter keeps the trace', () => {
    const plan = toPartPlan(slotJob(line({ slotWidth: 3 })));
    expect(plan.engraves).toEqual([]);
    expect(plan.traces).toHaveLength(1);
    expect(plan.traces[0]!.name).toBe('Trace line "groove" (41 points)');
  });

  it('a slot raises no stroke-merge warning (its walls are the width, not merged strokes)', () => {
    const tight = line({ points: [[-10, 0], [10, 0], [10, 1], [-10, 1]], slotWidth: undefined });
    expect(validateJob(slotJob(tight)).some((f) => f.code === 'trace-self-overlap')).toBe(true);
    expect(validateJob(slotJob({ ...tight, slotWidth: 5 })).some((f) => f.code === 'trace-self-overlap')).toBe(false);
  });
});

describe('the program and the oracle', () => {
  it('posts the S slot as a pocket, deterministically, and the oracle predicts the region', () => {
    const job = slotJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const nc = g.nc as string;
    expect(nc).toContain('Slot 6 mm along line');
    expect(nc).not.toContain('Trace line');
    // A pocket clears the band: the cutter's centre reaches beyond the path's own 1.5 mm offset —
    // some cut is 1.5 mm from the centreline, so more than one ring is walked.
    const work = nc.split('\n').filter((l) => !l.includes('G53'));
    const zs = work.flatMap((l) => [...l.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])));
    expect(Math.min(...zs)).toBeCloseTo(-1, 6);
    expect(generate(tl, job).nc).toBe(nc);

    // The prediction for the slot is the region: same area as the plan's buffered path.
    const entries = g.predicted.filter((p) => p.itemId === 'slot');
    expect(entries.length).toBeGreaterThan(0);
    const predictedArea = (() => {
      const cs = tl.CrossSection.ofPolygons(entries.flatMap((e) => e.polygons) as [number, number][][], 'EvenOdd');
      try {
        return cs.area();
      } finally {
        cs.delete();
      }
    })();
    const { area } = planRegion(job);
    expect(Math.abs(predictedArea - area) / area).toBeLessThan(0.005);
    for (const e of entries) expect(e.depth).toBeCloseTo(1, 6);

    const tool = jobTool(job);
    if (tool === null) throw new Error('the 3 mm flat is not resolvable');
    const session = createSimSession(tl);
    try {
      const load = session.load(nc, toSetup(job, Z1), tool, Z1.id);
      if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 180_000);

  it('posts a closed ring slot and passes the oracle', () => {
    const job = slotJob(line({ points: RING_POINTS, closed: true, slotWidth: 4 }));
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.nc).toContain('Slot 4 mm along line');
    const tool = jobTool(job)!;
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
      if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 180_000);

  it('absent and width ≤ the cutter post exactly today’s trace program', () => {
    const absent = slotJob(line({ slotWidth: undefined }));
    delete (absent.traces![0] as Partial<EngraveLineItem>).slotWidth;
    const atCutter = slotJob(line({ slotWidth: 3 }));
    const a = generate(tl, absent);
    const b = generate(tl, atCutter);
    expect(a.ok).toBe(true);
    expect(a.nc).toContain('Trace line "groove" (41 points)');
    expect(b.nc).toBe(a.nc);
  }, 120_000);
});

describe('the row — the region and its passes in one line; the offer when it stays a trace', () => {
  it('states the width, the path length, the cutter, the rings and the levels, units on each', () => {
    const facts = slotFacts(line(), FLAT_3, { stepOver: 1.2, stepDown: 0.5 }, []);
    expect(facts).toMatchObject({ kind: 'region', widthMm: 6, cutterMm: 3, rings: 2, levels: 2 });
    const text = slotSentence(facts!);
    expect(text).toContain('A 6 mm slot along');
    expect(text).toContain('grows 3 mm to each side');
    expect(text).toContain('⌀3 mm cutter in 2 rings at 1.2 mm step-over, 2 levels of 0.5 mm');
  });

  it('informs when the cutter is not narrower, and offers the widest owned flat that is', () => {
    const owned = [
      { key: 'f1', name: 'Fine flat', diameterMm: 1 },
      { key: 'f15', name: 'Small flat', diameterMm: 1.5 },
      { key: 'f6', name: '⌀6 mm flat end', diameterMm: 6 },
    ];
    const facts = slotFacts(line({ slotWidth: 2 }), FLAT_3, null, owned);
    expect(facts).toMatchObject({ kind: 'trace', offerFits: true, offer: { key: 'f15' } });
    expect(slotSentence(facts!)).toBe(
      'The ⌀3 mm cutter is not narrower than the 2 mm slot, so the line is traced one cutter wide (3 mm). Small flat (⌀1.5 mm) would cut it 2 mm wide.',
    );
    const none = slotFacts(line({ slotWidth: 2 }), FLAT_3, null, [owned[2]!]);
    expect(slotSentence(none!)).toContain('No cutter you own is narrower than 2 mm; the nearest is ⌀6 mm flat end.');
  });

  it('has nothing to say for a line without a slot width', () => {
    expect(slotFacts(line({ slotWidth: undefined }), FLAT_3, null, [])).toBeNull();
  });
});

describe('the document — the width round-trips and is bounded', () => {
  it('parses a slot width, and refuses a zero or an oversize one', () => {
    const ok = parseEngraveJob(JSON.parse(JSON.stringify(slotJob())));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.job.traces![0] as EngraveLineItem).slotWidth).toBe(6);
    expect(parseEngraveJob(JSON.parse(JSON.stringify(slotJob(line({ slotWidth: 0 }))))).ok).toBe(false);
    expect(parseEngraveJob(JSON.parse(JSON.stringify(slotJob(line({ slotWidth: 101 }))))).ok).toBe(false);
  });
});
