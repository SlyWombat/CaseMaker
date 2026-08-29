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
import {
  buildRackNodes,
  computeRackDims,
  SLOT_PITCH,
  plateScrewYs,
  accessorySlots,
  accessorySpaces,
  cableNotchGeometry,
  floorRibsEnabled,
  plateTabYs,
  SHELF_DECK_T,
  SHELF_RIB_H,
  TRAY_DECK_T,
  TAB_T,
  TAB_SCREW_INSET,
  TAB_SCREW_HEAD_H,
  TAB_SCREW_BITE,
} from '@/engine/compiler/rack';
import { collectMeshTransferables, transferListForPlan, union } from '@/engine/compiler/buildPlan';
import { PRINT_FLIP_NODE_IDS } from '@/engine/exportLayout';
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
import type { RackAccessory, RackParams } from '@/types';
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
      // No one-piece exports: assembledExport is opt-in, and off by default so
      // that building the unions does not tax every edit.
    ]);
    for (const node of plan.nodes) expectClean(node.id, node.op);
    // Template default (Prusa XL) fits — no fit errors on the report.
    expect(plan.placementReport?.errorCount ?? 0).toBe(0);
    // Explicit timeout: this compiles and meshes the whole rack, which sits
    // near vitest's 5 s default and tips over it on a loaded machine.
  }, 60000);

  it('offers the one-piece exports only when the rack fits the printer', () => {
    const accs: RackAccessory[] = [
      { id: 'a', type: 'shelf', slots: 3, shelfDepth: 123, vented: true },
      { id: 'b', type: 'keystone', slots: 2 },
    ];
    const asmIds = (printer?: { x: number; y: number; z: number }, on = true): string[] =>
      buildRackNodes({ ...SAMPLE, accessories: accs, printer, assembledExport: on })
        .map((n) => n.id)
        .filter((id) => id.startsWith('rack-assembled'));

    // 252 x 250 x 280 needs a large-format machine.
    expect(asmIds({ x: 360, y: 360, z: 360 })).toEqual(['rack-assembled-frame', 'rack-assembled-all']);
    expect(asmIds({ x: 220, y: 220, z: 250 }), 'bedslinger cannot print it whole').toEqual([]);
    expect(asmIds({ x: 360, y: 360, z: 200 }), 'tall enough matters too').toEqual([]);
    expect(asmIds(undefined), 'no printer set = no claim it fits').toEqual([]);
    expect(asmIds({ x: 360, y: 360, z: 360 }, false), 'opt-in: off by default').toEqual([]);

    const nodes = buildRackNodes({ ...SAMPLE, accessories: accs, printer: { x: 360, y: 360, z: 360 }, assembledExport: true });
    const dims = computeRackDims(SAMPLE);
    for (const id of ['rack-assembled-frame', 'rack-assembled-all']) {
      const m = exec(nodes.find((n) => n.id === id)!.op);
      try {
        // Count SOLID bodies. decompose() also returns inverted shells with
        // negative volume for sealed internal voids — the mid tab's fit slack
        // becomes one once the bearing pad closes it off from below. A 0.1 cm3
        // air pocket is not a second piece; counting it as one made this test
        // report "3 pieces" for a frame that is demonstrably one.
        const parts = m.decompose();
        const solids = parts.filter((c) => c.volume() > 1);
        expect(solids.length, `${id} must be a single connected solid`).toBe(1);
        parts.forEach((c) => c.delete());

        // One component is a MUCH weaker claim than it sounds, and on its own
        // it let a broken frame through: the plate tabs merely touch their
        // ledges on coincident faces, so Manifold called it connected while
        // 74% of each plate edge was an open SIDE_CLEAR slot and 1.1 kg hung
        // off six small tabs. Measure how much of the edge is actually bridged.
        for (const [label, z0] of [
          ['bottom', 5],
          ['top', dims.totalH - 5],
        ] as [string, number][]) {
          let bridged = 0;
          for (let y = 0; y < dims.depth; y += 2) {
            const c = Manifold.cube([0.28, 2, 5]).translate([15.01, y, z0]);
            const i = Manifold.intersection([m, c]);
            if (i.volume() > 0.1) bridged += 2;
            i.delete();
            c.delete();
          }
          expect(
            bridged / dims.depth,
            `${id}: ${label} plate edge must be welded to the side along its whole length`,
          ).toBeGreaterThan(0.95);
        }
      } finally {
        m.delete();
      }
    }
  }, 120000);

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
    const axisX = 15 + 0.3 - TAB_SCREW_INSET;
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
      // Ring from just outside the Ø4.8 pilot to Ø8 — the zone thread
      // actually forms in. Not wider: the axis sits 4.3 mm in from the plate
      // edge, so a generous ring pokes out past the panel's inner face and
      // measures open air as if it were a defect.
      const ring = (side: ReturnType<typeof exec>, y: number, z0: number, z1: number): number => {
        const outer = Manifold.cylinder(z1 - z0, 4, 4, 32).translate([axisX, y, z0]);
        const inner = Manifold.cylinder(z1 - z0 + 2, 2.4, 2.4, 32).translate([axisX, y, z0 - 1]);
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
        expect(ring(sides[0]!, y, 5 + TAB_T, 5 + TAB_T + TAB_SCREW_BITE), `bottom tab screw at y=${y} has a solid column`).toBeGreaterThan(0.9);
        expect(ring(sides[0]!, y, H - TAB_T - TAB_SCREW_BITE, H - TAB_T), `top tab screw at y=${y} has a solid column`).toBeGreaterThan(0.9);

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

  it('gives each tab screw head a flat seat, printed facing up', () => {
    const rack: RackParams = { ...SAMPLE, accessories: [] };
    const byId = new Map(buildRackNodes(rack).map((n) => [n.id, n.op]));
    const dims = computeRackDims(rack);
    const plate = exec(byId.get('rack-bottom')!);
    const PLATE_T = 5, HEAD_H = TAB_SCREW_HEAD_H, FOOT_H = 5;
    const x0 = 15 + 0.3;
    const axes = [x0 - TAB_SCREW_INSET, x0 + dims.plateW + TAB_SCREW_INSET];
    try {
      // The head bears on an annulus between the clearance hole and the bore
      // wall. It has to be solid and complete, with a clean step: a partial
      // reading means the seat is broken up rather than one flat face.
      const ring = (x: number, y: number, z: number): number => {
        const outer = Manifold.cylinder(0.1, 4.8, 4.8, 48).translate([x, y, z]);
        const inner = Manifold.cylinder(0.3, 2.7, 2.7, 48).translate([x, y, z - 0.1]);
        const shell = Manifold.difference([outer, inner]);
        const i = Manifold.intersection([plate, shell]);
        const f = i.volume() / shell.volume();
        i.delete();
        shell.delete();
        outer.delete();
        inner.delete();
        return f;
      };
      const floorZ = FOOT_H + HEAD_H; // outer face is at z = FOOT_H
      for (const x of axes) {
        for (const y of plateScrewYs(SAMPLE.depth)) {
          expect(ring(x, y, floorZ - 0.2), `bore is open below the seat at ${x},${y}`).toBeLessThan(0.02);
          expect(ring(x, y, floorZ + 0.2), `seat is solid and complete at ${x},${y}`).toBeGreaterThan(0.98);
        }
      }
      // A flat seat is only half of it — it also has to print facing UP. The
      // plate's counterbored face points DOWN in assembly, so the bottom plate
      // is the one that must be turned over; printed the other way the seat is
      // a bridged ceiling and the head has nothing smooth to bear on.
      expect(PRINT_FLIP_NODE_IDS, 'plates print counterbore-up').toContain('rack-bottom');
      expect(PRINT_FLIP_NODE_IDS, 'rack-top is already counterbore-up as modelled').not.toContain('rack-top');
      // Flat slab: tab and deck are the same thickness, which is what lets it
      // lie flat either way up.
      const bb = plate.boundingBox();
      expect(bb.max[2] - bb.min[2], 'plate is a flat slab').toBeCloseTo(PLATE_T, 5);

      // "One printed plate, installed twice" is a design claim the whole joint
      // rests on — every y feature symmetric about depth/2, tabs on the face
      // that points out of the rack. Prove it rather than trusting that both
      // ends call the same builder: map the bottom onto the top and difference.
      const top = exec(byId.get('rack-top')!);
      const mapped = plate
        .translate([0, -dims.depth / 2, -(FOOT_H + PLATE_T / 2)])
        .rotate([180, 0, 0])
        .translate([0, dims.depth / 2, dims.totalH - PLATE_T / 2]);
      try {
        const a = Manifold.difference([mapped, top]).volume();
        const b = Manifold.difference([top, mapped]).volume();
        expect(a + b, 'top plate is the bottom plate turned over — one printed part').toBeLessThan(1);
      } finally {
        top.delete();
        mapped.delete();
      }
    } finally {
      plate.delete();
    }
  }, 60000);

  it('lands every accessory variant on the sides: gap, clearance and screw holes', () => {
    // One shelf config was being spot-checked and the rest assumed. These are
    // the variants the panel can actually produce.
    const VARIANTS: { label: string; acc: RackAccessory }[] = [
      { label: 'shelf 86 vented', acc: { id: 'a', type: 'shelf', slots: 3, shelfDepth: 86, vented: true } },
      { label: 'shelf 86 solid', acc: { id: 'a', type: 'shelf', slots: 3, shelfDepth: 86, vented: false } },
      { label: 'shelf 123 vented', acc: { id: 'a', type: 'shelf', slots: 3, shelfDepth: 123, vented: true } },
      { label: 'shelf 123 frontplate', acc: { id: 'a', type: 'shelf', slots: 3, shelfDepth: 123, vented: true, frontPlate: true } },
      { label: 'shelf 160 vented', acc: { id: 'a', type: 'shelf', slots: 3, shelfDepth: 160, vented: true } },
      { label: 'shelf 160 solid+plate', acc: { id: 'a', type: 'shelf', slots: 3, shelfDepth: 160, vented: false, frontPlate: true } },
      { label: 'shelf 1-slot', acc: { id: 'a', type: 'shelf', slots: 1, shelfDepth: 123, vented: true } },
      { label: 'shelf custom 100', acc: { id: 'a', type: 'shelf', slots: 2, shelfDepth: 100, vented: true } },
      { label: 'keystone', acc: { id: 'a', type: 'keystone', slots: 2 } },
      { label: 'blank 2-slot', acc: { id: 'a', type: 'blank', slots: 2 } },
      { label: 'blank 1-slot', acc: { id: 'a', type: 'blank', slots: 1 } },
      { label: 'cable tray', acc: { id: 'a', type: 'cable-tray' } },
    ];
    for (const { label, acc } of VARIANTS) {
      const rack: RackParams = { ...SAMPLE, accessories: [acc] };
      const dims = computeRackDims(rack);
      const nodes = buildRackNodes(rack);
      const L = exec(nodes.find((n) => n.id === 'rack-side-left')!.op);
      const R = exec(nodes.find((n) => n.id === 'rack-side-right')!.op);
      const A = exec(nodes.find((n) => /^rack-(shelf|keystone|blank|cable-tray)-/.test(n.id))!.op);
      try {
        const bb = A.boundingBox();
        expect(bb.min[0] - 15, `${label}: left gap`).toBeCloseTo(0.3, 2);
        expect(dims.width - 15 - bb.max[0], `${label}: right gap`).toBeCloseTo(0.3, 2);
        for (const side of [L, R]) {
          const i = Manifold.intersection([A, side]);
          const v = i.volume();
          i.delete();
          expect(v, `${label}: fouls a side panel`).toBeLessThan(1);
        }
        // Screw holes must be coaxial. The accessory's local hole offset
        // cancels its placement offset, so they land exactly on holeZ(k).
        const n = accessorySlots(acc);
        for (let k = 0; k < n; k++) {
          // Span the side and the accessory's END RIB only — longer and this
          // pokes into the keystone's jack boss and reports a good hole as a
          // miss, which is exactly how it fooled a hand-run probe.
          const probe = Manifold.cylinder(28, 2, 2, 24).rotate([0, 90, 0]).translate([0, 22, dims.holeZ(k)]);
          const inL = Manifold.intersection([L, probe]).volume();
          const inA = Manifold.intersection([A, probe]).volume();
          probe.delete();
          expect(inL, `${label}: side hole blocked at slot ${k}`).toBeLessThan(1);
          expect(inA, `${label}: accessory thread hole missing at slot ${k}`).toBeLessThan(1);
        }
      } finally {
        [L, R, A].forEach((m) => m.delete());
      }
    }

    // ...and again as a full STACK, because the single-accessory case always
    // lands at slot 0 and would not catch a placement that drifts as the slot
    // cursor advances.
    const stack: RackAccessory[] = [
      { id: 'a', type: 'keystone', slots: 2 },
      { id: 'b', type: 'blank', slots: 2 },
      { id: 'c', type: 'shelf', slots: 3, shelfDepth: 86, vented: true },
      { id: 'd', type: 'shelf', slots: 3, shelfDepth: 123, vented: true },
      { id: 'e', type: 'cable-tray' },
    ];
    const stacked = { ...SAMPLE, accessories: stack };
    const sdims = computeRackDims(stacked);
    const snodes = buildRackNodes(stacked);
    const SL = exec(snodes.find((n) => n.id === 'rack-side-left')!.op);
    try {
      let cursor = 0;
      stack.forEach((acc, i) => {
        const n = accessorySlots(acc);
        const start = Math.min(cursor, Math.max(0, sdims.slots - n));
        const A = exec(snodes.find((nd) => nd.id === `rack-${acc.type}-${i}`)!.op);
        try {
          // Recessed the same 12 mm behind the front face, whatever the type.
          expect(A.boundingBox().min[1], `${acc.type} ${i}: front recess`).toBeCloseTo(12, 2);
          for (let k = 0; k < n; k++) {
            const probe = Manifold.cylinder(28, 2, 2, 24)
              .rotate([0, 90, 0])
              .translate([0, 22, sdims.holeZ(start + k)]);
            const inL = Manifold.intersection([SL, probe]).volume();
            const inA = Manifold.intersection([A, probe]).volume();
            probe.delete();
            expect(inL, `${acc.type} ${i}: side hole at slot ${start + k}`).toBeLessThan(1);
            expect(inA, `${acc.type} ${i}: thread hole at slot ${start + k}`).toBeLessThan(1);
          }
        } finally {
          A.delete();
        }
        cursor += n;
      });
    } finally {
      SL.delete();
    }
  }, 180000);

  it("full-depth shelf tracks the rack's depth and anchors front, mid and rear", () => {
    for (const depth of [200, 250, 300]) {
      const rack: RackParams = {
        ...SAMPLE,
        depth,
        accessories: [{ id: 'a', type: 'shelf', slots: 3, shelfDepth: 'full', vented: true }],
      };
      const dims = computeRackDims(rack);
      const nodes = buildRackNodes(rack);
      const L = exec(nodes.find((n) => n.id === 'rack-side-left')!.op);
      const A = exec(nodes.find((n) => n.id.startsWith('rack-shelf'))!.op);
      try {
        const bb = A.boundingBox();
        // Auto-sizes: front stays on the recess, back lands on the rack's rear
        // face, whatever the depth is set to.
        expect(bb.min[1], `depth ${depth}: front`).toBeCloseTo(12, 2);
        expect(bb.max[1], `depth ${depth}: back reaches the rack's rear`).toBeCloseTo(depth, 2);
        // Three anchors, not two: a shelf this long cantilevers badly off the
        // mid column alone, so the sides gain a rear column to match it.
        for (const y of [22, 100, depth - 12]) {
          for (let k = 0; k < 3; k++) {
            const probe = Manifold.cylinder(28, 2, 2, 24).rotate([0, 90, 0]).translate([0, y, dims.holeZ(k)]);
            const inL = Manifold.intersection([L, probe]).volume();
            const inA = Manifold.intersection([A, probe]).volume();
            probe.delete();
            expect(inL, `depth ${depth}: side hole at y=${y}, slot ${k}`).toBeLessThan(1);
            expect(inA, `depth ${depth}: shelf thread hole at y=${y}, slot ${k}`).toBeLessThan(1);
          }
        }
      } finally {
        [L, A].forEach((m) => m.delete());
      }
    }

    // Each rear boss must stand as an isolated ring, like the front column's.
    // Centred on the rear band's pocket EDGE they straddled it and printed as
    // half-buried crescents — 31-50% fused into the surrounding rim against
    // the front column's 0-4%, which is what the defect looked like in a
    // render. Both the bearing face and the halo around it are pinned.
    {
      const rack: RackParams = {
        ...SAMPLE,
        accessories: [{ id: 'a', type: 'shelf', slots: 3, shelfDepth: 'full', vented: true }],
      };
      const dims = computeRackDims(rack);
      const L = exec(buildRackNodes(rack).find((n) => n.id === 'rack-side-left')!.op);
      try {
        const annulus = (rIn: number, rOut: number, y: number, z: number): number => {
          const o = Manifold.cylinder(0.4, rOut, rOut, 48).rotate([0, 90, 0]).translate([0.2, y, z]);
          const i = Manifold.cylinder(0.8, rIn, rIn, 48).rotate([0, 90, 0]).translate([0, y, z]);
          const sh = Manifold.difference([o, i]);
          const t = Manifold.intersection([L, sh]);
          const f = t.volume() / sh.volume();
          [o, i, sh, t].forEach((m) => m.delete());
          return f;
        };
        for (let k = 1; k < 5; k++) {
          const z = dims.holeZ(k);
          const y = SAMPLE.depth - 12;
          expect(annulus(2.9, 4.6, y, z), `slot ${k}: rear head bearing`).toBeGreaterThan(0.98);
          expect(annulus(5.4, 7.5, y, z), `slot ${k}: rear boss stands isolated`).toBeLessThan(0.1);
        }
      } finally {
        L.delete();
      }
    }

    // The rear column is cut ONLY when a full-depth shelf is present, so an
    // ordinary rack is not peppered with holes it will never use.
    const plain = buildRackNodes({ ...SAMPLE, accessories: [{ id: 'a', type: 'shelf', slots: 3, shelfDepth: 123 }] });
    const dims = computeRackDims(SAMPLE);
    const L = exec(plain.find((n) => n.id === 'rack-side-left')!.op);
    try {
      const probe = Manifold.cylinder(28, 2, 2, 24)
        .rotate([0, 90, 0])
        .translate([0, SAMPLE.depth - 12, dims.holeZ(0)]);
      const inL = Manifold.intersection([L, probe]).volume();
      probe.delete();
      expect(inL, 'no rear anchor column without a full-depth shelf').toBeGreaterThan(1);
    } finally {
      L.delete();
    }
  }, 180000);

  it('cuts cable notches in the rear edge of the chosen plate, without splitting it', () => {
    const dims = computeRackDims(SAMPLE);
    const rearOpenings = (op: Parameters<typeof exec>[0], zMid: number): number => {
      const m = exec(op);
      try {
        let open = 0;
        let was = false;
        for (let x = 16; x < dims.width - 16; x += 0.5) {
          const c = Manifold.cube([0.4, 3, 0.4]).translate([x, dims.depth - 3, zMid]);
          const i = Manifold.intersection([m, c]);
          const isOpen = i.volume() < 0.05;
          if (isOpen && !was) open++;
          was = isOpen;
          i.delete();
          c.delete();
        }
        return open;
      } finally {
        m.delete();
      }
    };
    const zBottom = 7.5;
    const zTop = dims.totalH - 2.5;
    const plateOf = (rack: RackParams, id: string) =>
      buildRackNodes(rack).find((n) => n.id === id)!.op;

    // Off by default.
    expect(rearOpenings(plateOf(SAMPLE, 'rack-bottom'), zBottom)).toBe(0);

    // Only the chosen plate is cut — the flip means these are no longer one
    // printed part, which is the trade the panel warns about.
    const onlyBottom: RackParams = { ...SAMPLE, cableNotches: { plate: 'bottom', count: 2, width: 40, depth: 30 } };
    expect(rearOpenings(plateOf(onlyBottom, 'rack-bottom'), zBottom)).toBe(2);
    expect(rearOpenings(plateOf(onlyBottom, 'rack-top'), zTop)).toBe(0);

    const both: RackParams = { ...SAMPLE, cableNotches: { plate: 'both', count: 3, width: 30, depth: 25 } };
    expect(rearOpenings(plateOf(both, 'rack-bottom'), zBottom)).toBe(3);
    expect(rearOpenings(plateOf(both, 'rack-top'), zTop)).toBe(3);

    // Crowded and over-wide: the width clamps, and — the part that matters —
    // the plate stays ONE body. The walls between notches fall in the deck's
    // lattice, so without keeping solid material around each notch eight of
    // them came away as detached fingers: nine separate bodies.
    const crowded: RackParams = { ...SAMPLE, cableNotches: { plate: 'top', count: 8, width: 60, depth: 40 } };
    for (const id of ['rack-top', 'rack-bottom']) {
      const m = exec(plateOf(crowded, id));
      try {
        const parts = m.decompose();
        expect(parts.length, `${id} must stay one body`).toBe(1);
        parts.forEach((c) => c.delete());
      } finally {
        m.delete();
      }
    }
    expect(rearOpenings(plateOf(crowded, 'rack-top'), zTop)).toBe(8);
  }, 180000);

  it('never hands the worker the same ArrayBuffer twice', () => {
    // postMessage rejects a transfer list holding a buffer twice, and the
    // browser only says "ArrayBuffer at index N is a duplicate" — no hint as
    // to which node. The one-piece export unions the very same side-panel ops
    // that are also emitted as their own nodes, so with wall-mount ears (whose
    // gussets are `mesh` ops carrying typed arrays) every gusset buffer was
    // reachable three times over and the viewport died on any rack edit.
    for (const wallMount of ['none', 'ears', 'cleat', 'keyhole'] as const) {
      for (const assembledExport of [false, true]) {
        const rack: RackParams = {
          ...SAMPLE,
          wallMount,
          assembledExport,
          printer: { x: 360, y: 360, z: 360 },
        };
        // The ACTUAL list workerClient transfers. Asserting per-node would
        // not catch this: no single node repeats a buffer — the repeats are
        // across nodes, between a part and the fused export that contains it.
        const list = transferListForPlan({ nodes: buildRackNodes(rack) });
        expect(
          new Set(list).size,
          `${wallMount}/assembled=${assembledExport}: duplicate ArrayBuffer in the transfer list`,
        ).toBe(list.length);
      }
    }

    // And the collector itself must dedupe a subtree that appears twice.
    const shared = buildRackNodes({ ...SAMPLE, wallMount: 'ears' })[0]!.op;
    const once = collectMeshTransferables(shared);
    const twice = collectMeshTransferables(union([shared, shared]));
    expect(twice.length, 'a subtree used twice still transfers once').toBe(once.length);
  }, 120000);

  it('reports the usable space on each accessory, matching the geometry (#141)', () => {
    const accessories: RackAccessory[] = [
      { id: 'a', type: 'shelf', slots: 3, shelfDepth: 123, vented: true },
      { id: 'b', type: 'blank', slots: 2 },
      { id: 'c', type: 'shelf', slots: 1, shelfDepth: 86, vented: true },
      { id: 'd', type: 'cable-tray' },
      { id: 'e', type: 'shelf', slots: 2, shelfDepth: 123, vented: true },
    ];
    const rack: RackParams = { ...SAMPLE, accessories };
    const dims = computeRackDims(rack);
    const spaces = accessorySpaces(rack);
    const all = Manifold.union(buildRackNodes(rack).map((n) => exec(n.op)));
    try {
      expect(spaces).toHaveLength(accessories.length);
      // A faceplate holds nothing.
      expect(spaces[1]!.usable, 'a blank faceplate has no usable volume').toBeNull();

      for (const sp of spaces) {
        if (!sp.usable) continue;
        const acc = accessories[sp.index]!;
        const deckT = acc.type === 'cable-tray' ? TRAY_DECK_T : SHELF_DECK_T + SHELF_RIB_H;
        const z0 = dims.slotZ(sp.startSlot) + 0.25 + deckT;
        // Rise a column off the middle of the deck until something stops it.
        let free = 0;
        for (let z = z0 + 0.25; z < dims.totalH; z += 0.25) {
          const c = Manifold.cube([60, 40, 0.2]).translate([dims.width / 2 - 30, 60, z]);
          const i = Manifold.intersection([all, c]);
          const hit = i.volume() > 0.5;
          i.delete();
          c.delete();
          if (hit) break;
          free = z - z0;
        }
        expect(
          Math.abs(free - sp.usable.h),
          `accessory ${sp.index} (${acc.type}): reported ${sp.usable.h.toFixed(1)} mm but measured ${free.toFixed(1)}`,
        ).toBeLessThan(1);
      }

      // The specific thing that made the first formula wrong: a shelf under a
      // BLANK has the full run up to the next shelf, not one slot span. Getting
      // this wrong under-reported a 3-slot shelf as 46.5 mm when it had 79.5.
      expect(spaces[0]!.usable!.h, 'faceplate above must not form a ceiling').toBeGreaterThan(70);
      // Width is between the end ribs, well under the rack's outside width.
      expect(spaces[0]!.usable!.w).toBeCloseTo(SAMPLE.width - 2 * (15 + 0.3 + 12), 1);
    } finally {
      all.delete();
    }
  }, 180000);

  it('stiffens the floor plate and gives every tab something to bear on', () => {
    // The floor is NOT held up by the ground: it sits 5 mm clear, carried by
    // its tabs, so anything heavy on it is a plate spanning between the sides.
    for (const [width, expectRibs] of [[252, false], [350, true]] as [number, boolean][]) {
      const rack: RackParams = { ...SAMPLE, width, depth: 300, slots: 20, accessories: [] };
      const dims = computeRackDims(rack);
      expect(floorRibsEnabled(rack), `${width}: ribs auto`).toBe(expectRibs);
      const nodes = buildRackNodes(rack);
      const B = exec(nodes.find((n) => n.id === 'rack-bottom')!.op);
      const T = exec(nodes.find((n) => n.id === 'rack-top')!.op);
      const L = exec(nodes.find((n) => n.id === 'rack-side-left')!.op);
      try {
        const bb = B.boundingBox();
        // Ribs hang BELOW the plate into the foot gap, keeping 1 mm of ground
        // clearance — reaching the floor would help a freestanding rack and do
        // nothing for a wall-mounted one, which is the case that needs them.
        expect(bb.min[2], `${width}: underside`).toBeCloseTo(expectRibs ? 1 : 5, 1);
        expect(B.decompose().length, `${width}: plate is one body`).toBe(1);
        // Bottom plate only — ribs on the top plate would stand proud of the
        // rack and break stacking, since it is the same part turned over.
        if (expectRibs) expect(B.volume(), `${width}: top plate has no ribs`).toBeGreaterThan(T.volume() * 1.1);
        else expect(B.volume()).toBeCloseTo(T.volume(), -1);
        // Plate still seats without fouling the sides.
        const i = Manifold.intersection([B, L]);
        const clash = i.volume();
        i.delete();
        expect(clash, `${width}: plate fouls a side`).toBeLessThan(1);

        // EVERY tab must have material beneath it. Only the end tabs used to:
        // they land on a stacking foot, while the mid tab had nothing under it
        // and could only resist uplift, so a load was carried on four corners.
        for (const y of plateTabYs(dims.depth)) {
          const c = Manifold.cube([11, 20, 5]).translate([4.3, y - 10, 0]);
          const t = Manifold.intersection([L, c]);
          const frac = t.volume() / c.volume();
          t.delete();
          c.delete();
          expect(frac, `${width}: tab at y=${y} has nothing to bear on`).toBeGreaterThan(0.3);
        }
      } finally {
        [B, T, L].forEach((m) => m.delete());
      }
    }
  }, 180000);

  it('notches full-depth shelves to match the plates, and lines them up', () => {
    const accessories: RackAccessory[] = [
      { id: 'a', type: 'shelf', slots: 3, shelfDepth: 123, vented: true },
      { id: 'b', type: 'shelf', slots: 3, shelfDepth: 'full', vented: true },
    ];
    const rack: RackParams = {
      ...SAMPLE,
      accessories,
      cableNotches: { plate: 'both', count: 3, width: 40, depth: 30 },
    };
    const dims = computeRackDims(rack);
    const g = cableNotchGeometry(rack, dims);
    expect(g, 'notch geometry resolves').not.toBeNull();
    const nodes = buildRackNodes(rack);
    const B = exec(nodes.find((n) => n.id === 'rack-bottom')!.op);
    const short = exec(nodes.find((n) => n.id === 'rack-shelf-0')!.op);
    const full = exec(nodes.find((n) => n.id === 'rack-shelf-1')!.op);
    try {
      const open = (m: ReturnType<typeof exec>, x: number, y: number, z: number): boolean => {
        const c = Manifold.cube([3, 3, 2]).translate([x - 1.5, y - 1.5, z - 1]);
        const i = Manifold.intersection([m, c]);
        const v = i.volume() < 0.5;
        i.delete();
        c.delete();
        return v;
      };
      const yRear = dims.depth - 8;
      // A cable dropping through a shelf must land on the plate opening below
      // it, not beside it — so both are cut from ONE shared geometry.
      for (const cx of g!.cx) {
        expect(open(B, cx, yRear, 7.5), `bottom plate notch at x=${cx.toFixed(0)}`).toBe(true);
        expect(
          open(full, cx, yRear, full.boundingBox().min[2] + 1.5),
          `full shelf notch at x=${cx.toFixed(0)}`,
        ).toBe(true);
      }
      // A shorter shelf stops well before the back, so the cable run behind it
      // is already clear and it gets nothing.
      expect(short.boundingBox().max[1], 'short shelf does not reach the back').toBeLessThan(dims.depth - 50);
      // And the notches must not sever the deck, same trap as the plates.
      const parts = full.decompose();
      expect(parts.filter((c) => c.volume() > 1).length, 'notched shelf is one body').toBe(1);
      parts.forEach((c) => c.delete());
    } finally {
      [B, short, full].forEach((m) => m.delete());
    }
  }, 180000);

  it('stiffens the shelf deck enough to matter in PETG', () => {
    // A printed shelf came out flimsy. A flat 3 mm deck over a ~197 mm span
    // measured I = 106 mm4 — 23 mm of sag under 5 kg in PETG, which is about
    // HALF the stiffness of PLA and what this user prints in. Section depth is
    // the only lever big enough; closing the lattice alone reached 14.5 mm.
    const rack: RackParams = {
      ...SAMPLE,
      accessories: [{ id: 'a', type: 'shelf', slots: 3, shelfDepth: 123, vented: true }],
    };
    const dims = computeRackDims(rack);
    const S = exec(buildRackNodes(rack).find((n) => n.id.startsWith('rack-shelf'))!.op);
    try {
      const bb = S.boundingBox();
      const span = dims.width - 2 * (15 + 0.3 + 12);
      const z0 = bb.min[2];
      const shelfD = bb.max[1] - bb.min[1];
      // Section in the Y-Z plane: the deck spans in X between the end ribs.
      const len = 60;
      const xm = 15 + 0.3 + 12 + span / 2 - len / 2;
      const layers: { z: number; a: number }[] = [];
      for (let z = z0 - 0.5; z < z0 + SHELF_DECK_T + SHELF_RIB_H + 1; z += 0.2) {
        const c = Manifold.cube([len, shelfD, 0.2]).translate([xm, bb.min[1], z]);
        const i = Manifold.intersection([S, c]);
        const a = i.volume() / 0.2 / len;
        i.delete();
        c.delete();
        if (a > 0.001) layers.push({ z: z + 0.1, a });
      }
      const A = layers.reduce((acc, l) => acc + l.a * 0.2, 0);
      const zbar = layers.reduce((acc, l) => acc + l.z * l.a * 0.2, 0) / A;
      const I = layers.reduce((acc, l) => acc + l.a * 0.2 * (l.z - zbar) ** 2, 0);
      // Ribbed it measures ~687. Guard well clear of the 106 it had flat, so a
      // future "lightening" pass cannot quietly take the stiffness back out —
      // which is exactly how it got flimsy: opening the lattice to save 7.5 cm3.
      expect(I, 'shelf deck second moment').toBeGreaterThan(450);
      const petgSag5kg = (5 * 5 * 9.81 * span ** 3) / (384 * 2000 * I);
      expect(petgSag5kg, 'sag under 5 kg in PETG (mm)').toBeLessThan(6);
      // Ribs must rise ABOVE the deck: the shelf prints deck-down, so downstand
      // ribs would print first and leave the deck bridging between them.
      expect(bb.max[2] - z0, 'ribs stand proud of the deck').toBeGreaterThan(SHELF_DECK_T);
    } finally {
      S.delete();
    }
  }, 120000);

  it('gives every shelf screw a boss to bite, the rear anchor included', () => {
    // The end ribs are hollowed into a C-channel; ribChannelCuts leaves a solid
    // BOSS standing at each screw so the thread has something to catch. The
    // rear anchor hole was added without its boss, so on a full-depth shelf the
    // channel hollowed straight through behind it and the screw caught nothing
    // — found on a printed shelf, not by any test.
    const rack: RackParams = {
      ...SAMPLE,
      accessories: [{ id: 'a', type: 'shelf', slots: 3, shelfDepth: 'full', vented: true }],
    };
    const dims = computeRackDims(rack);
    const A = exec(buildRackNodes(rack).find((n) => n.id.startsWith('rack-shelf'))!.op);
    try {
      const ring = (y: number, z: number): number => {
        const o = Manifold.cylinder(11, 4.5, 4.5, 32).rotate([0, 90, 0]).translate([15.5, y, z]);
        const i = Manifold.cylinder(13, 2.4, 2.4, 32).rotate([0, 90, 0]).translate([14.5, y, z]);
        const sh = Manifold.difference([o, i]);
        const t = Manifold.intersection([A, sh]);
        const f = t.volume() / sh.volume();
        [o, i, sh, t].forEach((m) => m.delete());
        return f;
      };
      for (const [label, y] of [
        ['front', 22],
        ['mid', 100],
        ['rear anchor', SAMPLE.depth - 12],
      ] as [string, number][]) {
        for (let k = 0; k < 3; k++) {
          expect(ring(y, dims.holeZ(k)), `${label} screw, slot ${k}: nothing to bite`).toBeGreaterThan(0.9);
        }
      }
    } finally {
      A.delete();
    }
  }, 120000);

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
