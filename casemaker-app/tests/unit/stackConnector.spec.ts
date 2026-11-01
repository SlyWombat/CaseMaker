// Issue #149 — the stacking connector: the socket's profile and layout, the
// key against the socket at every fit rung (on real Manifold meshes), the
// detent, the parts on the bed, the inform-don't-refuse statements and the
// schema round trip. The "unchanged without connectors" half is
// `stackConnectorUnchanged.spec.ts`.

import { describe, it, expect } from 'vitest';
import {
  STACK_BACKING,
  STACK_BEAM_T,
  STACK_BEAM_W,
  STACK_BUMP,
  STACK_WINDOW_DEPTH,
  STACK_WINDOW_W,
  STACK_CAPTURE,
  STACK_DEPTH,
  STACK_END_PLAY,
  STACK_FLOOR_W,
  STACK_MOUTH_W,
  STACK_NOTCH_DEPTH,
  STACK_PAD_PROUD,
  STACK_PAD_W,
  STACK_SLIDE_CLEARANCE,
  STACK_STOP,
  STACK_WEB_PROUD,
  FIT_RELIEF_MM,
  FIT_VARIANTS,
  stackKeyLength,
  type FitVariant,
  type Project,
  type StackKeyVariant,
} from '@/types';
import {
  buildStackKeyLocal,
  buildStackKeyPrint,
  socketFullHeight,
  socketMinHeight,
  socketSectionPieces,
  socketSolids,
  socketZLayout,
  stackKeyDims,
} from '@/engine/compiler/stackConnector';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { buildFitCoupon, FIT_COUPONS } from '@/engine/compiler/fitCoupons';
import {
  cube,
  difference,
  intersection,
  translate,
  type BuildOp,
  type Profile,
} from '@/engine/compiler/buildPlan';
import { partForId, printMetaForId } from '@/engine/exporters/parts';
import { createDefaultProject } from '@/store/projectStore';
import { projectSchema } from '@/store/projectSchema';
import { resetSeed } from '@/utils/id';
import { exec } from './helpers/manifoldExec';

function box3(min: [number, number, number], max: [number, number, number]): BuildOp {
  return translate(min, cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]));
}

function volume(op: BuildOp): number {
  const m = exec(op);
  try {
    return m.volume();
  } finally {
    m.delete();
  }
}

function bbox(op: BuildOp): { min: number[]; max: number[] } {
  const m = exec(op);
  try {
    const b = m.boundingBox();
    return { min: [...b.min], max: [...b.max] };
  } finally {
    m.delete();
  }
}

function components(op: BuildOp): number {
  const m = exec(op);
  try {
    const parts = m.decompose();
    parts.forEach((p) => p.delete());
    return parts.length;
  } finally {
    m.delete();
  }
}

/** The polygon ring of a p-poly profile. */
function ring(p: Profile): Array<[number, number]> {
  if (p.kind !== 'p-poly') throw new Error(`expected p-poly, got ${p.kind}`);
  return p.contours[0] as Array<[number, number]>;
}

/** A free-standing socket in its own frame: the pad block minus the socket's cuts. */
function socketBlock(variant: StackKeyVariant, height = socketFullHeight(variant)): BuildOp {
  const layout = socketZLayout(height, variant);
  if (!layout) throw new Error('no layout');
  const s = socketSolids(layout, 2);
  return difference([s.pad(0, height), ...s.cuts]);
}

function withConnector(p: Project, c: NonNullable<Project['case']['stackConnector']>): Project {
  return { ...p, case: { ...p.case, stackConnector: c } };
}

function stock(boardId = 'rpi-4b'): Project {
  resetSeed();
  return createDefaultProject(boardId);
}

