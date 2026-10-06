import type { Mm, BBox } from './units';
import type { NodeVariant } from './variant';

export interface MeshBuffer {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface MeshStats {
  vertexCount: number;
  triangleCount: number;
  bbox: BBox;
  /** Issue #83 — number of disjoint solid components in this node. A clean
   *  shell or lid has exactly 1; >1 means at least one piece broke loose
   *  from its parent (a snap-fit lip not unioned with the wall, an
   *  orphaned cutout fragment, etc.) and will fall to the build plate
   *  in the slicer. Surfaced as a warning, not a hard error — the user
   *  can still export and clean up in their slicer. */
  componentCount?: number;
}

/**
 * Issue #168 — what the SLICER needs to know about a part beyond its geometry.
 *
 * Careful with the word "material": `partForId` in `@/engine/exporters/parts`
 * already reports a `material: 'rigid' | 'flex'` for the parts table, meaning
 * the FILAMENT CLASS (print the gasket in TPU). This is the other half — the
 * assignment a multi-material machine needs: which tool prints it, at what
 * infill, and whether it belongs in the main file at all. Both can be true of
 * the same part and neither implies the other, so they are deliberately
 * separate fields rather than one wider enum.
 *
 * Every field is optional and absent means today's behaviour exactly, so a
 * project that says nothing here exports byte-identically to before #168.
 */
export interface NodeMaterial {
  /** 1-based tool/extruder index, as the slicer counts them. */
  extruder?: number;
  /** Object-level `fill_density`, in the slicer's own units (`'15%'`). */
  fillDensity?: string;
  /** Write this part as its own file rather than in the main bundle (#108). */
  separateFile?: boolean;
}

export interface MeshNode {
  id: string;
  buffer: MeshBuffer;
  stats: MeshStats;
  /**
   * Issue #168 — copied from the `BuildNode` this mesh was built from, so the
   * export path can group and tag parts without re-deriving anything from ids.
   */
  material?: NodeMaterial;
  /**
   * Issue #148 — copied from the `BuildNode` too, and for the same reason:
   * whether this node is an alternative to other parts is a property of the
   * node, not something to guess back out of its id at each call site.
   */
  variant?: NodeVariant;
}

export interface BuildResult {
  generation: number;
  nodes: MeshNode[];
  combinedStats: MeshStats;
  durationMs: Mm;
}
