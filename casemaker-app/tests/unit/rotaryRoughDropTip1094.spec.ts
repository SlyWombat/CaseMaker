/**
 * #1094 — THE ROUGH'S TIP IS THE BALL'S DROP-CUTTER SURFACE. `aSweepRoughing`'s per-cell clamp sees
 * only the cell's own angle, so the ball's flank cuts the wall beside a near-axis cell: a one-cell
 * pit beside an 11 mm body is roughed to pit + 0.2, and the ball removes the body within its reach.
 * The rough now uses the finish's own tip stencil on the goal-plus-allowance surface, computed once.
 *
 * Red at the base: the rough posts a tip at the pit + 0.2 while body cells are inside the ball's
 * radius — the first case's `bad` count is non-zero.
 */
import { describe, expect, it } from 'vitest';

import { flatEndMill } from '@/engine/cnc/tool';
import type { GoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import { generateRotaryReliefIR } from '@/engine/cnc/cam/rotaryRelief';

const R = 10;
const PITCH = 0.1;
const NX = 100;
const NY = 629; // ceil(2π·10 / 0.1) — one turn at the pitch
const BODY_R = 8;
const PIT_R = 1;
const ALLOWANCE = 0.2;
const BALL_R = 1;
// The sweep's X columns are every `roughStepOver` (0.9 mm = 9 cells) after the chuck clip drops
// 40 columns (X < 4): new columns 0, 9, 18… — the pit must sit ON one (new 9 = original 49) or
// the base never feeds it and the case would pass vacuously.
const PIT_I = 49;
const PIT_J = 314;

/** The goal: an 8 mm body with one 0.1 mm cell at radius 1 (the pit 0f's field describes). */
function field(): GoalRadialField {
  const z = new Float32Array(NX * NY).fill(BODY_R - R);
  z[PIT_J * NX + PIT_I] = PIT_R - R;
  return {
    nx: NX,
    ny: NY,
    x0: 0,
    y0: 0,
    pitch: PITCH,
    radius: R,
    minRadius: PIT_R,
    maxRadius: BODY_R,
    z,
    covered: new Uint8Array(NX * NY).fill(1),
    coveredCount: NX * NY,
    resolutionNote: 'synthetic',
  };
}

const rise = (d: number): number => (d >= BALL_R ? BALL_R : BALL_R - Math.sqrt(Math.max(0, BALL_R * BALL_R - d * d)));
/** The shortest signed arc delta, (-πR, πR]: a tiny negative must not wrap a full turn. */
const wrapArc = (d: number): number => {
  const circ = 2 * Math.PI * R;
  let w = d % circ;
  if (w > circ / 2) w -= circ;
  if (w < -circ / 2) w += circ;
  return w;
};

function roughing() {
  const res = generateRotaryReliefIR({
    field: field(),
    section: undefined,
    // A ball ⌀2, as the readiness job's finish cutter.
    tool: flatEndMill(2, { shape: 'ball', typeText: 'Ball End', name: '2 mm ball' }),
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    feeds: { feed: 500, plungeFeed: 200, stepDown: 1, roughStepOver: 0.9, finishStepOver: 0.9 },
    rapid: { xyMmPerMin: 3000, zMmPerMin: 1500, accelMmPerS2: 500, source: 'the spec' },
    stockToLeaveMm: ALLOWANCE,
  });
  return res.roughing.moves;
}

const pitX = PIT_I * PITCH;
const pitArc = PIT_J * PITCH;
const arcOf = (m: { a?: number }): number => wrapArc(((m.a ?? 0) * Math.PI) / 180 * R);

describe('#1094 the rotary rough clears the ball over every body cell', () => {
  it('every rough tip within the ball’s radius of a body cell is at or above body + allowance − rise(d)', () => {
    let bodyCells = 0;
    let bad = 0;
    for (const m of roughing()) {
      if (m.kind !== 'feed') continue;
      const arc = arcOf(m);
      // Only moves near the pit can reach the pit's body ring.
      if (Math.hypot(m.x - pitX, wrapArc(arc - pitArc)) > 2 * BALL_R) continue;
      for (let di = -10; di <= 10; di++) {
        for (let dj = -10; dj <= 10; dj++) {
          const i = PIT_I + di;
          const j = ((PIT_J + dj) % NY + NY) % NY;
          if (i < 0 || i >= NX) continue;
          if (i === PIT_I && j === PIT_J) continue; // the pit itself
          const d = Math.hypot(m.x - (i * PITCH), wrapArc(arc - j * PITCH));
          if (d > BALL_R + 1e-9) continue;
          bodyCells++;
          if (!(m.z + rise(d) >= BODY_R + ALLOWANCE - 1e-6)) bad++;
        }
      }
    }
    expect(bodyCells).toBeGreaterThan(0);
    expect(bad).toBe(0);
  });

  it('the pit is not roughed: no near-pit feed rides at the pit floor', () => {
    const near = roughing().filter(
      (m) => m.kind === 'feed' && Math.hypot(m.x - pitX, wrapArc(arcOf(m) - pitArc)) <= 0.15,
    );
    expect(near.length).toBeGreaterThan(0);
    for (const m of near) {
      // The base rides the pit at radius 1.2; the drop-cutter tip is at the body's own clearance.
      expect(m.z).toBeGreaterThan(BODY_R + ALLOWANCE - 0.5);
    }
  });
});
