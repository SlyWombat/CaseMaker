/**
 * #948 review §4.1 — THE WHOLE-SURFACE PASS LINE, formed from every proposed setup's sweep.
 *
 * The pass line is no longer the top-surface band: it is the share of the goal's WHOLE surface
 * reproduced within the leftover band after all the setups the app proposes — the flip plan's
 * setups when it proposes them; a single top setup reads its top-surface number as its
 * whole-surface reach, stated. The elephant's underside on the stock bottom is excluded by
 * design, and the exclusion is a JOB FACT the sentence names ("the 36 × 100 face on the stock
 * bottom, N % of the surface"), never a silent subtraction.
 *
 * One setup's contribution is a MASK on its own goal grid (the same grid its program is stamped
 * on — the page rule, `exactSweptField`): `covered` marks the goal cells it samples and `reached`
 * marks those standing within the leftover band of the goal. This module is the one place that
 * maps the setups' masks into the DOCUMENT frame — the goal's own grid — and unions them:
 *
 *   reached(document) = ⋃_s toDocument_s(reached_s)
 *   cells(document)   = ⋃_s toDocument_s(covered_s)  −  the named excluded underside
 *
 * `toDocument` is the setup→document XY affine `[a b c; d e f]` the flip plan carries (#898 part
 * 2's setup interface, agreed on #945); absent, the setup's grid IS the document grid (today's
 * single top setup). The masks and the affine are plain data, so the union can be formed in the
 * worker and carried to the main thread like the heightfield itself.
 */

/** A grid as the page rule uses it: the goal's own cell centres. */
export interface GoalSurfaceGrid {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  pitch: number;
}

/** One proposed setup's contribution to the whole-surface field. */
export interface GoalSetupSurface {
  /** The setup's own goal grid (its frame) — the grid its programs are stamped on. */
  grid: GoalSurfaceGrid;
  /** 1 where the goal is covered on `grid` (the setup's cells of the denominator). */
  covered: Uint8Array;
  /** 1 where this setup's sweep stands within the leftover band of the goal, on `grid`. */
  reached: Uint8Array;
  /**
   * Setup cell centre → document XY, `[a b c; d e f]` with `doc = (a·x + b·y + c, d·x + e·y + f)`.
   * Absent/null: the setup's grid is the document grid (the single top setup today).
   */
  toDocument?: readonly [number, number, number, number, number, number] | null;
  /** The setup's face, for the sentence ("top", "bottom"). */
  faceUp?: string;
  /**
   * The job fact excluded from the denominator when this setup's plan states one — the goal's
   * face against the stock's bottom. `face` is the sentence's own words ("the 36 × 100 face on
   * the stock bottom"); the area becomes cells at the document pitch.
   */
  excluded?: { reason: 'stock-bottom'; areaMm2: number; face: string } | null;
}

/** The union over every proposed setup, as the goal check and the Cut card read it. */
export interface WholeSurfaceReach {
  /** Share of the goal's whole surface reproduced after every proposed setup, 0–1. */
  fraction: number;
  /** Reached cells over the document grid (after the union). */
  reachedCells: number;
  /** The denominator: covered goal cells minus the named excluded underside. */
  cells: number;
  /** Covered goal cells before the exclusion. */
  coveredCells: number;
  /** Excluded underside cells (the job fact); 0 when no setup names one. */
  excludedCells: number;
  /** The excluded face's stated area, mm²; 0 when none. */
  excludedAreaMm2: number;
  /** The excluded face, named for the sentence; null when none. */
  excludedFace: string | null;
  /** How many proposed setups contributed. */
  setups: number;
  /** The document grid the union was formed on. */
  grid: GoalSurfaceGrid;
}

/**
 * The union of the setups' reached masks in the DOCUMENT frame. Null when no setup covers a goal
 * cell (nothing to measure). A single setup with no affine is the identity case: its own masks,
 * unchanged — the single top setup's whole-surface reach IS its top-surface read.
 */
export function unionWholeSurface(
  documentGrid: GoalSurfaceGrid,
  setups: readonly GoalSetupSurface[],
): WholeSurfaceReach | null {
  const { nx, ny, x0, y0, pitch } = documentGrid;
  const covered = new Uint8Array(nx * ny);
  const reached = new Uint8Array(nx * ny);
  let excludedAreaMm2 = 0;
  let excludedFace: string | null = null;
  let used = 0;

  for (const setup of setups) {
    const map = setup.toDocument ?? null;
    const g = setup.grid;
    let contributed = false;
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        const k = j * g.nx + i;
        if (setup.covered[k] !== 1) continue;
        const sx = g.x0 + i * g.pitch;
        const sy = g.y0 + j * g.pitch;
        const dx = map === null ? sx : map[0] * sx + map[1] * sy + map[2];
        const dy = map === null ? sy : map[3] * sx + map[4] * sy + map[5];
        const di = Math.round((dx - x0) / pitch);
        const dj = Math.round((dy - y0) / pitch);
        if (di < 0 || dj < 0 || di >= nx || dj >= ny) continue;
        const dk = dj * nx + di;
        covered[dk] = 1;
        if (setup.reached[k] === 1) reached[dk] = 1;
        contributed = true;
      }
    }
    if (contributed) used++;
    if (setup.excluded !== undefined && setup.excluded !== null) {
      excludedAreaMm2 += setup.excluded.areaMm2;
      excludedFace = excludedFace ?? setup.excluded.face;
    }
  }

  let coveredCells = 0;
  let reachedCells = 0;
  for (let k = 0; k < covered.length; k++) {
    if (covered[k] === 1) coveredCells++;
    if (reached[k] === 1) reachedCells++;
  }
  if (coveredCells === 0) return null;
  const cellArea = pitch * pitch;
  // The exclusion is a stated area on the document grid; never more than the surface itself.
  const excludedCells = Math.min(coveredCells, Math.round(excludedAreaMm2 / cellArea));
  const cells = Math.max(coveredCells - excludedCells, 1);
  return {
    fraction: Math.min(1, reachedCells / cells),
    reachedCells,
    cells,
    coveredCells,
    excludedCells,
    excludedAreaMm2,
    excludedFace,
    setups: used,
    grid: documentGrid,
  };
}