describe('socket profile', () => {
  it('is a 45° dovetail, 3 mm deep, under a mouth narrower than its floor', () => {
    const [trap, mouth] = socketSectionPieces();
    const pts = ring(trap!);
    // Floor edge, then the lip edge: a 45° flank rises 1 mm per 1 mm inward.
    const [f0, f1, t1] = [pts[0]!, pts[1]!, pts[2]!];
    expect(f1[0] - f0[0]).toBeCloseTo(STACK_FLOOR_W, 9);
    expect(t1[1] - f1[1]).toBeCloseTo(STACK_DEPTH, 9);
    const flankDeg = (Math.atan2(t1[1] - f1[1], f1[0] - t1[0]) * 180) / Math.PI;
    expect(flankDeg).toBeCloseTo(45, 9);
    expect(2 * t1[0]).toBeCloseTo(STACK_MOUTH_W, 9);
    expect(STACK_MOUTH_W).toBeCloseTo(STACK_FLOOR_W - 2 * STACK_DEPTH, 9);
    // The floor sits on the pad's backing, so the wall is never cut.
    expect(f0[1]).toBeCloseTo(STACK_BACKING, 9);
    expect(STACK_BACKING - STACK_NOTCH_DEPTH).toBeGreaterThan(0);
    // The mouth piece opens through the pad face.
    const m = ring(mouth!);
    expect(Math.max(...m.map((p) => p[1]))).toBeGreaterThan(STACK_PAD_PROUD);
  });

  it('a relieved socket opens every engagement face by exactly the relief', () => {
    const r = 0.25;
    const nominal = ring(socketSectionPieces()[0]!);
    const relieved = ring(socketSectionPieces(r)[0]!);
    expect(nominal[0]![1] - relieved[0]![1]).toBeCloseTo(r, 9); // floor drops r
    // Flank moved r perpendicular = r·√2 horizontally at the lip line.
    expect(relieved[2]![0] - nominal[2]![0]).toBeCloseTo(r * Math.SQRT2, 9);
  });
});

describe('socket layout along the wall', () => {
  it('a tall wall gets the pocket, the stop, and a flush storage channel', () => {
    const H = socketFullHeight('short');
    const L = socketZLayout(H, 'short')!;
    expect(L.pocket).toEqual([0, STACK_CAPTURE + STACK_END_PLAY]);
    expect(L.stop[1] - L.stop[0]).toBeCloseTo(STACK_STOP, 9);
    expect(L.stop[0]).toBeCloseTo(L.pocket![1], 9);
    expect(L.channel).toEqual([L.stop[1], H]);
    expect(L.channel[1] - L.channel[0]).toBeCloseTo(stackKeyLength('short') + STACK_END_PLAY, 9);
    expect(L.flush).toBe(true);
    expect(L.storedProud).toBe(0);
  });

  it('a medium wall keeps the pocket and says how far a stored key stands proud', () => {
    const L = socketZLayout(30, 'short')!;
    expect(L.pocket).not.toBeNull();
    expect(L.flush).toBe(false);
    expect(L.storedProud).toBeCloseTo(stackKeyLength('short') + STACK_END_PLAY - (L.channel[1] - L.channel[0]), 9);
  });

  it('a short wall drops the pocket before the channel, and a tiny one gets nothing', () => {
    const L = socketZLayout(socketMinHeight() + 2, 'short')!;
    expect(L.pocket).toBeNull();
    expect(L.stop).toEqual([0, STACK_STOP]);
    expect(socketZLayout(socketMinHeight() - 0.1, 'short')).toBeNull();
  });

  it('the long key gets a deeper storage channel on a tall enough wall', () => {
    const L = socketZLayout(socketFullHeight('long'), 'long')!;
    expect(L.channel[1] - L.channel[0]).toBeCloseTo(stackKeyLength('long') + STACK_END_PLAY, 9);
    expect(L.flush).toBe(true);
  });
});

