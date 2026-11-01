// Issue #854 item 2 — REGISTRATION: the lid's ridge and the floor's groove.
//
// The connector RETAINS; registration only squares a stack. These specs run the
// real evaluator: the ridge exists on the lid's top at the case's wall band,
// the floor's underside carries a groove wider by the clearance, and two
// matching cases stack with the ridge inside the groove and no interference.

import { describe, it, expect } from 'vitest';

import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { computeLidDims } from '@/engine/compiler/lid';
import {
  STACK_RIDGE_INSET,
  STACK_RIDGE_W,
  stackGrooveDepth,
  stackRidgeHeight,
} from '@/engine/compiler/stackRegister';
import { intersection, translate, cube, type BuildOp } from '@/engine/compiler/buildPlan';
import { createDefaultProject } from '@/store/projectStore';
import type { CaseParameters, Project } from '@/types';
import { exec } from './helpers/manifoldExec';

const BOARD_ID = 'rpi-4b';

function project(register: boolean): Project {
  const base = createDefaultProject(BOARD_ID);
  return {
    ...base,
    case: {
      ...base.case,
      stackConnector: { sockets: [], key: 'short', keys: 0, ...(register ? { register: true } : {}) },
    } as CaseParameters,
  };
}

function nodeOp(p: Project, id: string): BuildOp {
  const plan = compileProject(p);
  const node = plan.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`${id} not in the plan`);
  return node.op;
}

function volume(op: BuildOp): number {
  const m = exec(op);
  const v = m.volume();
  m.delete();
  return v;
}

function probeMaterial(op: BuildOp, p: [number, number, number]): number {
  const box = translate(p, cube([1, 1, 1], true));
  const hit = exec(intersection([op, box]));
  const v = hit.volume();
  hit.delete();
  return v;
}

/** The case's own dims for the rpi-4b default, as the compiler computes them. */
function frame(): {
  outerX: number;
  outerY: number;
  wall: number;
  floor: number;
  lidTopZ: number;
  ringMidX: number;
} {
  const base = createDefaultProject(BOARD_ID);
  const dims = computeShellDims(base.board, base.case, [], () => undefined);
  const lid = computeLidDims(base.board, base.case);
  return {
    outerX: dims.outerX,
    outerY: dims.outerY,
    wall: base.case.wallThickness,
    floor: base.case.floorThickness,
    lidTopZ: lid.zPosition + lid.z,
    ringMidX: base.case.wallThickness + STACK_RIDGE_INSET + STACK_RIDGE_W / 2,
  };
}

describe('#854 — registration, separate from retention', () => {
  it('cuts nothing when the option is off', () => {
    expect(nodeOp(project(false), 'lid')).toBeDefined();
    // The option is what adds the ridge: the lid gains volume with it on.
    const off = volume(nodeOp(project(false), 'lid'));
    const on = volume(nodeOp(project(true), 'lid'));
    expect(on).toBeGreaterThan(off);
  });

  it('the ridge stands on the lid’s top at the wall band, inside the wall', () => {
    const f = frame();
    const lid = nodeOp(project(true), 'lid');
    const h = stackRidgeHeight(f.floor);
    const y = f.outerY / 2;
    // Material at the ring's mid-thickness, above the lid's top face...
    expect(probeMaterial(lid, [f.ringMidX, y, f.lidTopZ + h / 2])).toBeGreaterThan(0.5);
    // ...void inside the ring (it is a ring, not a slab)...
    const inner = f.wall + STACK_RIDGE_INSET + STACK_RIDGE_W + 3;
    expect(probeMaterial(lid, [inner, y, f.lidTopZ + h / 2])).toBeLessThan(0.02);
    // ...and nothing above the ridge's own height.
    expect(probeMaterial(lid, [f.ringMidX, y, f.lidTopZ + h + 1])).toBeLessThan(0.02);
  });

  it('the floor’s underside carries a groove wider than the ridge by the clearance', () => {
    const f = frame();
    const shell = nodeOp(project(true), 'shell');
    const depth = stackGrooveDepth(f.floor);
    const y = f.outerY / 2;
    // Void in the floor at the ring position (the groove) across its width —
    // the ridge plus the clearance each side (the 1 mm probe stays inside the
    // 2.0 mm channel).
    for (const x of [f.ringMidX - 0.4, f.ringMidX, f.ringMidX + 0.4]) {
      expect(probeMaterial(shell, [x, y, depth / 2]), `groove at ${x}`).toBeLessThan(0.02);
    }
    // Solid just inside the groove's inner wall: the groove is a ring, not a
    // hollowed floor.
    const inner = f.wall + STACK_RIDGE_INSET + STACK_RIDGE_W + 4;
    expect(probeMaterial(shell, [inner, y, depth / 2])).toBeGreaterThan(0.5);
  });

  it('two matching cases stack: the ridge enters the groove without interference', () => {
    const f = frame();
    const lid = nodeOp(project(true), 'lid');
    // The upper case sits ON the lower lid's top face.
    const upperShell = translate([0, 0, f.lidTopZ], nodeOp(project(true), 'shell'));
    const clash = volume(intersection([lid, upperShell]));
    expect(clash).toBeLessThan(1e-3);
    // The ridge itself does sit inside the groove — probe the upper shell's
    // groove at the ridge's height: the lid's material is there, the shell's
    // is not.
    const y = f.outerY / 2;
    const h = stackRidgeHeight(f.floor);
    expect(probeMaterial(lid, [f.ringMidX, y, f.lidTopZ + h / 2])).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// #854 item 3 — the toolbox archetype uses the same connector.
// ---------------------------------------------------------------------------

import { findTemplate } from '@/library/templates';
import { TOOLBOX_BIN_NODE_ID } from '@/engine/compiler/toolbox';

describe('#854 — the toolbox module joins through the same connector', () => {
  const toolboxWith = (connector: CaseParameters['stackConnector']) => {
    const p = findTemplate('toolbox')!.build();
    return { ...p, case: { ...p.case, stackConnector: connector } };
  };

  it('cuts sockets on the bin’s own walls and exports the keys', () => {
    const plain = compileProject(toolboxWith(undefined));
    const wired = compileProject(
      toolboxWith({ sockets: [{ face: '+y', offset: 0 }], key: 'short', keys: 1 }),
    );
    const ids = wired.nodes.map((n) => n.id);
    // The key is its own print, as with the case.
    expect(ids).toContain('stack-key-1');
    // The socket reaches the BIN (its walls are the module's outside)…
    const binOf = (plan: ReturnType<typeof compileProject>) =>
      plan.nodes.find((n) => n.id === TOOLBOX_BIN_NODE_ID)!.op;
    expect(volume(binOf(wired))).not.toBeCloseTo(volume(binOf(plain)), 1);
    // …and the report feeds the same connector section.
    expect(wired.connector?.sockets).toHaveLength(1);
    expect(plain.connector).toBeUndefined();
    expect(plain.nodes.some((n) => n.id.startsWith('stack-key-'))).toBe(false);
  });
});
