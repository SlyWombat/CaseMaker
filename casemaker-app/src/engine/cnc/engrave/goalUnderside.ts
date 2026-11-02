/**
 * #898 — WHERE THE PART'S UNDERSIDE COMES FROM, and what the app proposes.
 *
 * Today a goal is cut from the top to the mesh's own depth and its underside is simply whatever
 * the mesh says. The maintainer's two real parts need the choice stated: "for the elephant it is
 * designed to lay flat, so I would want it to stop cutting when it gets to the bottom of the mesh.
 * but the panther should have holding tabs that need to be cut off once the job is finished as it
 * should be a job that gets flipped".
 *
 * THIS MODULE OWNS THE READING AND THE CUT FLOOR. `goalUndersideOffer` measures the mesh (its flat
 * bottom's share of the footprint and the area that faces down above its bottom) and proposes one
 * of the three kinds with the number that decided it; `undersideFloorZ` turns a stated choice into
 * the work-frame Z the sampler floors the cut at (flat: the bottom plane plus a skin; plinth: a
 * stated height above the blank's bottom). The flipped-with-tabs kind's two bands are the split's
 * `bandMm` on each side (see `goalFlipSetups`), so its floor is that side's own band.
 *
 * The proposal NEVER writes the document: an absent block reads exactly as before, and the
 * operator's press stores the block with `source: 'user'`.
 */

import { placedSize } from './targetScale';
import { goalWorkMesh } from './goalFlipFindings';
import { coverageTriangles, sampleCoverageField, type CoverageMesh } from './goalCoverage';
import type { EngraveTargetObject, GoalUnderside, GoalUndersideKind } from '@/types/engraveJob';

/** The plinth's default height above the blank's bottom, mm. */
export const UNDERSIDE_PLINTH_MM = 2;

/** A bottom face this close to the mesh's lowest Z is its underside, mm. */
export const UNDERSIDE_TOL_MM = 0.1;

/**
 * The share of the footprint a flat bottom must cover for "flat on the stock bottom" to be the
 * proposal. A disc covers π/4 ≈ 0.785 of its bounding square, a plate 1.0, a posed figure far
 * less — 0.35 separates a designed flat base from a shaped or pointed underside.
 */
export const UNDERSIDE_FLAT_SHARE = 0.35;

/** The share of the goal's area that must face down above its bottom for a flip to be proposed. */
export const UNDERSIDE_UNDERCUT_SHARE = 0.02;

/** The grid the proposal is measured on, mm — the ring measure's own pitch. */
const PROPOSAL_PITCH_MM = 0.3;

/** What the app reads off a mesh, and the choice it proposes. */
export interface UndersideOffer {
  kind: GoalUndersideKind;
  /** The share of the footprint that is one face at the mesh's lowest Z, 0..1. */
  flatShare: number;
  /** The area that faces down ABOVE the mesh's bottom, mm² — undercuts, a shaped underside. */
  undercutMm2: number;
  /** The goal's whole surface area, mm². */
  totalMm2: number;
  /** The sentence naming the number that decided the proposal. */
  reason: string;
}

