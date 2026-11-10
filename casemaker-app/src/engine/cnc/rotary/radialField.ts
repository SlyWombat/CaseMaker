/**
 * #723 R-1 / #1083 — THE RADIAL HEIGHTFIELD: a goal mesh sampled as a radius per (x, θ) on a rod.
 *
 * A rotary relief is Makera's Rotation Relief (`Rotary.md` class R): the mesh is oriented along
 * the rod's X, the stock is a cylinder, and the cut follows the part's RADIUS around the axis —
 * the rotary analogue of the flat goal's top-Z (`sampleGoalHeightfield`, #534). This module owns
 * the sampling rule and nothing else, so the CAM, the findings and the preview cannot disagree
 * about what the mesh says:
 *
 *     map cell (x, s)  →  angle φ = s / R
 *     r(x, φ) = the OUTERMOST hit of the ray from the axis at X = x, direction (0, sin φ, cos φ)
 *     z       = r − R      (the stock's surface is z = 0; below it is negative — the map height
 *                           the flat goal pipeline and `toRotaryIR` already speak)
 *
 * THE MESH'S PLACEMENT. Its local X is the rod's axis; its local Y/Z section is measured about the
 * axis (a vertex at local (y, z) sits at radius `hypot(y, z)` and angle `atan2(y, z)`), so a mesh
 * modelled as a turned part is correct as authored. `position.x` is the mesh's centre along the
 * rod, `position.y` is the seam offset in map millimetres (it turns the mesh about the rod),
 * `position.z` is ignored on a rod — the radius IS the height — and `scale` applies per axis
 * about the axis (design `docs/design/rotary-relief.md` §Part 1). `rotation` is not read here:
 * turning a mesh about X/Y/Z is part 2's design.
 *
 * THE GRID is the map's: X along the rod, Y the arc at the design radius, zero at the seam; the
 * around extent is the full circumference. A cell no triangle's ray hits keeps the STOCK's surface
 * (`z = 0`, `covered = 0`) — the goal says nothing there, and the CAM leaves the stock standing,
 * exactly as the flat field's sentinel does. The grid is capped like the flat one: above
 * {@link DEFAULT_MAX_CELLS} the pitch is COARSENED and the coarser value is stated, never refused.
 *
 * SINGLE-VALUED, HONESTLY SO. One radius per (x, φ) cannot express an undercut, a re-entrant
 * groove hidden behind the outer surface, or an internal void. The sampler takes the outermost
 * surface, and material the ray re-enters behind it is left standing — the single-axis answer the
 * flat field gives too (#222).
 *
 * #1164 — AND IT IS THE DESIGN ∩ THE ROD, NOT THE DESIGN'S FARTHEST SHELL. When the outermost hit
 * is beyond the stock radius R, the field may not read a full-radius shelf unless the material is
 * actually there: an oversize overhang over a groove is air at R, and the goal inside the rod is
 * the groove. The rule is the crossing parity beyond R (odd = inside at R, so R; even = outside,
 * so the outermost crossing below R; none below = nothing inside the rod, the stock stands). It is
 * the sampler's own rule, so the planner, the preview and the goal check inherit it together.
 *
 * #1083 — WHY IT LIVES HERE, NOT IN THE CAM: the goal check (`workers/sim/goalCheckField.ts`, a
 * #964 gate root) compares the goal's radial field with the live column grid, and the gate's
 * import closure must carry no CAM (`cam/**`). The rule is the geometry's, so it sits in the
 * neutral rotary namespace; `cam/rotaryRelief.ts` re-exports the type and imports the sampler.
 */

import type { EngraveTargetObject } from '@/types/engraveJob';
import { targetObjectMesh } from '@/engine/import/targetObject';
import { targetScale } from '@/engine/cnc/engrave/targetScale';
import { DEFAULT_GRID_PITCH_MM, DEFAULT_MAX_CELLS } from '@/engine/cnc/engrave/goalHeightfield';

/**
 * A radius-per-(x, φ) field over the rotary map, in millimetres. `z[j*nx + i]` is the goal's
 * surface at map X `x0 + i·pitch` and arc `j·pitch`, expressed as the RADIUS above the axis less
 * the stock's radius `radius` — the same height convention the flat heightfield uses (0 at the
 * stock's surface, negative into it).
 */
