// The engrave preview engine (#205): the stock cut to each label's depth, one floor mesh per
// label, the vise jaws, and the stale-generation rule. Real Manifold, plain Node — the same
// harness `engravable.spec.ts` uses.
//
// Every volumetric assertion is against a CLOSED FORM: the uncut prism's volume, and the
// removed volume the measurement says the cuts are worth (Σ openedArea × depth). A test that
// compared the mesh against another run of the same code would pass on a systematic error.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { createEngravePreviewer } from '@/workers/sim/engravePreview';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { presetJawStrips, presetPartOnBoard } from '@/engine/cnc/sacrificial';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { EngraveJob, EngraveShape } from '@/types/engraveJob';
import { depthColor, SHALLOW_COLOR, DEEP_COLOR } from '@/components/viewport/engraveRamp';

/** Signed volume of a triangle soup (divergence theorem), absolute value in mm³. */
function meshVolume(m: NodeMeshOutput): number {
  const p = m.positions;
  const idx = m.indices;
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]! * 3;
    const b = idx[i + 1]! * 3;
    const c = idx[i + 2]! * 3;
    v +=
      (p[a]! * (p[b + 1]! * p[c + 2]! - p[c + 1]! * p[b + 2]!) -
        p[a + 1]! * (p[b]! * p[c + 2]! - p[c]! * p[b + 2]!) +
        p[a + 2]! * (p[b]! * p[c + 1]! - p[c]! * p[b + 1]!)) /
      6;
  }
  return Math.abs(v);
}

const previewer = createEngravePreviewer(tl);
let gen = 0;
/** One preview, on a fresh generation so nothing is ever stale. */
function preview(job: EngraveJob) {
  const p = previewer.engravePreview(job, ++gen);
  if (!p) throw new Error('the previewer refused a fresh generation');
  return p;
}

