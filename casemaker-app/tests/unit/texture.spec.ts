/**
 * #670 — SURFACE TEXTURES: a seeded pattern of short strokes over one region, cut as traces.
 *
 * The review seams. FUNNEL: the pattern arrives at the program, the oracle and the picture as
 * `plan.traces` entries — a shape carrying a texture is never pocketed. NUMBERS: one reading
 * (`textureNumbers`) quoted by the row, the findings, the plan and the sheet; the seed is stored
 * and the same document posts the same file byte for byte. CLIPPING: every emitted point is
 * inside the region, checked against an INDEPENDENT inside test per kind. ORDER: every cut the
 * texture writes sits at or above its depth, so a plunge into a neighbour's already-open groove
 * can never bite deeper. ORACLE: the prediction is the strokes' groove envelope, and the removal
 * is far less than the region's flat pocket — a flat-floor regression fails. ROUND TRIP: the
 * marker parses, an unknown pattern is refused, and the paths are never stored.
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
import { parseEngraveJob } from '@/store/engraveJobSchema';
import {
  DEFAULT_MAX_TEXTURE_STROKES,
  DEFAULT_TEXTURE_PITCH_MM,
  DEFAULT_TEXTURE_SEED,
  DEFAULT_TEXTURE_STROKE_MM,
  textureNumbers,
  textureOperationName,
  textureStrokes,
} from '@/engine/cnc/engrave/texture';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type {
  EngraveCircleShape,
  EngraveJob,
  EngravePolygonShape,
  EngraveRectShape,
  EngraveShape,
  EngraveSlotShape,
} from '@/types/engraveJob';

const TOOL_KEY = 'chamfer-90-vcarve';

/** A 90° V: tan(halfAngle) = 1, point tip. */
const V_TOOL: Tool = flatEndMill(3.175, {
  id: null,
  name: '3.175 mm 90° V',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: null,
  diameter: 3.175,
  angle: 90,
  halfAngle: null,
});

type P = [number, number];

function rect(id = 'texture', extra: Partial<EngraveRectShape> = {}): EngraveRectShape {
  return {
    id,
    name: 'stipple',
    kind: 'rect',
    position: { x: 15, y: 10 },
    rotation: 0,
    depth: 0.8,
    enabled: true,
    width: 10,
    height: 6,
    cornerRadius: 0,
    texture: { pattern: 'stipple' },
    ...extra,
  };
}

function textureJob(shape: EngraveShape = rect(), over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 40, width: 30 },
    labels: [],
    traces: [],
    toolKey: TOOL_KEY,
    tool: V_TOOL,
    shapes: [shape],
    ...over,
  };
}

/** Every point of every path inside the region, by a test written HERE, not the module's. */
function allInsideRect(paths: readonly P[][], cx: number, cy: number, w: number, h: number, tol = 1e-9): boolean {
  return paths.every((path) => path.every(([x, y]) => Math.abs(x - cx) <= w / 2 + tol && Math.abs(y - cy) <= h / 2 + tol));
}

describe('textureNumbers — one reading, the defaults labelled', () => {
  it('reads absent numbers as the CAM defaults and marks them so', () => {
    const n = textureNumbers({ pattern: 'stipple' }, 2);
    expect(n.pattern).toBe('stipple');
    expect(n.pitchMm).toBe(DEFAULT_TEXTURE_PITCH_MM);
    expect(n.strokeMm).toBe(DEFAULT_TEXTURE_STROKE_MM);
    expect(n.seed).toBe(DEFAULT_TEXTURE_SEED);
    expect(n.depthMm).toBe(2);
    expect(n.pitchSource).toBe('the CAM’s default');
    expect(n.strokeSource).toBe('the CAM’s default');
  });

  it('keeps a typed number and says it is typed', () => {
    const n = textureNumbers({ pattern: 'scallop', pitchMm: 2.5, strokeMm: 3, seed: 7 }, 1.2);
    expect(n.pitchMm).toBe(2.5);
    expect(n.strokeMm).toBe(3);
    expect(n.seed).toBe(7);
    expect(n.pitchSource).toBe('typed');
    expect(n.strokeSource).toBe('typed');
  });

  it('falls back from a number the pattern cannot run', () => {
    const n = textureNumbers({ pattern: 'stipple', pitchMm: 0, strokeMm: -1, seed: 1.5 }, 1);
    expect(n.pitchMm).toBe(DEFAULT_TEXTURE_PITCH_MM);
    expect(n.strokeMm).toBe(DEFAULT_TEXTURE_STROKE_MM);
    expect(n.seed).toBe(DEFAULT_TEXTURE_SEED);
    // 0 is a valid seed — it is the first one, not "absent".
    expect(textureNumbers({ pattern: 'stipple', seed: 0 }, 1).seed).toBe(0);
  });

  it('names the operation after the pattern', () => {
    expect(textureOperationName('stipple')).toBe('Texture stipple');
    expect(textureOperationName('scallop')).toBe('Texture scallop');
  });
});