export interface GoalRadialField {
  nx: number;
  ny: number;
  /** Map X (mm along the axis from the jaws) of column i = 0's centre. */
  x0: number;
  /** Map arc (mm at the design radius) of row j = 0's centre — always 0, the seam. */
  y0: number;
  /** Square cell pitch in the map, mm (both axes). */
  pitch: number;
  /** The design radius, ⌀/2, mm — the map's radius and the stock's surface. */
  radius: number;
  /** The smallest / largest radius any ray hit, mm. `radius` when no ray hit anything. */
  minRadius: number;
  maxRadius: number;
  /**
   * #1164 — how many beyond-rod cells the design ∩ rod rule re-cast against the mesh. The second
   * pass's work in its own unit (cells × triangles): a field over a large oversize mesh shows the
   * cost here, not in the operator's resolution sentence.
   */
  recastCells: number;
  /** #1164 — of `recastCells`, how many were classified from the quarter-cell offsets (a
   * degenerate centre ray: in a face's plane, or a silhouette edge merged by the crossing merge). */
  degenerateCells: number;
  z: Float32Array;
  /** 1 where at least one triangle's ray was hit, else 0 (the stock's surface stands). */
  covered: Uint8Array;
  coveredCount: number;
  /** The resolution this field is good to, in words, for the panel/run sheet to quote. */
  resolutionNote: string;
}

export interface SampleRadialOpts {
  /** The shop's grid pitch in map millimetres; absent → {@link DEFAULT_GRID_PITCH_MM}. */
  pitchMm?: number | null;
  /** The grid cap; absent → {@link DEFAULT_MAX_CELLS}. */
  maxCells?: number | null;
}