describe('the key in its socket, at every fit rung (real meshes)', () => {
  const variant: StackKeyVariant = 'short';
  const H = socketFullHeight(variant);
  const block = socketBlock(variant);
  const layout = socketZLayout(H, variant)!;
  const K = stackKeyLength(variant);

  for (const fit of FIT_VARIANTS as FitVariant[]) {
    const d = stackKeyDims(variant, fit);

    it(`${fit}: the clearance is the sliding gap plus the rung's relief, and the engagement holds`, () => {
      expect(d.clearance).toBeCloseTo(STACK_SLIDE_CLEARANCE + FIT_RELIEF_MM[fit], 9);
      expect(d.engagedDepth).toBeCloseTo(STACK_DEPTH - d.clearance, 9);
      // Even the loose key keeps two millimetres of wing under each lip.
      expect(d.lipOverlap).toBeGreaterThan(2);
      expect(d.capture).toBe(STACK_CAPTURE);
    });

    it(`${fit}: pushed home on the stop it does not touch the socket, and its top is flush`, () => {
      // Bump off: pushed home, the spring is sprung flat against the floor,
      // which a rigid mesh cannot show.
      const key = translate([0, 0, layout.channel[0]], buildStackKeyLocal(variant, fit, { bump: false }));
      expect(volume(intersection([key, block]))).toBeLessThan(1e-6);
      const top = layout.channel[0] + K;
      expect(H - top).toBeCloseTo(STACK_END_PLAY, 9);
    });

    it(`${fit}: parked half-proud, the bump sits in the seam notch clear of the socket`, () => {
      // Bump centre on the top edge = half the key in, half out.
      const key = translate([0, 0, H - STACK_CAPTURE], buildStackKeyLocal(variant, fit));
      expect(volume(intersection([key, block]))).toBeLessThan(1e-6);
    });

    it(`${fit}: the upper part's pocket takes the proud half, bump in its notch`, () => {
      // The seam is z = 0 of the upper part: the key's bump on it.
      const key = translate([0, 0, -STACK_CAPTURE], buildStackKeyLocal(variant, fit));
      expect(volume(intersection([key, block]))).toBeLessThan(1e-6);
    });

    it(`${fit}: it can leave the wall only by its stated play — the dovetail holds`, () => {
      const seated = buildStackKeyLocal(variant, fit, { bump: false });
      const at = (dy: number): BuildOp => translate([0, dy, layout.channel[0]], seated);
      expect(volume(intersection([at(d.pullOutPlay - 0.02), block]))).toBeLessThan(1e-4);
      expect(volume(intersection([at(d.pullOutPlay + 0.1), block]))).toBeGreaterThan(0.05);
    });
  }

  it('a looser rung is a smaller key in the same socket', () => {
    const v = FIT_VARIANTS.map((f) => volume(buildStackKeyLocal(variant, f)));
    expect(v[0]!).toBeGreaterThan(v[1]!);
    expect(v[1]!).toBeGreaterThan(v[2]!);
  });
});

describe('the detent', () => {
  for (const variant of ['short', 'long'] as StackKeyVariant[]) {
    it(`${variant}: each bump is ${STACK_CAPTURE} mm from an end, its tip ${STACK_BUMP} mm past the floor`, () => {
      const K = stackKeyLength(variant);
      const d = stackKeyDims(variant);
      expect(d.bumps).toEqual(variant === 'short' ? [K / 2] : [STACK_CAPTURE, K - STACK_CAPTURE]);
      for (const fit of FIT_VARIANTS as FitVariant[]) {
        const key = buildStackKeyLocal(variant, fit);
        // Everything below the floor plane is bump.
        const below = intersection([key, box3([-20, -5, -5], [20, STACK_BACKING, K + 5])]);
        const b = bbox(below);
        expect(b.min[1]!).toBeCloseTo(STACK_BACKING - STACK_BUMP, 3);
        const centres = (b.min[2]! + b.max[2]!) / 2;
        expect(centres).toBeCloseTo(K / 2, 3); // symmetric about the middle either way
        expect(b.min[2]!).toBeGreaterThan(STACK_CAPTURE - 3);
        expect(b.max[2]!).toBeLessThan(K - STACK_CAPTURE + 3);
      }
    });
  }

  it('the beam is free on its sides: a window runs behind it, 2 mm of travel for a 0.8 mm bump', () => {
    const d = stackKeyDims('short');
    // Strain is an estimate, but it must stay in an FDM part's elastic range.
    expect(d.beamStrain).toBeLessThan(0.03);
    expect(d.beamSpan).toBeGreaterThanOrEqual(20);
    const K = stackKeyLength('short');
    const key = buildStackKeyLocal('short', 'tight', { bump: false });
    const y0 = STACK_BACKING + STACK_SLIDE_CLEARANCE;
    const e = 0.05;
    const z: [number, number] = [K / 2 - 5, K / 2 + 5];
    // Behind the beam: empty — the window, 2 mm of room for the beam to flex into.
    const win = box3([-STACK_WINDOW_W / 2 + e, y0 + STACK_BEAM_T + e, z[0]], [STACK_WINDOW_W / 2 - e, y0 + STACK_BEAM_T + STACK_WINDOW_DEPTH - e, z[1]]);
    expect(volume(intersection([key, win]))).toBeLessThan(1e-6);
    // Beside the beam: the slits, so it is held only at its ends.
    const slit = box3([STACK_BEAM_W / 2 + e, y0 + e, z[0]], [STACK_WINDOW_W / 2 - e, y0 + STACK_BEAM_T - e, z[1]]);
    expect(volume(intersection([key, slit]))).toBeLessThan(1e-6);
    // The beam itself: solid, 1 mm thick.
    const beam = box3([-STACK_BEAM_W / 2 + e, y0 + e, z[0]], [STACK_BEAM_W / 2 - e, y0 + STACK_BEAM_T - e, z[1]]);
    expect(volume(intersection([key, beam]))).toBeCloseTo(volume(beam), 3);
    expect(STACK_BEAM_T).toBe(1);
    expect(STACK_WINDOW_DEPTH).toBeGreaterThan(STACK_BUMP + 1);
  });
});

