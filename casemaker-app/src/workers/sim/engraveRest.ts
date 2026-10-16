/**
 * The REST of a design, after the first tool has been through it (#410, the issue's scope
 * comment: "it can cut the larger area out first, then use a corn cutter to trace around the
 * areas that the larger cutter could not get to, with applicable overlap passes").
 *
 * The load-bearing word in that sentence is SIMULATED. A first pass with a ⌀2 mm cutter
 * "reaches 73 % of the title" is a statement about the offsets of the design's outlines in
 * plan view; it says nothing about what the program that was actually generated left behind —
 * which XY the toolpaths really covered, at which Z, and therefore where the material still
 * standing is. So the rest region is measured against the FIRST PROGRAM'S OWN SWEEP: the
 * removal solid the simulation produced, cross-sectioned at each cut's floor.
 *
 * Three quantities come out of that, and they are the three the operator needs:
 *
 *   cutArea      what this item asks for, opened by the second tool (the design)
 *   clearedArea  the share of it the first program really removed (design ∩ removal)
 *   restArea     what the second tool still has to cut (design − removal, grown back into the
 *                first tool's territory by `overlap` so the two programs double-cut the seam)
 *
 * and `design − (removal1 ∪ removal2)` — the material neither program will touch — is what the
 * second program's own sweep then answers, because that sweep is seeded with this removal
 * (`SimLoadOpts.priorRemoval`). Nothing here is an offset standing in for a cut.
 *
 * The polygons handed in and the polygons handed back are both in the STOCK frame (the job's
 * own frame), because that is the frame `engraveRegions` measures in and the frame a job's
 * items are placed by. Nothing is re-placed here.
 */

import type { ManifoldToplevel } from '../geometry/evaluateOp';
import { manifoldOfMesh, meshOutputOf, type NodeMeshOutput } from '../geometry/meshOutput';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;
type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;

/**
 * How far ABOVE a cut's floor the removal is sampled, mm.
 *
 * A cut's floor is a plane the removal solid's own bottom face lies ON, so slicing exactly at
 * it is a degenerate question ("is material removed at the boundary?") with no stable answer.
 * Sampling a hair above it asks the question that matters — "is the material gone just above
 * where the floor should be?" — and the value is chosen from the pipeline's own tolerances
 * rather than from taste: an order of magnitude above the sweep's chord (0.005 mm) and
 * simplify (0.002 mm) tolerances, so no rounding in the mesh can flip the answer, and a
 * twentieth of a layer height, so no real material hiding below it is ignored.
 */
export const REST_PLANE_EPS_MM = 0.01;

/**
 * A closed solid from a mesh the sweep produced (`meshes.removal`, `meshes.result`), or null
 * when it is not one. `manifoldOfMesh` is the other half of `meshOutputOf`; the weld it does
 * there is what lets a mesh from the worker build a solid here.
 */
export function solidFromMesh(tl: ManifoldToplevel, mesh: NodeMeshOutput): ManifoldInstance | null {
  return manifoldOfMesh(tl, mesh);
}

/**
 * Everything a set of programs removed, as ONE mesh — the union of their removal solids.
 *
 * This is what turns "what did the two of them leave standing?" into the same measurement as "what
 * did the first one leave?": hand this to {@link restMachining} as the removal, with an overlap of
 * zero, and `restArea` is the material no program touched, per item, at its own floor. Nothing new
 * decides anything — the union is the same solid the chained sweep would have reached, and the
 * measurement is the one already written.
 *
 * Null when nothing in the list is a closed solid, which is the honest answer to "nothing was
 * removed": every region is then whole, exactly as an absent `removal` reads.
 */
export function unionRemoval(
  tl: ManifoldToplevel,
  meshes: readonly (NodeMeshOutput | null)[],
): NodeMeshOutput | null {
  const solids: ManifoldInstance[] = [];
  for (const mesh of meshes) {
    if (mesh === null) continue;
    const solid = solidFromMesh(tl, mesh);
    if (solid !== null) solids.push(solid);
  }
  if (solids.length === 0) return null;
  const first = solids[0]!;
  if (solids.length === 1) {
    const out = meshOutputOf(first);
    first.delete();
    return out;
  }
  // One `add` at a time and a mesh read at the end: `getMesh()` forces the lazy boolean, so every
  // handle below can be freed the moment the copy exists (playback.ts, ONE MANIFOLD TRAP).
  let running = first;
  for (const next of solids.slice(1)) {
    const merged = running.add(next);
    running.delete();
    next.delete();
    running = merged;
  }
  const out = meshOutputOf(running);
  running.delete();
  return out;
}

/** What one item's cut asks for, at its own depth — `engraveRegions`' `CutRegion`. */
export interface RestCut {
  id: string;
  name?: string;
  /** Positive mm below the top face. */
  depth: number;
  /** Outer CCW, holes CW, in the stock frame. */
  polygons: [number, number][][];
}

export interface RestInput {
  /**
   * What the first program ACTUALLY removed, as its sweep's mesh. `null` when the sweep produced
   * none (nothing was cut, or the mesh was not a solid) — every cut is then rest in full, which
   * is the honest reading of "the first tool removed nothing".
   */
  removal: NodeMeshOutput | null;
  /** The regions the second tool would cut, each at its own depth — `engraveRegions(…).cuts`. */
  cuts: readonly RestCut[];
  /**
   * How far the rest pass reaches back into the first tool's territory, mm. This is the width of
   * the band BOTH programs cut: the seam between them is cut twice, so a ridge left there is a
   * ridge both cutters would have had to leave.
   */
  overlap: number;
}

