// Issue #151 (second half) — the carrier pocket: a wall shelf the finished
// module NESTS into.
//
// The claims worth testing are physical, so most are made against the mesh:
// "the module's own volume is empty space inside the pocket", "the walls are
// exactly the fit away from it", "the mouth flares", "the wall-screw bore goes
// through the plate and its head seat is on the room-facing face". An op-tree
// assertion would pass on a tray one fit too small — the failure this design
// invites, and the one nobody sees until the print is in their hand.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  buildPocketOp,
  buildStandNodes,
  computePocketDims,
  standModulePlacement,
} from '@/engine/compiler/stand';
import {
  aabbOfOp,
  cube,
  cylinder,
  intersection,
  translate,
  type BuildOp,
} from '@/engine/compiler/buildPlan';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { getBuiltinBoard } from '@/library';
import { createDefaultProject, useProjectStore } from '@/store/projectStore';
import { hardwareForProject } from '@/engine/exporters/hardwareList';
import { partForId } from '@/engine/exporters/parts';
import { derivedKind } from '@/engine/compiler/archetype';
import type { StandParams } from '@/types';
import { exec } from './helpers/manifoldExec';

function volume(op: BuildOp): number {
  const m = exec(op);
  try {
    return m.volume();
  } finally {
    m.delete();
  }
}

/** How much of `box` the part's material fills. */
function occupied(part: BuildOp, box: BuildOp): number {
  return volume(intersection([part, box]));
}

/** An axis-aligned box from its min corner and size. */
function box(min: [number, number, number], size: [number, number, number]): BuildOp {
  return translate(min, cube(size));
}

const POCKET: StandParams = {
  enabled: true,
  mount: 'pocket',
  tiltAngleDeg: 0,
  frameThickness: 8,
  bezelMargin: 0,
  openingClearance: 0.4,
  screwHoleDiameter: 2.4,
  baseDepth: 55,
  baseThickness: 5,
  gussetThickness: 6,
  gussetHeightFraction: 0.55,
};

describe('#151 — pocket carrier dims (pure)', () => {
  const board = getBuiltinBoard('guition-jc4880p443c')!;
  const d = computePocketDims(board, POCKET)!;

  it('sizes the pocket from the module envelope, not from a number typed here', () => {
    const enc = board.enclosure!;
    // Opening = the module's own outline + the fit, per side.
    expect(d.innerW).toBeCloseTo(board.pcb.size.x + 2 * POCKET.openingClearance, 6);
    expect(d.innerH).toBeCloseTo(board.pcb.size.y + 2 * POCKET.openingClearance, 6);
    // Thickness = flange + the deepest thing behind it (the rear body on this
    // panel; a taller boss would win, which is why it is a max()).
    expect(d.moduleD).toBeCloseTo(
      enc.flangeThickness + Math.max(enc.body.depth, enc.bossHeight),
      6,
    );
    expect(d.moduleD).toBeCloseTo(board.pcb.size.z, 6);
    // Enough depth past the face to get a finger behind it.
    expect(d.pocketD).toBeGreaterThan(d.moduleD);
  });

  it('puts a screw ear each side, and a plate taller than the walls need', () => {
    expect(d.plateW).toBeCloseTo(d.innerW + 2 * (d.plateT + d.earReach), 6);
    expect(d.plateH).toBeCloseTo(d.innerH + d.plateT, 6);
    // Both ears come out the same width, and each screw sits in the middle of
    // its own ear — the two are mirror images, not merely a mirrored pair of
    // numbers. (The bug this caught: an ear reach measured from the wall's
    // INNER face makes the left ear one wall thicker than the right, and
    // mirrors the screw into the wall on one side only.)
    const earW = (d.plateW - (d.innerW + 2 * d.plateT)) / 2;
    expect(earW).toBeCloseTo(d.earReach, 6);
    expect(d.earScrewX).toBeCloseTo(earW / 2, 6);
    expect(d.plateW - d.earScrewX).toBeCloseTo(d.plateW - earW / 2, 6);
    expect(d.earScrewYs).toHaveLength(2);
    for (const y of d.earScrewYs) expect(y).toBeGreaterThan(d.plateT);
    // Symmetric about the plate's mid-height — the two screws share the load.
    expect(d.earScrewYs[0]! + d.earScrewYs[1]!).toBeCloseTo(d.plateH, 6);
  });

  it('gives a short module one screw per ear, because two would collide', () => {
    const short = { ...POCKET };
    const tiny = {
      ...board,
      enclosure: { ...board.enclosure!, body: { ...board.enclosure!.body } },
      pcb: { ...board.pcb, size: { ...board.pcb.size, y: 20 } },
    };
    const dt = computePocketDims(tiny, short)!;
    expect(dt.plateH).toBeLessThan(60);
    expect(dt.earScrewYs).toHaveLength(1);
  });

  it('is null for a board with no module envelope', () => {
    expect(computePocketDims(getBuiltinBoard('rpi-4b')!, POCKET)).toBeNull();
    expect(buildPocketOp(getBuiltinBoard('rpi-4b')!, POCKET)).toBeNull();
  });
});

