import type { Mm, Deg } from './units';
import type { BoardProfile } from './board';
import type { CaseParameters } from './case';
import type { PortPlacement } from './port';
import type { HatProfile, HatPlacement } from './hat';
import type { MountingFeature } from './mounting';
import type { DisplayProfile, DisplayPlacement } from './display';
import type { FanMount } from './fan';
import type { TextLabel, CustomFont } from './textLabel';
import type { AntennaPlacement } from './antenna';
import type { PrinterVolume } from './printer';

export interface ExternalAsset {
  id: string;
  name: string;
  format: 'stl' | '3mf';
  data: string;
  transform: {
    position: [Mm, Mm, Mm];
    rotation: [Deg, Deg, Deg];
    scale: number;
  };
  visibility: 'reference' | 'subtract' | 'union';
}

export type ProjectSchemaVersion =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

export interface Project {
  schemaVersion: ProjectSchemaVersion;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  board: BoardProfile;
  case: CaseParameters;
  ports: PortPlacement[];
  externalAssets: ExternalAsset[];
  hats: HatPlacement[];
  customHats: HatProfile[];
  mountingFeatures: MountingFeature[];
  display: DisplayPlacement | null;
  customDisplays: DisplayProfile[];
  /** Fan mounts (issue #14, schemaVersion 4+). */
  fanMounts: FanMount[];
  /** Engraved/embossed text labels (issue #16, schemaVersion 4+). */
  textLabels: TextLabel[];
  /** Antennas (issue #19, schemaVersion 5+). */
  antennas: AntennaPlacement[];
  /** User-supplied fonts embedded for text labels (issue #169, schemaVersion 8+). */
  customFonts: CustomFont[];
  /**
   * The bed this project is printed on (issue #148, schemaVersion 14+).
   *
   * Optional: absent means "no fit checking", exactly as an absent
   * `case.rack.printer` did. Read it through `resolvePrinter`, never directly —
   * that is what keeps projects written before the move (which carry the bed on
   * `case.rack.printer`) working.
   */
  printer?: PrinterVolume;
}
