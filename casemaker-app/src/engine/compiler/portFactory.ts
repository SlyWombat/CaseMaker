import type { BoardProfile, PortPlacement } from '@/types';
import { newId } from '@/utils/id';

const DEFAULT_MARGIN = 0.5;

export function autoPortsForBoard(board: BoardProfile): PortPlacement[] {
  const out: PortPlacement[] = [];
  for (const c of board.components) {
    if (!c.facing || c.facing === '+z') continue;
    out.push({
      id: newId(`port-${c.id}`),
      sourceComponentId: c.id,
      kind: c.kind,
      position: { x: c.position.x, y: c.position.y, z: c.position.z },
      size: { x: c.size.x, y: c.size.y, z: c.size.z },
      facing: c.facing,
      cutoutMargin: c.cutoutMargin ?? DEFAULT_MARGIN,
      locked: false,
      enabled: true,
    });
  }
  return out;
}
