/**
 * #910 — A ⌀4 OR ⌀6 BALL IS FED FROM ITS OWN ROW, THE SEARCH STATES ITS REFUSAL, AND A GOAL'S
 * BALL MUST REACH THE GOAL, NOT THE BLANK.
 *
 * The demo re-run refused the elephant (j29) and the panther (j28) with "the search found no
 * candidate cutter plan", a fault. Three causes, each pinned here:
 *   1. a ball's feeds went through a FLAT proxy with no Makera id, so the ⌀4/⌀6 balls' own
 *      hardwood rows were never read, and the starting table stops at 3.2 mm;
 *   2. the search threw when every cutter was refused, dropping each one's reason;
 *   3. a goal's ball was asked to reach the STOCK's thickness, not the goal's depth (per side for
 *      a flip).
 * The elephant- and panther-class goals are generated ellipsoids of the real figures' size.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { kindedWork, materialRefusal, planCutters } from '@/engine/cnc/engrave/cutterPlan';
import { goalReachFindings, goalSideNeedMm } from '@/engine/cnc/engrave/goalReach';
import { splitGoalForBudget } from '@/engine/cnc/engrave/goalFlipSetups';
import { setupWorkJob } from '@/engine/cnc/engrave/setupWork';
import { candidatePlans, candidateRefusals, smartPick } from '@/engine/cnc/engrave/smartPick';
import { feedsFor, feedsToolForSurface, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { jobMachine } from '@/engine/cnc/calibration';
import { flatEndMill, vendorId, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import type { EngraveJob, EngraveTargetObject, StockMaterial } from '@/types/engraveJob';
import { NO_SHOP } from '../tools/noShop';

afterEach(() => clearTargetObjectMeshCache());

// ---- Makera's own cutters, as the synced catalogue states them (ids and lengths verbatim) ----

function makera(id: string, name: string, shape: 'ball' | 'flat', d: number, reach: number): ToolLibraryEntry {
  const tool: Tool = flatEndMill(d, {
    id,
    name,
    typeText: shape === 'ball' ? 'Ball Nose' : 'Flat End',
    shape,
    handleDiameter: Math.max(d, 3.175),
    cornerRadius: shape === 'ball' ? d / 2 : 0,
    fluteLength: reach,
    shoulderLength: reach,
  });
  return { key: `cat:${id}`, tool, provenance: 'fixture — Makera catalogue (#910)' } as ToolLibraryEntry;
}

const BALL_6x32 = makera('131032606032', '6*32mm Ball Nose', 'ball', 6, 32);
const BALL_6x22 = makera('131032605022', '6*22mm Ball Nose', 'ball', 6, 22);
const BALL_4x32 = makera('131022406032', '4*32mm Ball Nose', 'ball', 4, 32);
const BALL_3x22 = makera('131012313822', '3.175*22mm Ball Nose', 'ball', 3.175, 22);
const FLAT_6x32 = makera('111031606032', '6*32mm Flat End', 'flat', 6, 32);
const OFLUTE_42 = makera('111011313842', '3.175*42mm Flat End', 'flat', 3.175, 42);
const LIBRARY = [BALL_6x32, BALL_6x22, BALL_4x32, BALL_3x22, FLAT_6x32, OFLUTE_42];

/** Makera's rows for these cutters: the same numbers the synced catalogue states. */
function rows(): FeedCatalogueRow[] {
  const out: FeedCatalogueRow[] = [];
  for (const entry of LIBRARY) {
    const ball = entry.tool.shape === 'ball';
    const numbers = ball
      ? { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 1 }
      : { rpm: 10000, feed: 1000, plungeFeed: 300, stepDown: 1 };
    const cutter = { diameter: entry.tool.diameter, tipDiameter: entry.tool.tipDiameter };
    for (const material of ['Hardwood', 'ABS']) out.push({ cutterId: entry.tool.id!, material, ...numbers, cutter } as FeedCatalogueRow);
  }
  return out;
}
const CATALOGUE = rows();

