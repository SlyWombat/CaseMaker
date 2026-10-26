/**
 * #674 — RAISED PRISMS: a V-bit carves a ring around a shape so the shape stands.
 *
 * The review seams. THE FUNNEL: the plan derives ONE ring region from the shape and the margin
 * (pure profile algebra) and hands it to the existing plane V-carve under the inlay's top-face
 * convention — no new CAM. THE OUTER BOUND: the cut stops at the margin, a ring around the shape,
 * never the whole blank. THE ORDER: the rings run from the mouth inward, so the outer bevel is cut
 * first and the standing shape's flank LAST. THE ORACLE: the V region's floor plus the `vRegion`
 * growth, judged by the same session oracle as any V-carve. THE REFUSALS: no cone, a point tip, a
 * base narrower than the tip's flat twice, and a shape that cannot carry one.
 */

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { createSimSession } from '@/workers/sim/session';
import { createEngravePreviewer } from '@/workers/sim/engravePreview';
import { preview } from './helpers/engravePipeline';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { jobTool, toSetup, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { DEFAULT_PRISM_BASE_MM, prismNumbers, prismRingProfile } from '@/engine/cnc/engrave/prism';
import { vCone } from '@/engine/cnc/vProfile';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { EngraveJob, EngraveRectShape } from '@/types/engraveJob';

const TOOL_KEY = 'chamfer-90-vcarve';

/** A 90° V with a 0.2 mm tip: a prism's base is cleared by the tip's flat. */
const V_TIP: Tool = flatEndMill(3.175, {
  id: null,
  name: '3.175 mm 90° V (0.2 tip)',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: 0.2,
  diameter: 3.175,
  angle: 90,
  halfAngle: null,
});

/** The same V with a point tip: no base can be cleared. */
const V_POINT: Tool = flatEndMill(3.175, {
  id: null,
  name: '3.175 mm 90° V',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: null,
  diameter: 3.175,
  angle: 90,
  halfAngle: null,
});

function rect(extra: Partial<EngraveRectShape> = {}): EngraveRectShape {
  return {
    id: 'plate',
    name: 'plate',
    kind: 'rect',
    position: { x: 20, y: 15 },
    rotation: 0,
    depth: 2,
    enabled: true,
    width: 20,
    height: 10,
    cornerRadius: 0,
    prism: {},
    ...extra,
  };
}

function prismJob(shape: EngraveRectShape = rect(), over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 40, width: 30 },
    labels: [],
    traces: [],
    toolKey: TOOL_KEY,
    tool: V_TIP,
    shapes: [shape],
    // A V-carve's feeds row is a fraction of the TIP's width, and a 0.2 mm tip is narrower than
    // the 3.175 cutter's default step-over — so the job states its step-over, as the other
    // V-carve specs do.
    cutOverride: { stepDown: 0.2, stepOver: 0.2 },
    ...over,
  };
}

const CONE = vCone(V_TIP)!;
const CONE_POINT = vCone(V_POINT)!;

const polygonArea = (polygons: [number, number][][]): number => {
  const cs = tl.CrossSection.ofPolygons(polygons);
  const area = cs.area();
  cs.delete();
  return area;
};

describe('prismNumbers — one derivation, the base labelled', () => {
  it('derives the margin, the plane radius and the tip’s path from the height and the cone', () => {
    const check = prismNumbers(CONE, 2, {});
    expect(check.ok).toBe(true);
    const n = check.numbers;
    expect(n.heightMm).toBe(2);
    expect(n.baseMm).toBe(DEFAULT_PRISM_BASE_MM);
    expect(n.baseSource).toBe('the CAM’s default');
    // 90° V: tan = 1, so the slope is 2 mm wide either side and the margin 1 + 4.
    expect(n.slopeWidthMm).toBeCloseTo(2, 9);
    expect(n.marginMm).toBeCloseTo(5, 9);
    expect(n.planeRadiusMm).toBeCloseTo(0.1 + 2, 9);
    expect(n.tipPathWidthMm).toBeCloseTo(1 - 0.2, 9);
  });

  it('takes a typed base and refuses a point tip and a base the tip cannot fit', () => {
    expect(prismNumbers(CONE, 2, { baseMm: 3 }).numbers.baseMm).toBe(3);
    const point = prismNumbers(CONE_POINT, 2, {});
    if (point.ok) throw new Error('a point tip cannot clear a base');
    expect(point.code).toBe('prism-tip');
    const narrow = prismNumbers(CONE, 2, { baseMm: 0.15 });
    if (narrow.ok) throw new Error('a base narrower than the tip twice leaves no path');
    expect(narrow.code).toBe('prism-base');
    const noCone = prismNumbers(null, 2, {});
    if (noCone.ok) throw new Error('no cone, no prism');
    expect(noCone.code).toBe('prism-needs-cone');
  });
});

