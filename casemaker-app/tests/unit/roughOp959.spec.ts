/**
 * #959 — THE ROUGH OP, RED-FIRST.
 *
 * `cam/model/ops/rough.ts`'s `rough()` against two fixtures: an ANALYTIC dome (a paraboloid with
 * a known CL surface, so the op's own levels/masks/linking are what is measured, not the
 * drop-cutter) and the FIGURE PROXY (`figure.stl` at the j29 elephant job's 0.6533 scale, through
 * B's real `clSurface`/drop-cutter). Both checks are the ones the manager named:
 *
 *  - NO LEVEL CUTS BELOW THE CL SURFACE — every feed move's Z is at or above the CL height at its
 *    own XY, and the swept top (the flat disc stamped along every lateral feed) never falls below
 *    the CL surface anywhere it covers;
 *  - THE LEFTOVER ABOVE THE CL SURFACE ≤ stock-to-leave + one step-down — measured on points the
 *    rough actually cut, clear of the footprint's own edge, with the grid's own half-cell term
 *    stated (the mask is sampled on a grid, so a cell is judged by its high side).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { rough } from '../../src/engine/cnc/cam/model/ops/rough';
import type { ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import { clSurface } from '../../src/engine/cnc/cam/model/clsurface';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import type { FeatureSource, RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import type { Box2, RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import { targetObjectMesh } from '../../src/engine/import/targetObject';
import { placeTarget } from '../../src/engine/cnc/engrave/targetPlace';
import type { EngraveTargetObject } from '../../src/types/engraveJob';

const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const FEEDS = { feedMmPerMin: 900, plungeFeedMmPerMin: 250 };
const flat6: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });

const STEP_DOWN = 1.5;
const LEAVE = 0.3;

function regionOf(id: string, bounds: Box2, zTop: number, zBottom: number, slopeMaxDeg: number): { region: RemainderRegion; regionRef: RegionRef } {
  const [[x0, y0], [x1, y1]] = [bounds.min, bounds.max];
  const footprint: [number, number][][] = [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
  return {
    region: {
      id,
      footprint,
      area: (x1 - x0) * (y1 - y0),
      zTop,
      zBottom,
      triangles: new Uint32Array(),
      slopeDeg: [0, slopeMaxDeg],
      slopeMedianDeg: slopeMaxDeg / 2,
      in: 'top',
    },
    regionRef: { id, kind: 'curved', bounds, topZ: zTop, bottomZ: zBottom, obstacles: [], regionClearanceZ: zTop + 5 },
  };
}

/** The swept top from the posted moves: the flat disc stamped along every LATERAL feed at its Z. */
function sweptTop(
  ir: ReturnType<typeof rough>['ir'],
  radius: number,
  x0: number,
  y0: number,
  pitch: number,
  nx: number,
  ny: number,
  stockTop: number,
): Float64Array {
  const top = new Float64Array(nx * ny).fill(stockTop);
  const stamp = (cx: number, cy: number, z: number): void => {
    const iLo = Math.max(0, Math.floor((cx - radius - x0) / pitch));
    const iHi = Math.min(nx - 1, Math.ceil((cx + radius - x0) / pitch));
    const jLo = Math.max(0, Math.floor((cy - radius - y0) / pitch));
    const jHi = Math.min(ny - 1, Math.ceil((cy + radius - y0) / pitch));
    for (let j = jLo; j <= jHi; j++) {
      for (let i = iLo; i <= iHi; i++) {
        const dx = x0 + i * pitch - cx;
        const dy = y0 + j * pitch - cy;
        if (dx * dx + dy * dy > radius * radius) continue;
        const k = j * nx + i;
        if (z < top[k]!) top[k] = z;
      }
    }
  };
  for (const op of ir.operations) {
    let prev = null as { kind: string; x: number; y: number; z: number } | null;
    for (const m of op.moves) {
      if (m.kind === 'feed') {
        // Every feed cuts the disc at its own endpoint (a plunge's landing included).
        stamp(m.x, m.y, m.z);
        // A LATERAL cut only joins two feeds at the SAME Z; after a retract (any rapid) the next
        // feed is a plunge at a new XY, not a straight cut across the gap.
        if (prev !== null && prev.kind === 'feed' && Math.abs(prev.z - m.z) < 1e-9 && (m.x !== prev.x || m.y !== prev.y)) {
          const length = Math.hypot(m.x - prev.x, m.y - prev.y);
          const steps = Math.max(1, Math.ceil(length / (pitch / 2)));
          for (let s = 1; s < steps; s++) {
            const t = s / steps;
            stamp(prev.x + (m.x - prev.x) * t, prev.y + (m.y - prev.y) * t, m.z);
          }
        }
      }
      prev = { kind: m.kind, x: m.x, y: m.y, z: m.z };
    }
  }
  return top;
}

