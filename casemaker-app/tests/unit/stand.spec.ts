import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import {
  buildEdgeChannels,
  buildSliderStandOp,
  buildStandOp,
  computeSliderDims,
  computeStandDims,
  standModulePlacement,
} from '@/engine/compiler/stand';
import { getBuiltinBoard } from '@/library';
import { findTemplate, findTemplateByBoard } from '@/library/templates';
import { aabbOfOp } from '@/engine/compiler/buildPlan';
import { hardwareForProject } from '@/engine/exporters/hardwareList';
import type { StandParams } from '@/types';

const STAND: StandParams = {
  enabled: true,
  tiltAngleDeg: 15,
  frameThickness: 8,
  bezelMargin: 0,
  openingClearance: 0.4,
  screwHoleDiameter: 2.4,
  baseDepth: 55,
  baseThickness: 5,
  gussetThickness: 6,
  gussetHeightFraction: 0.55,
};

describe('Guition JC4880P443C module profile', () => {
  const board = getBuiltinBoard('guition-jc4880p443c')!;

  it('matches the vendor structure drawing', () => {
    // Outline + total thickness (flange 4.8 + rear body 9.0 = 13.8).
    expect(board.pcb.size.x).toBeCloseTo(117.01);
    expect(board.pcb.size.y).toBeCloseTo(69.41);
    expect(board.pcb.size.z).toBeCloseTo(13.8);
    const enc = board.enclosure!;
    expect(enc.flangeThickness + enc.body.depth).toBeCloseTo(board.pcb.size.z, 5);
    // Rear body is centred in the outline: rims 7.2 (L/R) and 2.17 (T/B).
    expect(enc.body.x).toBeCloseTo((117.01 - 102.6) / 2, 2);
    expect(enc.body.y).toBeCloseTo((69.41 - 65.06) / 2, 2);
    // Mounting bosses: Ø2 holes on a 108 x 60 grid, centred on the outline.
    expect(enc.bossDiameter).toBeCloseTo(5.4);
    expect(enc.bossHeight).toBeCloseTo(5.0);
    const xs = [...new Set(board.mountingHoles.map((h) => h.x))].sort((a, b) => a - b);
    const ys = [...new Set(board.mountingHoles.map((h) => h.y))].sort((a, b) => a - b);
    expect(board.mountingHoles.length).toBe(4);
    expect(xs[1]! - xs[0]!).toBeCloseTo(108, 1);
    expect(ys[1]! - ys[0]!).toBeCloseTo(60, 1);
    expect(xs[0]! + xs[1]!).toBeCloseTo(117.01, 1); // symmetric about the centre
    expect(ys[0]! + ys[1]!).toBeCloseTo(69.41, 1);
    for (const h of board.mountingHoles) expect(h.diameter).toBeCloseTo(2);
  });

  it('the bosses sit in the side rims, clear of the frame opening', () => {
    const enc = board.enclosure!;
    const bodyX0 = enc.body.x;
    const bodyX1 = enc.body.x + enc.body.width;
    for (const h of board.mountingHoles) {
      const r = enc.bossDiameter / 2;
      // Each boss must lie entirely outside the rear body's X span — that is
      // what leaves frame material under it once the body's opening is cut.
      const outboard = h.x + r <= bodyX0 + 1e-6 || h.x - r >= bodyX1 - 1e-6;
      expect(outboard).toBe(true);
    }
  });
});

