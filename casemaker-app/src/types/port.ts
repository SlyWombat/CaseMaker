import type { Mm } from './units';
import type { ComponentKind, Facing } from './board';

export interface PortPlacement {
  id: string;
  sourceComponentId: string | null;
  kind: ComponentKind;
  position: { x: Mm; y: Mm; z: Mm };
  size: { x: Mm; y: Mm; z: Mm };
  facing: Facing;
  cutoutMargin: Mm;
  locked: boolean;
}