/** Every feed move's own Z against the CL surface at its XY — the no-gouge rule at the path. */
function assertNoFeedBelowCl(ir: ReturnType<typeof rough>['ir'], cl: ClSurface, tolerance: number): void {
  for (const op of ir.operations) {
    for (const m of op.moves) {
      if (m.kind !== 'feed') continue;
      const z = cl.dropCutter(m.x, m.y);
      if (z !== null) expect(m.z, `a feed at (${m.x.toFixed(2)}, ${m.y.toFixed(2)}) is below the CL surface`).toBeGreaterThanOrEqual(z - tolerance);
    }
  }
}

describe('#959 rough — the analytic dome', () => {
  // A paraboloid cap: z = H0 (1 − (r/a)^2) above a flat base, apex 5 mm up. The flat cutter's CL
  // surface is analytic: the disc descends onto its HIGHEST surface point, which for this convex
  // cap is the point nearest the apex — h(max(0, d − r)).
  const A = 15;
  const H0 = 5;
  const R = 3;
  const bounds: Box2 = { min: [-28, -28], max: [28, 28] };
  const clAt = (x: number, y: number): number => {
    if (x < bounds.min[0] || x > bounds.max[0] || y < bounds.min[1] || y > bounds.max[1]) return Number.NaN;
    const d = Math.max(0, Math.hypot(x, y) - R);
    return Math.max(0, H0 * (1 - (d / A) ** 2));
  };
  const cl: ClSurface = {
    dropCutter: (x, y) => {
      const v = clAt(x, y);
      return Number.isFinite(v) ? v : null;
    },
    toleranceMm: 0.01,
    minSpacingMm: 0.1,
    minSpacingSource: 'derived',
    minSpacingFromStepOverMm: 1,
    maxSpacingMm: 0.5,
    sampleCount: 0,
  };

  it('#1002 — a rapid never descends below the CL surface when stepDown exceeds the hop', () => {
    // Companion to the RED-FIRST pocket fixture in `pocketOp959` (#1002). This dome does not
    // reach the defect on its own — its adjacent ground sits at the landing's own z, so the buggy
    // per-ring band and the finished-level proof agree here (verified at 8f5cc4c18) — but it pins
    // the rough op's version of the same rule at stepDown 2 > hop 1, which the built-in feeds'
    // stepDowns (all <= 1.0 = the default hop) would otherwise never exercise.
    const { region, regionRef } = regionOf('dome-1002', bounds, 8, 0, 22);
    const out = rough({
      cutter: flat6,
      region,
      regionRef,
      clSurface: cl,
      stepDownMm: 2,
      stockToLeaveMm: LEAVE,
      stepOverMm: 3,
      gridPitchMm: 0.25,
      feeds: FEEDS,
      offset: makeClipperOffset(tl),
      safeZMm: 12,
      hopZMm: 1,
      axisPrecision: 3,
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      rapid,
    });
    let rapidsChecked = 0;
    for (const op of out.ir.operations) {
      for (const m of op.moves) {
        if (m.kind !== 'rapid') continue;
        const z = cl.dropCutter(m.x, m.y);
        if (z === null) continue;
        rapidsChecked++;
        expect(m.z, `a rapid at (${m.x.toFixed(2)}, ${m.y.toFixed(2)}) is below the CL surface ${z.toFixed(2)}`).toBeGreaterThanOrEqual(z - 1e-6);
      }
    }
    // Non-vacuous: the plan actually has rapids over the surface to check.
    expect(rapidsChecked).toBeGreaterThan(3);
  }, 120_000);

  it('never cuts below the CL surface; the leftover above it is within leave + one step-down', () => {
    const { region, regionRef } = regionOf('dome', bounds, 8, 0, 22);
    const out = rough({
      cutter: flat6,
      region,
      regionRef,
      clSurface: cl,
      stepDownMm: STEP_DOWN,
      stockToLeaveMm: LEAVE,
      stepOverMm: 3,
      gridPitchMm: 0.25,
      feeds: FEEDS,
      // The real Clipper2 offset — the masks are rectilinear unions with holes, which a
      // bbox-shaped test fake would flatten (cutting straight through the cell the mask excludes).
      offset: makeClipperOffset(tl),
      safeZMm: 12,
      hopZMm: 3,
      axisPrecision: 3,
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      rapid,
    });

    expect(out.ir.operations[0]!.moves.length).toBeGreaterThan(0);
    assertNoFeedBelowCl(out.ir, cl, 1e-6);

    // The swept top over a 1 mm grid, then the leftover above the CL surface where the rough cut.
    const P = 1;
    const N = Math.floor((bounds.max[0] - bounds.min[0]) / P) + 1;
    const top = sweptTop(out.ir, R, bounds.min[0], bounds.min[1], P, N, N, 8);
    let cut = 0;
    let checked = 0;
    let worst = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = bounds.min[0] + i * P;
        const y = bounds.min[1] + j * P;
        // Clear of the footprint's own edge, where no contour-parallel path can reach.
        if (x < bounds.min[0] + R + P || x > bounds.max[0] - R - P || y < bounds.min[1] + R + P || y > bounds.max[1] - R - P) continue;
        const k = j * N + i;
        const target = clAt(x, y);
        if (!Number.isFinite(target)) continue;
        const t = top[k]!;
        // Never below the CL surface anywhere the sweep covered (the gouge rule, on the stamp).
        expect(t, `the sweep cut below the CL surface at (${x}, ${y})`).toBeGreaterThanOrEqual(target - 1e-6);
        if (t >= 8 - 1e-9) continue; // untouched by the rough: outside what the levels could reach
        cut++;
        checked++;
        const leftover = t - target;
        expect(leftover, `leftover ${leftover.toFixed(3)} mm above the CL at (${x}, ${y})`).toBeLessThanOrEqual(LEAVE + STEP_DOWN + 0.25);
        worst = Math.max(worst, leftover);
      }
    }
    // The dome is smooth and every interior point is reachable: nearly all of them were cut.
    expect(cut / Math.max(1, checked)).toBeGreaterThan(0.95);
    console.log(`dome: cut ${cut}/${checked}, worst leftover ${worst.toFixed(3)} mm (leave ${LEAVE} + step-down ${STEP_DOWN})`);
  }, 240_000);
});

