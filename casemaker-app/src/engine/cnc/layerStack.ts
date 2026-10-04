/**
 * The layer stack (#178): the compiled solid sliced on the printer's real layer grid.
 *
 * Depth decisions in V1 are geometric facts, never hand-coded rules (`/Fabrication.md` §7.1,
 * decisions 21 and 22). This module slices the part the app already compiled — its outline and
 * the voids it put in it — on the printer's ACTUAL layer boundaries, and exposes two answers
 * from that one structure:
 *
 *  - where the colour boundary is (`colourBoundaryDepth`), on a real layer line, not the ideal
 *    design height; and
 *  - how deep a cutter may go at any XY (`maxDepthAt`), by descending the stack from the
 *    engraved face: a point is cuttable to depth d only if it is solid in every layer between.
 *
 * The magnet pocket needs NO special case. It is a void in the compiled solid, so a point over
 * its footprint is simply not solid in the layers above the pocket ceiling and the limit comes
 * out shallower on its own — as it would for any future pocket, slot or counterbore. There is
 * no pocket rectangle, footprint or depth anywhere in this module.
 *
 * FRAME. Depths are measured DOWN from the engraved face, which is index 0 — the datum face the
 * cutter touches. This is the work frame of `verify.ts` (Z = 0 on the probed engraved face,
 * cuts negative, `/Fabrication.md` §7.2), and it is the frame every `maxDepthAt` result is in.
 * The part plan this reads is authored in the PART frame (z = 0 is the BACK face; the engraved
 * face is at z = thickness), so the two stock fields that carry a z are flipped here, once:
 * `split` and `keepOut[].zCeiling` are part-frame z, converted to a depth as `thickness − z`.
 *
 * OWNERSHIP. Every `CrossSection` lives on the wasm heap and must be `delete()`d. The stack owns
 * every one it creates (the layer sections, the running intersections and the empty section) and
 * frees them all in `dispose()`. The `CrossSection` returned by `cuttableAt` is one of those
 * owned objects: the CALLER MUST NOT delete it. `maxDepthAt` returns a plain number.
 *
 * The issue's `buildLayerStack(part, layerHeight)` takes the Manifold toplevel as its first
 * argument here, matching `executeProfile(tl, p)` (`workers/geometry/evaluateOp.ts`): the stack
 * runs beside it in the geometry worker, and the node-side tests pass the harness toplevel.
 */

import type { Profile } from '@/engine/compiler/profile';
import type { Mm, Vec2 } from '@/types/units';
import { executeProfile, type ManifoldToplevel } from '@/workers/geometry/evaluateOp';

type CrossSection = InstanceType<ManifoldToplevel['CrossSection']>;

/** A void opening at the back face: a cavity from the part's back face up to its ceiling. */
export interface LayerStackKeepOut {
  /** The void's footprint, in the part/work XY frame. */
  footprint: Profile;
  /** PART-frame z of the void's ceiling; the void spans z ∈ [0, zCeiling]. */
  zCeiling: Mm;
}

/**
 * The `PartPlan.stock` the badge compiler produces (#167/#172) — the structural subset this
 * module reads. A full `PartPlan` is assignable to it.
 */
export interface LayerStackPart {
  stock: {
    /** Outline of the part in the work XY frame (front-left at the origin). */
    outline: Profile;
    /** The MODEL's thickness from the compiled plan (decision 24). A MEASURED blank thickness
     *  is never an input — the back face carries the error and nothing references it. */
    thickness: Mm;
    /** Colour change height in the PART frame (z from the back face), as `make_badge.py --split`. */
    split: Mm;
    keepOuts: readonly LayerStackKeepOut[];
  };
}

export interface LayerStackLayer {
  /** Depth below the engraved face at which the layer starts; index 0 starts at the face. */
  z0: Mm;
  /** Depth below the engraved face at which the layer ends (its top, away from the cutter). */
  z1: Mm;
  /** The material present in this layer, in the XY frame. OWNED by the stack — do not delete. */
  section: CrossSection;
  /** The extruder this layer came from, when the compiler's per-node material tag (#168) supplies it. */
  extruder?: number;
}

export interface LayerStack {
  /** The uniform layer height the grid was built on. */
  layerHeight: Mm;
  /** The first layer's height; equals `layerHeight` unless the blank spec prescribes otherwise. */
  firstLayerHeight: Mm;
  /** Layer boundaries as depth below the engraved face, ascending from 0 to `thickness`. */
  boundaries: readonly Mm[];
  /** The layers, index 0 touching the engraved face. */
  layers: readonly LayerStackLayer[];
  /** Depth below the engraved face at which the extruder assignment changes (decision 27). */
  colourBoundaryDepth: Mm;
  /**
   * Running intersection from the face down to `depth` — the region solid all the way, i.e.
   * safe to cut to that depth. The returned section is OWNED by the stack; do not delete it.
   */
  cuttableAt(depth: Mm): CrossSection;
  /** Max depth below the engraved face a cutter may reach at (x, y). 0 = no cutting allowed. */
  maxDepthAt(x: Mm, y: Mm): Mm;
  /** Free every `CrossSection` the stack owns. Idempotent; the stack is unusable afterwards. */
  dispose(): void;
}