describe('the printed key lies flat', () => {
  for (const variant of ['short', 'long'] as StackKeyVariant[]) {
    it(`${variant}: on the bed at z = 0 on its flat grip face, one body`, () => {
      const op = buildStackKeyPrint(variant);
      const b = bbox(op);
      expect(b.min[2]!).toBeCloseTo(0, 6);
      expect(b.max[1]! - b.min[1]!).toBeCloseTo(stackKeyLength(variant), 6);
      expect(b.max[2]!).toBeCloseTo(STACK_DEPTH + STACK_WEB_PROUD + STACK_BUMP, 3);
      // The first layer is the whole web: (mouth − 2c) wide, the full length.
      const c = STACK_SLIDE_CLEARANCE;
      const layer = volume(intersection([op, box3([-50, -50, 0], [50, 100, 0.1])])) / 0.1;
      expect(layer).toBeCloseTo((STACK_MOUTH_W - 2 * c) * stackKeyLength(variant), 0);
      expect(components(op)).toBe(1);
    });
  }

  it('keys are export parts that print flat with no supports', () => {
    const plan = compileProject(withConnector(stock(), { sockets: [], key: 'short', keys: 3 }));
    const keys = plan.nodes.filter((n) => n.id.startsWith('stack-key-'));
    expect(keys.map((k) => k.id)).toEqual(['stack-key-1', 'stack-key-2', 'stack-key-3']);
    for (const k of keys) {
      expect(bbox(k.op).min[2]!).toBeCloseTo(0, 6);
      const part = partForId(k.id);
      expect(part.category).toBe('fastener');
      expect(part.supports).toBe('none');
      expect(part.printOrientation).toEqual({ rotation: [0, 0, 0], flipForPrint: false });
      expect(printMetaForId(k.id).hint).toMatch(/flat/i);
    }
    // Keys never overlap one another on the plate.
    const boxes = keys.map((k) => bbox(k.op));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i]!.min[0]!).toBeGreaterThan(boxes[i - 1]!.max[0]!);
  });
});