const percent = (fraction: number): string => `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;

/** The mesh's lowest Z and the footprint area, in the work frame. */
function bounds(mesh: CoverageMesh): { minZ: number; area: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i]! < minX) minX = p[i]!;
    if (p[i]! > maxX) maxX = p[i]!;
    if (p[i + 1]! < minY) minY = p[i + 1]!;
    if (p[i + 1]! > maxY) maxY = p[i + 1]!;
    if (p[i + 2]! < minZ) minZ = p[i + 2]!;
  }
  return { minZ, area: Math.max(0, maxX - minX) * Math.max(0, maxY - minY) };
}

/** The area of triangles whose three vertices all sit on the mesh's lowest plane, mm². */
function flatBottomArea(mesh: CoverageMesh, minZ: number): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  const plane = minZ + UNDERSIDE_TOL_MM;
  let area = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3;
    const b = idx[t + 1]! * 3;
    const c = idx[t + 2]! * 3;
    if (p[a + 2]! > plane || p[b + 2]! > plane || p[c + 2]! > plane) continue;
    const ux = p[b]! - p[a]!;
    const uy = p[b + 1]! - p[a + 1]!;
    const uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!;
    const vy = p[c + 1]! - p[a + 1]!;
    const vz = p[c + 2]! - p[a + 2]!;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    area += Math.hypot(cx, cy, cz) / 2;
  }
  return area;
}

/**
 * The app's reading of a goal mesh — a proposal only, with the number that decided it, or null
 * when the mesh cannot be read or is not a goal. It never looks at a stored `underside` block:
 * the offer is "what the mesh says", and the panel shows it beside whatever was chosen.
 */
export function goalUndersideOffer(goal: EngraveTargetObject): UndersideOffer | null {
  if ((goal.role ?? 'reference') !== 'goal' || !goal.enabled) return null;
  if (goal.format === 'png') return null; // a picture is a relief on the top; its underside is the blank
  const mesh = goalWorkMesh(goal);
  if (mesh === null) return null;
  const { minZ, area: footprintMm2 } = bounds(mesh);
  const flatArea = flatBottomArea(mesh, minZ);
  const flatShare = footprintMm2 > 0 ? Math.min(1, flatArea / footprintMm2) : 0;
  const field = sampleCoverageField(mesh, PROPOSAL_PITCH_MM);
  const facts = coverageTriangles(mesh, field);
  let undercutMm2 = 0;
  let totalMm2 = 0;
  for (const f of facts) {
    totalMm2 += f.areaMm2;
    // Facing DOWN (the tool cannot reach it from above) and standing above the part's own bottom
    // (a bottom face at minZ is not an undercut — it is the flat bottom itself).
    if (f.cls === 'facingAway' && f.centre[2] > minZ + UNDERSIDE_TOL_MM) undercutMm2 += f.areaMm2;
  }
  const undercutShare = totalMm2 > 0 ? undercutMm2 / totalMm2 : 0;
  if (flatShare >= UNDERSIDE_FLAT_SHARE) {
    return {
      kind: 'flat',
      flatShare,
      undercutMm2,
      totalMm2,
      reason: `its bottom is a flat face over ${percent(flatShare)} of its footprint, so it can stop on the stock's own bottom`,
    };
  }
  if (undercutShare > UNDERSIDE_UNDERCUT_SHARE) {
    return {
      kind: 'flipped-tabs',
      flatShare,
      undercutMm2,
      totalMm2,
      reason: `${percent(undercutShare)} of its surface faces down above its bottom, so one side cannot cut it`,
    };
  }
  return {
    kind: 'flat',
    flatShare,
    undercutMm2,
    totalMm2,
    reason: `its underside offers no face the top setup cannot reach, so it stops on the stock's own bottom`,
  };
}

/**
 * The work-frame Z the CUT's floor sits at for a stated underside, or null when the block has no
 * floor of its own.
 *
 * Only `plinth` floors the part's own cut: the part is machined down to the blank's bottom plus
 * its height, and everything below that is a flat base. A `flat` part is cut to its mesh's own
 * surface — the bottom face is never machined at all — so its floor is the surface program's own;
 * what its SKIN changes is the CLEAR BAND's floor ({@link undersideClearBaseZ}), and the flipped
 * kind's floor is each side's `bandMm`. A split side's band is applied by the caller before this,
 * so the two can never disagree about which floor a program cuts to.
 */
export function undersideFloorZ(
  goal: EngraveTargetObject,
  stock: { thickness: number },
): number | null {
  const block = goal.underside;
  if (block?.kind !== 'plinth') return null;
  return -stock.thickness + Math.max(0, block.plinthMm ?? UNDERSIDE_PLINTH_MM);
}

