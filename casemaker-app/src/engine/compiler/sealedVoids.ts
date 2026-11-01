import type { Mm, SealedVoid } from '@/types';

/**
 * Issue #850 — SEALED VOIDS, classified.
 *
 * A closed cavity inside a printed part is trapped air. Sometimes that is the
 * point — a captured magnet pocket is a void on purpose — and sometimes it is
 * an accident of a cutout or a union that left a cell walled in. The geometry
 * layer reports every void with its size and position (#850); this module
 * decides which ones nobody asked for, so exactly those are stated.
 *
 * DELIBERATE VAULTS ARE TAGGED WHERE THEY ARE CUT: the compiler knows the
 * magnet pockets it makes and hands their cavity centres here with the node
 * they land in (`magnets.ts`'s `deliberateVoidsFor`). A reported void matching
 * a tag on the same node is quiet; everything else is information.
 */

/** A void the compiler made on purpose, tagged where it was cut. */
export interface DeliberateVoid {
  /** The node id the cavity is inside ('shell', 'lid', …). */
  node: string;
  /** The cavity's centre, in the node's own frame, mm. */
  centreMm: [Mm, Mm, Mm];
}

/** A sealed cavity nobody asked for. */
export interface SealedVoidNote {
  node: string;
  volumeMm3: number;
  centreMm: [Mm, Mm, Mm];
}

/**
 * How close a reported void's centre must be to a tagged one to count as the
 * same cavity, mm. Manifold's bounding-box centre of a cavity and the pocket's
 * own centre agree well; the tolerance covers a boss or a rounded pocket floor
 * moving it by a fraction of a millimetre.
 */
export const VOID_MATCH_MM = 2;

/**
 * The voids that were NOT made on purpose, per node. Deliberate voids are
 * matched by node and centre; the rest come back as notes for the banner.
 */
export function classifySealedVoids(
  voidsByNode: ReadonlyMap<string, readonly SealedVoid[]>,
  deliberate: readonly DeliberateVoid[],
  matchMm = VOID_MATCH_MM,
): SealedVoidNote[] {
  const out: SealedVoidNote[] = [];
  for (const [node, voids] of voidsByNode) {
    for (const v of voids) {
      const matched = deliberate.some(
        (d) =>
          d.node === node &&
          Math.hypot(d.centreMm[0] - v.centreMm[0], d.centreMm[1] - v.centreMm[1], d.centreMm[2] - v.centreMm[2]) <=
            matchMm,
      );
      if (!matched) out.push({ node, volumeMm3: v.volumeMm3, centreMm: v.centreMm });
    }
  }
  return out;
}
