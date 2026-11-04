/**
 * #945 — THE FINISH STEP-OVER DERIVATION, PINNED AS A RULE (not a golden hash).
 *
 * `finishStepOverForCusp` (surface3d.ts) is a closed-form fix for ONE slice of #945's coverage
 * gap: on a FLAT span, a ball-nose finish's row-to-row cusp is the sagitta of a chord one
 * step-over long on the ball's own circle, and this function is the step-over that holds that
 * cusp at or under a stated band. It is not a tuned constant — a different cutter or a different
 * band re-derives a different number — and this spec pins that property directly (the first
 * `describe` below), closed-form, no mesh involved.
 *
 * The second `describe` measures what the rule actually buys on figure.stl (the #945 diagnosis
 * proxy), on the SAME metric the bench's own gate uses (`docs/bench/2026-10-28-z1-real-jobs/
 * tools/goal_check.py`'s `leftover0p1Pct`/`leftover0p3Pct`): over every COVERED CELL of
 * `sampleGoalHeightfield(target, { pitchMm: 0.1 })` (no clear band, no clip — the gate's own
 * `goal-hf.mts` call), the share where the swept top stands more than the band above the goal.
 * Cell-counted, not triangle-area-weighted: two earlier versions of this spec used a tip-field
 * eligibility test, then a triangle-area-weighted real sweep; NEITHER is the gate's own metric,
 * and both produced numbers that cannot be compared to the real job's manifest figures. This
 * version can.
 *
 * MEASURED ON THE PRODUCTION PIPELINE (2026-11-03, `generateGoalProgram` + a real dexel sim
 * session, NOT this file's own lighter FLAT-column harness below, whose absolute numbers differ
 * — only the DIRECTION is asserted from it): figure.stl, j29 placement, the real elephant job's
 * own 2 mm ball, this module's compiled-fallback step-over row (see the `legacyStepOverMm`
 * comment below for what is and is not known about the real job's own row), the shop's 0.1 mm
 * leftover-visible band, and the clear-band ring held fixed (#945 already decouples it from the
 * finish step-over). Of 22,865 covered cells: today's step-over (0.9 mm) leaves 51.56 % over the
 * 0.1 mm band (17.14 % over 0.3 mm); the derived step-over (0.8 mm) leaves 47.75 % (15.38 % over
 * 0.3 mm); the CEILING a stride-1 sweep (every row the grid offers — the best ANY step-over on
 * this one ball could do) leaves 29.22 % (8.60 % over 0.3 mm). So on the 0.1 mm band, about 43 %
 * of this job's leftover is closeable by this ball's OWN step-over alone
 * (`(51.56 − 29.22) / 51.56`), and the derived value closes about 17 % of that closeable share
 * (`(51.56 − 47.75) / (51.56 − 29.22)`) — real, but a small bite of a share that itself is under
 * half the total.
 *
 * WHETHER THIS MATCHES the #945 diagnosis's "a1 ≈ 94.5 % of the leftover" is NOT SETTLED here —
 * the two numbers are not yet comparable, not contradictory. The rest pass (#847/#912) is
 * planned from the gouge-safe TIP field, which does not depend on step-over, so a ⌀0.5 rest ball
 * (the real job's manifest states `idealCutterMm: 0.5`, from a 134-cutter shop this proxy does
 * not have) does not touch this 2 mm ball's own row cusps — those survive the rest pass
 * untouched. If the real job's rest pass took most of what ITS 2 mm ball alone could not reach,
 * its remaining leftover is mostly 2 mm cusps, and 94.5% would be consistent with this proxy's
 * 43% closeable share (no rest pass here to have already taken the rest). If instead the
 * diagnosis's "a1" meant leftover beyond the ⌀0.5 ball's own `beyondReach`, part of it is not
 * closeable by the 2 mm ball's step-over at all. Both readings are stated in the task report as
 * a question for the manager, not decided here.
 *
 * The remaining ~57 % of the proxy's leftover is not a step-over question for THIS ball at all:
 * it is either outside this ball's own reach (its own radius, independent of step-over — #912's
 * rest pass, or a smaller finishing ball), or, within what the ceiling shows is reachable, the
 * gap between the derived step-over and the ceiling (29.22 % vs 47.75 %) that a flat-span formula
 * does not model on real slopes — #671's scallop pass's territory, or simply a tighter raster
 * (closeable, at a real time cost:
 * production figures show 0.8 mm costs the finish operation +3.9 %; a fit against four measured
 * points puts the 1.5× guard near a 0.38 mm step-over on the WHOLE finish operation, or 0.6 mm on
 * just its step-over-scaling raster share — see the task report for both fits and why they
 * differ by the fixed cost of the rim laps). The assertions below pin the DIRECTION of what was
 * measured — tighter is better, not all the way there — not the specific percentages, which a
 * mesh, a placement or a column-engine change could move a little without the claim changing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { finishStepOverForCusp, generateSurface3dIR, type SurfaceFeeds, type SurfaceTool } from '@/engine/cnc/cam/surface3d';
import { sampleGoalHeightfield, DEFAULT_GRID_PITCH_MM } from '@/engine/cnc/engrave/goalHeightfield';
import { readTargetObjectFile, clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { flatEndMill } from '@/engine/cnc/tool';
import { FLAT, type ColumnCutter, type CutMove } from '@/workers/geometry/columnEngine';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { rectProfile } from '@/engine/compiler/profile';
import type { CamMove, RapidEstimate } from '@/engine/cnc/cam/ir';
import type { EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test' };
const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

/** The #945 diagnosis proxy: figure.stl at the j29 elephant job's own rotation/scale, on a stick. */
async function readFigureAtJ29Placement(): Promise<EngraveTargetObject> {
  const bytes = readFileSync(here('figure.stl'));
  const r = await readTargetObjectFile(new File([bytes], 'figure.stl'), 'goal-figure-945');
  if (!r.ok) throw new Error(r.error);
  return {
    id: r.id,
    name: r.name,
    format: r.format,
    sha256: r.sha256,
    data: r.data,
    size: r.size,
    position: { x: 18, y: 50, z: 0 },
    rotation: 90,
    enabled: true,
    role: 'goal',
    scale: { x: 0.6533, y: 0.6533, z: 0.6533 },
  };
}

