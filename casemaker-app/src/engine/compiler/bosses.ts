import type { CaseParameters, BoardProfile, InsertType } from '@/types';
import { cavityOriginXY } from '@/engine/coords';
import { cylinder, difference, translate, union, type BuildOp } from './buildPlan';

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
   *  boss fuses into the lid mesh; the floor keeps its own standoff). */
  position: 'bottom' | 'top';
  /** World-Z of the boss BASE (where it meets its anchoring surface).
   *  - 'bottom': base sits at z=0 (the case floor underside reference).
   *  - 'top': base sits at the lid underside Z; boss extends DOWN. */
  baseZ: number;
  /** Locator stub diameter on top of the standoff. Slip-fits into the
   *  board's mounting hole so the board self-locates before screws are
   *  added. 0 means no stub (mount hole too small for any useful stub). */
  lockNotchDiameter: number;
  /** Locator stub height — bottom of stub at the standoff top, top of
   *  stub flush with the board surface. 0 means no stub. */
  lockNotchHeight: number;
  /** Starter pilot diameter through the stub portion only. Smaller than
   *  the standoff body's pilot so a self-tap screw can find center on the
   *  stub before the wider main pilot picks up below the board. 0 means
   *  no starter (no main pilot, or stub absent). */
  lockNotchPilotDiameter: number;
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
  // Issue #162 — `bosses.enabled` governs the LID-side bosses only. The
  // board's own seat is governed by boardRetention: a screw-retained board
  // must have something to sit on AND something to thread into, whatever
  // the lid is doing. Without this, "Board retention: Screws" was purely
  // decorative — it changed the parts list and no geometry at all.
  const retention = params.boardRetention ?? 'screws';
  const screwRetained = retention === 'screws';
  if (!params.bosses.enabled && !screwRetained) return [];
  const { floorThickness: floor } = params;
  const origin = cavityOriginXY(params);
  const standoff = board.defaultStandoffHeight;
  // All joint types use floor + standoff. For screw-down, the lid carries
  // matching posts that descend from above to clamp the board (issue #21).
  // For non-screw-down joints, the floor bosses become solid pegs (no pilot
  // hole) — issue #27. The user's configured insertType is preserved so it
  // resurfaces when they switch back to screw-down.
  const totalHeight = floor + standoff;
  // Issue #162 — the pilot must follow whichever screw actually drives into
  // this boss: LID screws (joint='screw-down') or BOARD screws
  // (boardRetention='screws'). Gating it on the lid joint alone made the
  // default flat-lid case emit a SOLID peg whose locator stub then plugged
  // the board's mounting hole, so no board screw could ever be fitted —
  // while the BOM still billed four of them.
  const wantsPilot = screwRetained || params.joint === 'screw-down';
  const effectiveInsertType: InsertType = wantsPilot
    ? params.bosses.insertType
    : 'none';
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
  // Issue #162 — 'top' is now ADDITIVE, not a replacement. The board always
  // keeps its floor seat; a lid-anchored boss is emitted alongside it so the
  // board is clamped between the two. Previously 'top' removed the floor
  // standoff entirely and the board rested on nothing.
  const lidAnchored =
    params.bosses.enabled &&
    params.joint === 'screw-down' &&
    params.bosses.position === 'top';
  // baseZ for 'bottom' bosses is z=0 (the floor underside reference); we
  // compute the top boss baseZ inside buildBossesUnion / lid compiler from
  // the actual lid Z (it depends on shell + lidRecess + lidThickness).
  // Default it to 0 here; buildBossesUnion fills in the right value.
  const baseZ = 0;
  // Locator stub — see buildBossesUnion. Only emitted for bottom-mounted
  // standoffs; top-mounted bosses anchor to the lid and the board hangs
  // off the screws so a stub adds no value there. The stub OD slip-fits
  // through the board's mounting hole; when the standoff carries a
  // pilot, the stub gets a smaller starter pilot through it (down to
  // STUB_PILOT_MIN) so a self-tap screw finds center on the stub before
  // the wider main pilot picks up below the board.
  const STUB_PILOT_MIN = 1.2;
  const STUB_PILOT_WALL = 0.5;
  const STUB_MIN_OD = 1.8;
  // Issue #124 — the stub bottom face must overlap the standoff TOP annulus
  // (which is r=holeDiameter/2..outerDiameter/2 once the screw pilot is
  // drilled). If stubMaxOD ≤ holeDiameter, the stub disk and standoff
  // annulus are radially disjoint and the stub orphans into the cavity as
  // a floating part. Require a small radial embed past the pilot edge so
  // they actually fuse.
  const STUB_RADIAL_EMBED = 0.1;
  const mk = (
    h: (typeof board.mountingHoles)[number],
    position: 'bottom' | 'top',
  ): BossPlacement => {
    const stubMaxOD = h.diameter - 0.4;
    const canEmitStub =
      position === 'bottom' &&
      stubMaxOD >= STUB_MIN_OD &&
      stubMaxOD >= holeDiameter + STUB_RADIAL_EMBED;
    const lockNotchDiameter = canEmitStub ? stubMaxOD : 0;
    const lockNotchHeight = canEmitStub ? Math.min(board.pcb.size.z, 1.6) : 0;
    // Starter pilot must (a) be smaller than the main pilot so the screw
    // engages new material as it descends, and (b) leave at least
    // STUB_PILOT_WALL on each side of the stub. If those clamps drive it
    // below STUB_PILOT_MIN, omit the starter (the screw will simply
    // self-tap through the solid stub).
    let lockNotchPilotDiameter = 0;
    if (canEmitStub && holeDiameter > 0) {
      const wallLimited = lockNotchDiameter - 2 * STUB_PILOT_WALL;
      const candidate = Math.min(holeDiameter - 0.5, wallLimited);
      lockNotchPilotDiameter = candidate >= STUB_PILOT_MIN ? candidate : 0;
    }
    return {
      id: position === 'top' ? `boss-${h.id}-lid` : `boss-${h.id}`,
      x: h.x + origin.x,
      y: h.y + origin.y,
      outerDiameter,
      holeDiameter,
      totalHeight,
      position,
      baseZ,
      lockNotchDiameter,
      lockNotchHeight,
      lockNotchPilotDiameter,
    };
  };

  const out: BossPlacement[] = [];
  for (const h of board.mountingHoles) {
    // The floor standoff is the board's seat — always present.
    out.push(mk(h, 'bottom'));
    // ...plus a lid-anchored boss above it when the user asked for one.
    if (lidAnchored) out.push(mk(h, 'top'));
  }
  return out;
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
  // Tiny vertical overlap fuses the locator stub with the standoff body
  // (coplanar contact would leave a sliver in the union — same fix as the
  // #121 SECTION_EMBED pattern in rugged.ts).
  const SECTION_EMBED = 0.05;
  return placements
    .filter((b) => b.position === 'bottom')
    .map((b) => {
      const outer = cylinder(b.totalHeight, b.outerDiameter / 2, 32);
      // Composite body = standoff post + (optional) locator stub on top.
      // The stub gives the board something to drop over so it self-aligns
      // before screws are installed.
      let body: BuildOp = outer;
      if (b.lockNotchDiameter > 0 && b.lockNotchHeight > 0) {
        const stubH = b.lockNotchHeight + SECTION_EMBED;
        const stub = cylinder(stubH, b.lockNotchDiameter / 2, 24);
        const stubAtTop = translate([0, 0, b.totalHeight - SECTION_EMBED], stub);
        body = union([outer, stubAtTop]);
      }
      if (b.holeDiameter <= 0) {
        return translate([b.x, b.y, 0], body);
      }
      // Main pilot drills the standoff body. If a starter pilot is
      // configured, it drills the stub portion only — narrower so the
      // screw bites the stub material first, then engages the wider main
      // pilot as it descends past the board surface.
      const mainPilotH = b.totalHeight + SECTION_EMBED;
      const mainPilot = translate(
        [0, 0, -1],
        cylinder(mainPilotH + 1, b.holeDiameter / 2, 24),
      );
      let piloted: BuildOp;
      if (b.lockNotchPilotDiameter > 0 && b.lockNotchHeight > 0) {
        const starterH = b.lockNotchHeight + 1;
        const starter = translate(
          [0, 0, b.totalHeight - SECTION_EMBED],
          cylinder(starterH, b.lockNotchPilotDiameter / 2, 24),
        );
        piloted = difference([body, mainPilot, starter]);
      } else {
        // Stub absent or no starter — let the main pilot pass through any
        // stub above by extending it the full composite height.
        const fullH = b.totalHeight + b.lockNotchHeight + 2;
        const fullPilot = translate([0, 0, -1], cylinder(fullH, b.holeDiameter / 2, 24));
        piloted = difference([body, fullPilot]);
      }
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
  postBottomZ: number,
): BuildOp[] {
  // Issue #162 — the post must reach DOWN TO THE BOARD. It used to be
  // `lidUndersideZ - totalHeight`, i.e. floor + standoff, a length with no
  // relationship to where the board top actually is: at standoff 4 it
  // stopped ~7 mm short, at standoff 10 it overshot into the PCB. The
  // caller now passes the board-top anchor (already clearance-adjusted).
  const height = lidUndersideZ - postBottomZ;
  if (height <= 0) return [];
  return placements
    .filter((b) => b.position === 'top')
    .map((b) => {
      const outer = cylinder(height, b.outerDiameter / 2, 32);
      if (b.holeDiameter <= 0) {
        return translate([b.x, b.y, postBottomZ], outer);
      }
      // Pilot extends through the lid (so the screw can pass through from
      // above) plus a small overshoot at the bottom.
      const pilot = cylinder(height + 2, b.holeDiameter / 2, 24);
      const piloted = difference([outer, translate([0, 0, -1], pilot)]);
      return translate([b.x, b.y, postBottomZ], piloted);
    });
}

// Issue #162 — buildBossSupportColumns (#104) removed. It buttressed a
// lid-anchored boss back when 'top' REPLACED the floor standoff. Now that
// the board always keeps its floor seat and the lid boss fuses into the lid,
// the shell-side columns attached to nothing: they left the shell mesh in 5
// disconnected pieces (two floating solids and two sealed voids) on every
// position='top' build.