// ---- generated figures: closed ellipsoids of the real meshes' size ----

type V3 = [number, number, number];

/** A closed ellipsoid of the given full size, centred in XY on 0 and spanning z ∈ [-sz, 0]. */
function ellipsoidStl(sx: number, sy: number, sz: number, seg = 32, rings = 16): string {
  const at = (i: number, j: number): V3 => {
    const theta = (Math.PI * i) / rings; // 0 … π
    const phi = (2 * Math.PI * j) / seg;
    return [
      (sx / 2) * Math.sin(theta) * Math.cos(phi),
      (sy / 2) * Math.sin(theta) * Math.sin(phi),
      -sz / 2 + (sz / 2) * Math.cos(theta),
    ];
  };
  const tris: [V3, V3, V3][] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (i > 0) tris.push([a, b, d]);
      if (i < rings - 1) tris.push([d, b, c]);
    }
  }
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

let sha = 0;
function figure(name: string, size: { x: number; y: number; z: number }, stock: { x: number; y: number }): EngraveTargetObject {
  return {
    id: `goal-${name}`,
    name: `${name}.stl`,
    format: 'stl',
    sha256: `910-${name}-${sha++}`,
    data: ellipsoidStl(size.x, size.y, size.z),
    size,
    position: { x: stock.x / 2, y: stock.y / 2, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
}

function goalJob(goal: EngraveTargetObject, stock: { length: number; width: number; thickness: number }, material: StockMaterial = 'hardwood'): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, labels: [], shapes: [], toolKey: '', stock: { ...base.stock, ...stock, material }, targetObject: goal };
}

/** j29-class: a 90 × 42 × 31.7 mm figure laid flat in a 33 mm hardwood blank. */
const elephant = (): EngraveJob =>
  goalJob(figure('elephant', { x: 90, y: 42.35, z: 31.73 }, { x: 120, y: 70 }), { length: 120, width: 70, thickness: 33 });
/** j28-class: a 115 × 66 × 50 mm figure laid flat in a 51 mm hardwood blank. */
const panther = (): EngraveJob =>
  goalJob(figure('panther', { x: 115.7, y: 66.4, z: 50.12 }, { x: 150, y: 75 }), { length: 150, width: 75, thickness: 51 });

const firstKeys = (job: EngraveJob): string[] => candidatePlans(job, LIBRARY, CATALOGUE, null).map((p) => p.cutters[0]!.key);

describe('#910 1 — a ball is fed from its own catalogue row', () => {
  it('the surface proxy keeps the ball’s Makera id', () => {
    const proxy = feedsToolForSurface(BALL_6x32.tool);
    expect(proxy.shape).toBe('flat');
    expect(proxy.diameter).toBe(6);
    expect(vendorId(proxy)).toBe('131032606032');
  });

  for (const ball of [BALL_6x32, BALL_4x32]) {
    it(`${ball.tool.name} resolves its own hardwood row, where the starting table stops at 3.2 mm`, () => {
      const job = elephant();
      const feeds = feedsFor(CATALOGUE, 'hardwood', feedsToolForSurface(ball.tool), jobMachine(job), NO_SHOP.refuse);
      if (!feeds.ok) throw new Error(feeds.reason);
      expect(feeds.catalogue?.cutterId).toBe(ball.tool.id);
      expect(feeds.params.rpm).toBe(12000);
      expect(feeds.params.feed).toBe(500);
      expect(feeds.sources.feed).toBe('catalogue');
      expect(feeds.provenance).toContain(ball.tool.name);
    });
  }

  for (const material of ['hardwood', 'pla'] as const) {
    it(`the gate passes Makera’s ⌀4 and ⌀6 balls in ${material}`, () => {
      const job = { ...elephant(), stock: { ...elephant().stock, material } };
      for (const ball of [BALL_6x32, BALL_6x22, BALL_4x32]) {
        expect(materialRefusal(job, ball, CATALOGUE, null, null, undefined, { ownedVouches: true })).toBeNull();
      }
    });
  }

  it('a ⌀6 ball with no Makera id is still refused, and the refusal says why', () => {
    const anonymous = { key: 'inv:ball-6', tool: { ...BALL_6x32.tool, id: null }, provenance: 'owned' } as ToolLibraryEntry;
    const why = materialRefusal(elephant(), anonymous, CATALOGUE, null, null, undefined, { ownedVouches: true });
    expect(why).toContain('no cutting parameters for inv:ball-6');
    expect(why).toContain('6 mm');
  });
});

