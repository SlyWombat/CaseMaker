import { describe, it, expect } from 'vitest';
import { buildBoardSnapOps } from '@/engine/compiler/boardSnap';
import type { BoardProfile, CaseParameters } from '@/types';

function makeBoard(overrides: Partial<BoardProfile> = {}): BoardProfile {
  return {
    id: 'test-board',
    name: 'Test board',
    manufacturer: 'Test',
    pcb: { size: { x: 40, y: 50, z: 1.6 } },
    mountingHoles: [],
    components: [],
    defaultStandoffHeight: 5,
    recommendedZClearance: 10,
    builtin: false,
    ...overrides,
  };
}

function makeParams(overrides: Partial<CaseParameters> = {}): CaseParameters {
  return {
    wallThickness: 2,
    floorThickness: 2,
    lidThickness: 2,
    cornerRadius: 2,
    internalClearance: 1,
    zClearance: 10,
    joint: 'flat-lid',
    boardRetention: 'snap',
    ventilation: { enabled: false, pattern: 'none', coverage: 0 },
    bosses: { enabled: false, insertType: 'self-tap', outerDiameter: 5, holeDiameter: 2.5 },
    ...overrides,
  } as CaseParameters;
}

/** Collect translated-cube boxes as {min, max} world extents. */
function cubeExtents(ops: ReturnType<typeof buildBoardSnapOps>['caseAdditive']) {
  const boxes: Array<{ min: [number, number, number]; max: [number, number, number] }> = [];
  for (const op of ops) {
    if (op.kind === 'translate' && op.child.kind === 'cube') {
      const o = op.offset;
      const s = op.child.size;
      boxes.push({ min: [o[0], o[1], o[2]], max: [o[0] + s[0], o[1] + s[1], o[2] + s[2]] });
    }
  }
  return boxes;
}

describe('board-snap two-jaw clips', () => {
  it('does nothing unless boardRetention is snap', () => {
    const ops = buildBoardSnapOps(makeBoard(), makeParams({ boardRetention: 'screws' }));
    expect(ops.caseAdditive.length).toBe(0);
  });

  it('default layout emits spine + shelf + finger per wall (4 walls)', () => {
    const ops = buildBoardSnapOps(makeBoard(), makeParams());
    // 4 clips × (spine cube + shelf cube + finger mesh)
    const cubes = ops.caseAdditive.filter((o) => o.kind === 'translate');
    const fingers = ops.caseAdditive.filter((o) => o.kind === 'mesh');
    expect(fingers.length).toBe(4);
    expect(cubes.length).toBe(8);
  });

  it('board on the floor (standoff 0) gets no bottom jaw — the floor is it', () => {
    const ops = buildBoardSnapOps(makeBoard({ defaultStandoffHeight: 0 }), makeParams());
    const cubes = ops.caseAdditive.filter((o) => o.kind === 'translate');
    const fingers = ops.caseAdditive.filter((o) => o.kind === 'mesh');
    expect(fingers.length).toBe(4);
    expect(cubes.length).toBe(4); // spines only
  });

  it('shelf top sits at the board underside, leaving a board-thickness jaw gap', () => {
    const board = makeBoard(); // standoff 5, pcb.z 1.6
    const params = makeParams(); // floor 2
    const boardBotZ = 2 + 5;
    const boardTopZ = boardBotZ + 1.6;
    const boxes = cubeExtents(buildBoardSnapOps(board, params).caseAdditive);
    // Shelves: boxes whose top face is exactly the board underside.
    const shelves = boxes.filter((b) => Math.abs(b.max[2] - boardBotZ) < 1e-6);
    expect(shelves.length).toBe(4);
    // Spines run from the floor up past the board top (they carry the finger).
    const spines = boxes.filter((b) => b.max[2] > boardTopZ + 0.2);
    expect(spines.length).toBe(4);
    for (const s of spines) expect(s.min[2]).toBeLessThanOrEqual(params.floorThickness);
  });

  it('honors board.retentionClips placements and widths', () => {
    const board = makeBoard({
      retentionClips: [
        { edge: '-x', offset: 2.5, width: 6 },
        { edge: '+x', offset: 2.5, width: 6 },
      ],
    });
    const ops = buildBoardSnapOps(board, makeParams());
    const fingers = ops.caseAdditive.filter((o) => o.kind === 'mesh');
    expect(fingers.length).toBe(2); // one finger per declared clip, not per wall
    const boxes = cubeExtents(ops.caseAdditive);
    // All clip material spans y = offset..offset+width relative to the PCB
    // min corner (origin = wall 2 + clearance 1 = 3).
    for (const b of boxes) {
      expect(b.min[1]).toBeCloseTo(3 + 2.5, 5);
      expect(b.max[1]).toBeCloseTo(3 + 8.5, 5);
    }
  });

  it('a clip far from its wall stands on a grounded rib, not in free space', () => {
    // +y wall pushed 8mm away (antenna gap) — beyond the fill limit.
    const board = makeBoard({ retentionClips: [{ edge: '+y', offset: 15, width: 10 }] });
    const params = makeParams({ clearanceTweaks: { xMin: 0, xMax: 0, yMin: 0, yMax: 8 } });
    const boxes = cubeExtents(buildBoardSnapOps(board, params).caseAdditive);
    const spine = boxes.find((b) => b.max[2] > 2 + 5 + 1.6)!;
    expect(spine).toBeDefined();
    // Grounded: spine reaches down to (or into) the floor.
    expect(spine.min[2]).toBeLessThanOrEqual(params.floorThickness);
    // Standalone rib: sits just outboard of the PCB edge (y=3+50=53), not at
    // the far wall (y=61).
    expect(spine.max[1]).toBeLessThan(58);
    expect(spine.min[1]).toBeGreaterThan(52.9);
  });
});