/** Resolve feed endpoints into the FLAT column engine's `CutMove`s, as `surface3d.spec.ts` does. */
function cutMovesOf(moves: readonly CamMove[]): CutMove[] {
  const out: CutMove[] = [];
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1]!;
    const b = moves[i]!;
    if (b.kind !== 'feed') continue;
    out.push({ step: i, line: i, u0: a.x, u1: b.x, v0: a.y, v1: b.y, z: Math.min(a.z, b.z), z0: a.z, z1: b.z });
  }
  return out;
}

function prism(w: number, d: number, t: number): Setup {
  return stubSetup({ kind: 'prism', outline: rectProfile(w, d), thickness: t }, { kind: 'tape-down', contact: rectProfile(w, d) });
}

function heightAt(grid: ReturnType<typeof FLAT.buildGrid>, x: number, y: number): number | null {
  const i = Math.round((x - grid.u0) / grid.du);
  const j = Math.round((y - grid.v0) / grid.dv);
  if (i < 0 || j < 0 || i >= grid.nu || j >= grid.nv) return null;
  return grid.h[j * grid.nu + i] as number;
}

/** A real sweep of a ball of `radiusMm` at `stepOverMm` over the heightfield, as a (x, y) → Z fn. */
async function sweepTop(
  hf: ReturnType<typeof sampleGoalHeightfield>,
  radiusMm: number,
  stepOverMm: number,
): Promise<(x: number, y: number) => number | null> {
  const tool: SurfaceTool = { radius: radiusMm, ball: true };
  const feeds: SurfaceFeeds = { feed: 500, plungeFeed: 200, stepDown: 1, roughStepOver: stepOverMm, finishStepOver: stepOverMm };
  const { finishing } = await generateSurface3dIR({
    heightfield: hf,
    tool,
    toolObj: flatEndMill(radiusMm * 2, { shape: 'ball', name: `${radiusMm * 2} mm ball` }),
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    feeds,
    rapid: RAPID,
    labelId: 'goal-945',
    opts: { roughing: { mode: 'raster' } },
  });
  const cutter: ColumnCutter = { radius: 0, tanHalf: null, cornerRadius: radiusMm, outerRadius: radiusMm };
  const w = (hf.nx + 4) * hf.pitch;
  const d = (hf.ny + 4) * hf.pitch;
  const cut = cutMovesOf(finishing.moves);
  const grid = FLAT.buildGrid(prism(w, d, 50), cutter, cut, { dx: hf.pitch, dThetaDeg: hf.pitch });
  for (const m of cut) FLAT.applyMove(grid, m, cutter);
  return (x, y) => heightAt(grid, x, y);
}