describe('#151 — pocket carrier geometry (evaluated)', () => {
  const board = getBuiltinBoard('guition-jc4880p443c')!;
  const d = computePocketDims(board, POCKET)!;
  const T = d.plateT;
  const EAR = d.earReach;
  const wx0 = EAR; // left wall's outer face
  const wx1 = wx0 + d.innerW + 2 * T; // right wall's outer face
  const innerX0 = wx0 + T;
  const mouth = T + d.pocketD;
  const tray = buildPocketOp(board, POCKET)!;

  it('is one printed piece — a single shell after all the cuts', () => {
    const m = exec(tray);
    const parts = m.decompose();
    const count = parts.length;
    parts.forEach((p) => p.delete());
    const vol = m.volume();
    m.delete();
    expect(count).toBe(1);
    expect(vol).toBeGreaterThan(0);
  });

  it('datums on the wall plane and sits in the first octant', () => {
    const bb = aabbOfOp(tray)!;
    expect(bb.min[0]).toBeCloseTo(0, 6);
    expect(bb.min[1]).toBeCloseTo(0, 6);
    expect(bb.min[2]).toBeCloseTo(0, 6);
    expect(bb.max[0]).toBeCloseTo(d.plateW, 6);
    expect(bb.max[1]).toBeCloseTo(d.plateH, 6);
    expect(bb.max[2]).toBeCloseTo(mouth, 6);
  });

  // ---- The claim the whole feature rests on: the module fits --------------
  it('leaves the module’s own volume empty, and does not stick out anywhere', () => {
    const p = standModulePlacement(board, POCKET)!;
    const mw = board.pcb.size.x;
    const mh = board.pcb.size.y;
    // The placement puts the module at Ry(180) then + frameOffset, so its box
    // is [offset.x − mw, offset.x] × ... in the tray's frame.
    const moduleBox = box(
      [p.frameOffset[0] - mw, p.frameOffset[1], p.frameOffset[2] - d.moduleD],
      [mw, mh, d.moduleD],
    );
    expect(occupied(tray, moduleBox)).toBeCloseTo(0, 3);

    // ...and that box is inside the tray's own outline, not hanging off it.
    const mbb = aabbOfOp(moduleBox)!;
    const tbb = aabbOfOp(tray)!;
    for (let a = 0; a < 3; a++) {
      expect(mbb.min[a]!).toBeGreaterThanOrEqual(tbb.min[a]!);
      expect(mbb.max[a]!).toBeLessThanOrEqual(tbb.max[a]!);
    }
    // Nested in depth too: the face sits BEHIND the mouth, so a finger can
    // reach behind it.
    expect(mbb.max[2]!).toBeLessThan(mouth - 1);
  });

  it('leaves exactly the fit between the module and each wall', () => {
    const p = standModulePlacement(board, POCKET)!;
    const mw = board.pcb.size.x;
    const mh = board.pcb.size.y;
    const fit = (d.innerW - mw) / 2;
    const z0 = T;
    const z1 = T + d.moduleD; // clear of the mouth's lead-in band
    // Material ends exactly at the pocket's inner face...
    const wallEdge = box([innerX0 - 1, T, z0], [1, mh, z1 - z0]);
    expect(occupied(tray, wallEdge)).toBeCloseTo(volume(wallEdge), 3);
    // ...and the fit-thick slice between that face and the module is empty, so
    // the gap IS the fit — not tighter (the module wouldn't go in) and not
    // looser (the module would rattle).
    const gap = box([innerX0, T, z0], [fit, mh, z1 - z0]);
    expect(occupied(tray, gap)).toBeCloseTo(0, 3);
    // The floor is the module's bottom edge's own reference, not the fit
    // above it: its top face is at y = T and the module starts there.
    const underFloor = box([innerX0 + 2, T - 1, z0], [d.innerW - 4, 1, z1 - z0]);
    expect(occupied(tray, underFloor)).toBeCloseTo(volume(underFloor), 3);
    expect(p.frameOffset[1]).toBeCloseTo(T, 6);
  });

  it('flares the mouth: no material where the lead-in cuts, solid below it', () => {
    const lead = 3; // POCKET_LEAD
    // Just inside the left wall's inner face, in the lead-in band at the mouth.
    const atMouth = box([innerX0 - 0.5, T + 1, mouth - 1], [0.5, d.innerH - 2, 1]);
    expect(occupied(tray, atMouth)).toBeCloseTo(0, 3);
    // The same slice well inside the pocket is solid.
    const inside = box([innerX0 - 0.5, T + 1, mouth - 10], [0.5, d.innerH - 2, 1]);
    expect(occupied(tray, inside)).toBeCloseTo(volume(inside), 3);
    // And the floor's front lip is chamfered the same way.
    const floorLip = box([innerX0 + 2, T - 0.5, mouth - 1], [10, 0.5, 1]);
    expect(occupied(tray, floorLip)).toBeCloseTo(0, 3);
    // The band is exactly `lead` deep, measured on the lead-in's own slope.
    const justClear = box([innerX0 - 0.5, T + 1, mouth - lead - 1.5], [0.5, d.innerH - 2, 0.5]);
    expect(occupied(tray, justClear)).toBeCloseTo(volume(justClear), 3);
  });

  it('ribs the plate/wall corner outboard of each wall', () => {
    // Inside the rib's 45° web: outboard of the wall's outer face, above the
    // floor, clear of the plate. Nothing else lives here.
    const leftRib = box([wx0 - 5, 1, T + 1], [4, 2, 4]);
    const rightRib = box([wx1 + 1, 1, T + 1], [4, 2, 4]);
    expect(occupied(tray, leftRib)).toBeCloseTo(volume(leftRib), 2);
    expect(occupied(tray, rightRib)).toBeCloseTo(volume(rightRib), 2);
    // ...and nothing there when the single wall screw comes down into the same
    // band: a rib would be drilled through by its own ear screw.
    const tiny = { ...board, pcb: { ...board.pcb, size: { ...board.pcb.size, y: 20 } } };
    const dTiny = computePocketDims(tiny, POCKET)!;
    expect(dTiny.earScrewYs).toHaveLength(1);
    const tinyTray = buildPocketOp(tiny, POCKET)!;
    const xw = dTiny.earReach;
    const tinyRib = box([xw - 5, 1, dTiny.plateT + 1], [4, 2, 4]);
    expect(occupied(tinyTray, tinyRib)).toBeCloseTo(0, 3);
  });
});

