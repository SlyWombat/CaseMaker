import { describe, it, expect } from 'vitest';
import { buildHingeOps } from '@/engine/compiler/hinges';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { bboxOfOp } from '@/engine/compiler/connectivity';
import { parseProject, serializeProject } from '@/store/persistence';
import type { BoardProfile, CaseParameters, HingeFeature } from '@/types';
import type { BuildOp } from '@/engine/compiler/buildPlan';

function countOps(op: BuildOp, kind: BuildOp['kind']): number {
  let n = op.kind === kind ? 1 : 0;
  if ('child' in op && op.child) n += countOps(op.child, kind);
  if ('children' in op) for (const c of op.children) n += countOps(c, kind);
  return n;
}

function makeBoard(x: number, y: number): BoardProfile {
  return {
    id: `t-${x}x${y}`,
    name: 'T',
    manufacturer: 'T',
    pcb: { size: { x, y, z: 1.6 } },
    mountingHoles: [{ id: 'h1', x: 5, y: 5, diameter: 2.5 }],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 10,
    source: 'https://example.com',
    builtin: false,
  };
}

const baseCase: CaseParameters = {
  wallThickness: 2,
  floorThickness: 2,
  lidThickness: 2,
  cornerRadius: 0,
  internalClearance: 0.5,
  zClearance: 10,
  joint: 'flat-lid',
  ventilation: { enabled: false, pattern: 'none', coverage: 0 },
  bosses: { enabled: true, insertType: 'none', outerDiameter: 5, holeDiameter: 2.5 },
};

function defaultHinge(overrides: Partial<HingeFeature> = {}): HingeFeature {
  return {
    id: 'hinge-1',
    style: 'external-pin',
    face: '-y',
    numKnuckles: 5,
    knuckleOuterDiameter: 8,
    pinDiameter: 3,
    knuckleClearance: 0.4,
    positioning: 'centered',
    hingeLength: 60,
    pinMode: 'separate',
    enabled: true,
    ...overrides,
  };
}

