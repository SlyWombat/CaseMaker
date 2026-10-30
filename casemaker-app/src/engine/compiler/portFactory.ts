import type { BoardProfile, ComponentKind, PortPlacement } from '@/types';
import { newId } from '@/utils/id';

const DEFAULT_MARGIN = 0.5;

/**
 * #404 — A USB-C CUTOUT TAKES THE CABLE PLUG, NOT THE BARE RECEPTACLE.
 *
 * The generic 0.5 mm margin opened a 9 × 3.2 mm receptacle to 10 × 4.2 mm, while an overmoulded
 * USB-C plug is roughly 12 × 6.5 mm: in a normal wall the plug body meets the wall before the
 * connector can seat, unless the board sits at the wall face. 1.75 mm per edge opens the same
 * component to 12.5 × 6.7 mm, centred on it.
 *
 * The 1.75 is an estimate from a typical overmoulded plug, not a measured one — it wants a plug
 * measurement or a test print before it is treated as final. A component's own `cutoutMargin`
 * still wins over this table, and the per-port editor (#68) remains the override in both
 * directions.
 */
const KIND_MARGINS: Partial<Record<ComponentKind, number>> = { 'usb-c': 1.75 };

/** The cutout margin for a component with no `cutoutMargin` of its own. */
export function defaultMarginFor(kind: ComponentKind): number {
  return KIND_MARGINS[kind] ?? DEFAULT_MARGIN;
}

export function autoPortsForBoard(board: BoardProfile): PortPlacement[] {
  const out: PortPlacement[] = [];
  for (const c of board.components) {
    if (!c.facing || c.facing === '+z') continue;
    // Issue #100 — antenna-connector components are owned by the Antenna
    // feature (defaultAntennasForBoard auto-instantiates one). Skip the
    // generic auto-port so we don't end up with two cutouts at the same
    // location: a wrong-shaped rectangular port + the proper antenna hole.
    if (c.kind === 'antenna-connector') continue;
    out.push({
      id: newId(`port-${c.id}`),
      sourceComponentId: c.id,
      kind: c.kind,
      position: { x: c.position.x, y: c.position.y, z: c.position.z },
      size: { x: c.size.x, y: c.size.y, z: c.size.z },
      facing: c.facing,
      cutoutMargin: c.cutoutMargin ?? defaultMarginFor(c.kind),
      locked: false,
      enabled: true,
      cutoutShape: c.cutoutShape,
    });
  }
  return out;
}
