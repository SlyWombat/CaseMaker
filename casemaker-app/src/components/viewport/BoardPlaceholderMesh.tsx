import { useMemo } from 'react';
import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import { buildBoardPlaceholderGroup } from '@/engine/scene/boardPlaceholder';

/**
 * Render a representative 3D model of the host board inside the case cavity.
 *
 * Until per-board GLB / photo assets are bundled (see docs/board-assets.md and
 * issue #35), we synthesize a placeholder from the schema-driven
 * `BoardProfile.components` so users always see something — green PCB plus
 * coloured connector blocks. When `visualAssets.glb` is wired up later, this
 * component will defer to it.
 */
export function BoardPlaceholderMesh() {
  const board = useProjectStore((s) => s.project.board);
  const params = useProjectStore((s) => s.project.case);
  const showBoard = useViewportStore((s) => s.showBoard);
  const visualization = useViewportStore((s) => s.boardVisualization);

  const group = useMemo(() => {
    const wall = params.wallThickness;
    const cl = params.internalClearance;
    const floor = params.floorThickness;
    const standoff = board.defaultStandoffHeight;
    return buildBoardPlaceholderGroup(board, {
      origin: { x: wall + cl, y: wall + cl, z: floor + standoff },
    });
  }, [
    board,
    params.wallThickness,
    params.internalClearance,
    params.floorThickness,
  ]);

  // Issue #72 — 'none' explicitly hides the board renderer, separate from
  // the showBoard layer toggle. 'photo' and '3d' fall back to the
  // schematic placeholder until per-board GLB / image assets ship.
  if (!showBoard || visualization === 'none') return null;
  return <primitive object={group} />;
}
