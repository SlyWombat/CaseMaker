/**
 * cam/model/wholeSurface.ts — #965: C's whole-surface union (`held/948-whole-surface-v2`,
 * `703fa730`), wired to read across `ModelPlanOutput.perSetup` instead of the old engine's
 * per-setup goal masks.
 *
 * `unionWholeSurface` below is PORTED, not re-derived: `held/948-whole-surface-v2`'s own
 * `goalWholeSurface.ts` is already generic, plain-data grid math (a `GoalSurfaceGrid`, two
 * `Uint8Array` masks, an optional setup→document affine) with no dependency on the old engine's
 * CAM pipeline, so this is close to a verbatim copy — only the doc above it changes, to point at
 * the new engine's own caller.
 *
 * WHAT ACTUALLY FEEDS IT, for THIS engine: `#965`'s own acceptance spec
 * (`tests/unit/figureAcceptance965.spec.ts`) does not build `GoalSetupSurface` masks itself — it
 * stamps every posted program from every setup directly onto ONE fixed `GoalHeightfield` via
 * `exactSweptField`, relying on `setups.ts`'s `mapIRToDocument` to have already put every setup's
 * moves in the SAME document frame (see that file's own doc). That is a valid, simpler way to get
 * the same whole-surface answer when every setup shares one grid pitch and origin, which the
 * figures do. This module is for a caller that instead wants the union formed from PER-SETUP
 * grids (a different pitch/origin per setup, or a setup whose own grid is not axis-aligned with
 * the document — `toDocument`'s own purpose) — e.g. a future UI "coverage by setup" report, or a
 * caller whose setups do not share one grid. `setupSurfaceFor` is the adapter from a `SetupPlan`'s
 * own per-cell "did the goal get reached" classification (which THIS engine does not carry as a
 * stored field — `SetupPlan.clGrid` is sampling METADATA, not the sampled grid itself, per
 * `plan.ts`'s own interface) to the `GoalSetupSurface` shape this union reads; a caller supplies
 * the masks (typically built the same way the acceptance spec's own `checkGoalCutInto` does),
 * naming which `SetupPlan` and which face each came from.
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
   * Absent/null: the setup's grid is the document grid (a single top setup, or every setup
   * already mapped to the document frame — `setups.ts`'s `mapIRToDocument`/`documentXY`).
   */
  toDocument?: readonly [number, number, number, number, number, number] | null;
  /** The setup's face, for the sentence ("top", "bottom"). */
  faceUp?: string;
  /**
   * The job fact excluded from the denominator when this setup's plan states one — the goal's
   * face against the stock's bottom (#898's `flatOnStockBottom` underside). `face` is the
   * sentence's own words ("the 36 × 100 face on the stock bottom"); the area becomes cells at the
   * document pitch.
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
 * unchanged — the single top setup's whole-surface reach IS its top-surface read (#965's
 * acceptance line: "a single top setup states top = whole").
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