describe('#151 — pocket wall screws (evaluated)', () => {
  const board = getBuiltinBoard('guition-jc4880p443c')!;
  const d = computePocketDims(board, POCKET)!;
  const T = d.plateT;
  const tray = buildPocketOp(board, POCKET)!;

  it('drills the user’s wall screw clean through the plate, in each ear', () => {
    const sx = d.earScrewX;
    const sy = d.earScrewYs[1]!;
    // The wall screws are the user's own, so the bore is WALL_SCREW_D (4.5 mm).
    // Probe it with a 2 mm-radius cylinder clear through the plate's full
    // thickness — comfortably inside the bore's inscribed radius (2.23 mm at
    // 24 segments), so this fails only if the hole is missing or undersized.
    for (const cx of [sx, d.plateW - sx]) {
      const bore = translate([cx, sy, 0], cylinder(T + 2, 2.0, 32));
      expect(occupied(tray, bore)).toBeCloseTo(0, 3);
    }
  });

  it('counterbores the head on the ROOM-facing face, not the wall side', () => {
    const sx = d.earScrewX;
    const sy = d.earScrewYs[0]!;
    const headR = 4.8; // WALL_HEAD_D / 2
    const recess = 2; // WALL_HEAD_RECESS
    const front = box([sx - 5.5, sy - 5.5, T - recess], [11, 11, recess]);
    const back = box([sx - 5.5, sy - 5.5, 0], [11, 11, recess]);
    const full = 11 * 11 * recess;
    const removedFront = full - occupied(tray, front);
    const removedBack = full - occupied(tray, back);
    // Front: the head seat's full disc. (The bore is inside that disc, so it
    // adds nothing.) The tolerance is loose because both cuts are polygonal —
    // the seat is a 32-gon of area π·r²·(1 − ~0.5 %), not a true circle.
    expect(removedFront).toBeCloseTo(Math.PI * headR * headR * recess, -1);
    // Back: only the bore — the counterbore never reaches the wall side.
    expect(removedBack).toBeCloseTo(Math.PI * 2.25 * 2.25 * recess, -1);
    expect(removedFront).toBeGreaterThan(removedBack * 3);
  });

  it('bills the user’s own wall screws, and nothing that fastens the module', () => {
    const project = createDefaultProject('guition-jc4880p443c');
    project.case.stand = { ...POCKET };
    const items = hardwareForProject(project);
    const wall = items.find((i) => i.id === 'pocket-wall-screws')!;
    expect(wall.count).toBe(2 * d.earScrewYs.length);
    // No screws into the module: a pocket nests it, it does not bolt it.
    expect(items.some((i) => i.id === 'stand-screws')).toBe(false);
  });
});

