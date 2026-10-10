// Shape pockets (#214): rectangle, rounded rectangle, circle, slot, polygon — each at its own
// depth, through the SAME `itemProfile`/`toPartPlan`/`PartPlan` pipeline as a text label.
//
// Every geometric assertion is against a CLOSED FORM (the area a shape's definition implies),
// never against another run of the same code, and the area check is the issue's 0.5 %. The
// migration / schema / findings checks are pure zod and pure profile algebra; the engravability
// and toolpath checks drive the real Manifold evaluator the workers use.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate, engravability } from './helpers/engravePipeline';
import {
  itemProfile,
  polygonSelfIntersects,
  toPartPlan,
} from '@/engine/cnc/engrave/partPlan';
import { measureLabels } from '@/workers/sim/engraveGeometry';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { aabbOfProfile, type Profile } from '@/engine/compiler/profile';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import { generateEngrave } from '@/engine/cnc/cam/engraveJob';
import { feedsFor } from '@/engine/cnc/feeds';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import { Z1 } from '@/engine/cnc/machine';
import { createSimSession } from '@/workers/sim/session';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type {
  EngraveCircleShape,
  EngraveJob,
  EngravePolygonShape,
  EngraveRectShape,
  EngraveShape,
  EngraveSlotShape,
} from '@/types/engraveJob';

/** Area of a profile, with the CrossSection released. */
function area(p: Profile): number {
  const cs = executeProfile(tl, p);
  const a = cs.area();
  cs.delete();
  return a;
}

const base = { position: { x: 50, y: 30 }, rotation: 0, depth: 1, enabled: true };

function rect(over: Partial<EngraveRectShape> = {}): EngraveRectShape {
  return { id: 'r', kind: 'rect', width: 20, height: 10, cornerRadius: 0, ...base, ...over };
}
function circle(over: Partial<EngraveCircleShape> = {}): EngraveCircleShape {
  return { id: 'c', kind: 'circle', diameter: 20, ...base, ...over };
}
function slot(over: Partial<EngraveSlotShape> = {}): EngraveSlotShape {
  return { id: 's', kind: 'slot', length: 30, width: 10, ...base, ...over };
}
function polygon(points: [number, number][], over: Partial<EngravePolygonShape> = {}): EngravePolygonShape {
  return { id: 'p', kind: 'polygon', points, ...base, ...over };
}

/** Centre of a profile's bounding box, and its width/height. */
function box(p: Profile) {
  const b = aabbOfProfile(p)!;
  return {
    cx: (b.min[0] + b.max[0]) / 2,
    cy: (b.min[1] + b.max[1]) / 2,
    w: b.max[0] - b.min[0],
    h: b.max[1] - b.min[1],
  };
}

/** A one-shape job in the default stock, so the stock and edge margin are the shipped ones. */
function shapeJob(shape: EngraveShape, over: Partial<EngraveJob> = {}): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [];
  job.shapes = [shape];
  return { ...job, ...over };
}

describe('itemProfile (#214): area vs closed form, centred on position', () => {
  it('rectangle: width × height', () => {
    const p = itemProfile(rect(), []);
    const exact = 20 * 10;
    expect(Math.abs(area(p) - exact) / exact).toBeLessThan(0.005);
    const b = box(p);
    expect(Math.abs(b.cx - 50)).toBeLessThan(0.01);
    expect(Math.abs(b.cy - 30)).toBeLessThan(0.01);
  });

  it('rounded rectangle: w·h − (4 − π) r²', () => {
    const p = itemProfile(rect({ cornerRadius: 3 }), []);
    const exact = 20 * 10 - (4 - Math.PI) * 3 * 3;
    expect(Math.abs(area(p) - exact) / exact).toBeLessThan(0.005);
    const b = box(p);
    expect(Math.abs(b.cx - 50)).toBeLessThan(0.01);
    expect(Math.abs(b.cy - 30)).toBeLessThan(0.01);
  });

  it('circle: π r²', () => {
    // ⌀20 (r = 10): segmentsForRadius(10) is ≥ 100, so the inscribed polygon is well within 0.5 %.
    const p = itemProfile(circle(), []);
    const exact = Math.PI * 10 * 10;
    expect(Math.abs(area(p) - exact) / exact).toBeLessThan(0.005);
    const b = box(p);
    expect(Math.abs(b.cx - 50)).toBeLessThan(0.01);
    expect(Math.abs(b.cy - 30)).toBeLessThan(0.01);
  });

  it('slot: (L − w)·w + π (w/2)²', () => {
    const p = itemProfile(slot(), []);
    const exact = (30 - 10) * 10 + Math.PI * 5 * 5;
    expect(Math.abs(area(p) - exact) / exact).toBeLessThan(0.005);
    const b = box(p);
    expect(Math.abs(b.w - 30)).toBeLessThan(0.02);
    expect(Math.abs(b.h - 10)).toBeLessThan(0.01);
    expect(Math.abs(b.cx - 50)).toBeLessThan(0.01);
    expect(Math.abs(b.cy - 30)).toBeLessThan(0.01);
  });

  it('polygon: the exact shoelace area of its points', () => {
    const p = itemProfile(polygon([[-5, -5], [5, -5], [5, 5], [-5, 5]]), []);
    expect(Math.abs(area(p) - 100) / 100).toBeLessThan(0.005);
    const b = box(p);
    expect(Math.abs(b.cx - 50)).toBeLessThan(0.01);
    expect(Math.abs(b.cy - 30)).toBeLessThan(0.01);
  });

  it('rotating a rectangle 90° swaps its bounding box width and height', () => {
    const b0 = box(itemProfile(rect({ rotation: 0 }), []));
    const b90 = box(itemProfile(rect({ rotation: 90 }), []));
    expect(Math.abs(b90.w - 10)).toBeLessThan(0.02);
    expect(Math.abs(b90.h - 20)).toBeLessThan(0.02);
    // the swap of the ORIGINAL box, and still centred on the position
    expect(Math.abs(b90.w - b0.h)).toBeLessThan(0.02);
    expect(Math.abs(b90.h - b0.w)).toBeLessThan(0.02);
    expect(Math.abs(b90.cx - 50)).toBeLessThan(0.01);
    expect(Math.abs(b90.cy - 30)).toBeLessThan(0.01);
  });
});

