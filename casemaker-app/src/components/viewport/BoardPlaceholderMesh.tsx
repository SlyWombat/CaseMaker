import { useMemo } from 'react';
import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import { cavityOriginXY } from '@/engine/coords';
import { buildBoardPlaceholderGroup } from '@/engine/scene/boardPlaceholder';

/**
 * Render a representative 3D model of the host board inside the case cavity.
 *
 * Until per-board GLB / photo assets are bundled (see docs/board-assets.md and
 * issue #35), we synthesize a placeholder from the schema-driven
 * `BoardProfile.components` so users always see something — green PCB plus
 * coloured connector blocks. When `visualAssets.glb` is wired up later, this
 * component will defer to it.
 *
 * Issue #83 — when the Select tool is active, clicking the placeholder selects
 * the host PCB so the SelectionPanel can edit standoff Z (and, eventually,
 * X/Y once the schema migration lands).
 */
export function BoardPlaceholderMesh() {
  const board = useProjectStore((s) => s.project.board);
  const params = useProjectStore((s) => s.project.case);
  const showBoard = useViewportStore((s) => s.showBoard);

  const group = useMemo(() => {
    const xy = cavityOriginXY(params);
    const floor = params.floorThickness;
    const standoff = board.defaultStandoffHeight;
    return buildBoardPlaceholderGroup(board, {
      origin: { x: xy.x, y: xy.y, z: floor + standoff },
    });
  }, [
    board,
    params.wallThickness,
    params.internalClearance,
    params.clearanceTweaks,
    params.floorThickness,
  ]);

  // Issue #59 — boardVisualization cycle removed; board visibility is just
  // the showBoard layer toggle now.
  if (!showBoard) return null;
  return (
    <primitive
      object={group}
      onClick={(e: { stopPropagation: () => void }) => {
        // Issue #83 — read activeTool fresh at click time so the gate
        // tracks the current tool, not whatever was captured at mount.
        const { activeTool, showBoard: showBoardNow, setSelection } =
          useViewportStore.getState();
        if (activeTool !== 'select' || !showBoardNow) return;
        e.stopPropagation();
        setSelection({ kind: 'host' });
      }}
    />
  );
}
