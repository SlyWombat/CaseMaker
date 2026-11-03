/**
 * #941 — SAMPLE 5'S CUTTING ORDER AND ITS REST RULE.
 *
 * The acceptance doc asks for chamfer, then slot. The app planned slot → rest → chamfer because
 * the cutter order was a shape rank (flats lead, cones follow): any flat, including the slot that
 * exits straight through the top edges the bevel runs along, outran the bevel. The rule is the
 * edge's dependency — a stock-rim bevel precedes the cut that frees its edge, an interior pocket
 * keeps its lead over a bevel on its own rim — and a rest pass is offered only when the slot's own
 * cutter cannot reach the design's corners.
 */

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { cutterReachesAllCorners, orderCutterEntries, planCutters } from '@/engine/cnc/engrave/cutterPlan';
import { candidatePlans } from '@/engine/cnc/engrave/smartPick';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';

const FLAT_316 = flatEndMill(3.175, { name: '3.175 flat', fluteLength: 17 });
const FLAT_10 = flatEndMill(1.0, { name: '1 mm flat', fluteLength: 12 });
const CHAMFER: Tool = {
  ...flatEndMill(6, { name: '90° chamfer', fluteLength: 3 }),
  id: 'chamfer-90',
  shape: 'chamfer',
  tipDiameter: 0.1,
  halfAngle: 45,
  angle: null,
};
const TOOLS: ToolLibraryEntry[] = [
  { key: 'inv:flat-316', tool: FLAT_316, provenance: 'test' },
  { key: 'inv:flat-10', tool: FLAT_10, provenance: 'test' },
  { key: 'inv:chamfer-90', tool: CHAMFER, provenance: 'test' },
];
const shapeOf = (key: string): string | null => TOOLS.find((t) => t.key === key)?.tool.shape ?? null;
/** The chamfer's own hardwood row: without it the cutter has no cutting parameters and is unassigned. */
const ROWS: FeedCatalogueRow[] = [
  { cutterId: 'chamfer-90', material: 'Hardwood', rpm: 12000, feed: 1000, plungeFeed: 500, stepDown: 1 },
];

/** The sample-5 geometry: a 36 × 100 × 36 stick, a full-width 6 × 10 slot, a stock-rim bevel. */
function stickJob(slotCornerRadius = 0, bevelOf = 'stick'): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 's5',
    labels: [],
    drills: [],
    stock: { length: 36, width: 100, thickness: 36, material: 'hardwood' },
    toolKey: '',
    shapes: [
      {
        id: 'stick',
        name: 'stick',
        kind: 'rect',
        position: { x: 18, y: 50 },
        rotation: 0,
        width: 36,
        height: 100,
        depth: 36,
        cornerRadius: 0,
        construction: true,
        enabled: true,
      },
      {
        id: 'slot',
        name: 'slot',
        kind: 'rect',
        position: { x: 18, y: 50 },
        rotation: 0,
        width: 36,
        height: 6,
        depth: 10,
        cornerRadius: slotCornerRadius,
        enabled: true,
      },
    ],
    chamfers: [{ kind: 'chamfer', id: 'bevel', of: bevelOf, side: bevelOf === 'stick' ? 'outside' : 'inside', width: 1, enabled: true }],
  } as EngraveJob;
}

const CUTTERS = [
  { key: 'inv:flat-316', items: ['slot'] },
  { key: 'inv:flat-10', items: [] },
  { key: 'inv:chamfer-90', items: ['bevel'] },
];

describe('#941 the cutting order is the edge’s dependency', () => {
  it('a stock-rim bevel precedes the through-cut that frees its edge, and the rest follows the cut', () => {
    const ordered = orderCutterEntries(stickJob(), CUTTERS, shapeOf).map((c) => c.key);
    expect(ordered).toEqual(['inv:chamfer-90', 'inv:flat-316', 'inv:flat-10']);
  });

  it('a bevel on a pocket’s rim keeps the pocket first (pocket-before-rim-bevel)', () => {
    const ordered = orderCutterEntries(stickJob(0, 'slot'), CUTTERS, shapeOf).map((c) => c.key);
    expect(ordered).toEqual(['inv:flat-316', 'inv:flat-10', 'inv:chamfer-90']);
  });

  it('a job with no chamfer keeps the old rank byte for byte', () => {
    const job = { ...stickJob(), chamfers: [] } as EngraveJob;
    const ordered = orderCutterEntries(job, CUTTERS, shapeOf).map((c) => c.key);
    // Flats lead (stable: the slot cutter, then the rest), a cone follows.
    expect(ordered).toEqual(['inv:flat-316', 'inv:flat-10', 'inv:chamfer-90']);
  });

  it('the kind plan puts the bevel first: the bevel owns the rim, the flat owns the slot', () => {
    const plan = planCutters(stickJob(), null, TOOLS, ROWS);
    expect(plan.cutters.map((c) => c.shape)).toEqual(['chamfer', 'flat']);
    expect(plan.cutters[0]!.items).toEqual(['bevel']);
    expect(plan.cutters[1]!.items).toEqual(['slot']);
  });
});

describe('#941 the slot-rest rule', () => {
  it('a cutter reaches a corner exactly when its radius is no wider than the design states', () => {
    // The 3.175 flat's radius is 1.5875 mm: a sharp corner is out of its reach, r2 is not.
    expect(cutterReachesAllCorners(stickJob(0), 1.5875)).toBe(false);
    expect(cutterReachesAllCorners(stickJob(2), 1.5875)).toBe(true);
  });

  it('offers a rest pair for the square slot and none when the slot’s cutter can reach the corners', () => {
    const hasRest = (job: EngraveJob): boolean =>
      candidatePlans(job, TOOLS, ROWS).some((plan) => plan.cutters.some((c) => c.items.length === 0));
    expect(hasRest(stickJob(0))).toBe(true);
    expect(hasRest(stickJob(2))).toBe(false);
  });
});