describe('desk stand geometry', () => {
  const board = getBuiltinBoard('guition-jc4880p443c')!;

  it('emits a single fused stand part instead of shell + lid', () => {
    const project = findTemplate('guition-desk-stand')!.build();
    const plan = compileProject(project);
    expect(plan.nodes.map((n) => n.id)).toEqual(['stand']);
  });

  it('stands on the desk and leans back by the tilt angle', () => {
    const op = buildStandOp(board, STAND)!;
    const b = aabbOfOp(op)!;
    // Sits on the table: bottom face at z = 0.
    expect(b.min[2]).toBeCloseTo(0, 3);
    // Full module width, nothing hanging off the sides.
    expect(b.min[0]).toBeGreaterThanOrEqual(-0.01);
    expect(b.max[0]).toBeCloseTo(117.01, 1);
    // Height ≈ foot + frame standing at (90 - 15)°.
    const d = computeStandDims(board, STAND);
    expect(b.max[2]).toBeCloseTo(d.outerZ, 0);
    // Leaning back 15° puts the frame's top ~18mm behind its toe; the foot is
    // deep enough to keep the centre of mass over the base.
    expect(b.max[1]).toBeGreaterThan(50);
  });

  it('trims everything forward of the frame face, so the front beds flat', () => {
    // Printed face down: the frame's front plane must be the extreme front
    // surface. The foot's front lip is VERTICAL while the frame leans back, so
    // untrimmed it stands ~frameThickness·sin(tilt) ≈ 2.6 mm proud and the part
    // rocks on it. buildStandOp subtracts the half-space in front of that plane.
    // The boolean only resolves at mesh time, so assert it structurally here;
    // the flushness itself is measured on the exported mesh (see the STL check).
    const op = buildStandOp(board, STAND)!;
    expect(op.kind).toBe('difference');
    const cutter = (op as { children: { kind: string }[] }).children[1]!;
    // The cutter is the tilted half-space: translate(rotate(translate(cube))).
    expect(cutter.kind).toBe('translate');
    const rot = (cutter as unknown as { child: { kind: string; degrees: number[] } }).child;
    expect(rot.kind).toBe('rotate');
    expect(rot.degrees[0]).toBeCloseTo(90 - STAND.tiltAngleDeg, 5);
  });

  it('the three soft buttons are modelled as edge protrusions', () => {
    const enc = board.enclosure!;
    const btns = enc.edgeProtrusions ?? [];
    expect(btns.length).toBe(3);
    for (const b of btns) {
      expect(b.edge).toBe('-y'); // all on the bottom edge, with the SD slot
      expect(b.depth).toBeCloseTo(1.5); // measured off the vendor drawing
      expect(b.to - b.from).toBeGreaterThan(3); // ~3.2mm wide
    }
  });

  it('WITHOUT a channel the frame would clamp the buttons — regression guard', () => {
    // This is the bug the printed part had. The opening hugs the rear body, so
    // its edge lands at (body.y - openingClearance) = 1.775, while the buttons
    // reach out to (body.y - 1.5) = 0.675. The frame overlapped them by ~1.1mm
    // and held them pressed. Pin the arithmetic so nobody "tidies" the channel
    // away without noticing.
    const enc = board.enclosure!;
    const openingEdge = enc.body.y - STAND.openingClearance;
    const buttonTip = enc.body.y - enc.edgeProtrusions![0]!.depth;
    expect(buttonTip).toBeLessThan(openingEdge); // i.e. the button is INSIDE the frame material
  });

  it('cuts a full-thickness channel per button, at the MIRRORED x', () => {
    // The frame's x is a mirror of the board's back-view x — the module seats
    // face-to-face against it (see mirrorX). The bosses and the rear body are
    // symmetric so they hide this; the buttons are not. Cut them un-mirrored and
    // the middle button gets no channel at all and stays fully clamped — which
    // is exactly the bug this test exists to prevent.
    const enc = board.enclosure!;
    const T = STAND.frameThickness;
    const W = board.pcb.size.x;
    const H = board.pcb.size.y;
    const channels = buildEdgeChannels(board, STAND, W, H, T).map((c) => aabbOfOp(c)!);
    expect(channels.length).toBe(3);
    for (const b of enc.edgeProtrusions!) {
      // Where the button PHYSICALLY lands on the frame.
      const fx0 = W - b.to;
      const fx1 = W - b.from;
      const tipY = enc.body.y - b.depth;
      const hit = channels.find(
        (bx) =>
          bx.min[0] <= fx0 - 1 && // slack along the edge, both sides
          bx.max[0] >= fx1 + 1 &&
          bx.min[1] < tipY - 0.4 && // reaches past the button's tip
          bx.max[1] >= enc.body.y && // opens into the frame's opening
          bx.min[2] <= 0 &&
          bx.max[2] >= T, // through the FULL thickness — the insertion path
      );
      expect(hit, `no full-depth channel at the mirrored x for ${b.id}`).toBeDefined();
    }
    // And explicitly: nothing sits at the UN-mirrored x of the lone button —
    // proving we didn't just widen everything until both sides pass.
    const lone = enc.edgeProtrusions!.find((b) => b.from > 90)!;
    const wrongSide = channels.find(
      (bx) => bx.min[0] <= lone.from && bx.max[0] >= lone.to && bx.min[1] < 1,
    );
    expect(wrongSide, 'a channel was cut on the un-mirrored side').toBeUndefined();
  });

  it('the module placement puts the flange on the frame face, screen out', () => {
    // Use the SHIPPED params, not the fixture: the 10 mm frame is what actually
    // swallows the 9 mm rear body (an 8 mm frame would let it poke out the back).
    const shipped = findTemplate('guition-desk-stand')!.build().case.stand!;
    const p = standModulePlacement(board, shipped)!;
    const enc = board.enclosure!;
    // Ry(180) negates z, so board z=flangeThickness must land on frame z=T.
    const flangeRearZ = p.frameOffset[2] - enc.flangeThickness;
    expect(flangeRearZ).toBeCloseTo(shipped.frameThickness, 5);
    // ...and the rear body's back face lands inside the frame, not through it.
    const bodyBackZ = p.frameOffset[2] - board.pcb.size.z;
    expect(bodyBackZ).toBeGreaterThan(0);
    expect(bodyBackZ).toBeLessThan(shipped.frameThickness);
    // The desk frame is tilted; the wall frame is not.
    expect(p.rotXDeg).toBeCloseTo(90 - shipped.tiltAngleDeg, 5);
    expect(standModulePlacement(board, findTemplate('guition-wall-mount')!.build().case.stand!)!.rotXDeg).toBe(0);
  });

  it('a bare PCB (no enclosure block) yields no stand', () => {
    const bare = getBuiltinBoard('rpi-4b')!;
    expect(bare.enclosure).toBeUndefined();
    expect(buildStandOp(bare, STAND)).toBeNull();
  });

  it('falls back to the normal shell when the board is not an enclosure module', () => {
    const project = findTemplate('pi-server-tray')!.build();
    project.case.stand = { ...STAND };
    const plan = compileProject(project);
    // rpi-4b has no `enclosure`, so we must not emit an empty viewport.
    expect(plan.nodes.map((n) => n.id)).toContain('shell');
    expect(plan.nodes.map((n) => n.id)).toContain('lid');
  });

  it('the frame is thick enough to swallow the bosses and still land the screws', () => {
    const enc = board.enclosure!;
    const project = findTemplate('guition-desk-stand')!.build();
    const s = project.case.stand!;
    // Stack-up behind each boss: pocket (bossHeight + 0.2) + head counterbore
    // (1.5) must leave a real bearing land under the screw head, or the head
    // pulls straight through the frame.
    const land = s.frameThickness - (enc.bossHeight + 0.2) - 1.5;
    expect(land).toBeGreaterThanOrEqual(2.5);
    // Clearance hole passes an M2 screw without threading on it.
    expect(s.screwHoleDiameter).toBeGreaterThan(2);
  });

  it('the export hardware list calls out the M2 screws into the panel bosses', () => {
    const project = findTemplate('guition-desk-stand')!.build();
    const hw = hardwareForProject(project);
    const screws = hw.find((h) => h.id === 'stand-screws')!;
    expect(screws).toBeDefined();
    expect(screws.count).toBe(4);
    expect(screws.label).toMatch(/^M2 × \d+ mm/);
    // A stand has no lid/gasket/insert hardware to list.
    expect(hw.length).toBe(1);
  });

  it('pick-a-board on the Guition panel applies the stand template', () => {
    expect(findTemplateByBoard('guition-jc4880p443c')?.id).toBe('guition-desk-stand');
  });
});