/**
 * The bench gate's own metric (`goal_check.py`'s `leftover0pXPct`): of every COVERED cell of the
 * heightfield, the percentage where a real sweep of `radiusMm` at `stepOverMm` stands more than
 * `bandMm` above the goal. Cell-counted over the WHOLE covered footprint — no facing-away or
 * shadowed exclusion (the gate judges "side 1 only", exactly as a single top setup actually cuts
 * it) — so this is directly comparable to a job's manifest numbers.
 */
async function leftoverPct(
  target: EngraveTargetObject,
  radiusMm: number,
  stepOverMm: number,
  bandMm: number,
  pitchMm: number,
): Promise<number> {
  const hf = sampleGoalHeightfield(target, { stockTopZ: 0, pitchMm });
  const top = await sweepTop(hf, radiusMm, stepOverMm);
  let n = 0;
  let miss = 0;
  for (let j = 0; j < hf.ny; j++) {
    for (let i = 0; i < hf.nx; i++) {
      const idx = j * hf.nx + i;
      if (hf.covered[idx] !== 1) continue;
      n++;
      const goalZ = hf.z[idx] as number;
      const x = hf.x0 + i * hf.pitch;
      const y = hf.y0 + j * hf.pitch;
      const gotZ = top(x, y);
      const d = gotZ === null ? Infinity : gotZ - goalZ;
      if (d > bandMm) miss++;
    }
  }
  return n > 0 ? (miss / n) * 100 : 0;
}

describe('#945 a1 — finishStepOverForCusp, the derivation itself', () => {
  it('holds a flat span’s cusp at or under the band, for a spread of radii and bands', () => {
    const pitch = 0.1;
    for (const radiusMm of [0.5, 1, 1.5, 3, 6]) {
      for (const bandMm of [0.05, 0.1, 0.2]) {
        if (bandMm >= radiusMm) continue;
        const s = finishStepOverForCusp(radiusMm, bandMm, pitch);
        expect(s).not.toBeNull();
        const stepOverMm = s as number;
        // The stride this value reproduces inside `rasterRows` (`Math.round(stepOver/pitch)`)
        // must be exactly the one the derivation floored to — never one cell wider.
        expect(Math.round(stepOverMm / pitch)).toBe(Math.floor(stepOverMm / pitch + 1e-9));
        const cusp = radiusMm - Math.sqrt(radiusMm * radiusMm - (stepOverMm / 2) ** 2);
        expect(cusp).toBeLessThanOrEqual(bandMm + 1e-9);
        // It is the LARGEST stride-aligned step-over that holds the band — one more pitch-cell of
        // stride would breach it (otherwise the derivation is leaving cheap accuracy on the table,
        // or — #945, caught by this exact check before the `+ 1e-9` landed in `finishStepOverForCusp`
        // itself — silently floors an extra notch on float noise at a whole-stride boundary).
        const oneWider = stepOverMm + pitch;
        const cuspWider = radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - (oneWider / 2) ** 2));
        expect(cuspWider).toBeGreaterThan(bandMm);
      }
    }
  });

  it('returns null when the band is at or past the radius — a ball-radius question, not a row-spacing one', () => {
    expect(finishStepOverForCusp(1, 1, 0.1)).toBeNull();
    expect(finishStepOverForCusp(1, 1.5, 0.1)).toBeNull();
    expect(finishStepOverForCusp(0, 0.1, 0.1)).toBeNull();
    expect(finishStepOverForCusp(1, 0, 0.1)).toBeNull();
    expect(finishStepOverForCusp(1, 0.1, 0)).toBeNull();
  });
});