describe('Issue #92 — barrel-hinge geometry compiler', () => {
  it('disabled hinge produces no ops', () => {
    const board = makeBoard(80, 60);
    const hinge = defaultHinge({ enabled: false });
    const ops = buildHingeOps(hinge, board, baseCase);
    expect(ops.caseAdditive).toHaveLength(0);
    expect(ops.lidAdditive).toHaveLength(0);
    expect(ops.subtractive).toHaveLength(0);
  });

  it('omitted hinge produces no ops', () => {
    const board = makeBoard(80, 60);
    const ops = buildHingeOps(undefined, board, baseCase);
    expect(ops.caseAdditive).toHaveLength(0);
    expect(ops.lidAdditive).toHaveLength(0);
    expect(ops.subtractive).toHaveLength(0);
  });

  it('emits N knuckles split between case (even idx) and lid (odd idx) — N=5 → 3 case + 2 lid', () => {
    const board = makeBoard(80, 60);
    const hinge = defaultHinge({ numKnuckles: 5, style: 'external-pin' });
    const ops = buildHingeOps(hinge, board, baseCase);
    // External-pin mode: 3 case knuckles, no extra pin solid.
    expect(ops.caseAdditive.length).toBe(3);
    // Lid knuckles are pre-drilled (knuckle - through-hole) but each is
    // one entry in lidAdditive.
    expect(ops.lidAdditive.length).toBe(2);
    expect(ops.subtractive.length).toBe(1);
  });

  it('numKnuckles=7 → 4 case + 3 lid knuckles', () => {
    const board = makeBoard(120, 80);
    const hinge = defaultHinge({ numKnuckles: 7, hingeLength: 100 });
    const ops = buildHingeOps(hinge, board, baseCase);
    expect(ops.caseAdditive.length).toBe(4);
    expect(ops.lidAdditive.length).toBe(3);
  });

  it('print-in-place style emits a separate pin node; external-pin does not', () => {
    const board = makeBoard(80, 60);
    const ext = buildHingeOps(defaultHinge({ style: 'external-pin' }), board, baseCase);
    const pip = buildHingeOps(defaultHinge({ style: 'print-in-place' }), board, baseCase);
    // External-pin: no pin node, no extra case additives beyond knuckles.
    expect(ext.pinNode).toBeNull();
    expect(ext.caseAdditive.length).toBe(pip.caseAdditive.length);
    // Print-in-place: pin lives as its own node so the shell's through-hole
    // cutout doesn't drill it out — see HingeOps.pinNode docstring.
    expect(pip.pinNode).not.toBeNull();
    // Pin radius is pinDiameter/2 - knuckleClearance/2 = 1.5 - 0.2 = 1.3.
    let cur: BuildOp = pip.pinNode!;
    while (cur.kind === 'translate' || cur.kind === 'rotate') cur = cur.child;
    expect(cur.kind).toBe('cylinder');
    if (cur.kind === 'cylinder') {
      expect(cur.radiusLow).toBeCloseTo(1.3, 3);
      expect(cur.height).toBeCloseTo(60, 3);
    }
  });

  it('compileProject emits a separate hinge-pin node for print-in-place style only', () => {
    const projectExt = createDefaultProject('rpi-4b');
    projectExt.case.joint = 'flat-lid';
    projectExt.case.hinge = defaultHinge({ style: 'external-pin' });
    const planExt = compileProject(projectExt);
    expect(planExt.nodes.find((n) => n.id === 'hinge-pin')).toBeUndefined();

    const projectPip = createDefaultProject('rpi-4b');
    projectPip.case.joint = 'flat-lid';
    projectPip.case.hinge = defaultHinge({ style: 'print-in-place' });
    const planPip = compileProject(projectPip);
    const pinNode = planPip.nodes.find((n) => n.id === 'hinge-pin');
    expect(pinNode).toBeDefined();
    // Pin bbox: cylinder length = hingeLength = 60 mm along the face's u
    // (world X for ±y faces). Radius = 1.3 mm. The bbox helper conservatively
    // expands rotated cylinders to an L∞ envelope, but the volume must be
    // non-degenerate.
    const bb = bboxOfOp(pinNode!.op)!;
    const dx = bb.max[0] - bb.min[0];
    const dy = bb.max[1] - bb.min[1];
    const dz = bb.max[2] - bb.min[2];
    // At least the pin diameter on every axis (the bbox helper for rotated
    // cylinders is conservative; we just need a non-zero solid).
    expect(dx).toBeGreaterThan(2);
    expect(dy).toBeGreaterThan(2);
    expect(dz).toBeGreaterThan(2);
  });

  it('through-hole subtractive cylinder length spans hingeLength + 1 mm overshoot', () => {
    const board = makeBoard(80, 60);
    const hinge = defaultHinge({ hingeLength: 60 });
    const ops = buildHingeOps(hinge, board, baseCase);
    // The subtractive op is translate(rotate(cylinder)). Walk to the cylinder.
    let cur: BuildOp = ops.subtractive[0]!;
    while (cur.kind === 'translate' || cur.kind === 'rotate') cur = cur.child;
    expect(cur.kind).toBe('cylinder');
    if (cur.kind === 'cylinder') {
      expect(cur.height).toBeCloseTo(61, 3);
      expect(cur.radiusLow).toBeCloseTo(3 / 2 + 0.1, 3);
    }
  });

  it('compiled shell bbox grows past the case envelope on the hinge face', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'flat-lid';
    project.case.hinge = defaultHinge({ face: '-y' });
    const baseDims = computeShellDims(
      project.board,
      project.case,
      project.hats,
      () => undefined,
    );
    const plan = compileProject(project);
    const shell = plan.nodes.find((n) => n.id === 'shell')!;
    const bb = bboxOfOp(shell.op)!;
    // -y hinge → bbox.min.y should drop below 0 by at least knuckleR (~4 mm
    // for default 8 mm knuckle Ø, minus a small tolerance for difference of
    // bbox vs visible mesh).
    expect(bb.min[1]).toBeLessThan(0);
    expect(bb.min[1]).toBeLessThanOrEqual(-3.5);
    // Outer envelope Y was [0, outerY]; bbox should extend a bit past 0.
    expect(baseDims.outerY).toBeGreaterThan(0);
  });

  it('+y face hinge: bbox grows in +y past outerY', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'flat-lid';
    project.case.hinge = defaultHinge({ face: '+y' });
    const dims = computeShellDims(
      project.board,
      project.case,
      project.hats,
      () => undefined,
    );
    const plan = compileProject(project);
    const shell = plan.nodes.find((n) => n.id === 'shell')!;
    const bb = bboxOfOp(shell.op)!;
    expect(bb.max[1]).toBeGreaterThan(dims.outerY);
    expect(bb.max[1] - dims.outerY).toBeGreaterThanOrEqual(3.5);
  });

  it('-x face hinge: bbox grows in -x', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'flat-lid';
    project.case.hinge = defaultHinge({ face: '-x' });
    const plan = compileProject(project);
    const shell = plan.nodes.find((n) => n.id === 'shell')!;
    const bb = bboxOfOp(shell.op)!;
    expect(bb.min[0]).toBeLessThan(0);
  });

  it('+x face hinge: bbox grows in +x', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'flat-lid';
    project.case.hinge = defaultHinge({ face: '+x' });
    const dims = computeShellDims(
      project.board,
      project.case,
      project.hats,
      () => undefined,
    );
    const plan = compileProject(project);
    const shell = plan.nodes.find((n) => n.id === 'shell')!;
    const bb = bboxOfOp(shell.op)!;
    expect(bb.max[0]).toBeGreaterThan(dims.outerX);
  });

  it('compiled lid op contains hinge knuckles', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'flat-lid';
    project.case.hinge = defaultHinge({ face: '-y', numKnuckles: 5 });
    const plan = compileProject(project);
    const lid = plan.nodes.find((n) => n.id === 'lid')!;
    // Expect at least 2 cylinders in the lid op for the lid knuckles
    // (numKnuckles=5 → 2 lid knuckles). The lid plate itself is a roundedRect
    // or cube, so the cylinder count is dominated by hinge knuckles + their
    // through-holes.
    const cylCount = countOps(lid.op, 'cylinder');
    expect(cylCount).toBeGreaterThanOrEqual(2);
  });
});