describe('#910 2 — the search states its refusal', () => {
  it('a library whose every cutter is refused answers with each cutter’s reason, not a throw', async () => {
    const anonymous = { key: 'inv:ball-6', tool: { ...BALL_6x32.tool, id: null }, provenance: 'owned' } as ToolLibraryEntry;
    // #1037 — THE SHORT BALL NO LONGER BELONGS HERE. This case's subject is a library with NO
    // candidate plan; a ball shorter than the goal's whole depth still builds one (below), so the
    // plan-less library is the unfeedable ball plus a cutter of the wrong shape.
    const result = await smartPick(panther(), [anonymous, FLAT_6x32], CATALOGUE, null, () => {
      throw new Error('nothing should be evaluated');
    });
    expect(result.refused).toBe(true);
    if (result.refused !== true) throw new Error('expected a refusal');
    expect(result.candidates.map((c) => c.key)).toEqual(['inv:ball-6', 'cat:111031606032']);
    expect(result.candidates[0]!.reason).toContain('no cutting parameters');
    expect(result.candidates[1]!.reason).toBe("a flat cutter does none of this job's work (it needs ball)");
    expect(result.reason).toContain('inv:ball-6 — no cutting parameters');
    // The wrong-shaped rest are counted in the sentence, not listed.
    expect(result.reason).toContain('1 other cutter is not the shape this work needs');
  });

  it('a ball shorter than the goal’s whole depth is still a candidate — its reach is judged per feature (#1037)', () => {
    // The #785 whole-goal rule is gone by 6b's ruling: the finisher is gated on the depth it would
    // CUT (cam/model/plan's `goal-finish-unreachable`), so a 22 mm ball on the 50 mm-class panther
    // is a plan, never a pre-plan refusal. The plan's own gate states any region it cannot reach.
    const short = { ...BALL_3x22, key: 'cat:short' };
    const plans = candidatePlans(panther(), [short], CATALOGUE, null);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.cutters.map((c) => c.key)).toEqual(['cat:short']);
  });

  it('names the shape a cutter lacks', () => {
    const [flat] = candidateRefusals(elephant(), [{ ...FLAT_6x32 }], CATALOGUE, null);
    expect(flat!.reason).toBe("a flat cutter does none of this job's work (it needs ball)");
    expect(flat!.shapeOnly).toBe(true);
  });
});

describe('#910 3 — a goal’s ball reaches the goal, not the blank', () => {
  it('the elephant asks for its own 31.73 mm, not the 33 mm blank', () => {
    const [work] = kindedWork(elephant(), null);
    expect(work!.kind).toBe('ball');
    expect(work!.reachMm).toBe(31.73);
  });

  it('a goal sunk into the blank needs its lowest point, and a split side only its band', () => {
    const sunk = elephant();
    sunk.targetObject = { ...sunk.targetObject!, position: { ...sunk.targetObject!.position, z: -1 } };
    expect(kindedWork(sunk, null)[0]!.reachMm).toBe(32.73);
    // The band is measured from the goal's own top, so a sunk goal's 20 mm band reaches 21 mm.
    expect(goalSideNeedMm({ ...sunk.targetObject, bandMm: 20 })).toBeCloseTo(21, 6);
    expect(goalSideNeedMm({ ...sunk.targetObject, bandMm: 40 })).toBeCloseTo(32.73, 6);
  });
});

