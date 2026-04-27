import type { Mm } from './units';
import type { MountingHole, BoardComponent } from './board';
import type { PortPlacement } from './port';

export type HatRotation = 0 | 90 | 180 | 270;

export interface HatMountingPosition {
  id: string;
  label: string;
  offset: { x: Mm; y: Mm };
  rotation: HatRotation;
}

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
  /**
   * Valid mounting positions for HATs that support more than one orientation.
   * The first entry is the default. Empty/undefined = single canonical orientation.
   */
  mountingPositions?: HatMountingPosition[];
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
  /** When the HAT profile has mountingPositions, names the chosen entry. */
  mountingPositionId?: string;
  /** Auto-generated cutouts mirroring the HAT's components, with per-port toggles. */
  ports: PortPlacement[];
  enabled: boolean;
}