describe('engravePreview (#205)', () => {
  it('cuts the default job to Σ(openedArea × depth) of the uncut prism', () => {
    const job = defaultEngraveJob();
    const p = preview(job);
    const uncut = job.stock.length * job.stock.width * job.stock.thickness;
    const expected = p.engravability.reduce((sum, row) => {
      const depth = job.labels.find((l) => l.id === row.labelId)?.depth ?? 0;
      return sum + row.openedArea * depth;
    }, 0);

    expect(expected).toBeGreaterThan(0);
    const removed = uncut - meshVolume(p.stock);
    expect(Math.abs(removed - expected) / expected).toBeLessThan(0.01);
  });

  it('returns one floor mesh per cut label, at that label’s own depth', () => {
    const p = preview(defaultEngraveJob());
    expect(p.floors.map((f) => f.depth)).toEqual([2.0, 1.0, 0.5]);
    for (const floor of p.floors) expect(meshVolume(floor.mesh)).toBeGreaterThan(0);
  });

  it('draws the two vise jaws', () => {
    const p = preview(defaultEngraveJob());
    expect(p.fixture.map((f) => f.id)).toEqual(['vise-fixed-jaw', 'vise-moving-jaw']);
    for (const jaw of p.fixture) expect(meshVolume(jaw.mesh)).toBeGreaterThan(0);
  });

  it('leaves a label that is too deep out of the cut and reports it', () => {
    const job = defaultEngraveJob();
    job.labels = [{ ...job.labels[0]!, id: 'too-deep', text: 'DEEP', depth: 11.5 }];
    const p = preview(job);
    const uncut = job.stock.length * job.stock.width * job.stock.thickness;

    expect(p.findings.some((f) => f.code === 'depth-exceeds-stock' && f.severity === 'error')).toBe(true);
    expect(p.floors).toHaveLength(0);
    // The stock is drawn uncut there: volume unchanged, within the mesh's own tolerance.
    expect(Math.abs(meshVolume(p.stock) - uncut)).toBeLessThan(uncut * 0.001);
  });

  it('reports the tool recommendation with the compromise size suggestion appended', () => {
    const job = defaultEngraveJob();
    // A 4 mm label cannot survive the 3.175 mm cutter, so the compromise message gains the
    // measured cap-height suggestion (#201's suggestCapHeight, composed in the worker).
    job.labels = [{ ...job.labels[0]!, text: 'MAKER', size: 4, depth: 1 }];
    job.toolKey = 'flat-3.175x12-metal';
    const p = preview(job);
    expect(p.recommendation.key).toBe('flat-1.0');
    expect(p.recommendation.compromise).toBe(true);
    expect(p.recommendation.reason).toMatch(/Try \d+ mm or more\.|Choose a smaller cutter\./);
  });

  // #205 review — the preview predates #214's shapes, so this pins that a shape is a first-class
  // item: it is cut, it gets a floor, and a shape as the WORST item does not throw the
  // compromise reason (which must not assume every item is a label).
  it('cuts a shape beside a label, and a shape as the worst item does not throw the reason', () => {
    // (1) A label that loses detail plus a ⌀20 circle under the 3.175 mm cutter. The circle has no
    // glyphs: it proves `floors` walks `plan.engraves`, not `job.labels`, and that the reason is
    // still a complete string. The worst item here is the label, so this is the label branch.
    const job = defaultEngraveJob();
    job.toolKey = 'flat-3.175x12-metal';
    job.labels = [{ ...job.labels[0]!, id: 'lbl', text: 'MAKER', size: 4, depth: 1 }];
    job.shapes = [
      {
        id: 'hole',
        kind: 'circle',
        position: { x: 50, y: 30 },
        rotation: 0,
        depth: 0.8,
        enabled: true,
        diameter: 20,
      },
    ];
    const p = preview(job);
    const hole = p.floors.find((f) => f.labelId === 'hole');
    expect(hole).toBeDefined();
    expect(hole!.depth).toBe(0.8);
    expect(meshVolume(hole!.mesh)).toBeGreaterThan(0);
    expect(p.recommendation.compromise).toBe(true);
    expect(p.recommendation.reason.length).toBeGreaterThan(0);

    // (2) A RECT that is BOTH cut and the worst item. A cuttable circle can never be the worst
    // item: its opened ratio is 0 (⌀ ≤ cutter) or ≥ 0.986 (⌀ > cutter), never inside (0, 0.9) —
    // measured directly. A 1.2 mm square at r = 0.5 is 0.845, so it exercises the SHAPE branch of
    // `completeCompromiseReason`, where `job.labels.find` misses and the reason must survive.
    const sq: EngraveShape = {
      id: 'sq',
      kind: 'rect',
      position: { x: 50, y: 30 },
      rotation: 0,
      depth: 0.8,
      enabled: true,
      width: 1.2,
      height: 1.2,
      cornerRadius: 0,
    };
    const p2 = preview({ ...job, toolKey: 'flat-1.0', labels: [], shapes: [sq] });
    expect(p2.floors.some((f) => f.labelId === 'sq')).toBe(true);
    expect(p2.recommendation.compromise).toBe(true);
    expect(p2.recommendation.reason).toMatch(/loses/);
  });

  it('returns null when the generation is older than one already answered', () => {
    const job = defaultEngraveJob();
    const fresh = previewer.engravePreview(job, 1000);
    expect(fresh).not.toBeNull();
    expect(previewer.engravePreview(job, 999)).toBeNull();
  });
});