describe('wall mount', () => {
  const board = getBuiltinBoard('guition-jc4880p443c')!;
  const project = () => findTemplate('guition-wall-mount')!.build();

  it('emits the two snap-together parts: body + wall plate', () => {
    const plan = compileProject(project());
    expect(plan.nodes.map((n) => n.id)).toEqual(['wall-body', 'wall-plate']);
  });

  it('the shroud walls clear the module\'s rear body — the reason bezelMargin exists', () => {
    const s = project().case.stand!;
    const enc = board.enclosure!;
    // Frame outline is the module + 2×bezelMargin; the shroud eats shroudWall
    // off each side. What's left MUST still pass the module's rear body, or the
    // panel can't seat. The module's own rim is only ~2.2mm top/bottom, so with
    // bezelMargin 0 (the desk stand's value) this would fail.
    const cavH = board.pcb.size.y + 2 * s.bezelMargin - 2 * s.shroudWall!;
    const cavW = board.pcb.size.x + 2 * s.bezelMargin - 2 * s.shroudWall!;
    expect(cavH).toBeGreaterThan(enc.body.height + 1);
    expect(cavW).toBeGreaterThan(enc.body.width + 1);
    // And with a naive margin of 0 it genuinely wouldn't fit — pin the trap.
    expect(board.pcb.size.y - 2 * s.shroudWall!).toBeLessThan(enc.body.height);
  });

  it('the shroud is deep enough for a USB-C plug behind the panel', () => {
    const s = project().case.stand!;
    const enc = board.enclosure!;
    // The module's back face sits (frameThickness - body.depth) forward of the
    // frame's back plane, so plug clearance = shroudDepth + that.
    const clearance = s.shroudDepth! + (s.frameThickness - enc.body.depth);
    expect(clearance).toBeGreaterThan(20); // a USB-C plug body is ~12mm + bend
  });

  it('the snap fingers fit inside the shroud cavity depth', () => {
    const s = project().case.stand!;
    const fingerReach = s.plateThickness! + 12; // plate + FINGER_H
    expect(fingerReach).toBeLessThan(s.shroudDepth!);
  });

  it('both wall parts are grounded at z=0 (they meet at the wall plane)', () => {
    const plan = compileProject(project());
    for (const n of plan.nodes) {
      const bb = aabbOfOp(n.op)!;
      expect(bb.min[2]).toBeCloseTo(0, 3);
    }
  });

  it('the export hardware list calls out the drywall screws AND the M2s', () => {
    const hw = hardwareForProject(project());
    expect(hw.find((h) => h.id === 'stand-screws')?.count).toBe(4);
    const wall = hw.find((h) => h.id === 'wall-plate-screws')!;
    expect(wall).toBeDefined();
    expect(wall.count).toBe(2);
    expect(wall.label).toMatch(/drywall/i);
  });

  it('the desk stand does NOT list drywall screws', () => {
    const hw = hardwareForProject(findTemplate('guition-desk-stand')!.build());
    expect(hw.find((h) => h.id === 'wall-plate-screws')).toBeUndefined();
  });
});

