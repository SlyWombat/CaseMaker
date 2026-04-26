import type { Mm, Deg } from './units';
import type { BoardProfile } from './board';
import type { CaseParameters } from './case';
import type { PortPlacement } from './port';

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

export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  board: BoardProfile;
  case: CaseParameters;
  ports: PortPlacement[];
  externalAssets: ExternalAsset[];
}