describe('shape schema bounds (#214)', () => {
  it('rejects cornerRadius greater than min(width, height) / 2', () => {
    const job = shapeJob(rect({ width: 20, height: 10, cornerRadius: 6 }));
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((e) => e.includes('cornerRadius'))).toBe(true);
  });

  it('accepts cornerRadius exactly min(width, height) / 2', () => {
    const job = shapeJob(rect({ width: 20, height: 10, cornerRadius: 5 }));
    expect(parseEngraveJob(job).ok).toBe(true);
  });

  it('rejects a slot shorter than it is wide', () => {
    const job = shapeJob(slot({ length: 8, width: 10 }));
    const parsed = parseEngraveJob(job);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((e) => e.includes('length'))).toBe(true);
  });

  it('rejects a non-positive dimension', () => {
    const job = shapeJob(circle({ diameter: 0 }));
    expect(parseEngraveJob(job).ok).toBe(false);
  });

  it('rejects a polygon with fewer than 3 points', () => {
    const job = shapeJob(polygon([[0, 0], [1, 1]]));
    expect(parseEngraveJob(job).ok).toBe(false);
  });

  it('a version-1 job loads with its labels untouched and no shapes', () => {
    const v2 = defaultEngraveJob();
    const v1 = {
      schemaVersion: 1 as const,
      name: v2.name,
      stock: v2.stock,
      labels: v2.labels,
      toolKey: v2.toolKey,
      workholding: v2.workholding,
      minFloor: v2.minFloor,
      edgeMargin: v2.edgeMargin,
      customFonts: v2.customFonts,
    };
    const parsed = parseEngraveJob(v1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.schemaVersion).toBe(2);
    expect(parsed.job.labels).toEqual(v2.labels);
    expect(parsed.job.shapes).toEqual([]);
  });
});

describe('self-intersecting polygon (#214): a finding, not a cut', () => {
  const bowtie: [number, number][] = [[-5, -5], [5, 5], [5, -5], [-5, 5]];

  it('polygonSelfIntersects sees the crossing, and a simple ring is clean', () => {
    expect(polygonSelfIntersects(bowtie)).toBe(true);
    expect(polygonSelfIntersects([[-5, -5], [5, -5], [5, 5], [-5, 5]])).toBe(false);
  });

  it('validateJob reports polygon-self-intersecting', () => {
    const job = shapeJob(polygon(bowtie));
    const finding = validateJob(job).find((f) => f.code === 'polygon-self-intersecting');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');
    expect(finding!.labelId).toBe('p');
  });

  it('toPartPlan drops the crossing polygon, so no toolpath can be generated for it', () => {
    const job = shapeJob(polygon(bowtie));
    expect(toPartPlan(job).engraves).toHaveLength(0);

    // A simple polygon of the same size IS planned — the drop is about the crossing, not polygons.
    const good = shapeJob(polygon([[-5, -5], [5, -5], [5, 5], [-5, 5]]));
    expect(toPartPlan(good).engraves).toHaveLength(1);
  });
});

