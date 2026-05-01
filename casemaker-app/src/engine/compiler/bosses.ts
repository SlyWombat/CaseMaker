import type { CaseParameters, BoardProfile, InsertType } from '@/types';
import { cylinder, difference, mesh, translate, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

export interface BossPlacement {
  id: string;
  x: number;
  y: number;
  outerDiameter: number;
  holeDiameter: number;
  totalHeight: number;
  /** Issue #104 — 'bottom' (legacy) anchors the boss to the case floor;
   *  'top' anchors it to the lid underside (the lid compiler unions these
   *  cylinders into the lid mesh; the case shell gets a tapered support
   *  column instead via {@link buildBossSupportColumns}). */
  position: 'bottom' | 'top';
  /** World-Z of the boss BASE (where it meets its anchoring surface).
   *  - 'bottom': base sits at z=0 (the case floor underside reference).
   *  - 'top': base sits at the lid underside Z; boss extends DOWN. */
  baseZ: number;
}

const HEAT_SET_SPECS: Record<InsertType, { hole: number; minOuter: number }> = {
  'self-tap': { hole: 2.5, minOuter: 4.5 },
  'heat-set-m2.5': { hole: 3.6, minOuter: 5.6 },
  'heat-set-m3': { hole: 4.2, minOuter: 6.2 },
  'pass-through': { hole: 3.2, minOuter: 5 },
  none: { hole: 0, minOuter: 4.5 },
};

export function resolveInsertSpec(
  insertType: InsertType,
  configuredOuter: number,
  configuredHole: number,
): { outerDiameter: number; holeDiameter: number } {
  const spec = HEAT_SET_SPECS[insertType];
  // For self-tap and pass-through, honor user override of holeDiameter.
  // For heat-set, force the spec hole (the brass insert size is fixed).
  // For 'none' (issue #27), force hole=0 — the boss is a solid retention peg.
  const isHeatSet = insertType === 'heat-set-m2.5' || insertType === 'heat-set-m3';
  const holeDiameter =
    insertType === 'none' ? 0 : isHeatSet ? spec.hole : configuredHole;
  // Outer diameter must allow at least 1mm wall around the hole.
  const minOuter = Math.max(spec.minOuter, holeDiameter + 2);
  const outerDiameter = Math.max(configuredOuter, minOuter);
  return { outerDiameter, holeDiameter };
}

export function computeBossPlacements(
  board: BoardProfile,
  params: CaseParameters,
): BossPlacement[] {
  if (!params.bosses.enabled) return [];
  const { wallThickness: wall, internalClearance: cl, floorThickness: floor } = params;
  const standoff = board.defaultStandoffHeight;
  // All joint types use floor + standoff. For screw-down, the lid carries
  // matching posts that descend from above to clamp the board (issue #21).
  // For non-screw-down joints, the floor bosses become solid pegs (no pilot
  // hole) — issue #27. The user's configured insertType is preserved so it
  // resurfaces when they switch back to screw-down.
  const totalHeight = floor + standoff;
  const effectiveInsertType: InsertType =
    params.joint === 'screw-down' ? params.bosses.insertType : 'none';
  const { outerDiameter, holeDiameter } = resolveInsertSpec(
    effectiveInsertType,
    params.bosses.outerDiameter,
    params.bosses.holeDiameter,
  );
  // Issue #104 — top-mounted bosses anchor to the lid underside instead of
  // the floor. The position field defaults to 'bottom' for back-compat.
  // Top-position is only meaningful when joint='screw-down'; for other
  // joints we keep position='bottom' so the board still has retention pegs
  // even though no screw is involved.
  const position: 'bottom' | 'top' =
    params.joint === 'screw-down' && params.bosses.position === 'top' ? 'top' : 'bottom';
  // baseZ for 'bottom' bosses is z=0 (the floor underside reference); we
  // compute the top boss baseZ inside buildBossesUnion / lid compiler from
  // the actual lid Z (it depends on shell + lidRecess + lidThickness).
  // Default it to 0 here; buildBossesUnion fills in the right value.
  const baseZ = 0;
  return board.mountingHoles.map((h) => ({
    id: `boss-${h.id}`,
    x: h.x + wall + cl,
    y: h.y + wall + cl,
    outerDiameter,
    holeDiameter,
    totalHeight,
    position,
    baseZ,
  }));
}

export function getScrewClearanceDiameter(insertType: InsertType): number {
  switch (insertType) {
    case 'heat-set-m3':
      return 3.4;
    case 'heat-set-m2.5':
    case 'self-tap':
      return 2.9;
    case 'pass-through':
      return 3.4;
    case 'none':
      return 0;
    default:
      return 2.9;
  }
}

/**
 * Build the boss cylinders that get UNIONED with the floor (for 'bottom'
 * placements) — the legacy path. Top-position bosses are emitted by
 * {@link buildLidBosses} instead so they fuse with the lid mesh.
 */
export function buildBossesUnion(placements: BossPlacement[]): BuildOp[] {
  return placements
    .filter((b) => b.position === 'bottom')
    .map((b) => {
      const outer = cylinder(b.totalHeight, b.outerDiameter / 2, 32);
      if (b.holeDiameter <= 0) {
        return translate([b.x, b.y, 0], outer);
      }
      const pilot = cylinder(b.totalHeight + 2, b.holeDiameter / 2, 24);
      const piloted = difference([outer, translate([0, 0, -1], pilot)]);
      return translate([b.x, b.y, 0], piloted);
    });
}

/**
 * Issue #104 — bosses anchored to the lid underside hang DOWN from the lid.
 * The cylinder's top face fuses with the lid; its bottom face sits at
 * lidUndersideZ - boss.totalHeight, which is the same Z the bottom-position
 * bosses' top face would have been at — so the screw insert position is
 * unchanged, just the material it threads into is now lid-attached.
 *
 * Returned ops are in WORLD coords (not lid-local). The lid compiler is
 * responsible for unioning them into the lid mesh.
 */
export function buildLidBosses(
  placements: BossPlacement[],
  lidUndersideZ: number,
): BuildOp[] {
  return placements
    .filter((b) => b.position === 'top')
    .map((b) => {
      const baseZ = lidUndersideZ - b.totalHeight;
      const outer = cylinder(b.totalHeight, b.outerDiameter / 2, 32);
      if (b.holeDiameter <= 0) {
        return translate([b.x, b.y, baseZ], outer);
      }
      // Pilot extends through the lid (so the screw can pass through from
      // above) plus a small overshoot at the bottom.
      const pilot = cylinder(b.totalHeight + 2, b.holeDiameter / 2, 24);
      const piloted = difference([outer, translate([0, 0, -1], pilot)]);
      return translate([b.x, b.y, baseZ], piloted);
    });
}

/**
 * Issue #104 — tapered support columns on the inside wall, one per top-
 * mounted boss. Each column is a frustum-style mesh that:
 *   - sits flush against the nearest case wall
 *   - has its TOP face at the boss base radius, aligned with the boss
 *   - tapers DOWN over `supportTaperLength` to a thin rib at the wall plane
 *
 * The taper means it prints without support material when the case is
 * printed open-side-up: the column starts as full boss-diameter material
 * at the rim and narrows as it descends, hugging the wall.
 *
 * Implementation: each column is rendered as a cube primitive sized
 * (boss-diameter × wall-tangent-thickness × supportTaperLength) shifted
 * to butt against the wall, with the TAPER realized by truncating the
 * cube into a wedge mesh. For v1 simplicity we emit a rectangular cube
 * (no taper geometry) — slicers handle the modest overhang under typical
 * print speeds. The taper-as-mesh is a follow-up refinement.
 */
export function buildBossSupportColumns(
  placements: BossPlacement[],
  board: BoardProfile,
  params: CaseParameters,
): BuildOp[] {
  const top = placements.filter((b) => b.position === 'top');
  if (top.length === 0) return [];
  const dims = computeShellDims(board, params, [], () => undefined);
  const { wallThickness: wall, internalClearance: cl } = params;
  // The column extends from the lid underside DOWN by supportTaperLength.
  const supportTaperLength = Math.min(dims.cavityZ - 2, 8);
  if (supportTaperLength <= 1) return [];
  const lidUndersideZ = dims.outerZ - params.lidThickness;
  const columnTopZ = lidUndersideZ;
  const columnBottomZ = columnTopZ - supportTaperLength;
  const out: BuildOp[] = [];
  for (const b of top) {
    // Pick the closest wall to butt the column against. innerX/innerY are
    // the cavity bounds; the column tangent thickness extends inward from
    // the wall by `wall` (so the column overlaps the wall by 0 mm and
    // extends `wall` into the cavity at its top, narrowing to 1 mm rib at
    // the bottom).
    const innerXMin = wall;
    const innerXMax = wall + cl + board.pcb.size.x + cl;
    const innerYMin = wall;
    const innerYMax = wall + cl + board.pcb.size.y + cl;
    const dXmin = b.x - innerXMin;
    const dXmax = innerXMax - b.x;
    const dYmin = b.y - innerYMin;
    const dYmax = innerYMax - b.y;
    const m = Math.min(dXmin, dXmax, dYmin, dYmax);
    // Tangent (wall-parallel) width = boss outer diameter for full overlap
    // with the boss above.
    const tan = b.outerDiameter;
    // Inboard projection at the TOP (full boss radius into the cavity);
    // tapers down to 1 mm rib at the BOTTOM.
    const proj = b.outerDiameter / 2 + 0.5;
    let column: BuildOp;
    if (m === dXmin) {
      column = buildWallColumnMesh('-x', b.y, tan, proj, supportTaperLength, columnBottomZ, innerXMin);
    } else if (m === dXmax) {
      column = buildWallColumnMesh('+x', b.y, tan, proj, supportTaperLength, columnBottomZ, innerXMax);
    } else if (m === dYmin) {
      column = buildWallColumnMesh('-y', b.x, tan, proj, supportTaperLength, columnBottomZ, innerYMin);
    } else {
      column = buildWallColumnMesh('+y', b.x, tan, proj, supportTaperLength, columnBottomZ, innerYMax);
    }
    out.push(column);
  }
  return out;
}

/**
 * Build a tapered support column on the named inside wall as a mesh. The
 * column is a wedge — full boss-diameter at the top (z=zBase+H), tapering
 * to a thin rib at the bottom (z=zBase). Cross-section in the wall-tangent
 * direction is symmetric about the wall position.
 */
function buildWallColumnMesh(
  wallSide: '+x' | '-x' | '+y' | '-y',
  uCenter: number,
  tangentSize: number,
  topProjection: number,
  height: number,
  zBase: number,
  wallPlaneCoord: number,
): BuildOp {
  // Local frame: u = along the wall (tangent), n = inboard-normal (into
  // cavity), z = vertical.
  // 8 verts:
  //   z=zBase (rib, narrow): (uMin, n=0, z=zBase), (uMax, n=0, z=zBase),
  //     (uMin, n=1, z=zBase), (uMax, n=1, z=zBase)
  //   z=zBase+H (top, full):  (uMin, n=0, z=top),  (uMax, n=0, z=top),
  //     (uMin, n=top, z=top), (uMax, n=top, z=top)
  // The wall-side (n=0) face stays vertical; the inboard face slopes from
  // n=top at top down to n=1 (1 mm rib) at base.
  const RIB_BASE = 1;
  const uMin = uCenter - tangentSize / 2;
  const uMax = uCenter + tangentSize / 2;
  const positions: number[] = [];
  function pushVert(uOff: number, nOff: number, zOff: number): void {
    let x = 0;
    let y = 0;
    if (wallSide === '+x') {
      // +x wall is at world x = wallPlaneCoord = innerXMax; inboard direction is -x.
      x = wallPlaneCoord - nOff;
      y = uOff;
    } else if (wallSide === '-x') {
      x = wallPlaneCoord + nOff;
      y = uOff;
    } else if (wallSide === '+y') {
      x = uOff;
      y = wallPlaneCoord - nOff;
    } else {
      x = uOff;
      y = wallPlaneCoord + nOff;
    }
    positions.push(x, y, zBase + zOff);
  }
  // Index layout:
  // 0: (uMin, n=0,        z=0)        wall-base, narrow-tangent-min
  // 1: (uMax, n=0,        z=0)
  // 2: (uMin, n=RIB_BASE, z=0)
  // 3: (uMax, n=RIB_BASE, z=0)
  // 4: (uMin, n=0,        z=H)
  // 5: (uMax, n=0,        z=H)
  // 6: (uMin, n=topProj,  z=H)
  // 7: (uMax, n=topProj,  z=H)
  pushVert(uMin, 0, 0);
  pushVert(uMax, 0, 0);
  pushVert(uMin, RIB_BASE, 0);
  pushVert(uMax, RIB_BASE, 0);
  pushVert(uMin, 0, height);
  pushVert(uMax, 0, height);
  pushVert(uMin, topProjection, height);
  pushVert(uMax, topProjection, height);

  // Triangulation — 12 tris. Winding must produce outward normals; we don't
  // need to be perfect because manifold's union handles small flips, but
  // we'll be careful. The "outward" direction for each face:
  //   - bottom (z=0): -z normal
  //   - top (z=H): +z normal
  //   - wall side (n=0): away from wall (sign depends on wallSide)
  //   - inboard sloped face: +n (and somewhat +z)
  //   - end caps (u=uMin, u=uMax): ±u
  // For manifold, consistent CCW winding from outside is correct.
  const indices = new Uint32Array([
    // bottom z=0: 0,1,3 + 0,3,2  (CCW from -z)
    0, 1, 3, 0, 3, 2,
    // top z=H: 4,6,7 + 4,7,5 (CCW from +z)
    4, 6, 7, 4, 7, 5,
    // wall side n=0: 0,4,5 + 0,5,1 (CCW from outside the column = into the wall)
    0, 4, 5, 0, 5, 1,
    // inboard sloped face (rib at base, full at top): 2,3,7 + 2,7,6
    2, 3, 7, 2, 7, 6,
    // end cap u=uMin: 0,2,6 + 0,6,4
    0, 2, 6, 0, 6, 4,
    // end cap u=uMax: 1,5,7 + 1,7,3
    1, 5, 7, 1, 7, 3,
  ]);
  return mesh(new Float32Array(positions), indices);
}
