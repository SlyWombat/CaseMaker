import type { Mm, Deg } from './units';
import type { BoardProfile } from './board';
import type { CaseParameters } from './case';
import type { PortPlacement } from './port';
import type { HatProfile, HatPlacement } from './hat';

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

export type ProjectSchemaVersion = 1 | 2;

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
  /** Stacked HATs / shields (Phase 8a, schemaVersion 2+). v1 projects default to []. */
  hats: HatPlacement[];
  /** User-defined HAT profiles (schemaVersion 2+). v1 projects default to []. */
  customHats: HatProfile[];
}