describe('shapes reach the engravability check (#214)', () => {
  /** The ⌀2 shape is smaller than the ⌀3.175 cutter, so its opening is empty. */
  it('a 2 mm circle under a 3.175 mm cutter is item-empty', () => {
    const job = shapeJob(circle({ diameter: 2, depth: 1 }), { toolKey: 'flat-3.175x12-metal' });
    const m = measureLabels(tl, toPartPlan(job), 3.175 / 2, job.edgeMargin, () => []);
    expect(m[0]!.openedArea).toBe(0);
    const f = engravability(job, m, () => 0);
    const empty = f.find((x) => x.code === 'item-empty');
    expect(empty).toBeDefined();
    expect(empty!.message).toBe(
      'A 2 mm hole cannot be cut with a 3.175 mm cutter: it is smaller than the cutter.',
    );
  });

  it('a 6 mm circle at 2 mm deep opens with the 3.175 mm cutter and generates a toolpath', () => {
    const job = shapeJob(circle({ id: 'c6', diameter: 6, depth: 2, name: 'port' }), {
      toolKey: 'flat-3.175x12-metal',
    });
    const m = measureLabels(tl, toPartPlan(job), 3.175 / 2, job.edgeMargin, () => []);
    expect(m[0]!.openedArea).toBeGreaterThan(0);
    expect(m[0]!.polygons.length).toBeGreaterThan(0);
    expect(engravability(job, m, () => 1)).toHaveLength(0);

    const tool = resolveTool('flat-3.175x12-metal')!;
    const feeds = feedsFor([], job.stock.material, tool, Z1);
    expect(feeds.ok).toBe(true);
    if (!feeds.ok) return;
    const ir = generateEngrave(
      tl,
      [{ id: 'c6', text: 'Circle "port" ⌀6', depth: 2, polygons: m[0]!.polygons }],
      tool,
      feeds.params,
    );
    expect(ir.operations).toHaveLength(1);
    expect(ir.operations[0]!.moves.some((mv) => mv.kind === 'feed' && mv.z < 0)).toBe(true);
  });

  it('a shape smaller than the cutter is reported by its plain name, not as a label', () => {
    const f = engravability(
      shapeJob(circle({ id: 'c2', diameter: 2, name: 'drain' })),
      [
        {
          labelId: 'c2',
          glyphArea: 3.14,
          openedArea: 0,
          ratio: 0,
          emptyChars: [],
          outsideArea: 0,
          polygons: [],
        },
      ],
      () => 0,
    );
    expect(f.some((x) => x.code === 'item-empty')).toBe(true);
  });
});

describe('a mixed job funnels through one PartPlan (#214)', () => {
  it('two labels and three shapes at five depths become five engraves, labels first', () => {
    const job = defaultEngraveJob();
    job.labels = job.labels.slice(0, 2);
    job.shapes = [
      { ...rect({ id: 'sr', depth: 3 }), enabled: true },
      { ...circle({ id: 'sc', depth: 4 }), enabled: true },
      { ...slot({ id: 'ss', depth: 5 }), enabled: true },
    ];
    const plan = toPartPlan(job);
    expect(plan.engraves.map((e) => e.id)).toEqual([
      job.labels[0]!.id,
      job.labels[1]!.id,
      'sr',
      'sc',
      'ss',
    ]);
    expect(plan.engraves.map((e) => e.depth)).toEqual([2.0, 1.0, 3, 4, 5]);
  });

  it('drops a disabled shape', () => {
    const job = shapeJob(circle({ enabled: false }));
    expect(toPartPlan(job).engraves).toHaveLength(0);
  });
});

/** Rebuild a solid from a meshed sweep result so its volume can be read (`Mesh` is a plain holder,
 *  nothing to `delete()`; the bytes are copied in). */
function meshSolid(mesh: NodeMeshOutput) {
  return new tl.Manifold(
    new tl.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }),
  );
}

describe('⌀6 circle end to end (#214): generate → verify → simulate → oracle', () => {
  // The issue's last outstanding test. A ⌀6 disc under a ⌀3.175 flat end mill is the case where
  // the cutter CAN clear the whole shape — its centre is confined to ⌀2.825 and the tool's own
  // disc then reaches ⌀6 — so unlike a rectangle there is no unreachable corner, and the only gap
  // between the plan and π·3² is the polygonisation both the plan and the sweep share.
  it('removes the opened area to a flat floor at the asked depth, and the oracle agrees', () => {
    const job = shapeJob(circle({ id: 'c6', diameter: 6, depth: 2, name: 'port' }), {
      toolKey: 'flat-3.175x12-metal',
    });

    const g = generate(tl, job);
    expect(g.errors).toEqual([]);
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();
    expect(g.verify?.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.predicted).toHaveLength(1);

    // The opened region the CAM cut and the oracle will be compared against.
    const planned = tl.CrossSection.ofPolygons(g.predicted[0]!.polygons);
    const plannedArea = planned.area();
    planned.delete();
    expect(Math.abs(plannedArea - Math.PI * 9) / (Math.PI * 9)).toBeLessThan(0.01);

    const tool = jobTool(job);
    if (tool === null) throw new Error('flat-3.175x12-metal is not in the tool library');
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
      if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
      expect(load.meshes.removal).not.toBeNull();

      // Removed volume is stated from the OPENED area, not from π·3²·2: the rim is polygonised, so
      // the swept solid is the plan's area × the depth to a flat floor, to within 1 %.
      const removed = meshSolid(load.meshes.removal as NodeMeshOutput);
      const volume = removed.volume();
      removed.delete();
      expect(Math.abs(volume - plannedArea * 2) / (plannedArea * 2)).toBeLessThan(0.01);

      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 30_000);
});
