// Issue #266 — the RACK's own parts and their split joint.
//
// A rack part has no floor to hang a lap under, and a 5 mm plate cannot take a
// screw across its own thickness. So the archetype's half of the joint is an
// OUTSIDE BUTT STRAP on the part's free face: band across the seam, width along
// the strap's width axis, STRAP_DEPTH proud of the face, with the screws running
// along the seam through it. These specs run the real evaluator: a piece that
// would print as loose parts, or a strap that does not exist where it says,
// fails here rather than on the plate.

import { describe, it, expect } from 'vitest';

import {
  STRAP_DEPTH,
  buildRackPartSplit,
  planRackPartSplit,
  rackPieceId,
  type RackPartSplitRequest,
} from '@/engine/compiler/rackSplit';
import { LUG_EMBED, LUG_LAP } from '@/engine/compiler/shellSplit';
import { cube, difference, intersection, translate, type Aabb, type BuildOp } from '@/engine/compiler/buildPlan';
import type { PrinterVolume } from '@/types/printer';
import { exec } from './helpers/manifoldExec';

const BED: PrinterVolume = { x: 160, y: 160, z: 250 };

function boundsOf(op: BuildOp): Aabb {
  const m = exec(op);
  const b = m.boundingBox();
  m.delete();
  return { min: [...b.min], max: [...b.max] } as Aabb;
}

function bodies(op: BuildOp): number {
  const m = exec(op);
  const n = m.decompose().filter((c) => c.volume() > 0).length;
  m.delete();
  return n;
}

function probeMaterial(op: BuildOp, p: [number, number, number]): number {
  const box = translate(p, cube([1, 1, 1], true));
  const hit = exec(intersection([op, box]));
  const v = hit.volume();
  hit.delete();
  return v;
}

function slab(w: number, d: number, h: number): BuildOp {
  return cube([w, d, h]);
}

/** A side-panel-like slab: 15 thick in X, 300 deep in Y, 200 tall. */
function request(faceAxis: 0 | 1 | 2, sign: 1 | -1, op: BuildOp = slab(15, 300, 200)): RackPartSplitRequest {
  return { partOp: op, bounds: boundsOf(op), printer: BED, face: { axis: faceAxis, sign } };
}

