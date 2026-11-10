/**
 * #1157 — A GEAR SAMPLE IS STAGED AS AN OUTLINE, NOT AS A 3D GOAL.
 *
 * `gears-outline` sat in MESH_PURPOSES, so a gear STL was planned as a 3D `targetObject` inside a
 * block. heart-gear-a — a 40.754 mm bevel gear — cannot pass that staging: 53 % of its surface
 * faces away from one top setup and 4 regions sit deeper than the shop's longest ball (22 mm), so
 * the run read 5.66 % coverage with no plan defect. The purpose name and the manifest's own note
 * ("Tooth flanks under a cutter radius: leftover statement") ask for an OUTLINE: the gear's
 * silhouette cut from a plate.
 *
 * This module owns the purpose sets the harness dispatches on, and derives the silhouette as an
 * `OutlineImport` the existing outline job consumes: the widest horizontal cross-section of the
 * mesh — the same section the flip planning calls the parting plane — traced into rings and
 * centred on its own bounding box.
 */
import { crossSectionArea, crossSectionPolylines } from '../../src/engine/cnc/engrave/goalUnderside';
import type { CoverageMesh } from '../../src/engine/cnc/engrave/goalCoverage';
import type { OutlineImport } from '../../src/engine/import/outlineTypes';

/** The purpose whose samples are cut as an outline of the mesh's silhouette (#1157). */
export const GEAR_OUTLINE_PURPOSE = 'gears-outline';

/** Purposes planned as a 3D goal mesh. `gears-outline` left this set in #1157. */
export const MESH_PURPOSES = new Set([
  'rotary',
  'rotary-unreachable',
  'relief-3axis',
  'plate-2.5d',
  'step-import',
  'relief-plate-own',
  'badge-own',
]);

/** Purposes planned from a vector outline (SVG/DXF drawing). */
export const OUTLINE_PURPOSES = new Set(['svg-coaster', 'svg-outline', 'svg-shapes-mm', 'dxf-units']);

export interface MeshSilhouette {
  /** The rings, centred on their bounding box, with the size — the harness's outline job input. */
  outline: OutlineImport;
  /** The z of the widest cross-section, in the mesh's own frame, mm. */
  sectionZ: number;
  /** The cross-section area there, mm². */
  sectionAreaMm2: number;
  /** The rings found (a gear with a bore has two). */
  loops: number;
}

const round = (v: number): number => Number(v.toFixed(3));

/**
 * The mesh's silhouette as an outline — the WIDEST horizontal cross-section (a gear's outline is
 * widest across its teeth; a cone's at its base), sampled across the Z extent. Null when the mesh
 * has no Z extent or no closed section there.
 */
export function meshSilhouette(mesh: CoverageMesh, sourceName: string, samples = 65): MeshSilhouette | null {
  const p = mesh.positions;
  if (p.length === 0) return null;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 2; i < p.length; i += 3) {
    const z = p[i]!;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!(maxZ > minZ)) return null;
  let bestZ = (minZ + maxZ) / 2;
  let bestArea = -1;
  const span = maxZ - minZ;
  for (let i = 1; i < samples; i++) {
    const z = minZ + (span * i) / samples;
    const area = crossSectionArea(mesh, z);
    if (area > bestArea + 1e-9) {
      bestArea = area;
      bestZ = z;
    }
  }
  if (!(bestArea > 0)) return null;
  const loops = crossSectionPolylines(mesh, bestZ);
  if (loops.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const loop of loops) {
    for (const [x, y] of loop) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const contours = loops.map((loop) => loop.map(([x, y]): [number, number] => [x - cx, y - cy]));
  return {
    // '3mf' is the nearest existing "a volume's footprint" format the outline vocabulary carries;
    // the source's own name rides beside it and the note says it is a silhouette.
    outline: {
      format: '3mf',
      sourceName,
      contours,
      fillRule: 'NonZero',
      width: round(maxX - minX),
      height: round(maxY - minY),
      notes: [`silhouette: the widest cross-section (${round(bestArea)} mm²) at z ${round(bestZ)} mm, ${loops.length} ring(s)`],
    },
    sectionZ: round(bestZ),
    sectionAreaMm2: round(bestArea),
    loops: loops.length,
  };
}