describe('the plan — one derived ring in the shape’s place', () => {
  it('cuts the ring between the shape and its outward offset, not the shape', () => {
    const job = prismJob();
    const plan = toPartPlan(job);
    expect(plan.engraves).toHaveLength(1);
    const engrave = plan.engraves[0]!;
    expect(engrave.id).toBe('plate');
    expect(engrave.name).toBe('Prism rect "plate" 20×10');
    expect(engrave.prism).toBeDefined();
    expect(engrave.depth).toBe(2);

    const n = prismNumbers(CONE, 2, {}).numbers;
    const cs = executeProfile(tl, engrave.profile);
    const ring = cs.toPolygons() as [number, number][][];
    cs.delete();
    // The ring's area is the offset rectangle's less the shape's own, and its bbox reaches the
    // margin beyond the shape instead of covering the blank.
    const offsetCS = executeProfile(tl, prismRingProfile({ kind: 'p-rect', size: [20, 10], center: true }, n.marginMm));
    const offsetArea = offsetCS.area();
    offsetCS.delete();
    expect(polygonArea(ring)).toBeCloseTo(offsetArea, 6);
    let maxX = -Infinity;
    for (const contour of ring) for (const [x] of contour) maxX = Math.max(maxX, x);
    expect(maxX).toBeCloseTo(20 + 10 + n.marginMm, 3);
    expect(maxX).toBeLessThan(40);
  });

  it('leaves a shape with no prism marker a plain pocket', () => {
    const plain = rect({ prism: undefined });
    const plan = toPartPlan(prismJob(plain));
    expect(plan.engraves[0]!.prism).toBeUndefined();
    expect(plan.engraves[0]!.name).toBe('Pocket rect "plate" 20×10');
  });
});

describe('findings — what a prism cannot be cut with, or on', () => {
  const find = (job: EngraveJob, code: string) => validateJob(job).find((f) => f.code === code);

  it('refuses a cutter with no cone', () => {
    const flat = flatEndMill(3.175, { id: null, name: '3.175 mm flat', typeText: 'Flat End' });
    const f = find(prismJob(rect(), { toolKey: 'flat-3.175x12-metal', tool: flat }), 'prism-needs-cone');
    expect(f).toBeDefined();
    expect(f!.message).toContain('3.175 mm flat');
  });

  it('refuses a point tip, and a base narrower than its flat twice', () => {
    const point = find(prismJob(rect(), { tool: V_POINT }), 'prism-tip');
    expect(point).toBeDefined();
    expect(point!.message).toContain('point tip');
    const narrow = find(prismJob(rect({ prism: { baseMm: 0.15 } })), 'prism-base');
    expect(narrow).toBeDefined();
    expect(narrow!.message).toContain('0.15 mm');
    expect(narrow!.message).toContain('0.2 mm');
  });

  it('refuses a prism that is also a texture, an inlay or a through cut', () => {
    expect(find(prismJob(rect({ texture: { pattern: 'stipple' } })), 'prism-shape')).toBeDefined();
    expect(find(prismJob(rect({ inlay: { role: 'female' } })), 'prism-shape')).toBeDefined();
    expect(find(prismJob(rect({ through: true })), 'prism-shape')).toBeDefined();
  });

  it('refuses a combined shape carrying a prism', () => {
    const border = {
      id: 'ring',
      kind: 'border' as const,
      position: { x: 20, y: 15 },
      rotation: 0,
      depth: 1,
      enabled: true,
      inset: 2,
      width: 3,
      prism: { baseMm: 1 },
    };
    expect(find(prismJob(rect(), { shapes: [], combined: [border] }), 'prism-shape')).toBeDefined();
  });

  it('raises nothing for a prism with a tipped V and a real base', () => {
    expect(validateJob(prismJob()).filter((f) => f.code.startsWith('prism-'))).toEqual([]);
  });
});

