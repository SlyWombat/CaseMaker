import type { Mm } from './units';

/**
 * A font registry id: a bundled font ('sans-default', 'mono-default',
 * 'serif-default') or the id of a `CustomFont` embedded in the project.
 */
export type TextFont = string;

/** A user-supplied TTF/OTF embedded in the project, base64 like ExternalAsset.data. */
export interface CustomFont {
  id: string;
  name: string;
  /** base64 of the font file. */
  data: string;
}
export type TextWeight = 'regular' | 'bold';
export type TextMode = 'engrave' | 'emboss';

import type { CaseFace } from './case';
export type { CaseFace };

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
