// Rack archetype — parametric mini-rack assembly (emulates Printables
// 1307276 "Mini Rack" by Meuon). Covers:
//   • the template compiles to the full part set, one connected component
//     per node (the multi-part contract manifoldIntegrity enforces globally)
//   • default dimensions reproduce the measured sample envelope
//   • parametric resize keeps functional features fixed while the envelope
//     tracks the parameters
//   • printer fit validation: the sample size needs a large printer; a
//     220 mm printer configuration passes for a shrunken rack
//   • wall-mount variants emit their extra geometry/parts

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { aabbOfOp, type BuildOp } from '@/engine/compiler/buildPlan';
import { buildRackNodes, computeRackDims, SLOT_PITCH } from '@/engine/compiler/rack';
import {
  rectFitsBed,
  validateRackFit,
  PRINTER_PRESETS,
  maxRackWidthForBed,
  maxRackDepthForBed,
  maxRackSlotsForBed,
} from '@/engine/compiler/rackFit';
import { findTemplate } from '@/library/templates';
import { hardwareForProject } from '@/engine/exporters/hardwareList';
import type { RackParams } from '@/types';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('manifold-3d/manifold.wasm');
const tl = await ManifoldModule({ locateFile: () => wasmPath });
tl.setup();
const { Manifold, Mesh } = tl;
type ManifoldInstance = InstanceType<typeof Manifold>;

function dedupeVertices(positions: Float32Array, indices: Uint32Array): {
  positions: Float32Array;
  indices: Uint32Array;
} {
  const map = new Map<string, number>();
  const newPos: number[] = [];
  const newIdx = new Uint32Array(indices.length);
  const PREC = 1e5;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]!;
    const x = Math.round(positions[v * 3]! * PREC) / PREC;
    const y = Math.round(positions[v * 3 + 1]! * PREC) / PREC;
    const z = Math.round(positions[v * 3 + 2]! * PREC) / PREC;
    const k = `${x},${y},${z}`;
    let id = map.get(k);
    if (id === undefined) {
      id = newPos.length / 3;
      newPos.push(x, y, z);
      map.set(k, id);
    }
    newIdx[i] = id;
  }
  return { positions: new Float32Array(newPos), indices: newIdx };
}

function exec(op: BuildOp): ManifoldInstance {
  switch (op.kind) {
    case 'cube':
      return Manifold.cube(op.size, op.center ?? false);
    case 'cylinder':
      return Manifold.cylinder(op.height, op.radiusLow, op.radiusHigh ?? op.radiusLow, op.segments ?? 0, op.center ?? false);
    case 'mesh': {
      const d = dedupeVertices(op.positions, op.indices);
      return new Manifold(new Mesh({ numProp: 3, vertProperties: d.positions, triVerts: d.indices }));
    }
    case 'translate': {
      const c = exec(op.child);
      const r = c.translate(op.offset);
      c.delete();
      return r;
    }
    case 'rotate': {
      const c = exec(op.child);
      const r = c.rotate(op.degrees);
      c.delete();
      return r;
    }
    case 'scale': {
      const c = exec(op.child);
      const r = c.scale([op.factor, op.factor, op.factor]);
      c.delete();
      return r;
    }
    case 'union':
    case 'difference':
    case 'intersection': {
      const cs = op.children.map(exec);
      let r: ManifoldInstance;
      if (op.kind === 'union') r = Manifold.union(cs);
      else if (op.kind === 'difference') r = Manifold.difference(cs);
      else r = Manifold.intersection(cs);
      cs.forEach((c) => c.delete());
      return r;
    }
  }
}

function expectClean(id: string, op: BuildOp): void {
  const m = exec(op);
  try {
    const components = m.decompose();
    const n = components.length;
    components.forEach((c) => c.delete());
    const detail = `${id} — status=${m.status()} empty=${m.isEmpty()} tris=${m.numTri()} components=${n}`;
    expect(m.isEmpty(), detail).toBe(false);
    expect(m.status() === 'NoError' || m.status() === 0, detail).toBe(true);
    expect(n, detail).toBe(1);
  } finally {
    m.delete();
  }
}