const positive = (v: number | null | undefined): boolean =>
  typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Sample a goal mesh to the rotary map's radial field. The caller passes the stock's radius (the
 * job's ⌀/2); the placement contract is this module's header.
 */
export function sampleGoalRadialField(
  target: Pick<EngraveTargetObject, 'sha256' | 'format' | 'data' | 'position' | 'scale'>,
  radius: number,
  opts: SampleRadialOpts = {},
): GoalRadialField {
  if (!(radius > 0)) throw new Error(`a rotary relief needs a positive stock radius; it was given ${radius} mm`);
  if (target.format === 'png') throw new Error('a picture relief is a flat heightfield; a rotary relief needs a mesh');
  const mesh = targetObjectMesh(target);
  const requestedPitch = positive(opts.pitchMm) ? (opts.pitchMm as number) : DEFAULT_GRID_PITCH_MM;
  const maxCells = positive(opts.maxCells) ? (opts.maxCells as number) : DEFAULT_MAX_CELLS;
  const scale = targetScale(target);

  // The mesh's local X centre is placed at `position.x`; the section's origin stays on the axis.
  const xCentre = (mesh.bbox.min[0] + mesh.bbox.max[0]) / 2;
  const xOf = (lx: number): number => target.position.x + (lx - xCentre) * scale.x;
  // The seam offset: `position.y` map millimetres of arc, at the design radius.
  const seam = target.position.y / radius;

  // The grid: the placed mesh's own X extent × one full circumference, at the shop pitch.
  const xMin = xOf(mesh.bbox.min[0]);
  const xMax = xOf(mesh.bbox.max[0]);
  const circumference = 2 * Math.PI * radius;
  let pitch = requestedPitch;
  let nx = Math.max(1, Math.ceil((xMax - xMin) / pitch) + 1);
  let ny = Math.max(1, Math.ceil(circumference / pitch));
  let coarsened = false;
  if (nx * ny > maxCells) {
    const k = Math.sqrt((nx * ny) / maxCells);
    pitch = requestedPitch * k;
    nx = Math.max(1, Math.ceil((xMax - xMin) / pitch) + 1);
    ny = Math.max(1, Math.ceil(circumference / pitch));
    coarsened = true;
  }
  const x0 = xMin;
  const z = new Float32Array(nx * ny);
  const covered = new Uint8Array(nx * ny);
  /** The TRUE farthest hit per cell, before the rod clip — #1164's rule reads it after the pass. */
  const rawMax = new Float32Array(nx * ny);
  let minR = Infinity;
  let maxR = -Infinity;
  // The part's closest approach to the axis: a mesh that tapers to the axis has a VERTEX there,
  // and between two sampled rays the hit radii would read a cell-width above zero — the vertex is
  // the honest number the axis finding (R8) is about.
  let minVertexR = Infinity;

  // The mesh's vertices in the rod's Cartesian frame: X along the axis, (Y, Z) the section.
  const nVerts = mesh.positions.length / 3;
  const world = new Float64Array(nVerts * 3);
  const phi = new Float64Array(nVerts);
  for (let v = 0; v < nVerts; v++) {
    const lx = mesh.positions[v * 3]!;
    const ly = mesh.positions[v * 3 + 1]! * scale.y;
    const lz = mesh.positions[v * 3 + 2]! * scale.z;
    world[v * 3] = xOf(lx);
    world[v * 3 + 1] = ly;
    world[v * 3 + 2] = lz;
    phi[v] = Math.atan2(ly, lz);
    const vr = Math.hypot(ly, lz);
    if (vr < minVertexR) minVertexR = vr;
  }

  // The triangles in the rod's frame, flat: nine numbers each. The raster walks each triangle's
  // (x, φ) footprint; the boundary retry below can then ask one cell's ray of every triangle.
  const triCount = Math.floor(mesh.indices.length / 3);
  const tri = new Float64Array(triCount * 9);
  for (let t = 0; t < triCount; t++) {
    for (let v = 0; v < 3; v++) {
      const idx = mesh.indices[t * 3 + v]!;
      tri[t * 9 + v * 3] = world[idx * 3]!;
      tri[t * 9 + v * 3 + 1] = world[idx * 3 + 1]!;
      tri[t * 9 + v * 3 + 2] = world[idx * 3 + 2]!;
    }
  }

  // No hit can be farther from the axis than the mesh's own farthest vertex; a ray that grazes a
  // triangle edge-on (det ≈ 0) can otherwise return a huge `t` through the u/v epsilon, which is
  // arithmetic, not the part.
  let rBound = 0;
  for (let v = 0; v < nVerts; v++) {
    const rr = Math.hypot(world[v * 3 + 1]!, world[v * 3 + 2]!);
    if (rr > rBound) rBound = rr;
  }
  rBound = rBound * 1.001 + 1e-6;

  const EPS = 1e-9;
  /** mm: a shared edge or a coplanar pair is one crossing, and R is a boundary. */
  const CROSS = 1e-5;
  /**
   * The farthest hit of the ray (ox, 0, 0) + t·(0, sin φ, cos φ) on triangle `t`, or 0. When
   * `crossings` is given, every positive hit along the ray is pushed onto it — the #1164 rule needs
   * the whole crossing list, not just the farthest. `flags.degenerate` is set when a triangle is
   * EDGE-ON to the ray (det ≈ 0): the ray may run along a mesh edge or in a face's plane, where an
   * intersection is missed or double-counted, so parity cannot be trusted on that ray alone.
   */
  const rayHit = (
    t: number,
    ox: number,
    ang: number,
    crossings?: number[],
    flags?: { degenerate: boolean },
  ): number => {
    const ax = tri[t * 9]!, ay = tri[t * 9 + 1]!, az = tri[t * 9 + 2]!;
    const bx = tri[t * 9 + 3]!, by = tri[t * 9 + 4]!, bz = tri[t * 9 + 5]!;
    const cx = tri[t * 9 + 6]!, cy = tri[t * 9 + 7]!, cz = tri[t * 9 + 8]!;
    const dy = Math.sin(ang);
    const dz = Math.cos(ang);
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x;
    const pz = -dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < EPS) {
      // #1164 review — PARALLEL IS NOT DEGENERATE. A face square to the axis (an end cap, a flat
      // normal to X) is parallel to every radial ray; flagging those would send every beyond-rod
      // cell down the quarter-cell path (3x the work and a quarter-cell bias everywhere). The ray
      // is degenerate only when it also LIES IN the triangle's plane.
      if (flags !== undefined) {
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) {
          const distance = Math.abs((ox - ax) * (nx / len) - ay * (ny / len) - az * (nz / len));
          if (distance < 1e-6) flags.degenerate = true;
        }
      }
      return 0;
    }
    const inv = 1 / det;
    const tx = ox - ax, ty = -ay, tz = -az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -EPS || u > 1 + EPS) return 0;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dy * qy + dz * qz) * inv;
    if (v < -EPS || u + v > 1 + EPS) return 0;
    const r = (e2x * qx + e2y * qy + e2z * qz) * inv;
    // A hit AT the axis (r = 0) is a real surface point — a mesh that tapers to it reaches the
    // axis, which the CAM refuses (R8); dropping it would leave the apex cells 'uncovered' and
    // read as the stock's surface instead.
    const hit = r >= -EPS && r <= rBound ? Math.max(0, r) : 0;
    if (hit > 0 && crossings !== undefined) crossings.push(hit);
    return hit;
  };

  /**
   * #1164 — one ray's class against the rod: `inside` (the material is there at R, so the goal is
   * the rod), `below` (outside at R; `below` is the outermost crossing under R), or `none` (the
   * design has nothing inside the rod on this ray). `degenerate` is set when a triangle is edge-on
   * to the ray or two crossings merge, where the crossing count may be 0 or 2 read as 1.
   */
  const classifyRay = (ox: number, ang: number): { kind: 'inside' | 'below' | 'none'; below: number; degenerate: boolean } => {
    const hits: number[] = [];
    const flags = { degenerate: false };
    for (let t = 0; t < triCount; t++) rayHit(t, ox, ang, hits, flags);
    hits.sort((a, b) => a - b);
    const crossings: number[] = [];
    for (const h of hits) {
      const prev = crossings[crossings.length - 1];
      if (prev === undefined || h - prev > CROSS) crossings.push(h);
      else flags.degenerate = true; // two surfaces read as one: the truth may be 0 or 2, not 1
    }
    let beyond = 0;
    let below = 0;
    for (const h of crossings) {
      if (h > radius + CROSS) beyond += 1;
      else if (h < radius - CROSS) below = h; // sorted: ends on the outermost crossing below R
    }
    return { kind: beyond % 2 === 1 ? 'inside' : below > 0 ? 'below' : 'none', below, degenerate: flags.degenerate };
  };
  /** The farthest hit over every triangle, or 0. */
  const rayHitAll = (ox: number, ang: number): number => {
    let best = 0;
    for (let t = 0; t < triCount; t++) {
      const r = rayHit(t, ox, ang);
      if (r > best) best = r;
    }
    return best;
  };
  const record = (idx: number, r: number): void => {
    if (r <= 0) return;
    if (r > rawMax[idx]!) rawMax[idx] = r;
    if (covered[idx] === 0 || r > (z[idx] as number) + radius) {
      // #808 — CLIPPED TO THE ROD. A hit past the rod's surface has no material to cut there, so
      // the field holds it AT the surface (z = 0) rather than above it: a tip planned from a
      // positive height would sit in the air and the post would refuse the program. The TRUE reach
      // is still what `maxRadius` reports, which the oversize warning names.
      z[idx] = Math.min(0, r - radius);
      covered[idx] = 1;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  };

  for (let t = 0; t < triCount; t++) {
    const ax = tri[t * 9]!;
    const bx = tri[t * 9 + 3]!;
    const cx = tri[t * 9 + 6]!;
    // The triangle's (x, φ) footprint, its angles unwrapped about the first vertex so a triangle
    // spanning the seam stays one continuous patch.
    const p0 = phi[mesh.indices[t * 3]!]!;
    const unwrap = (p: number): number => {
      let d = p - p0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return p0 + d;
    };
    const pa = p0 + seam;
    const pb = unwrap(phi[mesh.indices[t * 3 + 1]!]!) + seam;
    const pc = unwrap(phi[mesh.indices[t * 3 + 2]!]!) + seam;
    const iLo = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / pitch));
    const iHi = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / pitch));
    const pLo = Math.min(pa, pb, pc);
    const pHi = Math.max(pa, pb, pc);
    if (pHi - pLo > 2 * Math.PI) continue; // a degenerate wrap; no honest footprint
    const jLo = Math.floor((pLo * radius) / pitch);
    const jHi = Math.ceil((pHi * radius) / pitch);
    for (let jj = jLo; jj <= jHi; jj++) {
      // The map's around axis is periodic: a footprint past either end wraps to the other. The
      // footprint lives in MAP angle (the seam already added); the GEOMETRY's own angle is that
      // less the seam, because the mesh itself is not rotated — the map is.
      const j = ((jj % ny) + ny) % ny;
      // #1096 — THE ROW'S OWN ANGLE, not the unwrapped index's. `ny = ceil(2πR / pitch)` makes
      // `ny · pitch` up to one cell MORE than the circumference, so a negative `jj` (a triangle
      // whose first vertex has a negative φ) cast at `jj · pitch / radius` is up to a cell off the
      // row `j` it is recorded in — at a cliff that reads the wrong radius entirely (the panther's
      // 36 near-axis pinholes). The retry pass below already casts this way.
      const ang = (j * pitch) / radius - seam;
      for (let i = iLo; i <= iHi; i++) record(j * nx + i, rayHit(t, x0 + i * pitch, ang));
    }
  }

  // A ray exactly along a mesh edge lies in the plane of BOTH faces that share it, so the
  // intersection cannot see it: without this, every vertex angle has a hairline of missed cells —
  // and the seam (φ = 0) is one on most meshes. A cell that borders a covered cell in its own
  // angular row gets a second look a quarter cell off its angle, which completes that edge and
  // leaves a real void (no covered neighbour) at the stock's surface.
  const angStep = (0.25 * pitch) / radius;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (covered[idx] === 1) continue;
      const up = ((j + 1) % ny) * nx + i;
      const down = ((j - 1 + ny) % ny) * nx + i;
      if (covered[up] !== 1 && covered[down] !== 1) continue;
      const ang = (j * pitch) / radius - seam;
      const ox = x0 + i * pitch;
      record(idx, Math.max(rayHitAll(ox, ang - angStep), rayHitAll(ox, ang + angStep)));
    }
  }

  // #1164 SLICE (B) — THE FIELD IS THE DESIGN ∩ THE ROD (#1155's corrected ruling, design §6). A
  // ray whose outermost hit is beyond the rod used to be read as a full-radius shelf: correct only
  // when the material actually fills the rod. Where it does not — an oversize overhang over a
  // groove — the rod surface point is AIR, and the goal there is the outermost design surface
  // inside the rod. The crossings beyond R answer which case this is: an odd count means the ray is
  // inside the solid at R (the clip stands); an even count means it is outside, and the goal is the
  // outermost crossing below R. No crossing below R means the design has nothing inside the rod on
  // that ray: the cell is uncovered and the stock stands.
  //
  // DEGENERATE RAYS (analyst review, 2026-11-10). A ray along a mesh edge (det ≈ 0, at every vertex
  // angle and the seam) can miss an intersection, and a silhouette edge merged by CROSS reads two
  // crossings as one — either flips the parity. For a cell whose centre ray is degenerate, the
  // class comes from the two quarter-cell offsets the retry pass already uses; if they disagree the
  // clip at R stands (conservative: the planner then stands off rather than cutting in). This is
  // the one place a disagreement is resolved in favour of the rod, and it is stated here.
  let oversizeCells = 0;
  let degenerateCells = 0;
  for (let idx = 0; idx < z.length; idx++) {
    if (covered[idx] !== 1 || rawMax[idx]! <= radius + CROSS) continue;
    oversizeCells += 1;
    const j = Math.floor(idx / nx);
    const i = idx - j * nx;
    const ang = (j * pitch) / radius - seam;
    const ox = x0 + i * pitch;
    const centre = classifyRay(ox, ang);
    let chosen = centre;
    if (centre.degenerate) {
      degenerateCells += 1;
      const left = classifyRay(ox, ang - angStep);
      const right = classifyRay(ox, ang + angStep);
      if (left.kind !== right.kind) continue; // disagree: the conservative clip at R stands
      chosen = { kind: left.kind, below: Math.max(left.below, right.below), degenerate: false };
    }
    if (chosen.kind === 'inside') continue;
    if (chosen.kind === 'none') {
      // Nothing of the design inside the rod on this ray: the stock's surface stands, uncovered.
      covered[idx] = 0;
      z[idx] = 0;
      continue;
    }
    z[idx] = chosen.below - radius;
    // #1164 review — the rewritten radius is a GOAL radius, so the reach bound must see it: a
    // groove floor below every outermost hit the raster recorded is the nearest thing to the axis.
    if (chosen.below < minR) minR = chosen.below;
  }

  let coveredCount = 0;
  for (let k = 0; k < covered.length; k++) if (covered[k] === 1) coveredCount++;
  const minRadius = coveredCount === 0 ? radius : Math.min(minR, minVertexR);
  // #1164 — `maxRadius` is the TRUE reach: an oversize sleeve with nothing inside the rod clears
  // every cell, and the oversize warning must still name what cannot be cut. Only a field no ray
  // hit at all reads the stock's radius.
  const maxRadius = maxR > 0 ? maxR : radius;
  const resolutionNote =
    (coarsened
      ? `sampled on a ${pitch.toFixed(4)} mm grid around a ⌀${Number((2 * radius).toFixed(3))} mm rod ` +
        `(coarsened from the requested ${requestedPitch} mm: the map would need ${nx * ny} cells, over the ${maxCells}-cell cap)`
      : `sampled on a ${pitch} mm grid around a ⌀${Number((2 * radius).toFixed(3))} mm rod`) +
    `; one map cell is ${Number(((pitch / radius) * (180 / Math.PI)).toFixed(3))}° of A`;

  return {
    nx,
    ny,
    x0,
    y0: 0,
    pitch,
    radius,
    minRadius,
    maxRadius,
    recastCells: oversizeCells,
    degenerateCells,
    z,
    covered,
    coveredCount,
    resolutionNote,
  };
}