export interface RestRegion {
  /** The cut's own id, so a caller can name the item this rest belongs to. */
  id: string;
  name?: string;
  depth: number;
  /** Outer CCW, holes CW, in the stock frame — ready to be an item of the second job. */
  polygons: [number, number][][];
  /** mm² of the rest region (`polygons`). */
  area: number;
  /** mm² the item asks for, opened by the second tool. */
  cutArea: number;
  /** mm² of `cutArea` the first program removed. */
  clearedArea: number;
}

export interface RestResult {
  regions: RestRegion[];
  /** Totals over every cut handed in, mm². */
  cutArea: number;
  clearedArea: number;
  restArea: number;
  /** Facts about the measurement itself, for the run sheet — never silently empty. */
  notes: string[];
}

/** `0.71 mm²`, no float noise. */
function mm2(v: number): string {
  return `${Number(v.toFixed(2))} mm²`;
}

/**
 * `0.493 mm`, at the precision the sheet prints a band at — the same three places
 * `restSettings` uses. The band is DERIVED (#436), so it arrives as
 * `0.49302855497458753` and would print as that if it went in raw.
 */
function mm(v: number): string {
  return `${Number(v.toFixed(3))} mm`;
}

/**
 * Measure the rest region. Every handle this opens is closed before it returns.
 *
 * Regions with nothing left to cut are DROPPED, not returned empty: a zero-area item is an
 * `item-empty` refusal in the generator, and "this cutter already finished that one" is a fact
 * for the run sheet, not an item for the second job.
 */
export function restMachining(tl: ManifoldToplevel, input: RestInput): RestResult {
  const CS = tl.CrossSection;
  const notes: string[] = [];
  const regions: RestRegion[] = [];
  let cutArea = 0;
  let clearedArea = 0;
  let restArea = 0;

  const solid = input.removal === null ? null : solidFromMesh(tl, input.removal);
  if (input.removal !== null && solid === null) {
    notes.push(
      'the first program’s removal was not a closed solid, so nothing could be measured against it ' +
        '— every region below counts as rest in full.',
    );
  }
  if (input.removal === null) {
    notes.push('the first program removed nothing, so the rest pass is the whole design.');
  }

  // One cross-section per distinct floor plane: a job's items routinely share a depth, and a
  // slice of a swept solid is the expensive part of this.
  const byDepth = new Map<number, RestCut[]>();
  for (const cut of input.cuts) {
    if (cut.polygons.length === 0) continue;
    const group = byDepth.get(cut.depth);
    if (group === undefined) byDepth.set(cut.depth, [cut]);
    else group.push(cut);
  }

  try {
    for (const [depth, cuts] of byDepth) {
      // The material the first program removed, at least as deep as this item's floor. Slices
      // are per DEPTH because the removal is a solid, not a stencil: a 0.4 mm floor is cleared
      // in places a 0.998 mm floor is not.
      let cleared: CrossSectionInstance | null = null;
      if (solid !== null) {
        const slice = solid.slice(REST_PLANE_EPS_MM - depth);
        if (slice.isEmpty()) slice.delete();
        else cleared = slice;
      }
      for (const cut of cuts) {
        const design = CS.ofPolygons(cut.polygons, 'EvenOdd');
        const designArea = design.area();
        cutArea += designArea;

        let thisCleared = 0;
        let rest: CrossSectionInstance;
        if (cleared === null) {
          rest = design.translate([0, 0]);
        } else {
          const hit = design.intersect(cleared);
          thisCleared = hit.area();
          hit.delete();
          clearedArea += thisCleared;
          // The rest region, grown back into the first tool's territory by `overlap` and clipped
          // to the design again — so the growth lands on the SEAM and nowhere else. `simplify`
          // after an offset is the documented cleanup for the slivers an offset introduces, and
          // those slivers would otherwise become a second item's worth of noise in the toolpath.
          const raw = design.subtract(cleared).offset(input.overlap, 'Round');
          const clean = raw.simplify();
          raw.delete();
          rest = clean.intersect(design);
          clean.delete();
        }
        design.delete();

        const area = rest.area();
        restArea += area;
        if (area > 0) {
          regions.push({
            id: cut.id,
            ...(cut.name === undefined ? null : { name: cut.name }),
            depth: cut.depth,
            polygons: rest.toPolygons() as [number, number][][],
            area,
            cutArea: designArea,
            clearedArea: thisCleared,
          });
        }
        rest.delete();
      }
      cleared?.delete();
    }
  } finally {
    solid?.delete();
  }

  notes.push(
    `measured against the first program’s simulated removal: ${mm2(clearedArea)} of the ` +
      `${mm2(cutArea)} the second tool could cut was already gone`,
  );
  if (input.overlap > 0) {
    // WHAT the band is, and no judgement about whether it is enough (#436). This note used to add
    // "so no ridge can survive at the seam", which was true of the diameter-wide band it was written
    // against and is not true of a chosen band narrower than the second cutter's own scallop — and a
    // measurement that states a verdict is a verdict nobody re-checks. `restSettings` derives the
    // judgement from the same two cutters, per job, and the run sheet prints it there.
    notes.push(
      `the rest pass overlaps the first tool by ${mm(input.overlap)}, so a band that wide is cut ` +
        'by both programs',
    );
  }
  return { regions, cutArea, clearedArea, restArea, notes };
}
