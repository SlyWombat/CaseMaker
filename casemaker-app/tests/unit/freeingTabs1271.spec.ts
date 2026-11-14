/**
 * #1271 — A 3D PART'S FREEING TABS ARE THE SHOP'S, NOT A CONSTANT.
 *
 * The freeing contour of a goal used to take `DEFAULT_RELEASE_TABS` (4 x 6 x 1) whatever the shop
 * said: `tabs.count`, `tabs.heightMm` and a width key changed nothing there (the #1237 class). It now
 * reads `tabs.count`, `tabs.freeingWidthMm` (new; a cut-out's own width stays `tabs.widthMm`) and
 * `tabs.heightMm` from the plan input's defaults map. Each recommendation equals the old constant,
 * so a shop that changed nothing gets byte-identical programs; each key changed changes the placed
 * tabs. The contour outcome also states asked / placed / added / unplaceable as plain data.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_RELEASE_TABS, planModelCam, type ModelPlanInput } from '../../src/engine/cnc/cam/model/plan';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import { KNOWN_DEFAULTS } from '../../src/platform/defaultsClient';

const flat6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });

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


function planInput(defaults: Record<string, number>, extra: Partial<ModelPlanInput> = {}): ModelPlanInput {
  const map: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(defaults)) map[k] = { value: v, source: 'test' };
  return {
    geometry: box(),
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0, stockBottom: -10 }, underside: 'flatOnStockBottom' }],
    stock: { length: 60, width: 40, thickness: 10, material: 'hardwood' },
    fixture: { mount: 'vise', envelope: null },
    cutters: { house: [flat6 as Tool], catalogue: [] },
    tolerances: { finishMm: 0.01 },
    edgeBreak: { legMm: 0 },
    defaults: map as unknown as ModelPlanInput['defaults'],
    ...extra,
  };
}

async function contourOf(defaults: Record<string, number>, extra: Partial<ModelPlanInput> = {}) {
  const out = await planModelCam(planInput(defaults, extra));
  const op = out.perSetup[0]!.ops.find((o) => o.kind === 'contour')!;
  return { counts: op.outcome.tabCounts, moves: JSON.stringify(op.outcome.ir.operations.flatMap((o) => o.moves)) };
}

describe('#1271 the freeing contour reads the shop’s three keys', () => {
  it('the recommendations equal the old constant, so the bytes do not move', async () => {
    expect(KNOWN_DEFAULTS['tabs.count']!.fallback).toBe(DEFAULT_RELEASE_TABS.count);
    expect(KNOWN_DEFAULTS['tabs.freeingWidthMm']!.fallback).toBe(DEFAULT_RELEASE_TABS.width);
    expect(KNOWN_DEFAULTS['tabs.heightMm']!.fallback).toBe(DEFAULT_RELEASE_TABS.height);
    // The pre-change behaviour is a plan that STATES the constant as its freeing tabs.
    const stated = await contourOf({}, { freeingTabs: { count: 4, widthMm: 6, heightMm: 1 } });
    const shop = await contourOf({});
    expect(shop.moves).toBe(stated.moves);
    expect(shop.counts).toEqual({ asked: 4, placed: 4, added: 0, unplaceable: 0 });
  });

  it('each key changed changes the placed tabs on the 27 x 10 block', async () => {
    const base = await contourOf({});
    const count = await contourOf({ 'tabs.count': 2 });
    expect(count.counts).toEqual({ asked: 2, placed: 2, added: 0, unplaceable: 0 });
    expect(count.moves).not.toBe(base.moves);
    const width = await contourOf({ 'tabs.freeingWidthMm': 12 });
    expect(width.moves).not.toBe(base.moves);
    const wide = await contourOf({ 'tabs.freeingWidthMm': 30 });
    expect(wide.counts).toEqual({ asked: 4, placed: 2, added: 0, unplaceable: 2 });
    const height = await contourOf({ 'tabs.heightMm': 3 });
    expect(height.moves).not.toBe(base.moves);
  });

  it('a cut-out’s tab width is a different key: tabs.widthMm changes nothing on a goal', async () => {
    expect((await contourOf({ 'tabs.widthMm': 9 })).moves).toBe((await contourOf({})).moves);
  });

  it('asked / placed / added / unplaceable are plain data, including the tabs added to meet the span limit', async () => {
    expect((await contourOf({ 'tabs.count': 8 })).counts).toEqual({ asked: 8, placed: 4, added: 0, unplaceable: 4 });
    expect((await contourOf({ 'tabs.count': 2, 'tabs.maxSpanMm': 20 })).counts).toEqual({ asked: 2, placed: 4, added: 2, unplaceable: 0 });
  });
});
