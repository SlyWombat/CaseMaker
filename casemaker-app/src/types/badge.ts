import type { Mm } from './units';

/**
 * Issue #167 — the two-colour name-badge blank, as a first-class project.
 *
 * This is the part `samples/badge-blank/make_badge.py` draws, ported onto the
 * Profile IR (`src/engine/compiler/badge.ts`). The script is the one-time
 * ORACLE: the sample STLs beside it are its output, and `tests/unit/badge.spec.ts`
 * asserts the compiled geometry matches them.
 *
 * Frame and orientation, matching the oracle exactly:
 *
 *   - the outline is CENTRED on the XY origin (the script builds it from
 *     `±(W/2, H/2)`, not from a corner), so the bounding box is
 *     `[-W/2, W/2] × [-H/2, H/2] × [0, thickness]`;
 *   - `z = 0` is the BACK face — the one that carries the magnet pocket and
 *     sits on the print bed in the oracle's own 3MF;
 *   - the colour split is the plane `z = splitHeight`. The bottom colour fills
 *     `0 … splitHeight` (pocket and pocket roof included); the top colour is
 *     `splitHeight … thickness` and is the face that gets engraved.
 *
 * Printing: the blank prints FLIPPED — engraved face on the bed, pocket opening
 * upward (no support, no bridging). The oracle ships its 3MF identity-
 * transformed, i.e. in the wrong orientation, so the flip belongs in the app's
 * print layout; see the print table in `src/engine/exporters/parts.ts`.
 *
 * Defaults are the oracle script's parameters, not invented numbers. #166 owns
 * the blank PRINT specification (infill, usable depth band) and may re-point
 * the thickness/split; these are the geometry the sample STLs were built from
 * (`make_badge.py:20-33`, sizes given there in inches).
 */
export interface BadgeMagnetPocket {
  /** Pocket length along X, mm (the script's `--magnet L`). */
  length: Mm;
  /** Pocket width along Y, mm (the script's `--magnet W`). */
  width: Mm;
  /** Pocket depth up from the back face, mm. Must be < splitHeight. */
  depth: Mm;
}

export interface BadgeParams {
  enabled: boolean;
  /** Overall length along X, mm. Oracle: 3.0 in. */
  width: Mm;
  /** Overall width along Y, mm. Oracle: 1.5 in. */
  height: Mm;
  /** Overall thickness, back face to engraved face, mm. Oracle: 0.15 in. */
  thickness: Mm;
  /** Corner radius of the outline, mm. Oracle: 0.125 in. */
  cornerRadius: Mm;
  /** Height of the colour-change plane above the back face, mm. */
  splitHeight: Mm;
  /**
   * Magnet pocket recessed into the BACK face, centred on the outline. `null`
   * = no pocket (the oracle's `--magnet 0 0 0`).
   */
  magnetPocket: BadgeMagnetPocket | null;
  /** Extruder (tool) the bottom colour prints on. Oracle: T2. */
  bottomExtruder: number;
  /** Extruder (tool) the top colour prints on. Oracle: T3. */
  topExtruder: number;
}

/**
 * The oracle's default part: 76.2 × 38.1 × 3.81 mm, R3.175, split at 3.0 mm,
 * a 45 × 13 × 2.3 mm pocket, extruders 2 and 3.
 */
export function defaultBadgeParams(overrides: Partial<BadgeParams> = {}): BadgeParams {
  return {
    enabled: true,
    width: 76.2,
    height: 38.1,
    thickness: 3.81,
    cornerRadius: 3.175,
    splitHeight: 3.0,
    magnetPocket: { length: 45, width: 13, depth: 2.3 },
    bottomExtruder: 2,
    topExtruder: 3,
    ...overrides,
  };
}

/**
 * The one assertion the oracle script makes (`make_badge.py:33-34`), as a
 * check rather than a crash: the pocket has to sit wholly inside the bottom
 * colour, or the colour change would cut through the pocket roof.
 *
 * Returns a human-readable reason, or `null` when the parameters are sound.
 */
export function badgeParamsProblem(b: BadgeParams): string | null {
  if (!(b.thickness > 0)) return 'the badge thickness must be positive';
  if (!(b.splitHeight > 0)) return 'the colour split height must be positive';
  if (b.splitHeight >= b.thickness) {
    return `the colour split (${b.splitHeight} mm) must be below the thickness (${b.thickness} mm) — nothing would be left for the top colour`;
  }
  const p = b.magnetPocket;
  if (!p) return null;
  if (!(p.depth > 0)) return 'the magnet pocket depth must be positive, or the pocket should be null';
  if (p.depth >= b.splitHeight) {
    return `the magnet pocket (${p.depth} mm deep) would break through the colour split (${b.splitHeight} mm) — its roof must stay in the bottom colour`;
  }
  if (p.length >= b.width - 2 || p.width >= b.height - 2) {
    return `the magnet pocket (${p.length} × ${p.width} mm) is too big for the badge (${b.width} × ${b.height} mm) — the oracle keeps 1 mm of wall per side`;
  }
  return null;
}