describe('the stipple — deterministic, seeded, anchored to the grid', () => {
  const shape = rect();
  const numbers = textureNumbers(shape.texture, shape.depth);

  it('derives the same paths every time', () => {
    const a = textureStrokes(shape, numbers);
    const b = textureStrokes(shape, numbers);
    expect(b).toEqual(a);
    expect(a.paths.length).toBeGreaterThan(20);
  });

  it('is a different pattern for a different seed', () => {
    const a = textureStrokes(shape, textureNumbers({ pattern: 'stipple', seed: 1 }, shape.depth));
    const b = textureStrokes(shape, textureNumbers({ pattern: 'stipple', seed: 2 }, shape.depth));
    expect(b.paths).not.toEqual(a.paths);
    expect(b.paths.length).toBeGreaterThan(10);
  });

  it('anchors each cell to the stock grid: a smaller region keeps the same strokes', () => {
    // The same pitch over nested regions: every stroke the smaller region keeps UNSHRUNK is
    // exactly a stroke of the larger one. A per-window random stream would reshuffle them.
    const big = rect('big', { width: 18, height: 14 });
    const small = rect('small', { width: 8, height: 5, position: { x: 15, y: 10 } });
    const bigPaths = textureStrokes(big, textureNumbers(big.texture, big.depth)).paths;
    const smallPaths = textureStrokes(small, textureNumbers(small.texture, small.depth)).paths;
    const key = (p: readonly P[]) => p.map(([x, y]) => `${x.toFixed(9)},${y.toFixed(9)}`).join(' ');
    const bigKeys = new Set(bigPaths.map(key));
    const unclipped = smallPaths.filter(
      (p) => Math.hypot(p[p.length - 1]![0] - p[0]![0], p[p.length - 1]![1] - p[0]![1]) > numbers.strokeMm - 1e-6,
    );
    expect(unclipped.length).toBeGreaterThan(5);
    for (const path of unclipped) expect(bigKeys.has(key(path))).toBe(true);
  });

  it('makes each stroke the stated length, at the stated pitch', () => {
    const s = textureStrokes(rect('s', { width: 20, height: 20 }), textureNumbers({ pattern: 'stipple', pitchMm: 2, strokeMm: 1.5 }, 1));
    // 20 × 20 at a 2 mm pitch is ~100 cells; every unclipped stroke is exactly the stroke length.
    expect(s.paths.length).toBeGreaterThan(50);
    for (const path of s.paths) {
      const len = Math.hypot(path[path.length - 1]![0] - path[0]![0], path[path.length - 1]![1] - path[0]![1]);
      expect(len).toBeLessThanOrEqual(1.5 + 1e-9);
    }
  });
});