describe('U7 Pro Outdoor slider bench stand', () => {
  const board = getBuiltinBoard('ubiquiti-u7-pro-outdoor')!;
  const project = () => findTemplate('u7-pro-outdoor-desk-stand')!.build();
  const stand = () => project().case.stand!;

  it('device outline matches the official tech specs (the only published dims)', () => {
    // 170 x 208 x 66.5 mm / 1.2 kg — techspecs.ui.com. The channel dims are
    // NOT published anywhere; they are estimates awaiting caliper verification.
    expect(board.pcb.size.x).toBeCloseTo(170);
    expect(board.pcb.size.y).toBeCloseTo(208);
    expect(board.pcb.size.z).toBeCloseTo(66.5);
    const enc = board.enclosure!;
    expect(enc.flangeThickness + enc.body.depth).toBeCloseTo(board.pcb.size.z, 5);
  });

  it('the channel is geometrically coherent: lips narrower than the cavity, shallower than the floor', () => {
    const ch = board.enclosure!.sliderChannel!;
    expect(ch.throatWidth).toBeLessThan(ch.cavityWidth);
    expect(ch.lipDepth).toBeLessThan(ch.totalDepth);
    expect(ch.length).toBeLessThan(ch.topFromDeviceBottom); // channel fits on the back
    expect(ch.topFromDeviceBottom).toBeLessThan(board.pcb.size.y);
  });

  it('emits a single fused stand part', () => {
    const plan = compileProject(project());
    expect(plan.nodes.map((n) => n.id)).toEqual(['stand']);
  });

  it('stands on the desk, grounded at z = 0', () => {
    const op = buildSliderStandOp(board, stand())!;
    const b = aabbOfOp(op)!;
    expect(b.min[2]).toBeCloseTo(0, 3);
    expect(b.min[0]).toBeGreaterThanOrEqual(-0.01);
    expect(b.min[1]).toBeGreaterThanOrEqual(-0.01);
  });

  it('the male T-profile clears every channel surface by the design fits', () => {
    const s = stand();
    const d = computeSliderDims(board, s)!;
    const ch = board.enclosure!.sliderChannel!;
    // Lateral: throat through the lip opening, wings inside the cavity.
    expect(ch.throatWidth - d.throatW).toBeCloseTo(2 * s.openingClearance, 5);
    expect(ch.cavityWidth - d.wingW).toBeCloseTo(2 * s.openingClearance, 5);
    // Axial: wings sit behind the lips and stop short of the channel floor.
    expect(d.protrusion).toBeLessThanOrEqual(ch.totalDepth - 0.29);
    expect(d.wingT).toBeGreaterThan(0.8); // still a printable locking wing
    // The bracket is shorter than the channel, so the top end-stop seats.
    expect(d.engagement).toBeLessThan(ch.length);
    expect(d.engagement).toBeGreaterThan(50); // leverage against wobble
  });

  it('the 208 mm device hangs clear of the foot — the column is sized from topFromDeviceBottom', () => {
    const s = stand();
    const d = computeSliderDims(board, s)!;
    // Bottom edge floats above the foot's top face...
    expect(d.deviceBottomZ).toBeGreaterThan(s.baseThickness + 4);
    // ...which forces a tall column: this is the trap the reference OpenSCAD
    // fell into (75 mm column ⇒ the AP's lower half hits the base plate).
    expect(d.colH).toBeGreaterThan(board.enclosure!.sliderChannel!.topFromDeviceBottom);
  });

  it('the foot out-reaches the leaning device, front and back', () => {
    const s = stand();
    const d = computeSliderDims(board, s)!;
    const t = (s.tiltAngleDeg * Math.PI) / 180;
    const enc = board.enclosure!;
    const devD = enc.flangeThickness + enc.body.depth;
    const yDevBot = d.colH - enc.sliderChannel!.topFromDeviceBottom;
    // Device bottom-front corner, in world y (same math as the compiler).
    const S = d.TyCol - d.colT * Math.cos(t);
    const frontCorner = S + yDevBot * Math.sin(t) - devD * Math.cos(t);
    expect(frontCorner).toBeGreaterThanOrEqual(25); // anti-tip reserve
    // Column's top-back corner stays inside the foot.
    expect(d.TyCol + d.colH * Math.sin(t)).toBeLessThan(d.baseDepth - 8);
    // And the foot is wide enough to resist sideways tipping of a 170 mm AP.
    expect(d.footW).toBeGreaterThanOrEqual(0.75 * board.pcb.size.x);
  });

  it('needs no hardware — gravity is the retention', () => {
    expect(hardwareForProject(project())).toEqual([]);
  });

  it('the module placement hangs the device on the tilted column', () => {
    const p = standModulePlacement(board, stand())!;
    expect(p.rotXDeg).toBeCloseTo(90 - stand().tiltAngleDeg, 5);
    // Ry(180) negates z, so the device's back (z = 66.5) lands on the column
    // front face (z = colT).
    const d = computeSliderDims(board, stand())!;
    expect(p.frameOffset[2] - board.pcb.size.z).toBeCloseTo(d.colT, 5);
  });

  it('pick-a-board on the U7 Pro Outdoor applies the bench-stand template', () => {
    expect(findTemplateByBoard('ubiquiti-u7-pro-outdoor')?.id).toBe('u7-pro-outdoor-desk-stand');
  });

  it('a board without a sliderChannel cannot build a slider stand', () => {
    const guition = getBuiltinBoard('guition-jc4880p443c')!;
    expect(buildSliderStandOp(guition, stand())).toBeNull();
  });
});
