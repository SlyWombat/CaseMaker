import { describe, it, expect } from 'vitest';
import { buildHingeOps, HARDWARE_SCREW } from '@/engine/compiler/hinges';
import { FASTENERS } from '@/engine/compiler/fasteners';
import { hardwareForProject } from '@/engine/exporters/hardwareList';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { bboxOfOp } from '@/engine/compiler/connectivity';
import { parseProject, serializeProject } from '@/store/persistence';
import { computeLidDims } from '@/engine/compiler/lid';
import { exec } from './helpers/manifoldExec';
import type { BoardProfile, CaseParameters, HingeFeature } from '@/types';
import type { BuildOp } from '@/engine/compiler/buildPlan';

function countOps(op: BuildOp, kind: BuildOp['kind']): number {
  let n = op.kind === kind ? 1 : 0;
  if ('child' in op && op.child) n += countOps(op.child, kind);
  if ('children' in op) for (const c of op.children) n += countOps(c, kind);
  return n;
}

/** Walk down the single-subtree spine of an op to its bottom solid. */
function bottom(op: BuildOp): BuildOp {
  let cur: BuildOp = op;
  for (;;) {
    if (cur.kind === 'difference') cur = cur.children[0]!;
    else if (cur.kind === 'translate' || cur.kind === 'rotate') cur = cur.child;
    else return cur;
  }
}

/** The knuckles in a list that also carries their fairing cubes — #121 on the
 *  lid side, #263 on the case side — in list order. */
function knuckleOps(ops: BuildOp[]): BuildOp[] {
  return ops.filter((op) => bottom(op).kind === 'cylinder');
}

/** The world placement of an op's bottom solid, the same walk `bottom` does. */
function offsetOf(op: BuildOp): [number, number, number] {
  let cur: BuildOp = op;
  for (;;) {
    if (cur.kind === 'translate') return cur.offset;
    if (cur.kind === 'difference') cur = cur.children[0]!;
    else if (cur.kind === 'rotate') cur = cur.child;
    else throw new Error(`no placement under ${cur.kind}`);
  }
}

/** Positive-volume bodies in a solid. `decompose()` also reports sealed voids
 *  (negative volume), which are not printed parts (see Manifold component notes). */