describe('#959 rough — the figure proxy', () => {
  const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

  /** figure.stl at the j29 elephant job's own placement, as a work-frame mesh. */
  function figureGeometry(): { geometry: FeatureSource; target: EngraveTargetObject; bbox: { min: [number, number, number]; max: [number, number, number] } } {
    const bytes = readFileSync(here('figure.stl'));
    const target: EngraveTargetObject = {
      id: 'figure',
      name: 'figure.stl',
      format: 'stl',
      sha256: 'fixture',
      data: bytes.toString('base64'),
      size: { x: 1, y: 1, z: 1 },
      position: { x: 0, y: 0, z: 0 },
      rotation: 90,
      enabled: true,
      role: 'goal',
      scale: { x: 0.6533, y: 0.6533, z: 0.6533 },
    };
    const mesh = targetObjectMesh(target);
    const { place } = placeTarget(target, mesh);
    const positions = new Float32Array(mesh.positions.length);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < mesh.positions.length; v += 3) {
      const [x, y, z] = place(mesh.positions[v]!, mesh.positions[v + 1]!, mesh.positions[v + 2]!);
      positions[v] = x;
      positions[v + 1] = y;
      positions[v + 2] = z;
      min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
    }
    return {
      geometry: { triangles: { positions, indices: mesh.indices, triangleCount: mesh.triangleCount, bbox: { min, max } } },
      target,
      bbox: { min, max },
    };
  }

  it('never cuts below the CL surface on the elephant; the cut points keep the allowance', () => {
    const { geometry, bbox } = figureGeometry();
    const zTop = 6;
    const zBottom = bbox.min[2];
    const bounds: Box2 = {
      min: [bbox.min[0] - 2, bbox.min[1] - 2],
      max: [bbox.max[0] + 2, bbox.max[1] + 2],
    };
    const { region, regionRef } = regionOf('figure', bounds, zTop, zBottom, 60);
    const cl = clSurface(geometry, region, flat6, 3);

    const out = rough({
      cutter: flat6,
      region,
      regionRef,
      clSurface: cl,
      stepDownMm: STEP_DOWN,
      stockToLeaveMm: LEAVE,
      stepOverMm: 3,
      gridPitchMm: 0.6,
      feeds: FEEDS,
      offset: makeClipperOffset(tl),
      safeZMm: zTop + 5,
      hopZMm: 3,
      axisPrecision: 3,
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      rapid,
    });

    expect(out.ir.operations[0]!.moves.length).toBeGreaterThan(0);
    assertNoFeedBelowCl(out.ir, cl, 1e-6);

    const P = 1;
    const N = Math.floor((bounds.max[0] - bounds.min[0]) / P) + 1;
    const M = Math.floor((bounds.max[1] - bounds.min[1]) / P) + 1;
    const top = sweptTop(out.ir, 3, bounds.min[0], bounds.min[1], P, N, M, zTop);
    // The CL surface on the same grid, for the per-point checks and the reach filter below.
    const clv = new Float64Array(N * M).fill(Number.NaN);
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const z = cl.dropCutter(bounds.min[0] + i * P, bounds.min[1] + j * P);
        if (z !== null) clv[j * N + i] = z;
      }
    }
    // WHERE THE RULE APPLIES. A ⌀6 flat cannot enter a crevice narrower than its disc, and the
    // elephant has them: inside one the cutter only ever passes overhead, leaving a column the
    // finish must clear. The rough's promise is about ground the cutter can FOLLOW — points whose
    // CL surface stays within one step-down over the cutter's own radius. Anything steeper is
    // stated as the finish's, exactly as the reference cards' "the model's own crevices" line does.
    const R = 3;
    const reachable = (i: number, j: number): boolean => {
      const z = clv[j * N + i]!;
      if (!Number.isFinite(z)) return false;
      const cells = Math.ceil(R / P);
      for (let dj = -cells; dj <= cells; dj++) {
        for (let di = -cells; di <= cells; di++) {
          const jj = j + dj;
          const ii = i + di;
          if (jj < 0 || ii < 0 || jj >= M || ii >= N) continue;
          if (Math.hypot(di * P, dj * P) > R) continue;
          const zn = clv[jj * N + ii]!;
          if (Number.isFinite(zn) && zn - z > STEP_DOWN / 2) return false;
        }
      }
      return true;
    };
    let cut = 0;
    let judged = 0;
    let worst = 0;
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const x = bounds.min[0] + i * P;
        const y = bounds.min[1] + j * P;
        const k = j * N + i;
        const z = clv[k]!;
        if (!Number.isFinite(z)) continue;
        const t = top[k]!;
        expect(t, `the sweep cut below the CL surface at (${x}, ${y})`).toBeGreaterThanOrEqual(z - 1e-6);
        if (!reachable(i, j)) continue;
        judged++;
        if (t >= zTop - 1e-9) continue;
        cut++;
        worst = Math.max(worst, t - z);
        expect(t - z, `leftover ${(t - z).toFixed(3)} mm above the CL at (${x}, ${y})`).toBeLessThanOrEqual(LEAVE + STEP_DOWN + 0.4);
      }
    }
    expect(cut).toBeGreaterThan(0);
    console.log(`figure: ${cut} cut of ${judged} reachable points, worst leftover ${worst.toFixed(3)} mm`);
  }, 600_000);
});
