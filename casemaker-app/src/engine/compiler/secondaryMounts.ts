import type { BoardProfile, CaseParameters, BoardClip } from '@/types';
import { cavityOriginXY } from '@/engine/coords';
import { cube, translate, type BuildOp } from './buildPlan';

/**
 * Snap-clip mounts for secondary boards (board.secondaryBoardMounts).
 *
 * A daughterboard (e.g. SlyTherm's MSR-2 mmWave module) is held above the case
 * floor by thin cantilever clips — no screws, no holes. Each clip is a spring
 * arm just outboard of a board edge, rising from the floor, with:
 *   • a REST LEDGE at the board underside (z = floor + standoffHeight) that the
 *     board drops onto, and
 *   • a HOOK LIP at the board top (z = underside + thickness) that overhangs the
 *     board edge inward and springs back over it after insertion.
 * The board pushes in from above: its edge cams the hook outward, the arm flexes,
 * and the hook snaps back to trap the board between ledge and hook.
 *
 *              arm ┃          ┃ hook lip (overhang mm inward, over board top)
 *   (spring, floor┃──┐        ┃▔▔▔▔
 *    → top)       ┃  │  board →┃    ] board thickness
 *                 ┃──┘ rest    ┃▁▁▁▁ rest ledge (under board)
 *                 ┃  ledge     ┃
 *          floor ─┸────────────┸─
 */

const CLIP_W = 6;             // mm — clip width along the board edge
const ARM_T = 1.8;            // mm — spring-arm thickness (outboard of the board)
const GAP = 0.15;            // mm — clearance between board edge and arm inner face
const LEDGE_D = 2.0;          // mm — rest-ledge reach inward under the board
const LEDGE_THK = 1.5;        // mm — rest-ledge vertical thickness
const HOOK_THK = 1.2;         // mm — hook-lip vertical thickness
const DEFAULT_OVERHANG = 2.0; // mm — hook reach inward over the board top
const EMBED = 0.5;            // mm — sink the arm base into the floor for fusion

export function buildSecondaryMountOps(
  board: BoardProfile,
  params: CaseParameters,
): { caseAdditive: BuildOp[] } {
  const mounts = board.secondaryBoardMounts;
  if (!mounts || mounts.length === 0) return { caseAdditive: [] };
  const origin = cavityOriginXY(params);
  const floorTop = params.floorThickness;
  const ops: BuildOp[] = [];

  const box = (
    xLo: number, xHi: number, yLo: number, yHi: number, zLo: number, zHi: number,
  ): BuildOp => translate([xLo, yLo, zLo], cube([xHi - xLo, yHi - yLo, zHi - zLo]));

  for (const m of mounts) {
    const bXMin = origin.x + m.position.x;
    const bXMax = bXMin + m.size.x;
    const bYMin = origin.y + m.position.y;
    const bYMax = bYMin + m.size.y;
    const boardBottomZ = floorTop + m.standoffHeight;
    const boardTopZ = boardBottomZ + m.size.z;
    const overhang = m.overhang ?? DEFAULT_OVERHANG;

    for (const clip of m.clips) {
      ops.push(
        ...buildClip(clip, bXMin, bXMax, bYMin, bYMax, boardBottomZ, boardTopZ, floorTop, overhang, box),
      );
    }
  }
  return { caseAdditive: ops };
}

function buildClip(
  clip: BoardClip,
  bXMin: number, bXMax: number, bYMin: number, bYMax: number,
  boardBottomZ: number, boardTopZ: number, floorTop: number, overhang: number,
  box: (xLo: number, xHi: number, yLo: number, yHi: number, zLo: number, zHi: number) => BuildOp,
): BuildOp[] {
  const axis: 'x' | 'y' = clip.edge === '+x' || clip.edge === '-x' ? 'x' : 'y';
  // inwardSign points from the arm (outboard) toward the board interior.
  const inwardSign = clip.edge === '-x' || clip.edge === '-y' ? +1 : -1;
  const boardEdge =
    clip.edge === '-x' ? bXMin : clip.edge === '+x' ? bXMax : clip.edge === '-y' ? bYMin : bYMax;
  // Position along the edge, from the board's min corner on the tangent axis.
  const tCenter = axis === 'x' ? bYMin + clip.offset : bXMin + clip.offset;

  const armInner = boardEdge - inwardSign * GAP;                 // just outboard of the edge
  const armOuter = boardEdge - inwardSign * (GAP + ARM_T);
  const ledgeInner = boardEdge + inwardSign * LEDGE_D;           // reaches under the board
  const hookInner = boardEdge + inwardSign * overhang;          // reaches over the board
  const nr = (a: number, b: number): [number, number] => [Math.min(a, b), Math.max(a, b)];
  const [armLo, armHi] = nr(armInner, armOuter);
  const [ledLo, ledHi] = nr(armInner, ledgeInner);
  const [hookLo, hookHi] = nr(armInner, hookInner);
  const tLo = tCenter - CLIP_W / 2;
  const tHi = tCenter + CLIP_W / 2;
  const armZLo = floorTop - EMBED;
  const armZHi = boardTopZ + HOOK_THK;

  // Map (normal, tangent) → (x, y): normal is the clip's edge axis.
  const mk = (nLo: number, nHi: number, zLo: number, zHi: number): BuildOp =>
    axis === 'y' ? box(tLo, tHi, nLo, nHi, zLo, zHi) : box(nLo, nHi, tLo, tHi, zLo, zHi);

  return [
    mk(armLo, armHi, armZLo, armZHi),                              // spring arm / post
    mk(ledLo, ledHi, boardBottomZ - LEDGE_THK, boardBottomZ),      // rest ledge
    mk(hookLo, hookHi, boardTopZ, boardTopZ + HOOK_THK),           // hook lip
  ];
}