describe('Issue #110 — protective-case hinge styles', () => {
  function defaultHinge(style: HingeFeature['style']): HingeFeature {
    return {
      id: 'h-test',
      style,
      face: '-y',
      numKnuckles: 5,
      knuckleOuterDiameter: 8,
      pinDiameter: 3,
      knuckleClearance: 0.4,
      positioning: 'centered',
      hingeLength: 80,
      pinMode: 'separate',
      enabled: true,
    };
  }

  it('piano-continuous derives many tightly-spaced knuckles from hingeLength', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = {
      ...project.case,
      hinge: defaultHinge('piano-continuous'),
    };
    const ops = buildHingeOps(params.hinge!, project.board, params, project.hats ?? [], () => undefined);
    // hingeLength=80, knuckleOD=8, clearance=0.4 → pitch≈8.4 → ~9 knuckles.
    // Forced odd, ≥5. We assert it's at least 7 (much more than the user's 5).
    const cylCount = countOps(
      { kind: 'union', children: [...ops.caseAdditive, ...ops.lidAdditive] },
      'cylinder',
    );
    expect(cylCount).toBeGreaterThanOrEqual(7);
  });

  it('pip-pivot emits no centerline pin even with pinMode = print-in-place', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = {
      ...project.case,
      hinge: { ...defaultHinge('pip-pivot'), pinMode: 'print-in-place' },
    };
    const ops = buildHingeOps(params.hinge!, project.board, params, project.hats ?? [], () => undefined);
    expect(ops.pinNode).toBeNull();
  });

  it('all three new styles compile through compileProject without errors', () => {
    const project = createDefaultProject('rpi-4b');
    for (const style of ['piano-continuous', 'piano-segmented', 'pip-pivot'] as const) {
      const sealedProject = {
        ...project,
        case: { ...project.case, hinge: defaultHinge(style) },
      };
      const plan = compileProject(sealedProject);
      expect(plan.nodes.find((n) => n.id === 'shell')).toBeDefined();
      expect(plan.nodes.find((n) => n.id === 'lid')).toBeDefined();
    }
  });
});

describe('Issue #92 — schema migration v6 → v7', () => {
  it('createDefaultProject stamps schemaVersion: 7 with hinge undefined', () => {
    const p = createDefaultProject('rpi-4b');
    expect(p.schemaVersion).toBe(7);
    expect(p.case.hinge).toBeUndefined();
  });

  it('a v6-shaped project on disk loads, stamps schemaVersion: 7, and has hinge undefined', () => {
    const v6 = { ...createDefaultProject('rpi-4b'), schemaVersion: 6 };
    const text = JSON.stringify(v6);
    const parsed = parseProject(text);
    expect(parsed.schemaVersion).toBe(7);
    expect(parsed.case.hinge).toBeUndefined();
  });

  it('a v7 project with hinge round-trips through serialize/parse', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.hinge = {
      id: 'h1',
      style: 'print-in-place',
      face: '-y',
      numKnuckles: 5,
      knuckleOuterDiameter: 8,
      pinDiameter: 3,
      knuckleClearance: 0.4,
      positioning: 'centered',
      hingeLength: 60,
      pinMode: 'print-in-place',
      enabled: true,
    };
    const round = parseProject(serializeProject(project));
    expect(round.case.hinge).toEqual(project.case.hinge);
  });
});