describe('#266 — the strap joint on a rack part', () => {
  it('cuts the part on its over-bed axis and straps the OUTSIDE face', () => {
    // Side panel: over the bed in Y only; the seam runs up its depth, and the
    // width axis is its height, so the screws climb the panel.
    const req = request(0, -1);
    const plan = planRackPartSplit(req)!;
    expect(plan).not.toBeNull();
    expect(plan.seams).toEqual([{ axis: 1, at: 150 }]);
    expect(plan.widthAxis).toBe(2);
    // 200 mm of strap: the shared seam rule, floored at two.
    expect(plan.screwCount).toBe(5);
    const split = buildRackPartSplit(req, plan, 'rack-side-left')!;
    // The seam runs on Y, so the pieces number along Y: a1 and a2.
    expect(split.nodes.map((n) => n.id)).toEqual(['rack-side-left-split-a1', 'rack-side-left-split-a2']);
    for (const n of split.nodes) expect(n.variant?.replaces).toEqual(['rack-side-left']);
  });

  it('each piece is ONE printed body', () => {
    const req = request(0, -1);
    const split = buildRackPartSplit(req, planRackPartSplit(req)!, 'rack-side-left')!;
    for (const n of split.nodes) expect(bodies(n.op)).toBe(1);
  });

  it('the strap stands OUTSIDE the face it was given, and nowhere else', () => {
    const req = request(0, -1);
    const plan = planRackPartSplit(req)!;
    const split = buildRackPartSplit(req, plan, 'rack-side-left')!;
    const strap = plan.straps.find((l) => l.piece === 0)!;
    // 4 mm off the screw's axis along the band, and 4 mm off the site along the
    // width, so the probe is in strap material, not the holes.
    const at: [number, number, number] = [
      LUG_EMBED - STRAP_DEPTH / 2,
      strap.mouth + LUG_LAP / 2,
      strap.at + 4,
    ];
    expect(probeMaterial(split.nodes[0]!.op, at)).toBeGreaterThan(0.5);
    // Nothing on the part's other side.
    expect(probeMaterial(split.nodes[0]!.op, [15 + 3, at[1], at[2]])).toBeLessThan(0.01);
    // The strap protrudes by exactly STRAP_DEPTH − the embed.
    const b = boundsOf(split.nodes[0]!.op);
    expect(b.min[0]).toBeCloseTo(-(STRAP_DEPTH - LUG_EMBED), 3);
  });

  it('a plate lid-style strap sits above the top face for a +Z face', () => {
    const op = slab(300, 200, 5);
    const req = request(2, 1, op);
    const plan = planRackPartSplit(req)!;
    const split = buildRackPartSplit(req, plan, 'rack-top')!;
    const strap = plan.straps.find((l) => l.piece === 0)!;
    const at: [number, number, number] = [strap.mouth + LUG_LAP / 2, strap.at + 4, 5 + 3];
    expect(probeMaterial(split.nodes[0]!.op, at)).toBeGreaterThan(0.5);
    expect(probeMaterial(split.nodes[0]!.op, [at[0], at[1], -2])).toBeLessThan(0.01);
  });

  it('both halves carry a hole at every screw site', () => {
    const req = request(0, -1);
    const plan = planRackPartSplit(req)!;
    const split = buildRackPartSplit(req, plan, 'rack-side-left')!;
    for (const lug of plan.straps) {
      const node = split.nodes[lug.piece]!;
      const mid = lug.mouth + lug.reach / 2;
      const at: [number, number, number] = [0, 0, 0];
      at[lug.axis] = mid;
      at[lug.widthAxis] = lug.at;
      at[req.face.axis] = LUG_EMBED - STRAP_DEPTH / 2;
      expect(probeMaterial(node.op, at), `hole ${lug.screwKey} piece ${lug.piece}`).toBeLessThan(0.05);
    }
  });

  it('refuses a seam on the strap’s own face axis — a strap along the cut is not a butt joint', () => {
    // Over the bed in X only, with the strap on the X face.
    const op = slab(300, 100, 200);
    const req: RackPartSplitRequest = { partOp: op, bounds: boundsOf(op), printer: BED, face: { axis: 0, sign: -1 } };
    expect(planRackPartSplit(req)).toBeNull();
  });

  it('a part that fits the bed is offered nothing', () => {
    const op = slab(15, 120, 100);
    expect(planRackPartSplit(request(0, -1, op))).toBeNull();
  });

  it('names pieces for the part they came from', () => {
    expect(rackPieceId('rack-bottom', [0, 0])).toBe('rack-bottom-split-a1');
    expect(rackPieceId('rack-bottom', [1, 1])).toBe('rack-bottom-split-b2');
  });
});

// ---------------------------------------------------------------------------
// #266 — the rack's parts as the engine offers them (rack.ts wiring).
// ---------------------------------------------------------------------------

import { KS_WIN_W, buildRackSplitNodes, keystoneLayout, rackSplitOffers } from '@/engine/compiler/rack';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import type { RackParams } from '@/types';

const SMALL = { x: 130, y: 130, z: 200 };

const SAMPLE: RackParams = {
  enabled: true,
  width: 252,
  depth: 250,
  slots: 16,
  accessories: [
    { id: 'a', type: 'keystone' },
    { id: 'b', type: 'blank', slots: 2 },
    { id: 'c', type: 'cable-tray' },
  ],
};

