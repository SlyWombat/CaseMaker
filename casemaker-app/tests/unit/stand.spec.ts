import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { buildStandOp, computeStandDims } from '@/engine/compiler/stand';
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