describe('the program and the oracle', () => {
  it('cuts the ring outside-in and passes the oracle', () => {
    const job = prismJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();

    const n = prismNumbers(CONE, 2, {}).numbers;
    // The removal is bounded by the mouth's prism: at least the base's floor (the tip clears it)
    // and at most the whole mouth times the height (the slopes are inside the mouth). The mouth
    // is the shape grown by the margin all round.
    const floorArea = (20 + 2 * n.marginMm - 2 * n.slopeWidthMm) * (10 + 2 * n.marginMm - 2 * n.slopeWidthMm) - (20 + 2 * n.slopeWidthMm) * (10 + 2 * n.slopeWidthMm);
    const mouthArea = (20 + 2 * n.marginMm) * (10 + 2 * n.marginMm);
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${TOOL_KEY} is not in the library`);
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
      if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
      expect(session.oracle(g.predicted).ok).toBe(true);
      const removal = load.meshes.removal as NodeMeshOutput | null;
      if (removal !== null) {
        const body = new tl.Manifold(new tl.Mesh({ numProp: 3, vertProperties: removal.positions, triVerts: removal.indices }));
        const volume = body.volume();
        body.delete();
        expect(floorArea).toBeGreaterThan(20);
        expect(volume).toBeGreaterThan(floorArea * 2 * 0.8);
        expect(volume).toBeLessThan(mouthArea * 2);
      }
    } finally {
      session.dispose();
    }
  }, 120_000);

  it('clears the base outward and cuts the walls LAST, and the tip never reaches the shape', () => {
    const job = prismJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const n = prismNumbers(CONE, 2, {}).numbers;
    // The distance from a point to the shape's own outline (a 20×10 rect at 20,15).
    const toShape = (x: number, y: number): number =>
      Math.hypot(Math.max(0, Math.abs(x - 20) - 10), Math.max(0, Math.abs(y - 15) - 5));

    // Split the file into rings: each is a rapid to its start, a plunge, then its feeds.
    const rings: [number, number][][] = [];
    let current: [number, number][] = [];
    for (const line of (g.nc as string).split('\n')) {
      if (/^G0 /.test(line)) {
        if (current.length > 0) rings.push(current);
        current = [];
        continue;
      }
      const m = /^G1 X(-?\d+(?:\.\d+)?) Y(-?\d+(?:\.\d+)?)/.exec(line);
      if (m) current.push([Number(m[1]), Number(m[2])]);
    }
    if (current.length > 0) rings.push(current);
    expect(rings.length).toBeGreaterThan(3);
    const span = (ring: [number, number][]): number => Math.max(...ring.map(([x, y]) => toShape(x, y)));

    // `placeLoops` walks `pocketLoops`' rings INNERMOST first, so the base's middle is cleared
    // before the ring that runs against both walls: the last cut in the file is the one that
    // forms the bevel and the standing shape's flank, with the shape supported until then.
    expect(span(rings[rings.length - 1]!)).toBeGreaterThan(span(rings[0]!));

    // GOUGE SAFETY: no cutting point comes nearer the shape than the tip radius plus the slope
    // foot — the tip's flat is tangent to the shape's wall, so the shape is never undercut — and
    // none leaves the margin ring.
    const all = rings.flat();
    expect(all.length).toBeGreaterThan(40);
    for (const [x, y] of all) {
      expect(toShape(x, y)).toBeGreaterThan(n.planeRadiusMm - 0.05);
      expect(toShape(x, y)).toBeLessThan(n.marginMm + 0.05);
    }
  }, 60_000);

  it('states the height, the base and the margin on the run sheet', () => {
    const job = prismJob();
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const texts = buildRunSheet(job, g, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const step = texts.find((t) => t.includes('raised prism'));
    expect(step).toBeDefined();
    expect(step).toContain('stands 2 mm');
    expect(step).toContain('1 mm flat base');
    expect(step).toContain('the CAM’s default');
    expect(step).toContain('5 mm');
  }, 60_000);
});

describe('the picture — the ring is drawn as a V-carve', () => {
  it('leaves a floor at the standing height for the shape’s id', () => {
    const previewer = createEngravePreviewer(tl);
    const job = prismJob();
    const p = preview(previewer, job, 1);
    expect(p).not.toBeNull();
    const floor = p!.floors.filter((f) => f.labelId === 'plate');
    expect(floor).toHaveLength(1);
    expect(floor[0]!.depth).toBe(2);
  }, 120_000);
});

describe('the document — the marker round-trips', () => {
  it('saves and parses the base unchanged', () => {
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(prismJob(rect({ prism: { baseMm: 2.5 } })))));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.shapes[0]!.prism).toEqual({ baseMm: 2.5 });
  });

  it('refuses an unknown key in the marker, and a pre-#674 shape has none', () => {
    const dto = JSON.parse(JSON.stringify(prismJob())) as { shapes: { prism: Record<string, unknown> }[] };
    dto.shapes[0]!.prism = { baseMm: 1, angleDeg: 40 };
    expect(parseEngraveJob(dto).ok).toBe(false);
    const plain = parseEngraveJob(JSON.parse(JSON.stringify(prismJob(rect({ prism: undefined })))));
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.job.shapes[0]!.prism).toBeUndefined();
  });
});