describe('#266 — the rack’s own parts, part by part', () => {
  it('offers every part that overruns the bed, with its state', () => {
    const offers = rackSplitOffers(SAMPLE, SMALL);
    const ids = offers.map((o) => o.partId);
    for (const id of ['rack-side-left', 'rack-side-right', 'rack-top', 'rack-bottom']) {
      expect(ids).toContain(id);
    }
    const available = offers.filter((o) => o.state === 'available');
    expect(available.length).toBeGreaterThan(0);
    for (const o of available) {
      expect(o.pieces).toBeGreaterThan(1);
      expect(o.screws).toBeGreaterThanOrEqual(2);
      expect(o.screwLabel).toBeDefined();
    }
  });

  it('builds pieces as alternatives to the whole parts when asked', () => {
    const nodes = buildRackSplitNodes(SAMPLE, SMALL);
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) expect(n.id).toMatch(/-split-[a-z]\d+$/);
    const top = nodes.find((n) => n.id.startsWith('rack-top-split-'));
    expect(top?.variant?.replaces).toEqual(['rack-top']);
  });

  it('a rack on a big bed is offered nothing, and builds nothing', () => {
    const big = { x: 300, y: 300, z: 300 };
    expect(rackSplitOffers(SAMPLE, big)).toEqual([]);
    expect(buildRackSplitNodes(SAMPLE, big)).toEqual([]);
  });

  it('compileProject puts the pieces and the offer on the plan when splitForPrint is on', () => {
    const base = createDefaultProject();
    const project = {
      ...base,
      printer: SMALL,
      case: { ...base.case, rack: { ...SAMPLE, enabled: true }, splitForPrint: true },
    };
    const plan = compileProject(project);
    expect(plan.rackSplitOffers?.length).toBeGreaterThan(0);
    expect(plan.nodes.some((n) => n.id.startsWith('rack-top-split-'))).toBe(true);
    // The whole parts stay on the list: the split is an offer, not a replacement.
    expect(plan.nodes.some((n) => n.id === 'rack-top')).toBe(true);
  });
});

describe('#266 — face plates and lattice decks', () => {
  it('a keystone plate’s seam lands between whole jack windows', () => {
    const rack: RackParams = { ...SAMPLE, accessories: [{ id: 'k', type: 'keystone' }] };
    const offer = rackSplitOffers(rack, SMALL).find((o) => o.partId === 'rack-keystone-0');
    expect(offer?.state).toBe('available');
    const { jacksX } = keystoneLayout(rack.width);
    expect(jacksX.length).toBeGreaterThan(1);
    for (const seam of offer!.seams!) {
      if (seam.axis !== 0) continue; // an X seam is the one that meets the jack row
      for (const cx of jacksX) {
        // Clear of the window, whole jack on both sides.
        expect(Math.abs(seam.at - cx)).toBeGreaterThanOrEqual(KS_WIN_W / 2);
      }
    }
  });

  it('a seam band makes the cut run through solid material across the part', () => {
    // A lattice-like deck: square holes leaving a grid, so the band has voids
    // to fill where the seam crosses it.
    const holes: BuildOp[] = [];
    for (let x = 10; x < 290; x += 14) {
      for (let y = 10; y < 110; y += 14) holes.push(translate([x, y, -1], cube([8, 8, 5])));
    }
    const op = difference([slab(300, 120, 3), ...holes]);
    const plain = { partOp: op, bounds: boundsOf(op), printer: BED, face: { axis: 2 as const, sign: -1 as const } };
    const banded = { ...plain, seamBand: { z: [0, 3] as [number, number], width: 12 } };
    const plainSplit = buildRackPartSplit(plain, planRackPartSplit(plain)!, 'rack-shelf-0')!;
    const bandedSplit = buildRackPartSplit(banded, planRackPartSplit(banded)!, 'rack-shelf-0')!;
    // The band is real material: the banded piece carries more of it.
    const vol = (o: BuildOp): number => {
      const m = exec(o);
      const v = m.volume();
      m.delete();
      return v;
    };
    const total = (nodes: { op: BuildOp }[]): number => nodes.reduce((n, node) => n + vol(node.op), 0);
    expect(total(bandedSplit.nodes)).toBeGreaterThan(total(plainSplit.nodes));
    // ...and it is SOLID across the deck along the seam on BOTH sides (the
    // probes sit on the band, 2 mm inside each cut face).
    const seam = bandedSplit.seams[0]!;
    for (const [node, off] of [
      [bandedSplit.nodes[0]!, -2],
      [bandedSplit.nodes[1]!, 2],
    ] as const) {
      for (const y of [10, 30, 50, 70, 90, 110]) {
        const at: [number, number, number] =
          seam.axis === 0 ? [seam.at + off, y, 1.5] : [y, seam.at + off, 1.5];
        expect(probeMaterial(node.op, at), `band at y=${y}`).toBeGreaterThan(0.5);
      }
    }
  });
});
