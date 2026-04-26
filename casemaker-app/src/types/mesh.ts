import type { Mm, BBox } from './units';

export interface MeshBuffer {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface MeshStats {
  vertexCount: number;
  triangleCount: number;
  bbox: BBox;
}

export interface MeshNode {
  id: string;
  buffer: MeshBuffer;
  stats: MeshStats;
}

export interface BuildResult {
  generation: number;
  nodes: MeshNode[];
  combinedStats: MeshStats;
  durationMs: Mm;
}
