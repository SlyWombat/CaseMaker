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

export type ProjectSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

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
}