describe('#151 — pocket carrier wires into the compiler', () => {
  beforeEach(() => {
    useProjectStore.getState().setProject(createDefaultProject('guition-jc4880p443c'));
  });

  it('emits the tray as the only part, and nothing for a bare board', () => {
    const board = getBuiltinBoard('guition-jc4880p443c')!;
    expect(buildStandNodes(board, POCKET)!.map((n) => n.id)).toEqual(['pocket-tray']);
    expect(buildStandNodes(getBuiltinBoard('rpi-4b')!, POCKET)).toBeNull();
  });

  it('is the stand archetype, and compiles to one well-formed part', () => {
    const p = createDefaultProject('guition-jc4880p443c');
    p.case.stand = { ...POCKET };
    expect(derivedKind(p)).toBe('stand');
    const plan = compileProject(p);
    expect(plan.nodes.map((n) => n.id)).toEqual(['pocket-tray']);
    expect(volume(plan.nodes[0]!.op)).toBeGreaterThan(0);
  });

  it('gives the part a name and a print hint the exporter can use', () => {
    const meta = partForId('pocket-tray');
    expect(meta.displayName).toMatch(/wall shelf/i);
    expect(meta.material).toBe('rigid');
    expect(meta.printOrientation.flipForPrint).toBe(false);
    expect(meta.supports).toBe('none');
  });
});