describe('sockets on a case', () => {
  it('cut into the shell AND the on-rim lid, both still one clean body, growing only the chosen walls', () => {
    const base = compileProject(stock());
    const p = withConnector(stock(), {
      sockets: [
        { face: '+y', offset: 0 },
        { face: '-x', offset: 17 },
      ],
      key: 'short',
      keys: 1,
    });
    const plan = compileProject(p);
    const shell = plan.nodes.find((n) => n.id === 'shell')!;
    const lid = plan.nodes.find((n) => n.id === 'lid')!;
    for (const n of [shell, lid]) {
      expect(components(n.op), n.id).toBe(1);
      const m = exec(n.op);
      expect(m.status()).toBe('NoError');
      m.delete();
    }
    const b0 = bbox(base.nodes.find((n) => n.id === 'shell')!.op);
    const b1 = bbox(shell.op);
    expect(b1.max[1]! - b0.max[1]!).toBeCloseTo(STACK_PAD_PROUD, 3); // +y grew
    expect(b0.min[0]! - b1.min[0]!).toBeCloseTo(STACK_PAD_PROUD, 3); // -x grew
    expect(b1.min[1]!).toBeCloseTo(b0.min[1]!, 6); // -y did not
    expect(b1.max[0]!).toBeCloseTo(b0.max[0]!, 6); // +x did not
    const lb0 = bbox(base.nodes.find((n) => n.id === 'lid')!.op);
    const lb1 = bbox(lid.op);
    expect(lb1.max[1]! - lb0.max[1]!).toBeCloseTo(STACK_PAD_PROUD, 3);
    // The socket removed material: the case is lighter than pad volume alone would make it.
    expect(plan.connector?.sockets.map((s) => s.face)).toEqual(['+y', '-x']);
    expect(plan.nodes.some((n) => n.id === 'stack-key-1')).toBe(true);
  });

  it('a recessed lid leaves the whole socket in the shell', () => {
    const p0 = stock();
    const p = withConnector({ ...p0, case: { ...p0.case, lidRecess: true } }, {
      sockets: [{ face: '+y', offset: 0 }],
      key: 'short',
      keys: 0,
    });
    const plan = compileProject(p);
    const lidBase = compileProject({ ...p0, case: { ...p0.case, lidRecess: true } }).nodes.find((n) => n.id === 'lid')!;
    const lid = plan.nodes.find((n) => n.id === 'lid')!;
    expect(JSON.stringify(lid.op)).toBe(JSON.stringify(lidBase.op));
  });
});

describe('inform, don\'t refuse', () => {
  it('a socket on a port is stated, with an offer to move that clears it', () => {
    const plan = compileProject(
      withConnector(stock(), { sockets: [{ face: '-x', offset: 0 }], key: 'short', keys: 0 }),
    );
    const clash = plan.connector!.notes.find((n) => n.kind === 'clash')!;
    expect(clash.message).toMatch(/left socket at 0 mm runs into a port cutout/);
    expect(clash.suggestedOffset).toBeDefined();
    expect(clash.message).toContain(`${clash.suggestedOffset} mm`);
    // The socket is still cut where the user put it.
    expect(plan.connector!.sockets[0]!.offset).toBe(0);
    // Taking the offer leaves nothing to say about it.
    const moved = compileProject(
      withConnector(stock(), {
        sockets: [{ face: '-x', offset: clash.suggestedOffset! }],
        key: 'short',
        keys: 0,
      }),
    );
    expect(moved.connector!.notes.filter((n) => n.kind === 'clash')).toEqual([]);
  });

  it('names a hinge and a latch on the protective case', async () => {
    const { findTemplate } = await import('@/library/templates');
    resetSeed();
    const p = findTemplate('protective-case')!.build();
    const { computeShellDims } = await import('@/engine/compiler/caseShell');
    const dims = computeShellDims(p.board, p.case, p.hats ?? [], () => undefined);
    // Put the front socket right on the first latch (latch u runs from the corner).
    const latchU = p.case.latches![0]!.uPosition;
    const plan = compileProject(
      withConnector(p, {
        sockets: [{ face: '-y', offset: latchU - dims.outerX / 2 }, { face: '+y', offset: 0 }],
        key: 'short',
        keys: 0,
      }),
    );
    const text = plan.connector!.notes.map((n) => n.message).join('\n');
    expect(text).toMatch(/latch/);
    expect(text).toMatch(/hinge/);
  });

  it('a wall too short or too narrow is stated, not thrown', () => {
    const p = withConnector(stock(), { sockets: [{ face: '+y', offset: 500 }], key: 'short', keys: 0 });
    const plan = compileProject(p);
    const clamped = plan.connector!.notes.find((n) => n.kind === 'clamped')!;
    expect(clamped.message).toMatch(/runs? off the rounded corner/);
    expect(Math.abs(plan.connector!.sockets[0]!.offset)).toBeLessThan(500);
  });

  it('the storage mode is a FACT on the report, not a statement (#854)', () => {
    const plan = compileProject(
      withConnector(stock(), {
        sockets: [{ face: '+y', offset: 0 }, { face: '-y', offset: 29 }],
        key: 'short',
        keys: 0,
      }),
    );
    // No statement at all: a note that fires on nearly every case is noise.
    expect(plan.connector!.notes.some((n) => /stands .* proud instead of flush/.test(n.message))).toBe(false);
    // The fact lives on the report, once for the case, for the section to show.
    expect(plan.connector!.storage).not.toBeNull();
    expect(plan.connector!.storage!.storedProud).toBeGreaterThan(0);
    expect(plan.connector!.storage!.channelMm).toBeGreaterThan(0);
  });

  it('a second socket on the same wall is stated and not cut', () => {
    const plan = compileProject(
      withConnector(stock(), {
        sockets: [{ face: '+y', offset: -20 }, { face: '+y', offset: 20 }],
        key: 'short',
        keys: 0,
      }),
    );
    expect(plan.connector!.sockets).toHaveLength(1);
    expect(plan.connector!.notes.some((n) => n.kind === 'duplicate')).toBe(true);
  });
});