describe('#910 — elephant- and panther-class hardwood goals propose a ⌀6 ball', () => {
  it('the elephant (90 × 42 × 32 mm) is offered the ⌀6 × 32 ball, roughed by a flat, fed from its own row', () => {
    const job = elephant();
    const plans = candidatePlans(job, LIBRARY, CATALOGUE, null);
    // The ⌀6 × 32 is the largest ball that reaches 31.73 mm; the ⌀6 × 22 does not.
    expect(firstKeys(job)).toContain(BALL_6x32.key);
    expect(firstKeys(job)).not.toContain(BALL_6x22.key);
    expect(plans.some((p) => p.cutters[0]!.key === BALL_6x32.key && p.goalRoughKey !== undefined)).toBe(true);
    // #1051 — THE RULE'S OWN PICK IS NOW THE LARGEST BALL THAT FITS THE FINISHING BUDGET, its
    // reach no longer filtering it for a mesh goal (#1037's rule the engine already follows). At
    // the 0.1 mm grid the ⌀6 and ⌀4 × 32 stencils exceed the budget, so the rule offers the
    // ⌀3.175 × 22 the budget allows — a plan that posts; the old reach-first order preferred an
    // over-budget ball the generator refuses. The SEARCH still builds the ⌀6 × 32 plan (asserted
    // above), and the engine judges the finisher's reach per feature.
    const rule = planCutters(job, null, LIBRARY, CATALOGUE, null);
    expect(rule.cutters[0]?.key).toBe(BALL_3x22.key);
    const feeds = feedsFor(CATALOGUE, 'hardwood', feedsToolForSurface(BALL_6x32.tool), jobMachine(job), NO_SHOP.refuse);
    expect(feeds.ok && feeds.catalogue?.cutterId).toBe('131032606032');
  });

  it('the panther (115 × 66 × 50 mm) is no longer refused for the goal’s whole depth — the ⌀6 × 32 ball is its plan (#1037)', () => {
    // Re-pinned: this case used to pin the #785 whole-goal refusal — "the work is 50.12 mm deep",
    // the search refusing without evaluating anything. #1037's ruling (6b) removes that class:
    // the reach is judged per feature by the finisher gate (`goal-finish-unreachable`), so the
    // search has a plan and evaluates it. The ⌀6 × 32 is the ball that builds it.
    const plans = candidatePlans(panther(), LIBRARY, CATALOGUE, null);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.cutters.map((c) => c.key)).toEqual([BALL_6x32.key]);
  });

  it('cut as a flip, each side of the panther is offered the ⌀6 × 32 ball', () => {
    const job = panther();
    const split = splitGoalForBudget(job, job.targetObject!, { firstMm: 26, secondMm: 26 }, LIBRARY);
    if (!split.ok) throw new Error(split.reason);
    const flipped: EngraveJob = { ...job, targetObject: undefined, targetObjects: split.goals, setups: split.setups };
    for (const index of [0, 1]) {
      const side = setupWorkJob(flipped, LIBRARY, index);
      if (side === null) throw new Error(`side ${index + 1} has no work`);
      const [work] = kindedWork(side, null);
      expect(work?.kind).toBe('ball');
      // Each side cuts its 26 mm band (the flipped side's from the goal's own top, under the
      // 0.88 mm the blank stands proud of the figure).
      expect(work!.reachMm).toBeLessThanOrEqual(26.88);
      expect(firstKeys(side)).toContain(BALL_6x32.key);
      // The ⌀6 × 22 does not reach a 26 mm band.
      expect(firstKeys(side)).not.toContain(BALL_6x22.key);
      // And the generator's reach check agrees: the band, not the whole figure, must be reached.
      expect(goalReachFindings(side.targetObject!, BALL_6x32.tool, [], LIBRARY)).toEqual([]);
    }
  });
});
