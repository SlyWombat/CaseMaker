import type { Mm } from './units';

export type ComponentKind =
  | 'usb-c'
  | 'usb-a'
  | 'usb-b'
  | 'micro-usb'
  | 'hdmi'
  | 'micro-hdmi'
  | 'barrel-jack'
  | 'ethernet-rj45'
  | 'gpio-header'
  | 'sd-card'
  | 'flat-cable'
  | 'fan-mount'
  | 'text-label'
  | 'custom';

export type Facing = '+x' | '-x' | '+y' | '-y' | '+z';

export interface MountingHole {
  id: string;
  x: Mm;
  y: Mm;
  diameter: Mm;
}

export interface BoardComponent {
  id: string;
  kind: ComponentKind;
  position: { x: Mm; y: Mm; z: Mm };
  size: { x: Mm; y: Mm; z: Mm };
  facing?: Facing;
  cutoutMargin?: Mm;
}

export interface BoardProfile {
  id: string;
  name: string;
  manufacturer: string;
  pcb: { size: { x: Mm; y: Mm; z: Mm } };
  mountingHoles: MountingHole[];
  components: BoardComponent[];
  defaultStandoffHeight: Mm;
  recommendedZClearance: Mm;
  source?: string;
  builtin: boolean;
}
