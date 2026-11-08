/**
 * #1073 line 2, step 0 — THE BRACKET FLIP'S DOCUMENT-FRAME MAP (RY180).
 *
 * `frameForFace` used to refuse every non-vise bottom: `up = [0, 0, -1]` is the SAME vector for the
 * VISE's half turn about X (`RX180`, y → −y) and a BRACKET/TAPE mount's half turn about Y (`RY180`,
 * x → −x), so a frame carrying only `up` could not say which turn it meant — and guessing would
 * have posted a mirrored program. The frame now carries the axis `setups/orient.ts` already decides
 * (`SetupFrame.flipAxis`), and the three readers that turn geometry — `toSetupFrame`, `documentXY`,
 * `rotatedGeometryFor` — branch on it. The vise path keeps the exact frame shape it had before
 * (no `flipAxis` field, the same RX180 map), so every pre-#1073 call site is byte-identical.
 *
 * RED at 68b086bce: `frameForFace('bottom', { kind: 'bracket' }, …)` throws
 * "a 'bottom' setup is only wired for a vise mount".
 */
import { describe, expect, it } from 'vitest';

import { toSetupFrame } from '@/engine/cnc/cam/model/features';
import { documentXY, frameForFace, rotatedGeometryFor, shiftToStockTop } from '@/engine/cnc/cam/model/setups';
import { flipReflection } from '@/engine/cnc/setups/flip';
import type { MountSpec } from '@/engine/cnc/setups/types';
import type { ParsedMesh } from '@/engine/import/stlParser';

const BRACKET: MountSpec = { kind: 'bracket' };
const TAPE: MountSpec = { kind: 'tape' };
const VISE: MountSpec = { kind: 'vise', viseOpeningMm: 200 };

const THICKNESS = 25;
const STOCK_TOP_Z = 0;

/** One triangle through the point (10, 20, 5) — enough to read the turn off a vertex. */
function oneTriangle(): ParsedMesh {
  const positions = new Float32Array([10, 20, 5, 12, 20, 5, 10, 22, 5]);
  return {
    positions,
    indices: new Uint32Array([0, 1, 2]),
    triangleCount: 1,
    bbox: { min: [10, 20, 5], max: [12, 22, 5] },
  };
}

describe('#1073 step 0 — frameForFace carries the half turn its mount decides', () => {
  it('builds a bottom frame for a bracket mount and names the Y half turn', () => {
    const frame = frameForFace('bottom', BRACKET, STOCK_TOP_Z, THICKNESS);
    expect(frame.up).toEqual([0, 0, -1]);
    expect(frame.stockTop).toBeCloseTo(THICKNESS);
    expect(frame.stockBottom).toBeCloseTo(-STOCK_TOP_Z);
    expect(frame.flipAxis).toBe('y');
  });

  it('does the same for tape (orient lays both over Y)', () => {
    expect(frameForFace('bottom', TAPE, STOCK_TOP_Z, THICKNESS).flipAxis).toBe('y');
  });

  it('keeps the vise frame byte-for-byte: no flipAxis field, the same Z datum', () => {
    // Absent `flipAxis` IS the vise's X turn (#1073); writing it explicitly would change every
    // pre-existing frame's own shape for no gain.
    expect(frameForFace('bottom', VISE, STOCK_TOP_Z, THICKNESS)).toEqual({
      up: [0, 0, -1],
      stockTop: THICKNESS - STOCK_TOP_Z,
      stockBottom: -STOCK_TOP_Z,
    });
    expect(frameForFace('bottom', VISE, STOCK_TOP_Z, THICKNESS).flipAxis).toBeUndefined();
  });

  it('leaves the top frame the identity', () => {
    expect(frameForFace('top', BRACKET, 7, THICKNESS)).toEqual({ up: [0, 0, 1], stockTop: 7, stockBottom: 7 - THICKNESS });
  });
});

describe('#1073 step 0 — the turn and its XY map agree, per axis', () => {
  it('toSetupFrame turns about Y for a bracket flip (x and z negate, y stays)', () => {
    const turned = toSetupFrame(oneTriangle(), [0, 0, -1], 'y');
    expect(turned.positions[0]).toBeCloseTo(-10);
    expect(turned.positions[1]).toBeCloseTo(20);
    expect(turned.positions[2]).toBeCloseTo(-5);
  });

  it('toSetupFrame still turns about X by default (the vise, and every pre-#1073 caller)', () => {
    const turned = toSetupFrame(oneTriangle(), [0, 0, -1]);
    expect(turned.positions[0]).toBeCloseTo(10);
    expect(turned.positions[1]).toBeCloseTo(-20);
    expect(turned.positions[2]).toBeCloseTo(-5);
  });

  it('documentXY maps a bracket frame x → −x (+ offset) and a vise frame y → −y', () => {
    const bracket = frameForFace('bottom', BRACKET, STOCK_TOP_Z, THICKNESS);
    const vise = frameForFace('bottom', VISE, STOCK_TOP_Z, THICKNESS);
    const top = frameForFace('top', BRACKET, STOCK_TOP_Z, THICKNESS);

    expect(documentXY(bracket, 10, 20)).toEqual([-10, 20]);
    expect(documentXY(bracket, 10, 20, [160, 0])).toEqual([150, 20]);
    expect(documentXY(vise, 10, 20)).toEqual([10, -20]);
    expect(documentXY(vise, 10, 20, [0, 90])).toEqual([10, 70]);
    expect(documentXY(top, 10, 20)).toEqual([10, 20]);
  });

  it('agrees with #1088’s flipReflection for the tray’s left-right flip — one mapping, two readers', () => {
    // m1trayF: a 160 × 90 blank, a hole at X 156; the flipped frame puts it at X 4, Y unchanged.
    const bracket = frameForFace('bottom', BRACKET, STOCK_TOP_Z, THICKNESS);
    expect(documentXY(bracket, 156, 37.8, [160, 0])).toEqual([4, 37.8]);
    expect(flipReflection({ x: 156, y: 37.8 }, { axis: 'left-right' }, 160, 90)).toEqual({ x: 4, y: 37.8 });
  });

  it('rotatedGeometryFor turns the same way (a bracket frame mirrors X, not Y)', () => {
    const bracket = frameForFace('bottom', BRACKET, STOCK_TOP_Z, THICKNESS);
    const rotated = rotatedGeometryFor({ triangles: oneTriangle() }, bracket);
    expect(rotated.triangles.positions[0]).toBeCloseTo(-10);
    expect(rotated.triangles.positions[1]).toBeCloseTo(20);
  });

  it('shiftToStockTop carries the axis through, so the shim cannot turn a bracket flip back into the vise map', () => {
    const frame = frameForFace('bottom', BRACKET, 4, THICKNESS);
    const shifted = shiftToStockTop({ triangles: oneTriangle() }, frame);
    expect(shifted.frame.flipAxis).toBe('y');
    expect(shifted.frame.stockTop).toBe(0);
    // Pre-rotation shift is +stockTop for an up[2] < 0 frame; the rotation then negates z.
    expect(shifted.geometry.triangles.positions[2]).toBeCloseTo(5 + 21);
  });
});
