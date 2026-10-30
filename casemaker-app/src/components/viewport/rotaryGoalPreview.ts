/**
 * #723 R-3 preview — THE GOAL ON A ROD, DRAWN.
 *
 * The rotary relief is cut from a RADIAL heightfield (R-1): for every (x, arc) cell of the map,
 * the goal's outermost radius there, as `z = r − R`. The CAM and the findings read that field; so
 * does this picture, which is the point — the surface the operator sees IS the surface the CAM
 * measures, not a second sampling of the mesh.
 *
 * Both views use it, as one geometry: the MAP view draws it flat (x along, y arc, z height), and
 * the STOCK view wraps the same buffer onto the cylinder with the preview's own `wrapMapGeometry`.
 *
 * A REFUSED PART IS STILL DRAWN. A goal wider than the rod, one tapering to the axis or one past
 * the free span is refused by the generator, and the field still samples it (the design's rule) so
 * the refusal and its cause are visible together.
 *
 * THE PREVIEW SAMPLES COARSER THAN THE CUT. A picture needs tens of thousands of cells; the CAM may
 * sample millions, and the sampler's own cap coarsens the pitch and says so in `resolutionNote`.
 * The preview's cap is therefore its own labelled number, and nothing here claims to be the CAM's
 * resolution.
 *
 * Pure geometry, no React: the component memoizes these and disposes what they make.
 */

import * as THREE from 'three';

import { sampleGoalRadialField, type GoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

/** The preview's cell cap. The sampler coarsens the pitch to stay under it. */
export const ROTARY_GOAL_PREVIEW_MAX_CELLS = 40_000;

/** The preview's base pitch, mm. Coarser than a cut grid on purpose — see the module note. */
export const ROTARY_GOAL_PREVIEW_PITCH_MM = 0.5;

/**
 * The goal a rotary job will cut, or null. An enabled `role: 'goal'` target with mesh bytes; a
 * picture is a flat relief (the generator refuses it on a rod by name), and a reference mesh is
 * not cut at all.
 */
export function rotaryGoalTarget(job: EngraveJob): EngraveTargetObject | null {
  const target = job.targetObject;
  if (target === undefined || !target.enabled) return null;
  if ((target.role ?? 'reference') !== 'goal') return null;
  if (target.format === 'png' || target.data === undefined) return null;
  return target;
}

/** The field the preview draws for a goal on a rod of `radius` mm. */
export function rotaryGoalPreviewField(
  target: Pick<EngraveTargetObject, 'sha256' | 'format' | 'data' | 'position' | 'scale'>,
  radius: number,
): GoalRadialField {
  return sampleGoalRadialField(target, radius, {
    pitchMm: ROTARY_GOAL_PREVIEW_PITCH_MM,
    maxCells: ROTARY_GOAL_PREVIEW_MAX_CELLS,
  });
}

/**
 * The part's surface as a map-frame mesh: one quad per cell whose FOUR corners are all covered,
 * at `(x0 + i·pitch, j·pitch, z)`. Uncovered cells are the stock standing around the part and are
 * not drawn; the map's rows wrap, so the row past the last one is row 0 at the full circumference.
 */
export function rotaryGoalSurfaceGeometry(field: GoalRadialField): THREE.BufferGeometry {
  const { nx, ny, pitch, x0, z, covered } = field;
  const at = (i: number, j: number): number => (j % ny) * nx + i;
  const positions: number[] = [];
  const indices: number[] = [];
  let vertex = 0;
  for (let j = 0; j < ny; j++) {
    const y0 = j * pitch;
    const y1 = (j + 1) * pitch; // the wrap: the last row's far edge is the seam at 2πR
    for (let i = 0; i < nx - 1; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i, j + 1);
      const d = at(i + 1, j + 1);
      if (covered[a] !== 1 || covered[b] !== 1 || covered[c] !== 1 || covered[d] !== 1) continue;
      const xA = x0 + i * pitch;
      const xB = x0 + (i + 1) * pitch;
      positions.push(xA, y0, z[a]!, xB, y0, z[b]!, xA, y1, z[c]!, xB, y1, z[d]!);
      indices.push(vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2);
      vertex += 4;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
