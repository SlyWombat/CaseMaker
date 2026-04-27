import type { Mm } from './units';

export type TextFont = 'sans-default' | 'mono-default';
export type TextWeight = 'regular' | 'bold';
export type TextMode = 'engrave' | 'emboss';

export type CaseFace = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export interface TextLabel {
  id: string;
  text: string;
  font: TextFont;
  weight: TextWeight;
  /** mm cap height. */
  size: Mm;
  face: CaseFace;
  position: { u: Mm; v: Mm };
  rotation: number;
  /** mm — depth of engraving below face / extrusion above face. */
  depth: Mm;
  mode: TextMode;
  enabled: boolean;
  attachedToPortId?: string;
}