function bodies(op: BuildOp): number {
  const m = exec(op);
  const n = m.decompose().filter((c) => c.volume() > 0).length;
  m.delete();
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
    // Issue #263 — each case knuckle now emits TWO entries: the knuckle plus a
    // fairing tab that ties it to the wall (the case-side mirror of #121).
    expect(knuckleOps(ops.caseAdditive).length).toBe(3);
    expect(ops.caseAdditive.length).toBe(3 * 2);
    // Issue #121 — each lid knuckle now emits TWO entries: the
    // pre-drilled cylinder + a fairing-tab cube that bridges it to the
    // lid plate. So 2 lid knuckles → 4 lidAdditive entries.
    expect(ops.lidAdditive.length).toBe(2 * 2);
    expect(ops.subtractive.length).toBe(1);
  });

  it('numKnuckles=7 → 4 case + 3 lid knuckles (each lid knuckle adds knuckle+fairing)', () => {
    const board = makeBoard(120, 80);
    const hinge = defaultHinge({ numKnuckles: 7, hingeLength: 100 });
    const ops = buildHingeOps(hinge, board, baseCase);
    // Issue #263 — 4 case knuckles × (knuckle + fairing) = 8 entries.
    expect(knuckleOps(ops.caseAdditive).length).toBe(4);
    expect(ops.caseAdditive.length).toBe(4 * 2);
    // Issue #121 — 3 lid knuckles × (knuckle + fairing) = 6 entries.
    expect(ops.lidAdditive.length).toBe(3 * 2);
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

describe('Issue #92 — schema migration v6 → v7 (now stamps v8, see #169)', () => {
  it('createDefaultProject stamps schemaVersion: 16 with hinge undefined', () => {
    const p = createDefaultProject('rpi-4b');
    expect(p.schemaVersion).toBe(16);
    expect(p.case.hinge).toBeUndefined();
  });

  it('a v6-shaped project on disk loads, stamps schemaVersion: 16, and has hinge undefined', () => {
    const v6 = { ...createDefaultProject('rpi-4b'), schemaVersion: 6 };
    const text = JSON.stringify(v6);
    const parsed = parseProject(text);
    expect(parsed.schemaVersion).toBe(16);
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

describe('Issue #114 — hardware-screw hinge (two M3 screws, no pin)', () => {
  // The style is built around one screw, so the pair it closes is sized from
  // it: (length − engage − clearance) / 2 knuckles. Keep the arithmetic here so
  // a change to the screw shows up as a failing expectation, not a silent shift.
  const CLEAR = 0.4;
  const KNUCKLE_LEN = (HARDWARE_SCREW.length - HARDWARE_SCREW.engage - CLEAR) / 2;
  const CLUSTER = 2 * KNUCKLE_LEN + CLEAR;
  // Thread-forming pilot in the outer (screw-head-side) knuckle, a running
  // clearance in the inner one — the half of the pair the lid pivots on.
  const PILOT_R = FASTENERS[HARDWARE_SCREW.size].pilotForming / 2;
  const CLEAR_R = FASTENERS[HARDWARE_SCREW.size].clearance.normal / 2;

  function screwHinge(overrides: Partial<HingeFeature> = {}): HingeFeature {
    return defaultHinge({ style: 'hardware-screw', ...overrides });
  }

  function bottomCylinder(op: BuildOp): Extract<BuildOp, { kind: 'cylinder' }> {
    const c = bottom(op);
    if (c.kind !== 'cylinder') throw new Error(`expected a cylinder, got ${c.kind}`);
    return c;
  }

  /** The u-offset (world X on a ±y face) of each op's placement, in list order. */
  function uOffsets(ops: BuildOp[]): number[] {
    return ops.map((op) => offsetOf(op)[0]);
  }

  function dimsFor(board: BoardProfile, hinge: HingeFeature) {
    return computeShellDims(board, { ...baseCase, hinge }, [], () => undefined);
  }

  it('puts one pivot pair at each end of the face, with the middle of the face empty', () => {
    const board = makeBoard(100, 80);
    const hinge = screwHinge();
    const ops = buildHingeOps(hinge, board, baseCase);
    const faceLen = dimsFor(board, hinge).outerX;
    const us = uOffsets(knuckleOps(ops.caseAdditive));

    expect(us).toHaveLength(2);
    expect(us[0]).toBeCloseTo(0, 6);
    // The second cluster ends flush with the far end of the face.
    expect(us[1]).toBeCloseTo(faceLen - CLUSTER, 6);
    // Nothing of the hinge lives in the middle half of the face — that is the
    // point of the style, and it is where `hingeLength` would have put knuckles.
    for (const u of us) {
      expect(Math.abs(u - faceLen / 2)).toBeGreaterThan(faceLen / 4);
    }
  });

  it('emits four knuckles: two case, two lid, each pair 7.0 mm long for an 8 mm screw', () => {
    const board = makeBoard(100, 80);
    const ops = buildHingeOps(screwHinge(), board, baseCase);
    // Two case knuckles + their fairing cubes (#263).
    expect(knuckleOps(ops.caseAdditive)).toHaveLength(2);
    expect(ops.caseAdditive).toHaveLength(2 * 2);
    // Each lid knuckle is a difference + a fairing cube that ties it to the lid.
    expect(ops.lidAdditive).toHaveLength(2 * 2);
    // Both sides' fairing cubes live beside the knuckles in the same list; take
    // the case knuckles and the first child of each lid difference.
    const knuckles = [
      ...knuckleOps(ops.caseAdditive),
      ...ops.lidAdditive.filter((o) => o.kind === 'difference').map((o) => o.children[0]!),
    ];
    for (const op of knuckles) {
      expect(bottomCylinder(op).height).toBeCloseTo(KNUCKLE_LEN, 6);
    }
    // The two lid knuckles, in order, sit just past their case neighbours.
    const lidUs = uOffsets(ops.lidAdditive.filter((o) => o.kind === 'difference'));
    expect(lidUs[0]).toBeCloseTo(KNUCKLE_LEN + CLEAR, 6);
  });

  it('the two screws share one axis, and each pair gets two bores — pilot outside, clearance inside', () => {
    const board = makeBoard(100, 80);
    const ops = buildHingeOps(screwHinge(), board, baseCase);
    // Exactly two through-holes, not the one long centreline bore.
    expect(ops.subtractive).toHaveLength(2);

    const [left, right] = ops.subtractive;
    // Left pair: the OUTER knuckle (index 0, case) is threaded…
    expect(bottomCylinder(left!).radiusLow).toBeCloseTo(PILOT_R, 6);
    // …and the right pair's outer knuckle is the LID's (index 3), so the case
    // knuckle there (index 2) is the clearance side.
    expect(bottomCylinder(right!).radiusLow).toBeCloseTo(CLEAR_R, 6);

    // The lid knuckles are bored the other way round, and share the axis.
    const lidCyls = ops.lidAdditive
      .filter((o) => o.kind === 'difference')
      .map((o) => bottomCylinder(o.children[1]!));
    expect(lidCyls[0]!.radiusLow).toBeCloseTo(CLEAR_R, 6); // index 1, inner
    expect(lidCyls[1]!.radiusLow).toBeCloseTo(PILOT_R, 6); // index 3, outer

    // Same Y and Z for both bores: one hinge axis, two screws along it.
    const yz = ops.subtractive.map((o) => [offsetOf(o)[1], offsetOf(o)[2]]);
    expect(yz[0]).toEqual(yz[1]);
  });

  it('emits no pin at all, even when pinMode asks for a print-in-place one', () => {
    const board = makeBoard(100, 80);
    const ops = buildHingeOps(screwHinge({ pinMode: 'print-in-place' }), board, baseCase);
    expect(ops.pinNode).toBeNull();
  });

  it('ignores hingeLength and positioning — the screws are what size it', () => {
    const board = makeBoard(100, 80);
    const short = buildHingeOps(
      screwHinge({ hingeLength: 15, positioning: 'continuous' }),
      board,
      baseCase,
    );
    const long = buildHingeOps(
      screwHinge({ hingeLength: 200, positioning: 'centered' }),
      board,
      baseCase,
    );
    expect(uOffsets(knuckleOps(short.caseAdditive))).toEqual(
      uOffsets(knuckleOps(long.caseAdditive)),
    );
  });

  it('keeps two pairs on a face too short to separate them, rather than merging into one boss', () => {
    const board = makeBoard(20, 20);
    const hinge = screwHinge();
    const ops = buildHingeOps(hinge, board, baseCase);
    expect(knuckleOps(ops.caseAdditive)).toHaveLength(2);
    expect(ops.subtractive).toHaveLength(2);
    const us = uOffsets(knuckleOps(ops.caseAdditive));
    // Whether they fit at the ends or fall back to a spread, they stay distinct.
    expect(Math.abs(us[0]! - us[1]!)).toBeGreaterThan(0);
  });

  it('compiles to shell + lid with no hinge-pin node, and no diagnostics', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'flat-lid';
    project.case.hinge = screwHinge();
    const plan = compileProject(project);
    expect(plan.nodes.find((n) => n.id === 'shell')).toBeDefined();
    expect(plan.nodes.find((n) => n.id === 'lid')).toBeDefined();
    expect(plan.nodes.find((n) => n.id === 'hinge-pin')).toBeUndefined();
  });

  it('bills two M3×8 screws and no pin', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.hinge = screwHinge();
    const items = hardwareForProject(project);
    const screws = items.find((i) => i.id === 'hinge-screws');
    expect(screws).toBeDefined();
    expect(screws!.count).toBe(2);
    expect(screws!.label).toContain(`${HARDWARE_SCREW.size} × ${HARDWARE_SCREW.length} mm`);
    // The note must not call out one part as the threaded one: the knuckles alternate
    // case/lid, so the screw at one end is held by the case and the one at the other by
    // the lid (see screwBoreRadius). It says which KNUCKLE is threaded, not which part.
    expect(screws!.note).toContain('outermost knuckle');
    expect(screws!.note).toContain('one screw is held by the case and the other by the lid');
    expect(items.find((i) => i.id === 'hinge-pin')).toBeUndefined();
    // And the other styles still bill a pin, not screws.
    const pip = createDefaultProject('rpi-4b');
    pip.case.hinge = defaultHinge({ style: 'external-pin' });
    const pipItems = hardwareForProject(pip);
    expect(pipItems.find((i) => i.id === 'hinge-pin')).toBeDefined();
    expect(pipItems.find((i) => i.id === 'hinge-screws')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #263 — case-side knuckles attach tangentially and fall off on a
// recessed-lid case.
//
// The knuckle centrelines sit knuckleR out from the outer face, so the
// cylinder's cross-section touches the wall along a LINE, not a volume. On a
// clamshell that line is inside the alignment flange and manifold fuses them;
// on a recessed lid the rim is a thin upstanding band with nothing behind the
// knuckle, and the shell decomposes into a body plus one loose knuckle per case
// position. The first test is the issue's own repro through the production
// evaluator: it printed FOUR parts for a five-knuckle hinge, the lid's share of
// which does not exist in the shell solid at all.
// ---------------------------------------------------------------------------
describe('case knuckles overlap the wall, they do not touch it (#263)', () => {
  const R = 4; // knuckleOuterDiameter 8

  function hinge(over: Partial<HingeFeature> = {}): HingeFeature {
    return {
      id: 'h',
      style: 'external-pin',
      face: '+y',
      numKnuckles: 5,
      knuckleOuterDiameter: 2 * R,
      pinDiameter: 3,
      knuckleClearance: 0.4,
      positioning: 'centered',
      hingeLength: 60,
      pinMode: 'separate',
      enabled: true,
      ...over,
    };
  }

  function recessed(over: Partial<CaseParameters> = {}, h = hinge()): CaseParameters {
    const base = createDefaultProject('rpi-4b');
    return { ...base.case, wallThickness: 4, lidThickness: 4, lidRecess: true, hinge: h, ...over };
  }

  function shellOf(params: CaseParameters): BuildOp {
    const project = createDefaultProject('rpi-4b');
    const plan = compileProject({ ...project, case: params });
    return plan.nodes.find((n) => n.id === 'shell')!.op;
  }

  it('a recessed-lid case with a gasket and a hinge is ONE printed shell', () => {
    // The repro: wall 4, gasket 2.5 (the clamped #264 width), external-pin hinge
    // on +y. Before the fairing: a body 39 847 mm³ plus three 490 mm³ knuckles
    // floating at y ∈ [68, 76] — the knuckles, detached, with a hole through
    // them where the pin bore was cut.
    const shell = shellOf(
      recessed({
        seal: {
          enabled: true,
          mode: 'recess',
          profile: 'flat',
          width: 2.5,
          depth: 2,
          compressionFactor: 0.25,
          gasketMaterial: 'tpu',
        },
      }),
    );
    expect(bodies(shell)).toBe(1);
  });

  it('stays below the plane the lid seats on', () => {
    // The band reaches half a knuckle radius either side of the axis, and the
    // axis sits one full radius below the lid's seating plane — that is what
    // makes the knuckle tangent to the lid's underside in the first place. So
    // the pad tops out R/2 under the rim and cannot foul the closed lid, on
    // any wall thickness.
    const board = createDefaultProject('rpi-4b').board;
    const params = recessed();
    const fairing = bboxOfOp(
      buildHingeOps(hinge(), board, params, [], () => undefined).caseAdditive.filter(
        (op) => bottom(op).kind === 'cube',
      )[0]!,
    )!;
    const lid = computeLidDims(board, params, [], () => undefined);
    expect(fairing.max[2]).toBeCloseTo(lid.zPosition - R / 2, 6);
  });

  it('holds on every face, not just the one the issue was filed against', () => {
    for (const face of ['-y', '+y', '-x', '+x'] as const) {
      expect(bodies(shellOf(recessed({}, hinge({ face })))), `${face} face`).toBe(1);
    }
  });

  it('leaves the clamshell case as it found it', () => {
    // On a clamshell the flange already bridged the knuckles; the fairing is
    // additive and must not split or otherwise reshape it.
    expect(bodies(shellOf(recessed({ lidRecess: false })))).toBe(1);
  });

  it('the hardware-screw style gets the same fairing', () => {
    expect(bodies(shellOf(recessed({}, hinge({ style: 'hardware-screw' })))))
      .toBe(1);
  });

  it('spans from inside the wall out to the knuckle axis, and stops short of the cavity', () => {
    // What the fairing IS, checked on the ops: the fusion above is manifold's
    // call, this is the shape it was given. The probe is the solid's own claim
    // about which box it got, not a re-derivation of the arithmetic.
    const board = createDefaultProject('rpi-4b').board;
    const params = recessed();
    const dims = computeShellDims(board, params, [], () => undefined);
    const ops = buildHingeOps(hinge(), board, params, [], () => undefined);
    const fairings = ops.caseAdditive.filter((op) => bottom(op).kind === 'cube');
    expect(fairings).toHaveLength(3); // one per case knuckle

    const bb = bboxOfOp(fairings[0]!)!;
    // The face plane is y = outerY; the pad ends 1 mm inside it…
    expect(bb.min[1]).toBeCloseTo(dims.outerY - 1, 6);
    // …and reaches the axis, knuckleR out from the face.
    expect(bb.max[1]).toBeCloseTo(dims.outerY + R, 6);
    // Its z-band is half the knuckle's radius either side of the axis, so it
    // can never stick out past the cylinder it is blending into (that band is
    // 0.5·R tall each way ⇒ R total).
    const axisZ = bb.min[2] + (bb.max[2] - bb.min[2]) / 2;
    expect(bb.max[2] - bb.min[2]).toBeCloseTo(R, 6);
    // And it is exactly one knuckle long in u — the knuckles hold a share of
    // the run each, so it never bridges across the gap to the one beside it.
    // (The knuckle op's own bbox is no use here: it is a rotated cylinder, and
    // `bboxOfOp` is deliberately conservative about those.)
    const knuckleLen = (60 - 4 * 0.4) / 5; // hingeLength less the four gaps, over five
    expect(bb.max[0] - bb.min[0]).toBeCloseTo(knuckleLen, 6);
    expect(bb.max[0] - bb.min[0]).toBeLessThan(60 / 5); // the pitch — a gap remains
    // A wall thinner than twice the reach halves it, rather than letting the
    // pad through into the cavity.
    const thin = recessed({ wallThickness: 1.6 });
    const thinFairing = bboxOfOp(
      buildHingeOps(hinge(), board, thin, [], () => undefined).caseAdditive.filter(
        (op) => bottom(op).kind === 'cube',
      )[0]!,
    )!;
    const thinDims = computeShellDims(board, thin, [], () => undefined);
    expect(thinFairing.min[1]).toBeCloseTo(thinDims.outerY - 0.8, 6);
    // …and the band is centred on the knuckle's own axis.
    expect(axisZ).toBeCloseTo(offsetOf(knuckleOps(ops.caseAdditive)[0]!)[2], 6);
  });
});
