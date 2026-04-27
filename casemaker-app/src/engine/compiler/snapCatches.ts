import type { BoardProfile, CaseParameters, SnapCatch, SnapWall } from '@/types';
import { SNAP_DEFAULTS } from '@/types/snap';
import { cube, difference, translate, union, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

/**
 * Default snap-catch placement based on case longest dimension (issue #29):
 *   < 80 mm  → 2 catches (midpoint of each short end)
 *   80–150 → 4 catches (midpoint of each wall)
 *   > 150  → 6 catches (short ends + thirds along the long walls)
 */
export function defaultSnapCatchesForCase(
  board: BoardProfile,
  params: CaseParameters,
): SnapCatch[] {
  const dims = computeShellDims(board, params);
  const longest = Math.max(dims.outerX, dims.outerY);
  const longerIsX = dims.outerX >= dims.outerY;

  const out: SnapCatch[] = [];
  const mid = (n: number) => n / 2;

  if (longest < 80) {
    if (longerIsX) {
      out.push({ id: 'snap-1', wall: '-x', uPosition: mid(dims.outerY), enabled: true });
      out.push({ id: 'snap-2', wall: '+x', uPosition: mid(dims.outerY), enabled: true });
    } else {
      out.push({ id: 'snap-1', wall: '-y', uPosition: mid(dims.outerX), enabled: true });
      out.push({ id: 'snap-2', wall: '+y', uPosition: mid(dims.outerX), enabled: true });
    }
  } else if (longest <= 150) {
    out.push({ id: 'snap-1', wall: '-x', uPosition: mid(dims.outerY), enabled: true });
    out.push({ id: 'snap-2', wall: '+x', uPosition: mid(dims.outerY), enabled: true });
    out.push({ id: 'snap-3', wall: '-y', uPosition: mid(dims.outerX), enabled: true });
    out.push({ id: 'snap-4', wall: '+y', uPosition: mid(dims.outerX), enabled: true });
  } else {
    if (longerIsX) {
      out.push({ id: 'snap-1', wall: '-x', uPosition: mid(dims.outerY), enabled: true });
      out.push({ id: 'snap-2', wall: '+x', uPosition: mid(dims.outerY), enabled: true });
      out.push({ id: 'snap-3', wall: '-y', uPosition: dims.outerX / 3, enabled: true });
      out.push({ id: 'snap-4', wall: '-y', uPosition: (2 * dims.outerX) / 3, enabled: true });
      out.push({ id: 'snap-5', wall: '+y', uPosition: dims.outerX / 3, enabled: true });
      out.push({ id: 'snap-6', wall: '+y', uPosition: (2 * dims.outerX) / 3, enabled: true });
    } else {
      out.push({ id: 'snap-1', wall: '-y', uPosition: mid(dims.outerX), enabled: true });
      out.push({ id: 'snap-2', wall: '+y', uPosition: mid(dims.outerX), enabled: true });
      out.push({ id: 'snap-3', wall: '-x', uPosition: dims.outerY / 3, enabled: true });
      out.push({ id: 'snap-4', wall: '-x', uPosition: (2 * dims.outerY) / 3, enabled: true });
      out.push({ id: 'snap-5', wall: '+x', uPosition: dims.outerY / 3, enabled: true });
      out.push({ id: 'snap-6', wall: '+x', uPosition: (2 * dims.outerY) / 3, enabled: true });
    }
  }
  return out;
}

interface CatchGeometry {
  /** Pocket cut into the case wall (subtractive). */
  pocket: BuildOp;
  /** Cantilever arm + barb attached to the lid lip (additive, lid-local Z). */
  armBarb: BuildOp;
}

/**
 * Build geometry for one snap catch — both the pocket cut into the case wall
 * (world coordinates) and the cantilever arm + barb attached under the lid
 * lip (lid-local coordinates, which the lid pipeline translates into place).
 */
export function buildSnapCatch(
  c: SnapCatch,
  board: BoardProfile,
  params: CaseParameters,
): CatchGeometry | null {
  if (!c.enabled) return null;
  const dims = computeShellDims(board, params);
  const { wallThickness: wall } = params;
  const {
    armLength,
    armThickness,
    armWidth,
    barbProtrusion,
    barbLength,
    pocketWidth,
    pocketHeight,
  } = SNAP_DEFAULTS;

  // Pocket: cut into the case wall just below the top edge so the barb has
  // somewhere to land. Vertical placement: pocketHeight tall, top edge at
  // shell outerZ - lidThickness*0 (the pocket lives within the wall above
  // the cavity ceiling).
  const pocketTopZ = dims.outerZ - 1; // pocket top sits 1mm below shell top
  const pocketBottomZ = pocketTopZ - pocketHeight;

  // Arm sits under the lid plate, descending into the cavity along the wall.
  // Arm root anchored at lid bottom (z=0 in lid-local coords), tip extending
  // downward to z = -armLength. Barb at the tip protrudes outward by barbProtrusion.

  const wallId: SnapWall = c.wall;
  let pocket: BuildOp;
  let armBarb: BuildOp;

  switch (wallId) {
    case '-x': {
      // Pocket cuts into the -x wall from inside (cavity x=wall) to outside (x=0).
      pocket = translate(
        [-1, c.uPosition - pocketWidth / 2, pocketBottomZ],
        cube([wall + 2, pocketWidth, pocketHeight]),
      );
      // Arm hangs from lid bottom along the inside of the -x wall.
      const arm = translate(
        [wall + 0, c.uPosition - armWidth / 2, -armLength],
        cube([armThickness, armWidth, armLength]),
      );
      // Barb protrudes outward (-x direction).
      const barb = translate(
        [wall - barbProtrusion, c.uPosition - armWidth / 2, -armLength],
        cube([barbProtrusion, armWidth, barbLength]),
      );
      armBarb = union([arm, barb]);
      break;
    }
    case '+x': {
      pocket = translate(
        [dims.outerX - wall - 1, c.uPosition - pocketWidth / 2, pocketBottomZ],
        cube([wall + 2, pocketWidth, pocketHeight]),
      );
      const arm = translate(
        [dims.outerX - wall - armThickness, c.uPosition - armWidth / 2, -armLength],
        cube([armThickness, armWidth, armLength]),
      );
      const barb = translate(
        [dims.outerX - wall, c.uPosition - armWidth / 2, -armLength],
        cube([barbProtrusion, armWidth, barbLength]),
      );
      armBarb = union([arm, barb]);
      break;
    }
    case '-y': {
      pocket = translate(
        [c.uPosition - pocketWidth / 2, -1, pocketBottomZ],
        cube([pocketWidth, wall + 2, pocketHeight]),
      );
      const arm = translate(
        [c.uPosition - armWidth / 2, wall, -armLength],
        cube([armWidth, armThickness, armLength]),
      );
      const barb = translate(
        [c.uPosition - armWidth / 2, wall - barbProtrusion, -armLength],
        cube([armWidth, barbProtrusion, barbLength]),
      );
      armBarb = union([arm, barb]);
      break;
    }
    case '+y': {
      pocket = translate(
        [c.uPosition - pocketWidth / 2, dims.outerY - wall - 1, pocketBottomZ],
        cube([pocketWidth, wall + 2, pocketHeight]),
      );
      const arm = translate(
        [c.uPosition - armWidth / 2, dims.outerY - wall - armThickness, -armLength],
        cube([armWidth, armThickness, armLength]),
      );
      const barb = translate(
        [c.uPosition - armWidth / 2, dims.outerY - wall, -armLength],
        cube([armWidth, barbProtrusion, barbLength]),
      );
      armBarb = union([arm, barb]);
      break;
    }
  }

  void difference;
  return { pocket, armBarb };
}

export function buildSnapCatchOps(
  catches: SnapCatch[] | undefined,
  board: BoardProfile,
  params: CaseParameters,
): { shellSubtract: BuildOp[]; lidAdd: BuildOp[] } {
  if (!catches || params.joint !== 'snap-fit') {
    return { shellSubtract: [], lidAdd: [] };
  }
  const shellSubtract: BuildOp[] = [];
  const lidAdd: BuildOp[] = [];
  for (const c of catches) {
    const g = buildSnapCatch(c, board, params);
    if (!g) continue;
    shellSubtract.push(g.pocket);
    lidAdd.push(g.armBarb);
  }
  return { shellSubtract, lidAdd };
}
