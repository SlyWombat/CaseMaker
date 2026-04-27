import type { Mm } from './units';
import type { MountingHole, BoardComponent } from './board';
import type { PortPlacement } from './port';

export interface HatProfile {
  id: string;
  name: string;
  manufacturer: string;
  pcb: { size: { x: Mm; y: Mm; z: Mm } };
  mountingHoles: MountingHole[];
  /**
   * Gap between the bottom of the HAT PCB and the top of the host PCB it sits on,
   * driven by the GPIO header / shield connector height. Standard 0.1" headers
   * give ~8.5 mm; stacking headers may give 11-15 mm.
   */
  headerHeight: Mm;
  /** Side-facing connectors on the HAT PCB itself (DMX, RJ-45, etc.). */
  components: BoardComponent[];
  /** Empty array = generic / universally compatible. */
  compatibleBoards: string[];
  source?: string;
  builtin: boolean;
}

export interface HatPlacement {
  id: string;
  hatId: string;
  /** 0 = directly on the host board, 1 = on top of stack[0], etc. */
  stackIndex: number;
  /** mm — overrides the HAT's default headerHeight if non-null. */
  liftOverride?: number;
  /** mm — XY offset relative to the host PCB origin. Default is centered match-up. */
  offsetOverride?: { x: Mm; y: Mm };
  /** Auto-generated cutouts mirroring the HAT's components, with per-port toggles. */
  ports: PortPlacement[];
  enabled: boolean;
}
