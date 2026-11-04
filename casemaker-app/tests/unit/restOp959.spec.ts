/**
 * #959 — THE REST OP, RED-FIRST: rest by CL DIFFERENCE.
 *
 * A square pocket with SHARP inside corners (A's red-fixture shape): a ⌀6 flat's CL surface is 0
 * only where its disc fits inside the pocket (the square eroded by 3) and jumps to the block's top
 * elsewhere — so the frame it cannot enter is exactly what it left standing. A ⌀1 flat fits 0.5
 * further in, and the rest pass must clear that frame and nothing else: the pocket's middle was
 * already cut and the outer 0.5 mm is beyond the small cutter too. Both CL surfaces are analytic
 * here, so the op's own two-sided rule is what is measured.
 */

import { describe, expect, it } from 'vitest';

import { rest } from '../../src/engine/cnc/cam/model/ops/rest';
import type { ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import type { Box2, RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { flatEndMill } from '../../src/engine/cnc/tool';
import { tl } from './helpers/manifoldExec';

const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const FEEDS = { feedMmPerMin: 900, plungeFeedMmPerMin: 250 };
const STEP_DOWN = 1.5;
const LEAVE = 0.3;
const HALF = 10; // the pocket's half-size
const TOP = 6; // the block's top

/** The CL surface of a flat cutter of `radius` over a square pocket with vertical, sharp walls:
 *  0 where the disc fits inside, the block's top where the disc overlaps a wall. */
function pocketCl(radius: number): ClSurface {
  let sampleCount = 0;
  return {
    dropCutter: (x, y) => {
      const mx = Math.abs(x);
      const my = Math.abs(y);
      if (mx > HALF || my > HALF) return null;
      sampleCount++;
      return Math.max(mx, my) <= HALF - radius ? 0 : TOP;
    },
    toleranceMm: 0.01,
    minSpacingMm: 0.1,
    maxSpacingMm: 0.5,
    get sampleCount() {
      return sampleCount;
    },
  };
}

const small = flatEndMill(1, { number: 2, id: 'flat-1', name: 'flat-1' });

function regionOf(): { region: RemainderRegion; regionRef: RegionRef } {
  const footprint: [number, number][][] = [[[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF]]];
  const bounds: Box2 = { min: [-HALF, -HALF], max: [HALF, HALF] };
  return {
    region: {
      id: 'pocket',
      footprint,
      area: (2 * HALF) ** 2,
      zTop: TOP,
      zBottom: 0,
      triangles: new Uint32Array(),
      slopeDeg: [0, 90],
      slopeMedianDeg: 0,
      in: 'top',
    },
    regionRef: { id: 'pocket', kind: 'curved', bounds, topZ: TOP, bottomZ: 0, obstacles: [], regionClearanceZ: TOP + 5 },
  };
}

/** The swept top from the posted moves: the flat disc stamped along every lateral feed at its Z. */
function sweptTop(
  ir: ReturnType<typeof rest>['ir'],
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
        stamp(m.x, m.y, m.z);
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

describe('#959 rest — the pocket with sharp inside corners', () => {
  const prev = pocketCl(3); // the ⌀6 cutter: fits only inside max(|x|,|y|) <= 7
  const next = pocketCl(0.5); // the ⌀1 cutter: fits up to 9.5

  it('clears the frame the previous cutter left, and only that frame, never below the next CL', () => {
    const { region, regionRef } = regionOf();
    const out = rest({
      cutter: small,
      region,
      regionRef,
      prevClSurface: prev,
      clSurface: next,
      stepDownMm: STEP_DOWN,
      stockToLeaveMm: LEAVE,
      stepOverMm: 0.5,
      gridPitchMm: 0.25,
      feeds: FEEDS,
      offset: makeClipperOffset(tl),
      safeZMm: TOP + 5,
      hopZMm: 3,
      toolNumber: 2,
      spindleRpm: 12000,
      air: true,
      rapid,
    });

    expect(out.ir.operations[0]!.moves.length).toBeGreaterThan(0);
    // Every feed's own Z is at or above the SMALL cutter's CL surface at its XY.
    for (const op of out.ir.operations) {
      for (const m of op.moves) {
        if (m.kind !== 'feed') continue;
        const z = next.dropCutter(m.x, m.y);
        if (z !== null) expect(m.z).toBeGreaterThanOrEqual(z - 1e-6);
      }
    }

    const P = 0.5;
    const N = Math.floor((2 * HALF) / P) + 1;
    const top = sweptTop(out.ir, 0.5, -HALF, -HALF, P, N, N, TOP);
    let frameCut = 0;
    let frameSeen = 0;
    let interiorCut = 0;
    let worst = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -HALF + i * P;
        const y = -HALF + j * P;
        const mx = Math.max(Math.abs(x), Math.abs(y));
        const t = top[j * N + i]!;
        if (mx <= 6.5) {
          // The middle: the ⌀6 cutter already cleared it, the rest must not touch it.
          if (t < TOP - 1e-9) interiorCut++;
          continue;
        }
        if (mx > 7.5 && mx <= 8.5) {
          // The frame the ⌀6 left standing and the ⌀1 can reach (the corner tips included).
          frameSeen++;
          if (t < TOP - 1e-9) {
            frameCut++;
            worst = Math.max(worst, t - 0); // the material above the small cutter's CL (0 here)
          }
          expect(t, `leftover above the ⌀1 CL at (${x}, ${y})`).toBeLessThanOrEqual(LEAVE + STEP_DOWN + 0.1);
        }
      }
    }
    expect(interiorCut).toBe(0);
    expect(frameSeen).toBeGreaterThan(0);
    expect(frameCut / frameSeen).toBeGreaterThan(0.9);
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(LEAVE + STEP_DOWN + 0.1);
    console.log(`rest: ${frameCut}/${frameSeen} frame points cut, worst standing ${worst.toFixed(3)} mm`);
  }, 240_000);
});