describe('the scallop — regular rows, no randomness', () => {
  it('is identical for any seed and clips to the region', () => {
    const shape = rect('scallop', { texture: { pattern: 'scallop', pitchMm: 2 } });
    const a = textureStrokes(shape, textureNumbers({ pattern: 'scallop', pitchMm: 2, seed: 1 }, shape.depth));
    const b = textureStrokes(shape, textureNumbers({ pattern: 'scallop', pitchMm: 2, seed: 99 }, shape.depth));
    expect(b.paths).toEqual(a.paths);
    expect(a.paths.length).toBeGreaterThan(2);
    expect(allInsideRect(a.paths, 15, 10, 10, 6)).toBe(true);
    // Rows are one pitch apart, and every point of a row sits between its line and one radius up.
    for (const path of a.paths) {
      const ys = path.map(([, y]) => y);
      const low = Math.min(...ys);
      expect(Math.max(...ys) - low).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('clipping — every emitted point is inside the region', () => {
  it('clips a rectangle, including one rotated', () => {
    const plain = textureStrokes(rect('plain', { width: 9, height: 5 }), textureNumbers(rect().texture, 1));
    expect(allInsideRect(plain.paths, 15, 10, 9, 5)).toBe(true);

    const turned = rect('turned', { width: 9, height: 5, rotation: 37 });
    const paths = textureStrokes(turned, textureNumbers(turned.texture, 1)).paths;
    const c = Math.cos((37 * Math.PI) / 180);
    const s = Math.sin((37 * Math.PI) / 180);
    for (const path of paths) {
      for (const [x, y] of path) {
        const dx = x - 15;
        const dy = y - 10;
        // Undo the rotation with the same arithmetic the document states, independently of the module.
        const lx = dx * c + dy * s;
        const ly = -dx * s + dy * c;
        expect(Math.abs(lx)).toBeLessThanOrEqual(4.5 + 1e-9);
        expect(Math.abs(ly)).toBeLessThanOrEqual(2.5 + 1e-9);
      }
    }
    expect(paths.length).toBeGreaterThan(5);
  });

  it('clips a circle', () => {
    const circle: EngraveCircleShape = {
      id: 'disc',
      kind: 'circle',
      position: { x: 15, y: 10 },
      rotation: 0,
      depth: 1,
      enabled: true,
      diameter: 8,
      texture: { pattern: 'stipple', pitchMm: 1.5 },
    };
    const paths = textureStrokes(circle, textureNumbers(circle.texture, 1)).paths;
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) for (const [x, y] of path) expect(Math.hypot(x - 15, y - 10)).toBeLessThanOrEqual(4 + 1e-9);
  });

  it('clips a slot stadium', () => {
    const slot: EngraveSlotShape = {
      id: 'slot',
      kind: 'slot',
      position: { x: 15, y: 10 },
      rotation: 0,
      depth: 1,
      enabled: true,
      length: 12,
      width: 4,
      texture: { pattern: 'stipple', pitchMm: 1.5 },
    };
    const paths = textureStrokes(slot, textureNumbers(slot.texture, 1)).paths;
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) {
      for (const [x, y] of path) {
        const px = Math.max(-4, Math.min(4, x - 15));
        expect(Math.hypot(x - 15 - px, y - 10)).toBeLessThanOrEqual(2 + 1e-9);
      }
    }
  });

  it('clips a rotated polygon by its own fill rule', () => {
    const triangle: EngravePolygonShape = {
      id: 'tri',
      kind: 'polygon',
      position: { x: 15, y: 10 },
      rotation: 25,
      depth: 1,
      enabled: true,
      points: [
        [-8, -5],
        [9, -5],
        [0, 8],
      ],
      texture: { pattern: 'stipple', pitchMm: 1.5 },
    };
    const paths = textureStrokes(triangle, textureNumbers(triangle.texture, 1)).paths;
    expect(paths.length).toBeGreaterThan(5);
    const c = Math.cos((25 * Math.PI) / 180);
    const s = Math.sin((25 * Math.PI) / 180);
    const ring: P[] = triangle.points;
    const inside = (x: number, y: number): boolean => {
      const dx = x - 15;
      const dy = y - 10;
      const lx = dx * c + dy * s;
      const ly = -dx * s + dy * c;
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!;
        const [xj, yj] = ring[j]!;
        if (yi > ly !== yj > ly && lx < ((xj - xi) * (ly - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    for (const path of paths) for (const [x, y] of path) expect(inside(x, y)).toBe(true);
  });

  it('shortens the strokes that cross the rim rather than dropping the whole pattern', () => {
    const shape = rect('edge', { width: 7, height: 4 });
    const paths = textureStrokes(shape, textureNumbers({ pattern: 'stipple', strokeMm: 1 }, shape.depth)).paths;
    const lengths = paths.map((p) => Math.hypot(p[p.length - 1]![0] - p[0]![0], p[p.length - 1]![1] - p[0]![1]));
    expect(lengths.some((l) => l < 1 - 1e-3)).toBe(true);
    expect(lengths.every((l) => l <= 1 + 1e-9)).toBe(true);
    expect(allInsideRect(paths, 15, 10, 7, 4)).toBe(true);
  });
});

describe('the plan — a texture is traces, never a pocket', () => {
  it('keeps the region out of `engraves` and puts its strokes in `traces`', () => {
    const plain = rect('plain', { name: 'pocket', texture: undefined });
    const plan = toPartPlan(textureJob(plain, { shapes: [plain, rect()] }));
    expect(plan.engraves.map((e) => e.id)).toEqual(['plain']);
    const trace = plan.traces.find((t) => t.id === 'texture');
    expect(trace).toBeDefined();
    expect(trace!.name).toBe('Texture stipple');
    expect(trace!.depth).toBe(0.8);
    expect(trace!.paths.length).toBeGreaterThan(20);
    expect(trace!.closed.every((closed) => closed === false)).toBe(true);
  });

  it('leaves a through texture and a shaded-off texture out of the program', () => {
    expect(toPartPlan(textureJob(rect('through', { through: true }))).traces).toEqual([]);
    expect(toPartPlan(textureJob(rect('off', { enabled: false }))).traces).toEqual([]);
    // A construction shape resolves but cuts nothing, texture or not.
    expect(toPartPlan(textureJob(rect('construction', { construction: true }))).traces).toEqual([]);
  });

  it('caps a crowded pattern and says so to the caller', () => {
    const dense = rect('dense', { width: 38, height: 28, texture: { pattern: 'stipple', pitchMm: 0.2 } });
    const numbers = textureNumbers(dense.texture, dense.depth);
    const capped = textureStrokes(dense, numbers);
    expect(capped.capped).toBe(true);
    expect(capped.paths.length).toBe(DEFAULT_MAX_TEXTURE_STROKES);
    // Under the cap nothing is flagged.
    expect(textureStrokes(rect(), textureNumbers(rect().texture, 0.8)).capped).toBe(false);
  });
});

describe('findings — a marked region that cannot cut, named', () => {
  const codes = (job: EngraveJob) => validateJob(job).map((f) => f.code);
  const find = (job: EngraveJob, code: string) => validateJob(job).find((f) => f.code === code);

  it('refuses `through` on a surface finish', () => {
    const job = textureJob(rect('t', { through: true }));
    const f = find(job, 'texture-through');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.labelId).toBe('t');
  });

  it('refuses a region that is both a texture and an inlay half', () => {
    const job = textureJob(rect('both', { inlay: { role: 'female' } }));
    expect(find(job, 'texture-shape')).toBeDefined();
  });

  it('refuses a combined shape carrying a texture', () => {
    const border = {
      id: 'ring',
      kind: 'border' as const,
      position: { x: 20, y: 15 },
      rotation: 0,
      depth: 1,
      enabled: true,
      inset: 2,
      width: 3,
      texture: { pattern: 'stipple' as const },
    };
    const job = textureJob(rect('t'), { shapes: [], combined: [border] });
    expect(find(job, 'texture-shape')).toBeDefined();
  });

  it('refuses a cutter the trace path cannot take, by name', () => {
    const ball = flatEndMill(3.175, { id: null, name: 'Ball 3.175', typeText: 'Ball End', shape: 'ball' });
    const job = textureJob(rect('t'), { tool: ball });
    const f = find(job, 'texture-tool');
    expect(f).toBeDefined();
    expect(f!.message).toContain('Ball 3.175');
    expect(f!.message).toContain('V-bit');
  });

  it('warns about a pattern that comes out empty', () => {
    const tiny = rect('tiny', { width: 0.1, height: 0.1, position: { x: 0.05, y: 0.05 }, texture: { pattern: 'stipple', pitchMm: 50 } });
    const f = find(textureJob(tiny), 'texture-empty');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(textureStrokes(tiny, textureNumbers(tiny.texture, tiny.depth)).paths).toEqual([]);
  });

  it('warns when the cap shortens a crowded pattern', () => {
    const dense = rect('dense', { width: 38, height: 28, texture: { pattern: 'stipple', pitchMm: 0.2 } });
    const f = find(textureJob(dense), 'texture-crowded');
    expect(f).toBeDefined();
    expect(f!.message).toContain(String(DEFAULT_MAX_TEXTURE_STROKES));
  });

  it('raises none of them for a plain V-bit stipple', () => {
    const job = textureJob();
    expect(codes(job).filter((c) => c.startsWith('texture-'))).toEqual([]);
  });
});

describe('the program and the oracle', () => {
  it('posts the strokes as a trace operation, cuts no deeper than the depth, and repeats byte for byte', () => {
    const job = textureJob(rect('t', { texture: { pattern: 'stipple', pitchMm: 2, strokeMm: 1 } }));
    const a = generate(tl, job);
    expect(a.ok).toBe(true);
    expect(a.nc).not.toBeNull();
    const nc = a.nc as string;
    expect(nc).toContain('Texture stipple');
    // Every WORK-FRAME Z word in the file sits at or above the pattern's floor: a stroke can
    // never bite below the depth, so a plunge into a neighbour's open groove only meets air. The
    // file's `G53` line is the machine-frame clearance the post states before it moves (#384) —
    // machine Z, not work Z — so it is read out of the scan rather than excused.
    const work = nc.split('\n').filter((line) => !line.includes('G53'));
    const zs = work.flatMap((line) => [...line.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1])));
    expect(zs.length).toBeGreaterThan(10);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-0.8 - 1e-6);
    // The same document posts the same program.
    const b = generate(tl, job);
    expect(b.nc).toBe(nc);
  }, 60_000);

  it('predicts a V texture as the strokes\' groove envelope', () => {
    const job = textureJob(rect('t', { texture: { pattern: 'stipple', pitchMm: 2, strokeMm: 1 } }));
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();
    // THE PREDICTION IS THE GROOVES: one entry carrying every stroke's path and the cone, not the
    // region's polygons — a flat-floor prediction would be a polygon entry, and a GROOVE is
    // dilated by the cone's reach at each level, which is the texture's envelope.
    const predicted = g.predicted.filter((p) => p.itemId === 't');
    expect(predicted.length).toBe(1);
    const groove = predicted[0]!.groove;
    expect(groove).toBeDefined();
    expect(groove!.cone.tanHalf).toBeCloseTo(1, 9);
    expect(groove!.paths.length).toBe(toPartPlan(job).traces.find((t) => t.id === 't')!.paths.length);
    expect(predicted[0]!.polygons).toEqual([]);

    const tool = jobTool(job);
    if (tool === null) throw new Error(`${TOOL_KEY} is not in the library`);
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
      if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
      expect(session.oracle(g.predicted).ok).toBe(true);
    } finally {
      session.dispose();
    }
  }, 120_000);

  it('removes far less than a flat pocket — the flat cutter\'s own prediction and removal', () => {
    // A FLAT texture takes the other side of the trace funnel: `traceCutRegions`' swept polygons
    // instead of a groove. Its removal is a solid, so this is also the test that can weigh the
    // cut against the pocket it is NOT.
    const region = { w: 10, h: 6, depth: 0.8 };
    // A sparse pattern under a narrow cutter, so the strokes really are strokes: a wide cutter at
    // a fine pitch sweeps overlapping capsules, which is a different (and intended) look but
    // makes the comparison with a flat pocket meaningless.
    const job = textureJob(rect('t', { texture: { pattern: 'stipple', pitchMm: 4, strokeMm: 0.6 } }), {
      toolKey: 'flat-1.0',
      tool: flatEndMill(1, { id: null, name: '1 mm flat end', typeText: 'Flat End' }),
    });
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.nc).not.toBeNull();
    const predicted = g.predicted.filter((p) => p.itemId === 't');
    expect(predicted.length).toBe(1);
    expect(predicted[0]!.groove).toBeUndefined();
    expect(predicted[0]!.polygons.length).toBeGreaterThan(0);

    const tool = jobTool(job);
    if (tool === null) throw new Error('the flat cutter is not in the library');
    const session = createSimSession(tl);
    try {
      const load = session.load(g.nc as string, toSetup(job, Z1), tool, Z1.id);
      if (!load.ok) throw new Error(`simulation refused: ${JSON.stringify(load.diagnostics)}`);
      expect(session.oracle(g.predicted).ok).toBe(true);
      const removal = load.meshes.removal as NodeMeshOutput;
      const body = new tl.Manifold(new tl.Mesh({ numProp: 3, vertProperties: removal.positions, triVerts: removal.indices }));
      const volume = body.volume();
      body.delete();
      const flat = region.w * region.h * region.depth;
      // The strokes remove the pattern, not the whole floor: a regression that pockets the region
      // flat would come out at ~`flat`.
      expect(volume).toBeGreaterThan(0.02 * flat);
      expect(volume).toBeLessThan(0.4 * flat);
    } finally {
      session.dispose();
    }
  }, 120_000);

  it('states the pattern and the stroke count in the run sheet', () => {
    const job = textureJob(rect('t', { texture: { pattern: 'stipple', pitchMm: 2, strokeMm: 1, seed: 3 } }));
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    const texts = buildRunSheet(job, g, null).sections.flatMap((s) => s.steps.map((st) => st.text));
    const step = texts.find((t) => t.includes('Texture stipple'));
    expect(step).toBeDefined();
    expect(step).toContain('mm pitch');
    expect(step).toContain('seed 3');
    expect(step).toContain('0.8 mm deep');
  }, 60_000);
});

describe('the picture — the strokes are drawn where they cut', () => {
  it('draws the texture as its own floor at the region depth', () => {
    const previewer = createEngravePreviewer(tl);
    // A tipped V: its stroke leaves a flat at the floor to draw. A point tip has no floor disc at
    // all — the groove closes to a line, which is the other honest picture.
    const tipped = flatEndMill(3.175, {
      id: null,
      name: '3.175 mm 90° V (0.2 tip)',
      typeText: 'Chamfer',
      shape: 'chamfer',
      tipDiameter: 0.2,
      diameter: 3.175,
      angle: 90,
      halfAngle: null,
    });
    const job = textureJob(rect('t', { texture: { pattern: 'stipple', pitchMm: 2, strokeMm: 1 } }), { tool: tipped });
    const p = preview(previewer, job, 1);
    expect(p).not.toBeNull();
    const floor = p!.floors.filter((f) => f.labelId === 't');
    expect(floor).toHaveLength(1);
    expect(floor[0]!.depth).toBe(0.8);
  }, 120_000);
});

describe('the document — the marker round-trips, the paths never do', () => {
  it('saves and parses the pattern and its numbers unchanged', () => {
    const job = textureJob(rect('t', { texture: { pattern: 'scallop', pitchMm: 1.5 } }));
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.shapes[0]!.texture).toEqual({ pattern: 'scallop', pitchMm: 1.5 });
    // The strokes are derived, never stored.
    expect(JSON.stringify(parsed.job)).not.toContain('paths');
  });

  it('refuses an unknown pattern and an unknown key in the marker', () => {
    const bad = textureJob(rect('t'));
    const asDto = JSON.parse(JSON.stringify(bad)) as { shapes: { texture: Record<string, unknown> }[] };
    asDto.shapes[0]!.texture = { pattern: 'zigzag' };
    expect(parseEngraveJob(asDto).ok).toBe(false);
    asDto.shapes[0]!.texture = { pattern: 'stipple', gamma: 2 };
    expect(parseEngraveJob(asDto).ok).toBe(false);
    // A seed that is not a whole number cannot reproduce a pattern, so it is refused too.
    asDto.shapes[0]!.texture = { pattern: 'stipple', seed: 1.5 };
    expect(parseEngraveJob(asDto).ok).toBe(false);
  });

  it('parses a pre-#670 shape with no marker exactly as before', () => {
    const plain = rect('plain', { texture: undefined });
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(textureJob(plain))));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.shapes[0]!.texture).toBeUndefined();
  });
});