/**
 * #898 — THE CLEAR BAND'S FLOOR under a FLAT underside: the part's own base plane, raised by the
 * skin that is left to break out. The band around the part is what frees it; a floor `skinMm`
 * above the base leaves that skin connecting the part to the surrounding stock, so the part comes
 * out held rather than loose. Null when the kind is not flat or the skin is zero — today's band.
 */
export function undersideClearBaseZ(goal: EngraveTargetObject): number | null {
  const block = goal.underside;
  if (block?.kind !== 'flat') return null;
  const skin = Math.max(0, block.skinMm ?? 0);
  if (!(skin > 0)) return null;
  return goal.position.z - placedSize(goal).z + skin;
}

/** The sentence beside the choice: what the chosen kind does, in the operator's terms. */
export function undersideSentence(goal: EngraveTargetObject): string | null {
  const block = goal.underside;
  if (block === undefined) return null;
  switch (block.kind) {
    case 'flat': {
      const skin = Math.max(0, block.skinMm ?? 0);
      const tabs = block.tabs;
      const freed =
        tabs !== undefined
          ? `freed by ${tabs.count} tab${tabs.count === 1 ? '' : 's'} ${tabs.widthMm} mm wide on the outline`
          : skin > 0
            ? `the part is freed by breaking out a ${skin} mm skin`
            : 'the part is freed by cutting round its footprint';
      return `Cut stops at the part's bottom${skin > 0 ? ` (${skin} mm skin left)` : ''}; ${freed}.`;
    }
    case 'flipped-tabs':
      return 'Cut from both sides at the part’s widest line; the tabs holding it to the stock are cut off by hand after.';
    case 'plinth': {
      const plinth = Math.max(0, block.plinthMm ?? UNDERSIDE_PLINTH_MM);
      return `Cut stops ${plinth} mm above the blank's bottom, leaving a plinth the part stands on.`;
    }
  }
}

/** The three choices, in the panel's order, with the sentence each one promises. */
export const UNDERSIDE_CHOICES: readonly { kind: GoalUndersideKind; label: string }[] = [
  { kind: 'flat', label: "flat on the stock's bottom" },
  { kind: 'flipped-tabs', label: 'flipped, held by tabs' },
  { kind: 'plinth', label: 'on a plinth' },
];

/** A chosen block for a kind, keeping nothing from a different kind. */
export function undersideFor(kind: GoalUndersideKind, previous?: GoalUnderside): GoalUnderside {
  return { kind, source: 'user', ...(kind === 'flat' && previous?.kind === 'flat' ? { skinMm: previous.skinMm, tabs: previous.tabs } : {}), ...(kind === 'plinth' && previous?.kind === 'plinth' ? { plinthMm: previous.plinthMm } : {}) };
}

/**
 * THE GOAL ROW CALLS THIS ON EVERY RENDER, so the proposal is cached on the facts it reads — the
 * same discipline `jobTopFaceCached` and `jobFlipFindings` follow. An edit anywhere the measure
 * reads misses the cache; everything else hits.
 */
const offerCache = new Map<string, UndersideOffer | null>();
const OFFER_CACHE_MAX = 8;

export function goalUndersideCached(goal: EngraveTargetObject): UndersideOffer | null {
  const s = goal.scale ?? { x: 1, y: 1, z: 1 };
  const key = [
    goal.sha256,
    goal.format,
    goal.data === undefined ? 'blob-absent' : 'blob-present',
    goal.enabled ? 1 : 0,
    goal.role ?? 'reference',
    goal.position.x, goal.position.y, goal.position.z,
    goal.rotation, goal.rotationX ?? 0, goal.rotationY ?? 0,
    s.x, s.y, s.z,
  ].join('|');
  if (offerCache.has(key)) return offerCache.get(key) as UndersideOffer | null;
  const computed = goalUndersideOffer(goal);
  offerCache.set(key, computed);
  if (offerCache.size > OFFER_CACHE_MAX) {
    const first = offerCache.keys().next().value;
    if (first !== undefined) offerCache.delete(first);
  }
  return computed;
}