describe('#945 a1 — the derived step-over on figure.stl (the diagnosis proxy), on the gate’s own metric', () => {
  // THE BAND: the shop's own leftover-visible threshold (`rest.visibleDepthMm`'s fallback, 0.1 mm
  // — REST_MACHINING_FALLBACK.visibleDepth in restSettings.ts), the same number
  // `generateGoalProgram` derives the production default against. Not re-declared here as a
  // literal import (restSettings.ts is outside this module's ownership): 0.1 is its stated value.
  const bandMm = 0.1;
  const pitchMm = DEFAULT_GRID_PITCH_MM;
  // The real elephant job's own cutter: Makera's 2 mm ball (radius 1 mm).
  const radiusMm = 1;
  // This module's COMPILED-FALLBACK feeds row for this tool/material — what `resolved.params
  // .stepOver` resolves to with no catalogue and no location loaded (confirmed directly by
  // running `generateGoalProgram` for this job with `shop: {}` and `catalogue: []`, the no-
  // location inputs `tests/unit/helpers/engravePipeline.ts`'s `generate()` wrapper passes; this
  // file's own harness below does not call that path at all — it drives `generateSurface3dIR`
  // directly, which is why the header's production-pipeline numbers were measured separately).
  // The REAL elephant job runs against the full 134-cutter Makera catalogue, whose own step-over
  // row for this tool/material is NOT known on this box (no `catalogue.json` is checked in, by
  // this repo's own "no vendor rows" rule) — so whether this fix moves the real job's own number
  // at all depends on that row being coarser than the 0.8 mm this derivation produces. Flagged in
  // the task report, not resolved here.
  const legacyStepOverMm = 0.9;

  it('the derived step-over is tighter than today’s compiled-fallback row, and lowers the gate’s own leftover% — not to the ceiling', async () => {
    const target = await readFigureAtJ29Placement();
    const derived = finishStepOverForCusp(radiusMm, bandMm, pitchMm);
    expect(derived).not.toBeNull();
    const derivedStepOverMm = derived as number;
    expect(derivedStepOverMm).toBe(0.8);
    expect(derivedStepOverMm).toBeLessThan(legacyStepOverMm);

    const before = await leftoverPct(target, radiusMm, legacyStepOverMm, bandMm, pitchMm);
    const after = await leftoverPct(target, radiusMm, derivedStepOverMm, bandMm, pitchMm);
    const ceiling = await leftoverPct(target, radiusMm, pitchMm, bandMm, pitchMm);
    // This harness's own absolute percentages differ from the production-pipeline numbers in the
    // module doc comment above (no clear band/rim here, a lighter FLAT-column sweep) — only the
    // DIRECTION is asserted, deliberately not a specific target: a slope-aware fix that someday
    // reaches the ceiling must not fail this test for succeeding.
    expect(before).toBeGreaterThan(ceiling); // the lever has real room: not every cell is at the ceiling already.
    expect(after).toBeLessThan(before); // the fix moves the number, in the right direction.
  }, 120_000);
});