describe('schema', () => {
  it('round-trips a connector through the project schema unchanged', () => {
    const p = withConnector(stock(), {
      sockets: [{ face: '+x', offset: -3.5 }, { face: '-y', offset: 12 }],
      key: 'long',
      keys: 2,
      fit: 'loose',
    });
    const parsed = projectSchema.parse(JSON.parse(JSON.stringify(p)));
    expect(parsed.case.stackConnector).toEqual(p.case.stackConnector);
  });

  it('a project without one parses without one', () => {
    const parsed = projectSchema.parse(JSON.parse(JSON.stringify(stock())));
    expect(parsed.case.stackConnector).toBeUndefined();
  });

  it('rejects a top-face socket and a negative key count', () => {
    const bad1 = withConnector(stock(), { sockets: [{ face: '+z' as never, offset: 0 }], key: 'short', keys: 0 });
    const bad2 = withConnector(stock(), { sockets: [], key: 'short', keys: -1 });
    expect(projectSchema.safeParse(JSON.parse(JSON.stringify(bad1))).success).toBe(false);
    expect(projectSchema.safeParse(JSON.parse(JSON.stringify(bad2))).success).toBe(false);
  });
});

describe('fit coupon', () => {
  it('is registered, prints a three-rung socket bar and one key as two bodies', () => {
    expect(FIT_COUPONS.some((c) => c.id === 'stack-connector')).toBe(true);
    const c = buildFitCoupon('stack-connector');
    expect(c.bodies).toBe(2);
    expect(components(c.op)).toBe(2);
    expect(c.columns.map((col) => col.value)).toEqual(FIT_VARIANTS.map((f) => FIT_RELIEF_MM[f]));
    expect(c.columns.filter((col) => col.shipped).map((col) => col.label)).toEqual(['0']);
    expect(c.provenance).toMatch(/PROVISIONAL/);
    expect(bbox(c.op).min[2]!).toBeCloseTo(0, 6);
  });

  it('the shipped key slides into every rung of the bar without touching it', () => {
    const c = buildFitCoupon('stack-connector');
    const H = c.dims.z;
    const layout = socketZLayout(H, 'short')!;
    for (const col of c.columns) {
      const s = socketSolids(layout, 0, col.value);
      const bar = difference([
        translate([col.x - 15, -9, 0], cube([30, 9 + STACK_PAD_PROUD, H])),
        ...s.cuts.map((op) => translate([col.x, 0, 0], op)),
      ]);
      const key = translate([col.x, 0, layout.channel[0]], buildStackKeyLocal('short', 'tight', { bump: false }));
      expect(volume(intersection([key, bar])), `rung ${col.label}`).toBeLessThan(1e-6);
    }
    expect(STACK_PAD_W).toBeLessThan(30);
  });
});
