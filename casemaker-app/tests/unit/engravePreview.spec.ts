// The engrave preview engine (#205): the stock cut to each label's depth, one floor mesh per
// label, the vise jaws, and the stale-generation rule. Real Manifold, plain Node — the same
// harness `engravable.spec.ts` uses.
//
// Every volumetric assertion is against a CLOSED FORM: the uncut prism's volume, and the
// removed volume the measurement says the cuts are worth (Σ openedArea × depth). A test that
// compared the mesh against another run of the same code would pass on a systematic error.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { preview, regions } from './helpers/engravePipeline';
import { createEngravePreviewer, FLOOR_THICKNESS_MM, LOST_THICKNESS_MM } from '@/workers/sim/engravePreview';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { effectiveMargins, MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';
import { jobTool, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { cuttingRadiusForSweep, flatEndMill, type Tool } from '@/engine/cnc/tool';
import { grooveRadiusAt, vCone } from '@/engine/cnc/vProfile';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { OVERSHOOT_MM } from '@/workers/geometry/sweep';
import { presetJawStrips, presetPartOnBoard } from '@/engine/cnc/sacrificial';
import { itemConditionSummary, type ConditionSummary } from '@/engine/cnc/toolCondition';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { viseForNewJob } from '@/engine/cnc/fixture';
import { defaultBadgeParams } from '@/types/badge';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { EngraveJob, EngraveLabel, EngraveShape } from '@/types/engraveJob';
import {
  depthColor,
  floorColor,
  SHALLOW_COLOR,
  DEEP_COLOR,
  SPLIT_TOP_COLOR,
  SPLIT_BOTTOM_COLOR,
} from '@/components/viewport/engraveRamp';

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
function buildPreview(job: EngraveJob) {
  const p = preview(previewer, job, ++gen);
  if (!p) throw new Error('the previewer refused a fresh generation');
  return p;
}

describe('engravePreview (#205)', () => {
  it('cuts the default job to Σ(openedArea × depth) of the uncut prism', () => {
    const job = defaultEngraveJob();
    const p = buildPreview(job);
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
    const p = buildPreview(defaultEngraveJob());
    expect(p.floors.map((f) => f.depth)).toEqual([2.0, 1.0, 0.5]);
    for (const floor of p.floors) expect(meshVolume(floor.mesh)).toBeGreaterThan(0);
  });

  it('draws the two vise jaws', () => {
    const p = buildPreview(defaultEngraveJob());
    expect(p.fixture.map((f) => f.id)).toEqual(['vise-fixed-jaw', 'vise-moving-jaw']);
    for (const jaw of p.fixture) expect(meshVolume(jaw.mesh)).toBeGreaterThan(0);
  });

  it('carries the registration band for the mount’s datum edge (§5.4)', () => {
    const p = buildPreview(defaultEngraveJob());
    expect(p.registration).toHaveLength(1);
    expect(p.registration[0]).toMatchObject({ edge: 'left', source: 'datum' });
    expect(p.registration[0]!.uncertainty).toBeGreaterThan(0);
  });

  it('leaves a label that is too deep out of the cut and reports it', () => {
    const job = defaultEngraveJob();
    job.labels = [{ ...job.labels[0]!, id: 'too-deep', text: 'DEEP', depth: 11.5 }];
    const p = buildPreview(job);
    const uncut = job.stock.length * job.stock.width * job.stock.thickness;

    expect(p.findings.some((f) => f.code === 'depth-exceeds-stock' && f.severity === 'error')).toBe(true);
    expect(p.floors).toHaveLength(0);
    // The stock is drawn uncut there: volume unchanged, within the mesh's own tolerance.
    expect(Math.abs(meshVolume(p.stock) - uncut)).toBeLessThan(uncut * 0.001);
  });

  // #171 — the void warning has to reach the LIVE panel, not only the run: the user places the
  // label with it on screen. The preview and `engraveGenerate` share `engraveCutRegions` and
  // `keepOutFindings`, so this pins the panel half of that pair.
  it('warns about a cut over a declared void, and only for the cut that covers it (#171)', () => {
    const job = defaultEngraveJob();
    const [case_, maker] = job.labels;
    // Size 8 keeps both boxes small enough to sit clearly inside / clearly outside the void.
    job.labels = [
      { ...case_!, id: 'over', size: 8, position: { x: 50, y: 30 }, depth: 0.8 }, // inside the void
      { ...maker!, id: 'clear', size: 8, position: { x: 50, y: 52 }, depth: 0.8 }, // behind it
    ];
    job.keepOuts = [
      {
        id: 'pocket',
        name: 'Magnet pocket',
        kind: 'rect',
        position: { x: 50, y: 30 },
        rotation: 0,
        enabled: true,
        zCeiling: 10,
        width: 30,
        height: 20,
        cornerRadius: 0,
      },
    ];

    const over = buildPreview(job).findings.filter((f) => f.code === 'item-over-void');
    expect(over).toHaveLength(1);
    expect(over[0]!.severity).toBe('warning');
    expect(over[0]!.labelId).toBe('over');
    expect(over[0]!.message).toContain('Magnet pocket');
  });

  // #270 — the panel half of the trace check: `keepOutFindings` sweeps the trace itself, and the
  // preview passes it the same radius the run does, so a trace crossing a void is warned about
  // while the line is being placed rather than only after Generate.
  it('warns about a TRACE over the void in the live preview too (#270)', () => {
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [];
    job.traces = [
      {
        kind: 'line',
        id: 'tr',
        position: { x: 35, y: 30 },
        rotation: 0,
        points: [
          [0, 0],
          [30, 0],
        ],
        closed: false,
        depth: 0.8,
        enabled: true,
      },
    ];
    job.keepOuts = [
      {
        id: 'pocket',
        name: 'Magnet pocket',
        kind: 'rect',
        position: { x: 50, y: 30 },
        rotation: 0,
        enabled: true,
        zCeiling: 10,
        width: 30,
        height: 20,
        cornerRadius: 0,
      },
    ];
    const over = buildPreview(job).findings.filter((f) => f.code === 'item-over-void');
    expect(over).toHaveLength(1);
    expect(over[0]!.labelId).toBe('tr');
  });

  it('reports the tool recommendation with the compromise size suggestion appended', () => {
    const job = defaultEngraveJob();
    // A 4 mm label cannot survive the 3.175 mm cutter, so the compromise message gains the
    // measured cap-height suggestion (#201's suggestCapHeight, composed in the worker).
    job.labels = [{ ...job.labels[0]!, text: 'MAKER', size: 4, depth: 1 }];
    job.toolKey = 'flat-3.175x12-metal';
    const p = buildPreview(job);
    // #407 — the built-in 3.175 mm row is Makera's `(Metal)` line and the only built-in at that
    // diameter, so the default softwood blank IS refused: `engraveRegions` reports
    // `tool-metal-line` beside the recommendation this case is about. Asserted, so the refused
    // pair is never silently treated as a valid job — there is no plain-named built-in to use.
    expect(p.findings.some((f) => f.code === 'tool-metal-line' && f.severity === 'error')).toBe(true);
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
    const p = buildPreview(job);
    // #407 — again the metal line, refused on this wood blank (see the case above): the floors
    // and the recommendation below are what the preview reports ALONGSIDE that refusal.
    expect(p.findings.some((f) => f.code === 'tool-metal-line')).toBe(true);
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
    const p2 = buildPreview({ ...job, toolKey: 'flat-1.0', labels: [], shapes: [sq] });
    expect(p2.floors.some((f) => f.labelId === 'sq')).toBe(true);
    expect(p2.recommendation.compromise).toBe(true);
    expect(p2.recommendation.reason).toMatch(/loses/);
  });

  it('returns null when the generation is older than one already answered', () => {
    const job = defaultEngraveJob();
    const fresh = preview(previewer, job, 1000);
    expect(fresh).not.toBeNull();
    expect(preview(previewer, job, 999)).toBeNull();
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
  function buildPreview(job: EngraveJob) {
    const p = preview(pv, job, ++g);
    if (!p) throw new Error('the previewer refused a fresh generation');
    return p;
  }

  it('draws no sacrificial bodies and keeps the jaws on the part with none', () => {
    const job = defaultEngraveJob();
    const L = job.stock.length;
    const p = buildPreview(job);
    expect(p.sacrificial).toEqual([]);
    // The fixed jaw's face is on x = 0; the moving jaw's is on x = L (the pre-#213 envelope).
    expect(p.fixture[0]!.mesh.bbox.max[0]).toBe(0);
    expect(p.fixture[1]!.mesh.bbox.min[0]).toBe(L);
  });

  it('draws the two strips and moves the jaws out by the strip thickness ("Strips between the jaws")', () => {
    const job = defaultEngraveJob();
    job.sacrificial = presetJawStrips();
    const L = job.stock.length;
    const p = buildPreview(job);

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
    const p = buildPreview(job);

    expect(p.sacrificial.map((s) => s.id)).toEqual(['sacrificial-under']);
    const under = p.sacrificial[0]!.mesh.bbox;
    // 10 mm overhang all round, 12 mm below the part's underside.
    expect(under).toMatchObject({ min: [-10, -10, -job.stock.thickness - 12], max: [L + 10, job.stock.width + 10, -job.stock.thickness] });

    // The 10 mm overhang, not the (absent) strips, is what shifts the jaws.
    expect(p.fixture[0]!.mesh.bbox.max[0]).toBe(-10);
    expect(p.fixture[1]!.mesh.bbox.min[0]).toBe(L + 10);
  });
});

// #288 — the picture drew only `plan.engraves`, so a plunge drill (#220) and a single-line trace
// (#219) were cut by the program and absent from the previewed blank. Each test's control is
// `plan.engraves` itself: the item's id is NOT in that list, which is exactly why the old loop could
// not have drawn it however long it ran.
describe('engravePreview — drills and traces are in the picture (#288)', () => {
  // Its own previewer: the tests above pin the shared one's latest generation.
  const pv = createEngravePreviewer(tl);
  let g = 0;
  function buildPreview(job: EngraveJob) {
    const p = preview(pv, job, ++g);
    if (!p) throw new Error('the previewer refused a fresh generation');
    return p;
  }

  /** The default job's cutter radius — asserted, not assumed, so a library change cannot hide here. */
  const R = (() => {
    const r = cuttingRadiusForSweep(jobTool(defaultEngraveJob())!);
    if (!r.ok) throw new Error('the default job’s cutter is not sweepable');
    return r.radius;
  })();

  /** Area of the regular n-gon `segmentsForRadius` polygonizes a disc of radius `r` into. */
  function discArea(r: number): number {
    const n = segmentsForRadius(r);
    return (n / 2) * r * r * Math.sin((2 * Math.PI) / n);
  }

  /** `uncut − removed`, off the drawn mesh — the preview's own account of what it cut. */
  function removedVolume(job: EngraveJob, p: ReturnType<typeof buildPreview>): number {
    return job.stock.length * job.stock.width * job.stock.thickness - meshVolume(p.stock);
  }

  /** One shallow label, so the drill's and the trace's own volume stands out against it. */
  function oneLabelJob(): EngraveJob {
    const job = defaultEngraveJob();
    job.labels = [{ ...job.labels[0]!, id: 'lbl', depth: 0.5 }];
    return job;
  }

  it('cuts a drill’s hole to its depth, and draws its floor', () => {
    const job = oneLabelJob();
    job.drills = [
      {
        kind: 'drill',
        id: 'd1',
        name: 'Magnet',
        position: { x: 20, y: 20 }, // clear of the label: the volumes below are summed, not unioned
        rotation: 0,
        depth: 3,
        enabled: true,
        through: false,
      },
    ];
    const p = buildPreview(job);

    // The control: a drill is not a region item, so `plan.engraves` never carried it.
    expect(toPartPlan(job).engraves.map((e) => e.id)).toEqual(['lbl']);

    const floor = p.floors.find((f) => f.labelId === 'd1');
    expect(floor).toBeDefined();
    expect(floor!.depth).toBe(3);
    // The floor IS the hole's cross-section: a prism of the cutter's own disc, so its mesh measures
    // the drawn hole against the closed form rather than against another run of this code.
    expect(meshVolume(floor!.mesh) / FLOOR_THICKNESS_MM).toBeCloseTo(discArea(R), 3);

    // …and the stock lost the label's region plus the hole, at their own depths.
    const labelArea = p.engravability.find((row) => row.labelId === 'lbl')!.openedArea;
    const expected = labelArea * 0.5 + discArea(R) * 3;
    expect(Math.abs(removedVolume(job, p) - expected) / expected).toBeLessThan(0.01);
  });

  it('cuts a trace’s swept groove to its depth, and draws its floor', () => {
    const job = oneLabelJob();
    job.traces = [
      {
        kind: 'line',
        id: 'tr',
        position: { x: 20, y: 30 },
        rotation: 0,
        points: [
          [0, 0],
          [30, 0],
        ],
        closed: false,
        depth: 2,
        enabled: true,
      },
    ];
    const p = buildPreview(job);

    // The control: nor is a trace — it is CAM'd by `generateTrace`, never pocketed as a region.
    expect(toPartPlan(job).engraves.map((e) => e.id)).toEqual(['lbl']);

    const floor = p.floors.find((f) => f.labelId === 'tr');
    expect(floor).toBeDefined();
    expect(floor!.depth).toBe(2);
    // The groove is the cutter's SWEEP, not the centre line: a 30 mm line under a r = 0.5 cutter is
    // a 30 × 1 mm capsule, 30 + πr² ≈ 30.79 mm² (polygonized, so a shade under).
    const grooveArea = meshVolume(floor!.mesh) / FLOOR_THICKNESS_MM;
    const capsule = 30 * (2 * R) + Math.PI * R * R;
    expect(Math.abs(grooveArea - capsule) / capsule).toBeLessThan(0.02);

    const labelArea = p.engravability.find((row) => row.labelId === 'lbl')!.openedArea;
    const expected = labelArea * 0.5 + capsule * 2;
    expect(Math.abs(removedVolume(job, p) - expected) / expected).toBeLessThan(0.03);
  });

  it('cuts a V-bit trace as the cone it sweeps, not a straight-walled slot (#420 slice 4)', () => {
    /** The bench bit: 30° included, 0.3 mm tip (halfAngle is measured from the axis). */
    const bit30 = (): Tool => ({
      number: 1,
      id: 'C1-BIT-ENGRAVE-30-0.3',
      name: 'Single Flute Engraving Bit 30 x 0.3',
      typeText: 'Engraving',
      shape: 'engraving',
      handleDiameter: 3.175,
      tipDiameter: 0.3,
      diameter: 3.175,
      cornerRadius: 0,
      angle: 30,
      halfAngle: 15,
      fluteLength: null,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
    });

    const job = oneLabelJob();
    job.labels = [];
    job.shapes = [];
    job.drills = [];
    job.tool = bit30();
    const depth = 1;
    job.traces = [
      {
        kind: 'line',
        id: 'tr',
        position: { x: 20, y: 30 },
        rotation: 0,
        points: [
          [0, 0],
          [30, 0],
        ],
        closed: false,
        depth,
        enabled: true,
      },
    ];
    const p = buildPreview(job);

    const cone = vCone(bit30())!;
    const r0 = cone.tipRadius;
    const t = cone.tanHalf;
    // The body's top is above the face (OVERSHOOT), so the cone is a shade wider there; that is
    // also the segment count the builder uses at every level.
    const bodyTopR = grooveRadiusAt(cone, depth + OVERSHOOT_MM);
    const n = segmentsForRadius(bodyTopR);
    const capFactor = (n / 2) * Math.sin((2 * Math.PI) / n);
    const length = 30;
    // The volume of the cone swept along the line, integrated level by level: a rectangle of
    // length `length` and cap at each end, with the reach from `grooveRadiusAt`.
    const integrated =
      2 * length * (r0 * depth + (t * depth * depth) / 2) +
      capFactor * (r0 * r0 * depth + r0 * t * depth * depth + (t * t * depth ** 3) / 3);

    const removed = removedVolume(job, p);
    expect(Math.abs(removed - integrated) / integrated).toBeLessThan(1e-3);

    // The shape being replaced: the mouth footprint extruded straight down. The taper must remove
    // materially less, and by the cone's own difference rather than a mesh accident.
    const mouthR = grooveRadiusAt(cone, depth);
    const slot = (2 * length * mouthR + Math.PI * mouthR * mouthR) * depth;
    expect(removed).toBeLessThan(slot * 0.9);

    // The floor is the TIP's flat, not the mouth.
    const floor = p.floors.find((f) => f.labelId === 'tr');
    expect(floor).toBeDefined();
    expect(floor!.depth).toBe(depth);
    const tipSegments = segmentsForRadius(r0);
    const tipCap = (tipSegments / 2) * Math.sin((2 * Math.PI) / tipSegments);
    const floorArea = meshVolume(floor!.mesh) / FLOOR_THICKNESS_MM;
    expect(floorArea).toBeCloseTo(2 * length * r0 + tipCap * r0 * r0, 4);
  });

  // The anti-drift test #288 is about: `engraveRegions().cuts` is the one list the prediction, the
  // program and the picture share, so this fails the moment a class reaches `cuts` undrawn (or a
  // drawn class is dropped from `cuts`) — which is the shape of the bug being fixed.
  it('draws exactly the cuts `engraveRegions` lists — one floor each, in that order', () => {
    const job = oneLabelJob();
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
    job.drills = [
      { kind: 'drill', id: 'd1', name: 'Magnet', position: { x: 20, y: 20 }, rotation: 0, depth: 3, enabled: true, through: false },
    ];
    job.traces = [
      {
        kind: 'line',
        id: 'tr',
        position: { x: 20, y: 10 },
        rotation: 0,
        points: [
          [0, 0],
          [10, 0],
        ],
        closed: false,
        depth: 1.5,
        enabled: true,
      },
    ];

    const cutIds = regions(tl, job).cuts.map((c) => c.id);
    expect(cutIds).toEqual(['lbl', 'hole', 'd1', 'tr']); // regions in plan order, then the traces

    const p = buildPreview(job);
    expect(p.floors.map((f) => f.labelId)).toEqual(cutIds);
    for (const floor of p.floors) expect(meshVolume(floor.mesh)).toBeGreaterThan(0);
  });
});

describe('engravePreview — V-carve outlines (#221)', () => {
  // Its own previewer: the "null for an older generation" test pins the shared one's latest
  // generation to 1000, so a shared counter would make every `++gen` here stale.
  const pv = createEngravePreviewer(tl);
  let g = 0;
  const build = (job: EngraveJob) => {
    const p = preview(pv, job, ++g);
    if (!p) throw new Error('the previewer refused a fresh generation');
    return p;
  };

  /** The bench bit: 30° included, 15° from the axis, 0.3 mm tip, 3.175 mm shank. */
  const bit30 = () =>
    flatEndMill(0.3, {
      name: 'Single Flute Engraving Bit 30 x 0.3',
      typeText: 'Engraving',
      shape: 'engraving',
      handleDiameter: 3.175,
      diameter: 3.175,
      tipDiameter: 0.3,
      angle: 30,
      halfAngle: 15,
    });

  const vJob = (): EngraveJob => {
    const base = defaultEngraveJob();
    return {
      ...base,
      stock: {
        length: 38.1,
        width: 76.2,
        thickness: 1.5,
        material: 'petg',
        print: { split: 1.3, layerHeight: 0.2 },
      },
      labels: [{ ...base.labels[0]!, position: { x: 19, y: 28 }, size: 8, depth: 0.394 }],
      toolKey: 'inv:kz-engrave-30-0-3',
      tool: bit30(),
    };
  };

  /** Shoelace area of a polygon set, mm² (outer CCW minus holes CW). */
  const ringsArea = (rings: [number, number][][]): number =>
    rings.reduce((sum, ring) => {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x0, y0] = ring[i]!;
        const [x1, y1] = ring[(i + 1) % ring.length]!;
        a += x0 * y1 - x1 * y0;
      }
      return sum + a / 2;
    }, 0);

  it('draws the surface opening, the colour plane and the floor for a V region', () => {
    const job = vJob();
    const p = build(job);
    const id = job.labels[0]!.id;
    const mine = p.outlines.filter((o) => o.labelId === id);
    expect(mine.map((o) => o.level)).toEqual(['surface', 'plane', 'floor']);

    const surface = mine.find((o) => o.level === 'surface')!;
    const plane = mine.find((o) => o.level === 'plane')!;
    const floor = mine.find((o) => o.level === 'floor')!;
    expect(surface.depth).toBe(0);
    expect(plane.depth).toBeCloseTo(0.2, 12); // the film
    expect(floor.depth).toBeCloseTo(0.394, 12);

    // The design is at the plane; the floor is e·tan narrower and the surface f·tan wider.
    expect(ringsArea(floor.rings)).toBeLessThan(ringsArea(plane.rings));
    expect(ringsArea(surface.rings)).toBeGreaterThan(ringsArea(plane.rings));
  });

  it('draws no outlines for a flat end mill: its three levels are one polygon set', () => {
    expect(build(defaultEngraveJob()).outlines).toEqual([]);
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

  it('stamps a version-1 job to v3 with no cut override (#213’s transform, #425’s stamp)', () => {
    const v2 = defaultEngraveJob();
    const v1: Record<string, unknown> = { ...v2, schemaVersion: 1 };
    delete v1.sacrificial;
    delete v1.breakthrough;

    const result = parseEngraveJob(JSON.parse(JSON.stringify(v1)) as unknown);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.schemaVersion).toBe(3);
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

// #170 — the choice of WHICH colouring is in force. Two floors either side of a split are drawn in
// the two stand-ins rather than on the ramp, and a blank with no split keeps the ramp it always
// had. Pinned here because it is a rule about what the picture MEANS, and it needs no canvas.
describe('floorColor — the two-colour reading (#170)', () => {
  it('sends a floor either side of the split to the two stand-in colours', () => {
    expect(floorColor(1.0, 4, 1.2)).toBe(SPLIT_TOP_COLOR);
    expect(floorColor(1.4, 4, 1.2)).toBe(SPLIT_BOTTOM_COLOR);
    // The split itself is the bottom colour's plane (`floorColour`).
    expect(floorColor(1.2, 4, 1.2)).toBe(SPLIT_BOTTOM_COLOR);
  });

  it('keeps the ramp — and only the ramp — on a blank that states no split', () => {
    expect(floorColor(2, 4, null)).toBe(depthColor(2, 4));
    expect(floorColor(0, 4, null)).toBe(depthColor(0, 4));
  });

  it('does not use the ramp at all once a split is known: depth is no longer the question', () => {
    // The whole point of the change: 1.0 and 1.4 are nearly the same colour on a 4 mm ramp, which
    // is exactly the confusion the two-state control exists to prevent.
    for (const d of [0, 1, 2, 3, 4]) {
      expect(floorColor(d, 4, 1.2)).not.toBe(depthColor(d, 4));
    }
  });
});

// #271 — the void the panel declares must reach the PREVIEW, or the outline the user places a
// label against is not the region the depth limit refuses over. The rings are asserted as a
// footprint (a bbox off the returned plain numbers), not by re-evaluating the profile here: the
// point is that the worker resolved `keepOutProfile` and shipped it.
describe('engravePreview — declared under-surface voids (#271)', () => {
  // Its own previewer: the tests above pin the shared one’s latest generation.
  const pv = createEngravePreviewer(tl);
  let g = 0;
  function buildPreview(job: EngraveJob) {
    const p = preview(pv, job, ++g);
    if (!p) throw new Error('the previewer refused a fresh generation');
    return p;
  }

  /** The bounding box of every ring of one void, as the viewport would see them. */
  function ringBBox(rings: [number, number][][]) {
    const xs = rings.flat().map(([x]) => x);
    const ys = rings.flat().map(([, y]) => y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }

  it('outlines the footprint and states what the ceiling leaves', () => {
    const job = defaultEngraveJob();
    job.keepOuts = [
      {
        id: 'pocket',
        name: 'Magnet pocket',
        kind: 'rect',
        position: { x: 50, y: 30 },
        rotation: 0,
        enabled: true,
        zCeiling: 10,
        width: 30,
        height: 20,
        cornerRadius: 0,
      },
    ];
    const p = buildPreview(job);

    expect(p.voids).toHaveLength(1);
    const v = p.voids[0]!;
    expect(v.id).toBe('pocket');
    expect(v.name).toBe('Magnet pocket');
    // 12 mm blank, ceiling 10: 2 mm of material left, and #345's margin taken off it. This fixture
    // MOVED back to 1 mm on decision A: the default job states NO print, so there is no layer grid
    // to make the 0.2 mm boundary margin a distance the printer can hold, and the void keeps the
    // job's 1 mm structural floor instead — 2 − 1.0 = 1.0, the same number the pre-#345 analytic
    // limit printed.
    expect(v.membrane).toBeCloseTo(2, 6);
    expect(v.limit).toBeCloseTo(1.0, 6);
    // The rings ARE the footprint: 30 × 20 centred on (50, 30) in the work frame.
    expect(ringBBox(v.rings)).toMatchObject({ minX: 35, maxX: 65, minY: 20, maxY: 40 });
  });

  it('resolves the arc kinds too, and drops a disabled void', () => {
    const job = defaultEngraveJob();
    job.keepOuts = [
      {
        id: 'hole',
        kind: 'circle',
        position: { x: 20, y: 20 },
        rotation: 0,
        enabled: false,
        zCeiling: 3,
        diameter: 8,
      },
      {
        id: 'slot',
        kind: 'slot',
        position: { x: 70, y: 40 },
        rotation: 0,
        enabled: true,
        zCeiling: 3,
        length: 20,
        width: 6,
      },
    ];
    const p = buildPreview(job);

    // A disabled void reserves nothing, so it is not drawn — the same list `toPartPlan` filters.
    expect(p.voids.map((v) => v.id)).toEqual(['slot']);
    const bbox = ringBBox(p.voids[0]!.rings);
    expect(bbox.minX).toBeCloseTo(60, 6);
    expect(bbox.maxX).toBeCloseTo(80, 6);
    expect(bbox.minY).toBeCloseTo(37, 6);
    expect(bbox.maxY).toBeCloseTo(43, 6);
    // The same bound as above: membrane (12 − 3) less the job's 1 mm floor, since this blank
    // states no print (#345 decision A).
    expect(p.voids[0]!.limit).toBeCloseTo(12 - 3 - 1.0, 6);
  });

  it('states what the LAYER GRID gives, not the declared membrane’s own answer (#351)', () => {
    // The blank the wizard seeds (#352) states the badge's print, so this void's roof is quantised
    // onto the 0.2 mm layer grid: the 1.51 mm of declared membrane becomes a 1.40 mm roof, and the
    // 0.2 mm boundary margin makes the limit 1.20. The viewport label used to read the analytic
    // 1.31 while the verifier refused every cut below 1.20 — #351, and the reason this number now
    // comes from `keepOutLimit` rather than being composed where the label is drawn.
    const blank = badgeBlankFor(defaultBadgeParams({ print: { layerHeight: 0.2, firstLayerHeight: 0.2 } }));
    const job: EngraveJob = {
      ...defaultEngraveJob(),
      stock: blank.stock,
      keepOuts: blank.pocket ? [blank.pocket] : [],
    };
    const p = buildPreview(job);

    expect(p.voids).toHaveLength(1);
    expect(p.voids[0]!.membrane).toBeCloseTo(1.51, 6); // still what the document declares
    expect(p.voids[0]!.limit).toBeCloseTo(1.2, 6); // what the run enforces, and what the label reads
  });
});

// #285/#345 — the boundary has two halves and this is the panel's: the number the viewport draws
// the line at, and the per-item `item-depth-bound` a label gets when its floor breaks the split's
// bound. Both come off the SAME `engraveRegions` call the cuts do, so the line and the finding
// cannot disagree.
describe('engravePreview — the colour boundary (#285, #345)', () => {
  // Its own previewer: the tests above pin the shared one’s latest generation.
  const pv = createEngravePreviewer(tl);
  let g = 0;
  function buildPreview(job: EngraveJob, margins = effectiveMargins(job, MARGIN_DEFAULTS)) {
    const p = preview(pv, job, ++g, [], margins);
    if (!p) throw new Error('the previewer refused a fresh generation');
    return p;
  }

  /** The badge's blank, with `over` merged into the one label over the pocket. `print=false` states
   *  NO print explicitly, because `defaultBadgeParams` now carries one (#368) and the "no boundary
   *  at all" side of #285's switch has to stay reachable. */
  function badgeJob(print: boolean, depth: number, over: Partial<EngraveLabel> = {}): EngraveJob {
    const badge = defaultBadgeParams(
      print ? { print: { layerHeight: 0.2, firstLayerHeight: 0.2 } } : { print: undefined },
    );
    const blank = badgeBlankFor(badge);
    const base = defaultEngraveJob(viseForNewJob(undefined, blank.stock));
    return {
      ...base,
      stock: blank.stock,
      keepOuts: blank.pocket ? [blank.pocket] : [],
      labels: [
        {
          id: 'lbl',
          text: 'CASE',
          font: base.labels[0]!.font,
          weight: 'bold',
          size: 6,
          // The magnet pocket's own centre on the TURNED blank (#383): the blank is 38.1 × 76.2,
          // so the pocket is 13 mm across X and 45 mm along Y about (19.05, 38.1).
          position: { x: 19.05, y: 38.1 },
          rotation: 0,
          depth,
          enabled: true,
          ...over,
        },
      ],
    };
  }

  it('reports the boundary the printer’s layers put the colour change on', () => {
    // 3.81 − 3.0 = 0.81 below the engraved face; the nearest 0.2 mm layer line is 0.8.
    expect(buildPreview(badgeJob(true, 0.5)).colourBoundaryDepth).toBeCloseTo(0.8, 6);
  });

  it('reports no boundary at all for a job that states no print', () => {
    expect(buildPreview(badgeJob(false, 0.5)).colourBoundaryDepth).toBeNull();
  });

  /**
   * The `item-depth-bound` findings for a job — the split's bound, and only it (#345).
   *
   * The default badge's split lands on 0.8 mm (above) and its default `boundaryMargin` is one
   * printed layer, 0.2 mm — so a `surface` floor must be at most 0.6 and a `reveal` floor at least
   * 1.0. Those are the numbers the cases below are written against.
   */
  function boundFindings(job: EngraveJob): JobFinding[] {
    return buildPreview(job).findings.filter((f) => f.code === 'item-depth-bound');
  }

  it('refuses a "surface" floor that lands ON the split', () => {
    // #285's review found the equality here was decided by whichever side of `≥`/`≤` the old test
    // happened to use. The bound always subtracts its margin, so a floor in the plane is refused
    // and there is no equality left to argue about.
    const wrong = boundFindings(badgeJob(true, 0.8, { depthIntent: 'surface' }));
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.severity).toBe('error');
    expect(wrong[0]!.labelId).toBe('lbl');
    // The sentence names the plane and the side, so the fix ("no deeper than 0.6") is legible.
    expect(wrong[0]!.message).toContain('the colour split is at 0.8 mm');
    expect(wrong[0]!.message).toContain('must stay 0.2 mm above it');
    expect(wrong[0]!.message).toContain('no deeper than 0.6 mm');
  });

  it('passes a "surface" floor exactly one margin above the split', () => {
    expect(boundFindings(badgeJob(true, 0.6, { depthIntent: 'surface' }))).toHaveLength(0);
  });

  it('refuses a "reveal" floor that lands ON the split', () => {
    const wrong = boundFindings(badgeJob(true, 0.8, { depthIntent: 'reveal' }));
    expect(wrong).toHaveLength(1);
    expect(wrong[0]!.severity).toBe('error');
    expect(wrong[0]!.message).toContain('the colour split is at 0.8 mm');
    expect(wrong[0]!.message).toContain('must go 0.2 mm below it');
    expect(wrong[0]!.message).toContain('at least 1 mm');
  });

  it('passes a "reveal" floor exactly one margin below the split', () => {
    // The other side of the same bound, and the reason it is not a `cut-too-deep` limit: a reveal
    // PAST the split is exactly what a two-colour blank is for.
    expect(boundFindings(badgeJob(true, 1, { depthIntent: 'reveal' }))).toHaveLength(0);
  });

  it('raises no SPLIT bound without a print — the label’s finding is the pocket’s void (#345 B)', () => {
    // #285's "no print, no split" still holds: `colourBoundaryFor` returns null, so no split bound
    // is built for either intent. But #345 decision B judges every label against every bound under
    // its footprint, and this label sits on the badge's magnet pocket — so the finding that arrives
    // names the POCKET's ceiling, not a colour split the job does not have.
    const blind = boundFindings(badgeJob(false, 0.9, { depthIntent: 'surface' }));
    expect(blind).toHaveLength(1);
    expect(blind[0]!.severity).toBe('error');
    expect(blind[0]!.labelId).toBe('lbl');
    expect(blind[0]!.message).toContain("the magnet pocket's ceiling");
    // 1.51 mm of membrane less the job's 1 mm floor, with no layer grid to make a smaller margin
    // mean anything (#345 decision A).
    expect(blind[0]!.message).toContain('no deeper than 0.51 mm');
    expect(blind[0]!.message).not.toContain('colour split');
  });

  it('leaves "custom" alone — the advanced override says the number is the point', () => {
    expect(boundFindings(badgeJob(true, 0.9, { depthIntent: 'custom' }))).toHaveLength(0);
  });

  it('leaves a label with no intent alone — it states no expectation', () => {
    expect(boundFindings(badgeJob(true, 0.9))).toHaveLength(0);
  });

  it('skips a disabled label and a construction label — neither has a floor to place', () => {
    expect(boundFindings(badgeJob(true, 0.9, { depthIntent: 'surface', enabled: false }))).toHaveLength(0);
    expect(boundFindings(badgeJob(true, 0.9, { depthIntent: 'surface', construction: true }))).toHaveLength(0);
  });

  it('takes the margin from the caller, not from the job (#345)', () => {
    // A house margin of 0.5 mm refuses a floor that the shipped 0.2 allows: the same job, the same
    // split, one number different — which is the whole point of the margin being a setting.
    const job = badgeJob(true, 0.6, { depthIntent: 'surface' });
    const p = buildPreview(job, { ...effectiveMargins(job, MARGIN_DEFAULTS), boundaryMargin: 0.5, source: 'user' });
    expect(p.findings.filter((f) => f.code === 'item-depth-bound')).toHaveLength(1);
  });
});

// #442 — the plain `conditions` argument the worker's previewer is handed, put to work end to end.
// `engravePreviewConditions.spec.ts` proves the store hands the table across the boundary and
// `recommendTool.spec.ts` proves the rule reads it; this pins that the table actually reaches the
// recommendation the worker returns, so a break anywhere between them is caught here.
describe('engravePreview — the bench’s cutter conditions (#442)', () => {
  // Its own previewer: the tests above pin the shared one’s latest generation.
  const pv = createEngravePreviewer(tl);
  let g = 0;
  function buildPreview(job: EngraveJob, conditions: ReadonlyMap<string, ConditionSummary>) {
    const p = preview(pv, job, ++g, [], effectiveMargins(job, MARGIN_DEFAULTS), conditions);
    if (!p) throw new Error('the previewer refused a fresh generation');
    return p;
  }

  it('drops the job’s own cutter when every copy is marked broken, and picks another (#442)', () => {
    // The default job names the 1.0 mm built-in, so its own cutter is the one to mark broken. The
    // summary is built by `toolCondition`'s own function — the very one `toolRegistryStore` fills the
    // lookup with — so this is not a hand-shaped summary that could differ from the app's.
    const job = defaultEngraveJob();
    const summary = itemConditionSummary({
      id: job.toolKey,
      quantity: 1,
      copies: [
        { id: 'c1', condition: 'broken', whereabouts: { kind: 'box' }, runtimeWarnMinutes: null, notes: null, runtimeMinutes: null },
      ],
    });

    // The control: with no table handed in, the job's own cutter is the pick — so the change below is
    // the conditions' doing and not a default of this fixture.
    expect(buildPreview(job, new Map()).recommendation.key).toBe(job.toolKey);

    const p = buildPreview(job, new Map([[job.toolKey, summary]]));
    const own = p.recommendation.candidates.find((c) => c.key === job.toolKey)!;
    // The operator's own statement outranks the numbers, and it arrives as the caller's summary — the
    // worker derives nothing of its own — so the broken cutter is out by name, before it is measured.
    expect(own.excluded).toBe('broken');
    expect(own.condition).toEqual(summary);
    // …and the rule moves to the cutter it can still cut with: the other built-in.
    expect(p.recommendation.key).toBe('flat-3.175x12-metal');
  });
});

// §5.7 — the lost layer. The controls are the measurements the preview ALREADY returns: a lost
// area must be `glyphArea − openedArea` for the same item (the ratio the panel prints), and the
// drawn sliver must be worth that area times its own thickness. That way the amber region cannot
// drift from the row's "N % kept" while both still pass their own tests.
describe('engravePreview — the lost layer (§5.7)', () => {
  // Its own previewer: the tests above pin the shared one's latest generation.
  const pv = createEngravePreviewer(tl);
  let g = 0;
  function buildPreview(job: EngraveJob) {
    const p = preview(pv, job, ++g);
    if (!p) throw new Error('the previewer refused a fresh generation');
    return p;
  }

  it('counts design − as-cut per region item, matching the engravability row', () => {
    const job = defaultEngraveJob();
    const p = buildPreview(job);

    // The shipped acceptance job's 8 mm label keeps 98.8 % (#209), so every label has some loss.
    expect(p.lost.map((l) => l.labelId)).toEqual(job.labels.map((l) => l.id));

    for (const lost of p.lost) {
      const row = p.engravability.find((r) => r.labelId === lost.labelId)!;
      const expected = row.glyphArea - row.openedArea;
      expect(expected).toBeGreaterThan(0);
      expect(Math.abs(lost.area - expected) / expected).toBeLessThan(0.02);
      // The contours ARE the area the mesh was built from: a 20 µm sliver measures area × thickness.
      expect(Math.abs(meshVolume(lost.mesh) / LOST_THICKNESS_MM - lost.area) / lost.area).toBeLessThan(0.02);
      // It stands ON the top face, never in the cut.
      expect(lost.mesh.bbox.min[2]).toBeCloseTo(0, 6);
      expect(lost.mesh.bbox.max[2]).toBeCloseTo(LOST_THICKNESS_MM, 6);
    }
  });

  it('does not paint a fully dropped glyph as lost: `item-empty` already refuses it by name', () => {
    const job = defaultEngraveJob();
    job.labels = [{ ...job.labels[0]!, id: 'tiny', text: 'I', size: 1.5, depth: 0.5 }];
    const p = buildPreview(job);

    const row = p.engravability.find((r) => r.labelId === 'tiny')!;
    // The cutter is 1.0 mm across; a 1.5 mm bar is far thinner, so the opening is empty.
    expect(row.openedArea).toBe(0);
    expect(row.glyphArea).toBeGreaterThan(0);
    // That is an ERROR (`item-empty`), and the picture leaves the item uncut. The lost layer is
    // deliberately silent here: the finding already says the item is not cut, and amber over the
    // whole glyph would read as a cutter limitation rather than the refusal it is.
    expect(p.findings.some((f) => f.code === 'item-empty' && f.labelId === 'tiny' && f.severity === 'error')).toBe(true);
    expect(p.lost).toHaveLength(0);
  });

  it('leaves an item with an ERROR finding out of the picture, and out of the lost layer too', () => {
    const job = defaultEngraveJob();
    job.labels = job.labels.map((l, i) => (i === 1 ? { ...l, depth: 11.5 } : l));
    const p = buildPreview(job);

    expect(p.findings.some((f) => f.code === 'depth-exceeds-stock' && f.labelId === job.labels[1]!.id)).toBe(true);
    expect(p.lost.map((l) => l.labelId)).not.toContain(job.labels[1]!.id);
    // The other two are still measured and still drawn.
    expect(p.lost.map((l) => l.labelId)).toEqual([job.labels[0]!.id, job.labels[2]!.id]);
  });

  // §5.7 — the design ↔ as-cut slider. Each stage is a CLOSED-FORM material state: the blank less
  // the opened area of every cut at or shallower than that stage's depth. A test that compared the
  // stages to each other would pass even if all of them were the finished stock.
  it('returns the cumulative stock at each cut depth, starting at the uncut design', () => {
    const job = defaultEngraveJob();
    const p = buildPreview(job);
    const uncut = job.stock.length * job.stock.width * job.stock.thickness;

    // The three labels cut at 2.0, 1.0 and 0.5 mm: the design, then a state after each of the two
    // shallower depths. The deepest state is `stock`, never a duplicate stage.
    expect(p.stages.map((s) => s.depth)).toEqual([0, 0.5, 1]);
    expect(p.stages[0]!.mesh).not.toBe(p.stock);

    const removedBy = (limit: number): number =>
      p.engravability.reduce((sum, row) => {
        const depth = job.labels.find((l) => l.id === row.labelId)?.depth ?? 0;
        return depth > 0 && depth <= limit ? sum + row.openedArea * depth : sum;
      }, 0);

    // The design stage IS the blank.
    expect(Math.abs(meshVolume(p.stages[0]!.mesh) - uncut)).toBeLessThan(uncut * 0.001);
    for (const stage of p.stages) {
      const removed = uncut - meshVolume(stage.mesh);
      const expected = removedBy(stage.depth);
      expect(Math.abs(removed - expected), `stage ${stage.depth} mm`).toBeLessThan(
        Math.max(expected * 0.02, uncut * 0.0005),
      );
    }
    // The finished stock removes every depth, and more than the last stage did.
    const finalRemoved = uncut - meshVolume(p.stock);
    expect(Math.abs(finalRemoved - removedBy(Infinity))).toBeLessThan(finalRemoved * 0.01);
    expect(finalRemoved).toBeGreaterThan(uncut - meshVolume(p.stages[p.stages.length - 1]!.mesh));
  });

  it('has no stages when nothing is cut — the slider has no second state to show', () => {
    const job = defaultEngraveJob();
    job.labels.forEach((l) => {
      l.enabled = false;
    });
    const p = buildPreview(job);

    expect(p.floors).toHaveLength(0);
    expect(p.stages).toEqual([]);
  });

  it('has no lost layer for a drill or a trace — neither design is an area the cutter falls short of', () => {
    const job = defaultEngraveJob();
    job.labels = [{ ...job.labels[0]!, id: 'lbl', depth: 0.5 }];
    job.drills = [
      {
        kind: 'drill',
        id: 'd1',
        name: 'Magnet',
        position: { x: 20, y: 20 },
        rotation: 0,
        depth: 3,
        enabled: true,
        through: false,
      },
    ];
    job.traces = [
      {
        kind: 'line',
        id: 'tr',
        position: { x: 20, y: 40 },
        rotation: 0,
        points: [
          [0, 0],
          [30, 0],
        ],
        closed: false,
        depth: 2,
        enabled: true,
      },
    ];
    const p = buildPreview(job);
    expect(p.lost.map((l) => l.labelId)).toEqual(['lbl']);
  });
});