const EPS = 1e-9;

/** Even-odd point-in-region over a set of contours (holes included, whichever way they wind). */
function pointInPolys(polys: readonly Vec2[][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of polys) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i]![0];
      const yi = ring[i]![1];
      const xj = ring[j]![0];
      const yj = ring[j]![1];
      const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (crosses) inside = !inside;
    }
  }
  return inside;
}

/** The boundary nearest to `depth`, so a nominal (off-grid) split lands on a real layer line. */
function nearestBoundary(depth: number, boundaries: readonly Mm[]): Mm {
  let best = boundaries[0]!;
  for (const b of boundaries) {
    if (Math.abs(b - depth) < Math.abs(best - depth) - EPS) best = b;
  }
  return best;
}

/**
 * Build the layer stack. Layers are `[0, firstLayerHeight]` then uniform `layerHeight` steps up
 * to `thickness` (decision 27: the first layer is its own size, `h₁ + k·h`). A layer counts as
 * solid where the compiled solid spans it — a void that reaches into a layer removes its
 * footprint from that layer, so the void query is slicer-independent (decision 27).
 */
export function buildLayerStack(
  tl: ManifoldToplevel,
  part: LayerStackPart,
  layerHeight: Mm,
  firstLayerHeight: Mm = layerHeight,
): LayerStack {
  if (!(layerHeight > 0)) throw new Error(`layerHeight must be > 0 (got ${layerHeight})`);
  if (!(firstLayerHeight > 0)) throw new Error(`firstLayerHeight must be > 0 (got ${firstLayerHeight})`);
  const { outline, thickness, split, keepOuts } = part.stock;
  if (!(thickness > 0)) throw new Error(`stock.thickness must be > 0 (got ${thickness})`);

  // Every CrossSection the stack creates goes in here and is freed once, in dispose(). Deletes
  // are identity-based, so a section aliased into more than one place is still deleted once.
  const owned = new Set<CrossSection>();
  const own = <T extends CrossSection>(cs: T): T => {
    owned.add(cs);
    return cs;
  };
  let disposed = false;

  // ---- the layer grid, in depth below the engraved face --------------------------------
  const boundaries: Mm[] = [0];
  for (let k = 1, b = firstLayerHeight; b < thickness - EPS; k++, b = firstLayerHeight + (k - 1) * layerHeight) {
    boundaries.push(b);
  }
  boundaries.push(thickness);

  const outlineCS = own(executeProfile(tl, outline));

  // ---- per-layer material: the outline minus every void that reaches into the layer -----
  const layers: LayerStackLayer[] = [];
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const z0 = boundaries[i]!;
    const z1 = boundaries[i + 1]!;
    // A void spans depth [thickness − zCeiling, thickness]; it reaches into this layer when the
    // layer's far edge is past its ceiling.
    const reaching = keepOuts.filter((k) => k.zCeiling > EPS && z1 > thickness - k.zCeiling + EPS);
    let section: CrossSection;
    if (reaching.length === 0) {
      section = outlineCS; // alias; already owned, so dispose still deletes it exactly once
    } else {
      const footprints = reaching.map((k) => executeProfile(tl, k.footprint));
      const union = tl.CrossSection.union(footprints);
      footprints.forEach((f) => f.delete());
      section = own(outlineCS.subtract(union));
      union.delete();
    }
    own(section);
    layers.push({ z0, z1, section });
  }

  // ---- the running intersection: solid in every layer from the face down ---------------
  const running: CrossSection[] = new Array(layers.length);
  let prev: CrossSection | null = null;
  for (let i = 0; i < layers.length; i++) {
    const r: CrossSection = prev === null ? layers[i]!.section : own(prev.intersect(layers[i]!.section));
    running[i] = own(r);
    prev = r;
  }

  // The empty section, for a query at or above the face. `union([])` is how Manifold makes one.
  const empty = own(tl.CrossSection.union([]));

  const last = layers[layers.length - 1]!;
  const colourBoundaryDepth = nearestBoundary(thickness - split, boundaries);

  // Lazily converted to polygons for point queries; JS arrays, no wasm handles.
  const polys: (Vec2[][] | null)[] = new Array(layers.length).fill(null);

  return {
    layerHeight,
    firstLayerHeight,
    boundaries,
    layers,
    colourBoundaryDepth,
    cuttableAt(depth: Mm): CrossSection {
      if (depth <= 0) return empty;
      for (let i = 0; i < layers.length; i++) {
        const l = layers[i]!;
        if (depth <= l.z1 + EPS) return running[i]!;
      }
      return running[running.length - 1]!;
    },
    maxDepthAt(x: Mm, y: Mm): Mm {
      for (let i = 0; i < running.length; i++) {
        const p = polys[i] ?? (polys[i] = running[i]!.toPolygons());
        if (!pointInPolys(p, x, y)) {
          return i === 0 ? 0 : layers[i - 1]!.z1;
        }
      }
      return last.z1;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const cs of owned) cs.delete();
      owned.clear();
    },
  };
}