const SAMPLE: RackParams = {
  enabled: true,
  width: 252,
  depth: 250,
  slots: 16,
  accessories: [
    { id: 'a', type: 'keystone' },
    { id: 'b', type: 'blank', slots: 2 },
    { id: 'c', type: 'shelf', slots: 3, shelfDepth: 86 },
    { id: 'd', type: 'shelf', slots: 3, shelfDepth: 123 },
    { id: 'e', type: 'cable-tray' },
  ],
};

describe('rack archetype — mini-rack template', () => {
  it('template compiles to the full rack part set, every node manifold-clean', () => {
    const tpl = findTemplate('mini-rack-10in');
    expect(tpl).toBeDefined();
    const plan = compileProject(tpl!.build());
    const ids = plan.nodes.map((n) => n.id);
    expect(ids).toEqual([
      'rack-side-left',
      'rack-side-right',
      'rack-bottom',
      'rack-top',
      'rack-keystone-0',
      'rack-blank-1',
      'rack-shelf-2',
      'rack-shelf-3',
      'rack-cable-tray-4',
    ]);
    for (const node of plan.nodes) expectClean(node.id, node.op);
    // Template default (Prusa XL) fits — no fit errors on the report.
    expect(plan.placementReport?.errorCount ?? 0).toBe(0);
  });

  it('default dimensions reproduce the measured sample envelope', () => {
    const dims = computeRackDims(SAMPLE);
    // Sample: 275 tall sides (16 slots × 16.5 + margins) + 5 stacking feet.
    expect(dims.bodyH).toBeCloseTo(16 * 16.5 + 11, 5);
    expect(dims.totalH).toBeCloseTo(280, 5);
    // Sample top/bottom plates nest between the 15 mm sides: 222 - clearance.
    expect(dims.plateW).toBeCloseTo(252 - 30 - 0.6, 5);

    const nodes = buildRackNodes(SAMPLE);
    const byId = new Map(nodes.map((n) => [n.id, n.op]));
    const side = aabbOfOp(byId.get('rack-side-left')!)!;
    expect(side.max[1] - side.min[1]).toBeCloseTo(250, 1); // depth
    expect(side.max[2] - side.min[2]).toBeCloseTo(280, 1); // height incl. feet
    // Accessories span BETWEEN the sides (recessed 12 mm behind the front
    // columns) — plate width, not full rack width.
    const keystone = aabbOfOp(byId.get('rack-keystone-0')!)!;
    expect(keystone.max[0] - keystone.min[0]).toBeCloseTo(252 - 30 - 0.6, 1);
    expect(keystone.min[1]).toBeCloseTo(12, 1); // FRONT_RECESS
  });

  it('resizing tracks parameters while the slot pitch stays fixed', () => {
    const small: RackParams = { ...SAMPLE, width: 180, depth: 160, slots: 8, accessories: [] };
    const dims = computeRackDims(small);
    expect(dims.bodyH).toBeCloseTo(8 * SLOT_PITCH + 11, 5);
    expect(dims.plateW).toBeCloseTo(180 - 30 - 0.6, 5);
    // Slot pitch is the invariant the whole ecosystem hangs off.
    expect(dims.holeZ(1) - dims.holeZ(0)).toBeCloseTo(SLOT_PITCH, 9);
    for (const node of buildRackNodes(small)) expectClean(node.id, node.op);
  });

  it('printer fit: sample size FAILS a 220 mm printer and names the blockers', () => {
    const rack: RackParams = { ...SAMPLE, printer: { preset: 'ender-3', x: 220, y: 220, z: 250 } };
    const issues = validateRackFit(rack);
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    // The side panel (250×280 flat) cannot fit a 220² bed even diagonally.
    expect(errors.some((i) => i.involves.includes('rack-side-left'))).toBe(true);
    // The summary suggests achievable dimensions.
    expect(errors.some((i) => i.message.includes('could fit a rack up to'))).toBe(true);
  });

  it('printer fit: a shrunken rack passes a 220 mm printer', () => {
    const rack: RackParams = {
      enabled: true,
      width: 200,
      depth: 180,
      slots: 10,
      printer: { preset: 'ender-3', x: 220, y: 220, z: 250 },
      accessories: [{ id: 'a', type: 'keystone' }, { id: 'b', type: 'shelf', shelfDepth: 86 }],
    };
    const issues = validateRackFit(rack);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('slider ceilings: max width/slots are consistent with the fit check', () => {
    // Whatever the helpers claim fits must actually pass rectFitsBed…
    const maxW = maxRackWidthForBed(220, 220);
    expect(rectFitsBed(maxW, 50, 220, 220)).toBe(true);
    expect(rectFitsBed(maxW + 4, 50, 220, 220)).toBe(false);
    // …and the max slot count's side panel must fit while one more doesn't.
    const maxS = maxRackSlotsForBed(180, 220, 220);
    expect(maxS).toBeGreaterThanOrEqual(2);
    expect(rectFitsBed(180, 5 + maxS * SLOT_PITCH + 11, 220, 220)).toBe(true);
    expect(rectFitsBed(180, 5 + (maxS + 1) * SLOT_PITCH + 11, 220, 220)).toBe(false);
    // …and the max depth's governing parts (side panel + top/bottom plate)
    // must both fit while 4 mm more does not.
    const maxD = maxRackDepthForBed(200, 10, 220, 220);
    const sideH = 5 + 10 * SLOT_PITCH + 11;
    expect(maxD).toBeGreaterThanOrEqual(80);
    expect(rectFitsBed(maxD, sideH, 220, 220) && rectFitsBed(200 - 30 + 22, maxD, 220, 220)).toBe(true);
    expect(rectFitsBed(maxD + 4, sideH, 220, 220) && rectFitsBed(200 - 30 + 22, maxD + 4, 220, 220)).toBe(false);
  });

  it('rectFitsBed: straight, rotated, diagonal, and impossible placements', () => {
    expect(rectFitsBed(200, 100, 220, 220)).toBe(true); // straight
    expect(rectFitsBed(100, 200, 220, 120)).toBe(true); // 90° rotated
    expect(rectFitsBed(252, 50, 220, 220)).toBe(true); // fits diagonally
    expect(rectFitsBed(252, 200, 220, 220)).toBe(false); // too big even diagonally
    expect(PRINTER_PRESETS.some((p) => p.id === 'prusa-xl')).toBe(true);
  });

  it('wall mount (ears): sides grow outward flanges; guidance warning emitted', () => {
    const rack: RackParams = { ...SAMPLE, accessories: [], wallMount: 'ears' };
    const nodes = buildRackNodes(rack);
    const left = aabbOfOp(nodes.find((n) => n.id === 'rack-side-left')!.op)!;
    expect(left.min[0]).toBeLessThan(-20); // ear reaches outboard of x=0
    const right = aabbOfOp(nodes.find((n) => n.id === 'rack-side-right')!.op)!;
    expect(right.max[0]).toBeGreaterThan(252 + 20);
    for (const node of nodes) expectClean(node.id, node.op);
    // Guidance lives in the RackPanel now — the validator must NOT emit a
    // permanent warning for merely having a wall mount selected.
    expect(validateRackFit(rack).filter((i) => i.kind === 'rack-config')).toEqual([]);
  });

  it('wall mount (cleat): emits cleat + spacer strips, all manifold-clean', () => {
    const rack: RackParams = { ...SAMPLE, accessories: [], wallMount: 'cleat' };
    const nodes = buildRackNodes(rack);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('rack-wall-cleat');
    expect(ids).toContain('rack-wall-spacer');
    for (const node of nodes) expectClean(node.id, node.op);
  });

  it('cleat hook geometry: hook above the 45° seat, relief below, zero interference', () => {
    const rack: RackParams = { ...SAMPLE, accessories: [], wallMount: 'cleat' };
    const nodes = buildRackNodes(rack);
    const byId = new Map(nodes.map((n) => [n.id, n.op]));
    const D = 250;
    const seatZ = 5 + 16 * SLOT_PITCH + 11 - 58; // front (low) edge of the seat plane
    const probeVol = (op: BuildOp, x0: number, y0: number, z0: number): number => {
      const m = exec({
        kind: 'intersection',
        children: [op, { kind: 'translate', offset: [x0, y0, z0], child: { kind: 'cube', size: [15, 10, 10] } }],
      });
      const v = m.volume();
      m.delete();
      return v;
    };
    const side = byId.get('rack-side-left')!;
    // Hook: material must exist in the rear band ABOVE the seat…
    expect(probeVol(side, 0, D - 10, seatZ + 16)).toBeGreaterThan(500);
    // …and must be fully relieved BELOW it (that's where the cleat + wall sit).
    expect(probeVol(side, 0, D - 10, seatZ - 25)).toBe(0);
    expect(probeVol(side, 0, D - 10, 100)).toBe(0);
    // The assembled cleat and spacer must not intersect the side panel.
    for (const partId of ['rack-wall-cleat', 'rack-wall-spacer'] as const) {
      const m = exec({ kind: 'intersection', children: [side, byId.get(partId)!] });
      expect(m.volume(), `${partId} interferes with the side panel`).toBe(0);
      m.delete();
    }
  });

  it('extra-deep 160 mm shelf anchors the mid bar: rear holes align with the side column', () => {
    const rack: RackParams = {
      ...SAMPLE,
      accessories: [{ id: 'x', type: 'shelf', slots: 3, shelfDepth: 160 }],
    };
    const nodes = buildRackNodes(rack);
    const byId = new Map(nodes.map((n) => [n.id, n.op]));
    // First slot's screw z in assembly space: feet + margin + half pitch.
    const holeZ = 5 + 5.5 + 0.5 * SLOT_PITCH;
    const probe = (op: BuildOp, x: number, y: number, z: number): number => {
      const m = exec({
        kind: 'intersection',
        children: [op, { kind: 'translate', offset: [x - 1.5, y - 1.5, z - 1.5], child: { kind: 'cube', size: [3, 3, 3] } }],
      });
      const v = m.volume();
      m.delete();
      return v;
    };
    // Void at the REAR hole center through the shelf's rib boss (y=100)…
    const shelf = byId.get('rack-shelf-0')!;
    expect(probe(shelf, 15.3 + 6, 100, holeZ)).toBe(0);
    // …and through the side panel's mid-bar column at the same y/z.
    const side = byId.get('rack-side-left')!;
    expect(probe(side, 7.5, 100, holeZ)).toBe(0);
    // Sanity: the rib boss around the hole is solid (offset probe hits material).
    expect(probe(shelf, 15.3 + 6, 100, holeZ + 5)).toBeGreaterThan(0);
    // Shrinking the rack below the mid bar's minimum depth warns.
    const shallow: RackParams = { ...rack, depth: 120 };
    expect(validateRackFit(shallow).some((i) => i.kind === 'rack-config' && /middle bar/.test(i.message))).toBe(true);
  });

  it('side fan mount: opening + standard bolt pattern cut through a solid anchored strip', () => {
    const rack: RackParams = {
      ...SAMPLE,
      accessories: [],
      fans: [{ id: 'f1', side: 'left', size: 80, y: 170, z: 140 }],
    };
    const nodes = buildRackNodes(rack);
    const left = nodes.find((n) => n.id === 'rack-side-left')!.op;
    const right = nodes.find((n) => n.id === 'rack-side-right')!.op;
    const zC = 5 + 140; // feet + configured height
    const probe = (op: BuildOp, x: number, y: number, z: number, s = 3): number => {
      const m = exec({
        kind: 'intersection',
        children: [op, { kind: 'translate', offset: [x - s / 2, y - s / 2, z - s / 2], child: { kind: 'cube', size: [s, s, s] } }],
      });
      const v = m.volume();
      m.delete();
      return v;
    };
    // Opening void at the fan center, through the full thickness.
    expect(probe(left, 7.5, 170, zC)).toBe(0);
    // All four bolt holes at the standard 71.5 mm spacing (void at hole
    // centers, solid right next to them).
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        expect(probe(left, 7.5, 170 + (sy * 71.5) / 2, zC + (sz * 71.5) / 2, 2)).toBe(0);
      }
    }
    expect(probe(left, 7.5, 170 + 71.5 / 2 + 6, zC)).toBeGreaterThan(0);
    // The strip is solid full-thickness beyond the opening (no bridge zone)…
    expect(probe(left, 7.5, 170, zC + 44)).toBeGreaterThan(0);
    // …and the right panel is untouched there (fan is left-side only): the
    // same spot falls in a vent window on the mirrored panel.
    expect(probe(right, 252 - 7.5, 170, zC)).toBe(0);
    // Still one connected component per panel.
    expectClean('rack-side-left+fan', left);
    expectClean('rack-side-right', right);
  });

  it('keyhole mount: flush rear face with working keyhole hangers', () => {
    const rack: RackParams = { ...SAMPLE, accessories: [], wallMount: 'keyhole' };
    const nodes = buildRackNodes(rack);
    // No extra printed parts — just the four structural pieces.
    expect(nodes.map((n) => n.id)).toEqual(['rack-side-left', 'rack-side-right', 'rack-bottom', 'rack-top']);
    const side = nodes[0]!.op;
    const zEntry = 5 + (16 * SLOT_PITCH + 11) - 30; // upper hanger
    const probe = (x: number, y: number, z: number, s = 2.4): number => {
      const m = exec({
        kind: 'intersection',
        children: [side, { kind: 'translate', offset: [x - s / 2, y - s / 2, z - s / 2], child: { kind: 'cube', size: [s, s, s] } }],
      });
      const v = m.volume();
      m.delete();
      return v;
    };
    expect(probe(7.5, 248, zEntry)).toBe(0); // entry circle void at the rear face
    expect(probe(7.5, 248, zEntry - 10)).toBe(0); // shank slot void below it
    expect(probe(7.5 + 4.2, 248, zEntry - 10)).toBeGreaterThan(0); // face wall beside the slot
    expect(probe(7.5, 243.5, zEntry - 10)).toBe(0); // head cavity behind the face wall
    // Flush: the rear band is full-depth solid away from the hangers.
    expect(probe(7.5, 248, 100)).toBeGreaterThan(0);
    for (const n of nodes.slice(0, 2)) expectClean(n.id, n.op);
  });

  it('hardware BOM lists the structural M5 screws (the shelf-to-side connection)', () => {
    const tpl = findTemplate('mini-rack-10in');
    const project = tpl!.build();
    const items = hardwareForProject(project);
    const screws = items.find((i) => i.id === 'rack-screws');
    expect(screws).toBeDefined();
    // Template accessories: keystone 2 + blank 2 + shelf 3 + shelf 3 + tray 2
    // = 12 slots × 2 sides = 24 front screws, + long shelf (123 ≥ 112)
    // 3 slots × 2 sides = 6 rear screws.
    expect(screws!.count).toBe(30);
    expect(screws!.note).toMatch(/side panels/);
  });

  it('slot overflow warns instead of silently stacking', () => {
    const rack: RackParams = {
      ...SAMPLE,
      slots: 4,
      accessories: [
        { id: 'a', type: 'shelf' },
        { id: 'b', type: 'shelf' },
      ],
    };
    const issues = validateRackFit(rack);
    expect(issues.some((i) => i.kind === 'rack-config' && /slots/.test(i.message))).toBe(true);
  });
});
