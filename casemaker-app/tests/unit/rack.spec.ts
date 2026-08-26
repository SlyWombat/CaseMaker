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
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { aabbOfOp, type BuildOp } from '@/engine/compiler/buildPlan';
import { buildRackNodes, computeRackDims, SLOT_PITCH, plateScrewYs } from '@/engine/compiler/rack';
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
import { Manifold, exec, type ManifoldInstance } from './helpers/manifoldExec';


function expectClean(id: string, op: BuildOp): void {
  const m = exec(op);
  try {
    const components = m.decompose();
    const n = components.length;
    components.forEach((c) => c.delete());
    const detail = `${id} — status=${m.status()} empty=${m.isEmpty()} tris=${m.numTri()} components=${n}`;
    expect(m.isEmpty(), detail).toBe(false);
    expect(m.status(), detail).toBe('NoError');
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
    // Side vents: the rib wall is perforated away from the bosses so a side
    // fan can blow through (vent hole center: local y=36, z=26 → global
    // y=48; shelf sits at slot 0, z0=10.75).
    expect(probe(shelf, 15.3 + 2.5, 48, 10.75 + 26)).toBe(0);
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
    const leftOp = nodes.find((n) => n.id === 'rack-side-left')!.op;
    const rightOp = nodes.find((n) => n.id === 'rack-side-right')!.op;
    const zC = 5 + 140; // feet + configured height
    // Execute each panel ONCE; probes are then cheap intersections.
    const leftM = exec(leftOp);
    const rightM = exec(rightOp);
    const probe = (m: ManifoldInstance, x: number, y: number, z: number, s = 3): number => {
      const box = Manifold.cube([s, s, s], true).translate([x, y, z]);
      const i = Manifold.intersection([m, box]);
      const v = i.volume();
      box.delete();
      i.delete();
      return v;
    };
    try {
      // Opening void at the fan center, through the full thickness.
      expect(probe(leftM, 7.5, 170, zC)).toBe(0);
      // All four bolt holes at the standard 71.5 mm spacing (void at hole
      // centers, solid right next to them).
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          expect(probe(leftM, 7.5, 170 + (sy * 71.5) / 2, zC + (sz * 71.5) / 2, 2)).toBe(0);
        }
      }
      expect(probe(leftM, 7.5, 170 + 71.5 / 2 + 6, zC)).toBeGreaterThan(0);
      // The strip is solid full-thickness beyond the opening (no bridge zone)…
      expect(probe(leftM, 7.5, 170, zC + 44)).toBeGreaterThan(0);
      // …and the right panel is untouched there (fan is left-side only): the
      // same spot falls in a vent window on the mirrored panel.
      expect(probe(rightM, 252 - 7.5, 170, zC)).toBe(0);
    } finally {
      leftM.delete();
      rightM.delete();
    }
    // Still one connected component per panel.
    expectClean('rack-side-left+fan', leftOp);
    expectClean('rack-side-right', rightOp);
  }, 30000);

  it('fan strip does NOT bury the screw columns (mid-post regression)', () => {
    // A 120 mm fan at the default-ish position overlaps the mid rib — the
    // strip fuses after the base cuts and must be re-drilled.
    const rack: RackParams = {
      ...SAMPLE,
      accessories: [],
      fans: [{ id: 'f1', side: 'left', size: 120, y: 150, z: 140 }],
    };
    const left = buildRackNodes(rack).find((n) => n.id === 'rack-side-left')!.op;
    const holeZ = 5 + 5.5 + 0.5 * SLOT_PITCH; // first slot's screw center
    // Execute the panel ONCE; each probe is then a cheap intersection.
    const panel = exec(left);
    try {
      const probe = (x: number, y: number, z: number): number => {
        const box = Manifold.cube([2, 2, 2], true).translate([x, y, z]);
        const m = Manifold.intersection([panel, box]);
        const v = m.volume();
        box.delete();
        m.delete();
        return v;
      };
      for (let k = 0; k < 16; k += 3) {
        const z = holeZ + k * SLOT_PITCH;
        expect(probe(7.5, 100, z), `rear screw hole at slot ${k} must stay open`).toBe(0);
        expect(probe(7.5, 22, z), `front screw hole at slot ${k} must stay open`).toBe(0);
      }
    } finally {
      panel.delete();
    }
  }, 30000);

  // The first printed set had nothing holding the plates in: the seat pockets
  // were cut the plate's FULL thickness at z = FOOT_H and z = H_TOP - PLATE_T,
  // so both broke out through the side body's bottom and top faces. The plates
  // were located fore/aft and free in z — the top lifted straight off and the
  // bottom dropped out. These probes pin the rebate-plus-dart joint that
  // replaced it, at both ends of the rack (the top plate is the same part
  // flipped, so a barb on one side only would have engaged at one end).
  it('carries the plates on corner tabs and lets the top one come back off', () => {
    const rack: RackParams = { ...SAMPLE, accessories: [] };
    const byId = new Map(buildRackNodes(rack).map((n) => [n.id, n.op]));
    const sides = ['rack-side-left', 'rack-side-right'].map((id) => exec(byId.get(id)!));
    // Joint geometry (rack.ts): tabs reach TAB_REACH over the side from the
    // plate edge, centred TAB_LEN/2 in from each stacking foot's front edge.
    const TAB_REACH = 11, TAB_T = 8;
    const axisX = 15 + 0.3 - TAB_REACH / 2;
    const tabYs = plateScrewYs(SAMPLE.depth);
    try {
      for (const plateId of ['rack-bottom', 'rack-top']) {
        const plate = exec(byId.get(plateId)!);
        try {
          const clash = (d: [number, number, number]): number => {
            const moved = plate.translate(d);
            let v = 0;
            for (const side of sides) {
              const i = Manifold.intersection([side, moved]);
              v += i.volume();
              i.delete();
            }
            moved.delete();
            return v;
          };
          expect(clash([0, 0, 0]), `${plateId} seats without interference`).toBeLessThan(1);
          // The ledge floor carries the plate, and its walls locate it fore/aft.
          expect(clash([0, 0, -1]), `${plateId} cannot drop through its ledges`).toBeGreaterThan(20);
          expect(clash([0, 3, 0]), `${plateId} cannot slide out fore/aft`).toBeGreaterThan(20);
        } finally {
          plate.delete();
        }
      }

      // The two ends retain differently ON PURPOSE, and that asymmetry is the
      // whole point of the joint — so pin it rather than let it drift.
      //
      // The BOTTOM tab tucks under rail material, so the plate is captured and
      // the frame has to be built onto it. The TOP ledge is open upward so the
      // plate drops into an assembled rack and lifts back out — that
      // serviceability is what replaced the old snap darts, and its retention
      // is the screws, not the geometry.
      const bottom = exec(byId.get('rack-bottom')!);
      const top = exec(byId.get('rack-top')!);
      try {
        const lift = (m: ReturnType<typeof exec>): number => {
          const moved = m.translate([0, 0, 1]);
          let v = 0;
          for (const side of sides) {
            const i = Manifold.intersection([side, moved]);
            v += i.volume();
            i.delete();
          }
          moved.delete();
          return v;
        };
        expect(lift(bottom), 'bottom plate is captured under the rails').toBeGreaterThan(20);
        expect(lift(top), 'top plate lifts straight out — it is screw-retained').toBeLessThan(1);
      } finally {
        bottom.delete();
        top.delete();
      }

      // Every tab screw needs a solid column to thread into. Before the vent
      // windows were pulled back and the tabs moved off the slot-0 accessory
      // screw column, two of these four had only ~67% of their thread annulus.
      const ring = (side: ReturnType<typeof exec>, y: number, z0: number, z1: number): number => {
        const outer = Manifold.cylinder(z1 - z0, 5.5, 5.5, 32).translate([axisX, y, z0]);
        const inner = Manifold.cylinder(z1 - z0 + 2, 2.1, 2.1, 32).translate([axisX, y, z0 - 1]);
        const shell = Manifold.difference([outer, inner]);
        const i = Manifold.intersection([side, shell]);
        const f = i.volume() / shell.volume();
        i.delete();
        shell.delete();
        outer.delete();
        inner.delete();
        return f;
      };
      const H = 5 + (16 * SLOT_PITCH + 11);
      for (const y of tabYs) {
        expect(ring(sides[0]!, y, 5 + TAB_T, 5 + TAB_T + 21), `bottom tab screw at y=${y} has a solid column`).toBeGreaterThan(0.9);
        expect(ring(sides[0]!, y, H - TAB_T - 21, H - TAB_T), `top tab screw at y=${y} has a solid column`).toBeGreaterThan(0.9);

        // ...and it has to be possible to actually INSERT it. The bottom
        // screw threads upward, so it can only be entered from under the
        // rack, and the end tabs sit over a stacking foot. Without an access
        // hole through the foot the head pocket is a sealed void — a screw
        // that cannot be fitted at all, which is exactly what shipped in the
        // first cut of this joint.
        const path = Manifold.cylinder(5, 4.9, 4.9, 32).translate([axisX, y, 0]);
        const blocked = Manifold.intersection([sides[0]!, path]);
        const v = blocked.volume();
        blocked.delete();
        path.delete();
        expect(v, `bottom tab screw at y=${y} can be inserted from below`).toBeLessThan(50);
      }
    } finally {
      sides.forEach((s) => s.delete());
    }
  }, 60000);

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

  it('shelf options: front plate closes the opening; vented=false solidifies deck and ribs', () => {
    const rack: RackParams = {
      ...SAMPLE,
      accessories: [{ id: 'x', type: 'shelf', slots: 3, shelfDepth: 86, frontPlate: true, vented: false }],
    };
    const shelf = buildRackNodes(rack).find((n) => n.id === 'rack-shelf-0')!.op;
    const probe = (x: number, y: number, z: number): number => {
      const m = exec({
        kind: 'intersection',
        children: [shelf, { kind: 'translate', offset: [x - 1, y - 1, z - 1], child: { kind: 'cube', size: [2, 2, 2] } }],
      });
      const v = m.volume();
      m.delete();
      return v;
    };
    const z0 = 10.75; // slot 0 with the 12 mm recess applied to y only
    // Front plate present mid-opening (global y = recess + plate middle)…
    expect(probe(126, 12 + 2, z0 + 25)).toBeGreaterThan(0);
    // …deck solid where a vent slot would be, rib wall solid where a side
    // vent hole would be.
    expect(probe(126, 12 + 40, z0 + 1.5)).toBeGreaterThan(0);
    expect(probe(15.3 + 2.5, 12 + 36, z0 + 26)).toBeGreaterThan(0);
    expectClean('rack-shelf-frontplate-solid', shelf);
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
