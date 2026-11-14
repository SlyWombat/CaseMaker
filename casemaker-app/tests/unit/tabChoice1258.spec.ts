/**
 * #1258 — THE TAB QUESTION, ENGINE HALF.
 *
 * When tabs at full corner margins cannot bring every stretch of outline under `tabs.maxSpanMm`,
 * the plan stops and asks instead of placing #1206's step-2 tab by itself. Three outcomes, each
 * pinned: no answer (the stretches, their candidates and numbers, no programs), `insideMargin`
 * (today's bytes — the automatic tab IS this answer) and `longerStretch` (no step-2 tab, the
 * stretch stated). A stored answer is for the outline and tab settings it was given for.
 *
 * The petit-pot-lid sample itself (three stretches, 13 / 10 / 13 joins) is the CLI comparison in
 * the hand-in; this file pins the same rule on a fixture the repository carries.
 */

import { describe, expect, it } from 'vitest';

import { contour } from '../../src/engine/cnc/cam/model/ops/contour';
import type { FeatureTree } from '../../src/engine/cnc/cam/model/features';
import { planModelCam, type ModelPlanInput } from '../../src/engine/cnc/cam/model/plan';
import { tabChoiceSentence } from '../../src/engine/cnc/cam/model/tabChoice';
import type { RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { OffsetFn, Polygons } from '../../src/engine/cnc/cam/pocket';
import { placeTabs } from '../../src/engine/cnc/cam/profile';
import type { CutParams } from '../../src/engine/cnc/feeds';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const flat6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const params: CutParams = { rpm: 12000, feed: 1000, plungeFeed: 300, stepDown: 2.5, stepOver: 3, peck: 0, air: true };
const identityOffset: OffsetFn = (region) => region.map((c) => [...c]);

/** 7 mm teeth: too short for the corner margin, wide enough for a 6 mm tab (contourOp959's fixture). */
function teeth(): Polygons {
  const outline: [number, number][] = [[0, 0], [27, 0], [27, 15]];
  for (let k = 1; k <= 18; k++) outline.push([27 - 2 * k, k % 2 === 1 ? 21.7 : 15]);
  outline.push([-3, 12], [0, 9], [-3, 6], [0, 3], [0, 0]);
  return [outline];
}
function round(): Polygons {
  return [Array.from({ length: 64 }, (_, i) => [12 * Math.cos((2 * Math.PI * i) / 64), 12 * Math.sin((2 * Math.PI * i) / 64)] as [number, number])];
}
function areaOf(outline: Polygons): number {
  const ring = outline[0]!;
  return ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2;
}
const region = (): RegionRef => ({ id: 'contour', kind: 'contour' } as unknown as RegionRef);
function runContour(outline: Polygons, tabs: Record<string, unknown>) {
  const c = { outline, area: areaOf(outline), zTo: -6, frees: true, shoulders: [] } as unknown as FeatureTree['contour'];
  return contour({
    cutter: flat6,
    contour: c,
    region: region(),
    depthMm: 6,
    tabs: { count: 4, width: 6, height: 1, maxSpanMm: 80, ...tabs },
    offset: identityOffset,
    params,
    rapid,
  });
}
const feedMoves = (out: ReturnType<typeof runContour>): string =>
  JSON.stringify(out.ir.operations.flatMap((op) => op.moves));

describe('#1258 placement: the stretches are reported, and placed only when the operator says so', () => {
  const ring = teeth()[0]!;

  it('ask reports every stretch with its candidates and places no step-2 tab', () => {
    const asked = placeTabs(ring, 4, 6, 3, { maxSpanMm: 80, tabChoice: 'ask' });
    expect(asked.tight).toEqual([]);
    expect(asked.stretches!.length).toBeGreaterThan(0);
    for (const s of asked.stretches!) {
      expect(s.spanMm).toBeGreaterThan(80);
      expect(s.candidates.length).toBeGreaterThan(0);
      for (const c of s.candidates) expect(c.fromCornerMm).toBeLessThan(c.marginMm);
      // one length left on either side of each tab, and every one of them within the limit here
      expect(s.leavesSpansMm).toHaveLength(s.candidates.length + 1);
      expect(s.stillOverLimit).toBe(false);
    }
    expect(asked.stretches!.map((s) => s.index)).toEqual(asked.stretches!.map((_, i) => i));
  });

  it('insideMargin places exactly the tabs the pre-#1258 placement placed (the automatic tab IS this answer)', () => {
    const legacy = placeTabs(ring, 4, 6, 3, { maxSpanMm: 80 });
    const chosen = placeTabs(ring, 4, 6, 3, { maxSpanMm: 80, tabChoice: 'insideMargin' });
    expect(legacy.stretches).toBeUndefined();
    expect(legacy.tight.length).toBeGreaterThan(0);
    expect(chosen.spans).toEqual(legacy.spans);
    expect(chosen.tight).toEqual(legacy.tight);
  });

  it('a stretch that needs several tabs lists EVERY one, and insideMargin places exactly those, leaving exactly the spans stated', () => {
    // The teeth outline's one 157 mm stretch needs five tabs to come under 80 mm: the question must
    // show all five (not the first), because the answer then places all five.
    const asked = placeTabs(ring, 4, 6, 3, { maxSpanMm: 80, tabChoice: 'ask' });
    const placed = placeTabs(ring, 4, 6, 3, { maxSpanMm: 80, tabChoice: 'insideMargin' });
    expect(asked.stretches).toHaveLength(1);
    const stretch = asked.stretches![0]!;
    expect(stretch.candidates).toHaveLength(5);
    expect(placed.tight).toHaveLength(5);
    const key = (p: readonly [number, number]): string => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
    expect(placed.tight.map((t) => key(t.at)).sort()).toEqual(stretch.candidates.map((c) => key(c.atXY)).sort());
    // The spans left are the real gaps between the placed spans, in that stretch.
    let perimeter = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    const spans = [...placed.spans].sort((x, y) => x.startArc - y.startArc);
    const gaps = spans.map((s, i) => {
      const next = spans[(i + 1) % spans.length]!;
      let g = next.startArc - s.endArc;
      if (g < 0) g += perimeter;
      return Number(g.toFixed(6));
    });
    for (const left of stretch.leavesSpansMm) expect(gaps).toContain(Number(left.toFixed(6)));
    expect(gaps.filter((g) => g > 80 + 1e-9)).toEqual([]);
  });

  it('longerStretch places no step-2 tab and still reports the stretches', () => {
    const asked = placeTabs(ring, 4, 6, 3, { maxSpanMm: 80, tabChoice: 'ask' });
    const left = placeTabs(ring, 4, 6, 3, { maxSpanMm: 80, tabChoice: 'longerStretch' });
    expect(left.tight).toEqual([]);
    expect(left.spans).toEqual(asked.spans);
    expect(left.stretches).toEqual(asked.stretches);
  });

  it('a job that needs no answer reports no stretches under any mode', () => {
    const none = placeTabs(ring, 4, 6, 3, { maxSpanMm: 400, tabChoice: 'ask' });
    expect(none.stretches).toEqual([]);
  });

  it('a stretch no tab fits in has no candidates, and is not an error under an answer', () => {
    const r = round()[0]!;
    // #1269: a limit of 40 mm is met by adding tabs to a smooth circle; 0.5 mm cannot be (the tabs would touch).
    const asked = placeTabs(r, 1, 6, 3, { maxSpanMm: 0.5, tabChoice: 'ask' });
    expect(asked.stretches).toHaveLength(1);
    expect(asked.stretches![0]!.candidates).toEqual([]);
    expect(asked.stretches![0]!.leavesSpansMm).toEqual([asked.stretches![0]!.spanMm]);
    expect(asked.stretches![0]!.stillOverLimit).toBe(true);
  });
});

describe('#1258 the contour op: byte-identical on insideMargin, the question otherwise', () => {
  it('insideMargin posts the pre-#1258 moves', () => {
    expect(feedMoves(runContour(teeth(), { tabChoice: 'insideMargin' }))).toBe(feedMoves(runContour(teeth(), {})));
  });

  it('ask carries the stretches on the outcome; longerStretch states each and places none', () => {
    const asked = runContour(teeth(), { tabChoice: 'ask' });
    expect(asked.tabChoice!.mode).toBe('ask');
    expect(asked.tabChoice!.stretches.length).toBeGreaterThan(0);
    const left = runContour(teeth(), { tabChoice: 'longerStretch' });
    expect((left.notes ?? []).join('\n')).toMatch(/[\d.]+ mm of the outline has no tab; the shop's limit is 80 mm — the operator's choice\./);
    expect((left.notes ?? []).join('\n')).not.toMatch(/Tab \d+ sits/);
  });

  it('the sheet states the in-margin tabs in tab-number order', () => {
    const notes = (runContour(teeth(), { tabChoice: 'insideMargin' }).notes ?? []).filter((n) => /Tab \d+ sits/.test(n));
    const numbers = notes.map((n) => Number(/Tab (\d+) sits/.exec(n)![1]));
    expect(numbers.length).toBeGreaterThan(1);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it('a no-fit stretch under insideMargin stays long and is stated, not refused', () => {
    const out = runContour(round(), { count: 1, maxSpanMm: 0.5, tabChoice: 'insideMargin' });
    expect((out.notes ?? []).join('\n')).toMatch(/of the outline has no tab and no tab fits there; the shop's limit is 0\.5 mm\./);
  });

  it('without a mode the old refusal stands', () => {
    expect(() => runContour(round(), { count: 1, maxSpanMm: 0.5 })).toThrow(/stretch|span limit/i);
  });
});

/** A 27 x 10 block, 10 mm tall, on a 20 mm stock: its four edges each take one tab and the stretches stay long. */
function box(): ModelPlanInput['geometry'] {
  const [w, d, h] = [27, 10, 10];
  const v: [number, number, number][] = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, -h], [w, 0, -h], [w, d, -h], [0, d, -h],
  ];
  const faces: [number, number, number][] = [
    [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
  ];
  const positions: number[] = [];
  for (const f of faces) for (const idx of f) positions.push(...v[idx]!);
  const arr = Float32Array.from(positions);
  return {
    triangles: {
      positions: arr,
      indices: Uint32Array.from({ length: arr.length / 3 }, (_, i) => i),
      triangleCount: faces.length,
      bbox: { min: [0, 0, -h], max: [w, d, 0] },
    },
  };
}
function planInput(extra: Partial<ModelPlanInput> = {}): ModelPlanInput {
  return {
    geometry: box(),
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -10 }, underside: 'flatOnStockBottom' }],
    stock: { length: 60, width: 40, thickness: 10, material: 'hardwood' },
    fixture: { mount: 'vise', envelope: null },
    cutters: { house: [flat6 as Tool], catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
    freeingTabs: { count: 4, widthMm: 6, heightMm: 1 },
    defaults: { 'tabs.maxSpanMm': { value: 10, source: 'test' } } as unknown as ModelPlanInput['defaults'],
    ...extra,
  };
}

describe('#1258 the plan asks, and an answer is for the job it was given for', () => {
  it('no answer: the question and NO programs; an answer on the input survives a structured clone', async () => {
    const asked = await planModelCam(planInput());
    expect(asked.perSetup).toEqual([]);
    expect(asked.tabChoiceNeeded).toBeDefined();
    expect(asked.tabChoiceNeeded!.limitMm).toBe(10);
    expect(asked.tabChoiceNeeded!.stretches.length).toBeGreaterThan(0);
    expect(asked.tabChoiceNeeded!.stretches[0]!.setupIndex).toBe(0);
    expect(asked.tabChoiceNeeded!.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    // What a card needs to draw the question to scale: the outline, the cutter's centre path and the placed tabs.
    const drawn = asked.tabChoiceNeeded!.setups;
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.setupIndex).toBe(0);
    expect(drawn[0]!.outline[0]!.length).toBeGreaterThanOrEqual(4);
    expect(drawn[0]!.path[0]!.length).toBeGreaterThanOrEqual(4);
    expect(drawn[0]!.tabsAt).toHaveLength(4);
    // …per cut-out: one ring here, named, with its own tab centres; every stretch says which cut-out it is on.
    expect(drawn[0]!.cuts).toHaveLength(1);
    expect(drawn[0]!.cuts[0]!.cut).toEqual({ id: 'setup-1-cut-1', name: 'Cut-out 1' });
    expect(drawn[0]!.cuts[0]!.tabsAt).toEqual(drawn[0]!.tabsAt);
    for (const s of asked.tabChoiceNeeded!.stretches) expect(s.cut).toEqual({ id: 'setup-1-cut-1', name: 'Cut-out 1' });
    const answer = { choice: 'longerStretch' as const, answeredFor: asked.tabChoiceNeeded!.fingerprint };
    expect(structuredClone(planInput({ tabChoice: answer })).tabChoice).toEqual(answer);
    expect(tabChoiceSentence(asked.tabChoiceNeeded!)).toMatch(/--tab-choice inside-margin/);
    expect(tabChoiceSentence(asked.tabChoiceNeeded!)).toMatch(/--tab-choice longer-stretch/);
  }, 240_000);

  it('each answer plans programs; the stretch with no place for a tab is stated either way', async () => {
    const asked = await planModelCam(planInput());
    const fingerprint = asked.tabChoiceNeeded!.fingerprint;
    for (const choice of ['insideMargin', 'longerStretch'] as const) {
      const out = await planModelCam(planInput({ tabChoice: { choice, answeredFor: fingerprint } }));
      expect(out.tabChoiceNeeded).toBeUndefined();
      expect(out.perSetup[0]!.programs.length).toBeGreaterThan(0);
      // An answered plan carries the question it was answered for, beside its programs (plain data),
      // so a reopened job can still show the answer and offer to change it.
      expect(out.tabChoiceApplied).toBeDefined();
      expect(out.tabChoiceApplied!.choice).toBe(choice);
      expect(out.tabChoiceApplied!.fingerprint).toBe(fingerprint);
      expect(out.tabChoiceApplied!.stretches).toEqual(asked.tabChoiceNeeded!.stretches);
      expect(structuredClone(out.tabChoiceApplied)).toEqual(out.tabChoiceApplied);
      const said = out.perSetup.flatMap((s) => s.statements.map((st) => st.text)).join('\n');
      expect(said).toMatch(/of the outline has no tab/);
    }
  }, 240_000);

  it('a changed tab width voids a stored answer: the plan asks again and says it is stale', async () => {
    const asked = await planModelCam(planInput());
    const stale = await planModelCam(
      planInput({
        tabChoice: { choice: 'insideMargin', answeredFor: asked.tabChoiceNeeded!.fingerprint },
        freeingTabs: { count: 4, widthMm: 5, heightMm: 1 },
      }),
    );
    expect(stale.tabChoiceStale).toBe(true);
    expect(stale.perSetup).toEqual([]);
    expect(stale.tabChoiceNeeded!.fingerprint).not.toBe(asked.tabChoiceNeeded!.fingerprint);
  }, 240_000);
});