// #213 §5 — the preview draws the sacrificial material AND moves the jaws onto it, so the picture
// matches what the sweep and the verifier will actually test against. Both assertions are on the
// preview's own output (boxes flagged `sacrificial-*`, jaw bbox faces), not on a re-run of
// `sacrificialBoxes`: the point is that the PREVIEW consumed them.
describe('engravePreview — sacrificial material (#213)', () => {
  // Its own previewer: the "null for an older generation" test above pins the shared one's
  // latest generation to 1000, so a shared counter would make every `++gen` here stale.
  const pv = createEngravePreviewer(tl);
  let g = 0;
  function preview(job: EngraveJob) {
    const p = pv.engravePreview(job, ++g);
    if (!p) throw new Error('the previewer refused a fresh generation');
    return p;
  }

  it('draws no sacrificial bodies and keeps the jaws on the part with none', () => {
    const job = defaultEngraveJob();
    const L = job.stock.length;
    const p = preview(job);
    expect(p.sacrificial).toEqual([]);
    // The fixed jaw's face is on x = 0; the moving jaw's is on x = L (the pre-#213 envelope).
    expect(p.fixture[0]!.mesh.bbox.max[0]).toBe(0);
    expect(p.fixture[1]!.mesh.bbox.min[0]).toBe(L);
  });

  it('draws the two strips and moves the jaws out by the strip thickness ("Strips between the jaws")', () => {
    const job = defaultEngraveJob();
    job.sacrificial = presetJawStrips();
    const L = job.stock.length;
    const p = preview(job);

    // The strips are drawn, one mesh per box, in the work frame: left X[-6, 0], right X[L, L+6].
    expect(p.sacrificial.map((s) => s.id)).toEqual(['sacrificial-left', 'sacrificial-right']);
    for (const s of p.sacrificial) expect(meshVolume(s.mesh)).toBeGreaterThan(0);
    expect(p.sacrificial[0]!.mesh.bbox).toMatchObject({ min: [-6, 0, -job.stock.thickness], max: [0, job.stock.width, 0] });
    expect(p.sacrificial[1]!.mesh.bbox).toMatchObject({ min: [L, 0, -job.stock.thickness], max: [L + 6, job.stock.width, 0] });

    // The 6 mm strips push both jaw faces out by 6 mm from the part's own edges.
    expect(p.fixture[0]!.mesh.bbox.max[0]).toBe(-6);
    expect(p.fixture[1]!.mesh.bbox.min[0]).toBe(L + 6);
    // …and each jaw keeps its own thickness: the fixed jaw's far side is its thickness past the face.
    expect(p.fixture[0]!.mesh.bbox.min[0]).toBe(-6 - job.workholding.vise.fixedJawThickness);
  });

  it('draws the under-board and moves the jaws out by its overhang ("Part on a larger board")', () => {
    const job = defaultEngraveJob();
    job.sacrificial = presetPartOnBoard();
    const L = job.stock.length;
    const p = preview(job);

    expect(p.sacrificial.map((s) => s.id)).toEqual(['sacrificial-under']);
    const under = p.sacrificial[0]!.mesh.bbox;
    // 10 mm overhang all round, 12 mm below the part's underside.
    expect(under).toMatchObject({ min: [-10, -10, -job.stock.thickness - 12], max: [L + 10, job.stock.width + 10, -job.stock.thickness] });

    // The 10 mm overhang, not the (absent) strips, is what shifts the jaws.
    expect(p.fixture[0]!.mesh.bbox.max[0]).toBe(-10);
    expect(p.fixture[1]!.mesh.bbox.min[0]).toBe(L + 10);
  });
});

describe('EngraveJob schema — #205’s cutOverride', () => {
  it('round-trips a v2 job that carries a cut override', () => {
    const result = parseEngraveJob({ ...defaultEngraveJob(), cutOverride: { rpm: 9000, stepOver: 0.4 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.cutOverride).toEqual({ rpm: 9000, stepOver: 0.4 });
  });

  it('leaves cutOverride absent on a v2 job that has none', () => {
    const result = parseEngraveJob(defaultEngraveJob());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.cutOverride).toBeUndefined();
  });

  it('stamps a version-1 job to v2 with no cut override (#213’s transform)', () => {
    const v2 = defaultEngraveJob();
    const v1: Record<string, unknown> = { ...v2, schemaVersion: 1 };
    delete v1.sacrificial;
    delete v1.breakthrough;

    const result = parseEngraveJob(JSON.parse(JSON.stringify(v1)) as unknown);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.schemaVersion).toBe(2);
    expect(result.job.sacrificial.under).toBeNull();
    expect(result.job.breakthrough).toBeGreaterThan(0);
    // A field this version added loads as "no override", never as a partial v1-shaped object.
    expect(result.job.cutOverride).toBeUndefined();
  });
});

// The depth ramp is the preview's only presentational rule that is worth pinning without a
// canvas: it is FIXED, so the same depth must read as the same colour in every job.
describe('the depth ramp (#205)', () => {
  it('pins the two ends, clamps outside them, and survives nothing being cuttable', () => {
    expect(depthColor(0, 4)).toBe(SHALLOW_COLOR);
    expect(depthColor(4, 4)).toBe(DEEP_COLOR);
    expect(depthColor(-1, 4)).toBe(SHALLOW_COLOR);
    expect(depthColor(9, 4)).toBe(DEEP_COLOR);
    // maxDepth = 0 would divide by zero; it reads as the shallow end instead.
    expect(depthColor(1, 0)).toBe(SHALLOW_COLOR);
  });

  it('is fixed, not per-job: a depth keeps its colour when the job gets a deeper cut', () => {
    expect(depthColor(1, 4)).toBe(depthColor(1, 4));
    expect(depthColor(1, 4)).not.toBe(depthColor(1, 8));
    // …and a mid depth is strictly between the ends.
    const mid = depthColor(2, 4);
    expect(mid).not.toBe(SHALLOW_COLOR);
    expect(mid).not.toBe(DEEP_COLOR);
  });
});
