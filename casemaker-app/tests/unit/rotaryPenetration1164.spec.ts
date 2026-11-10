// #1164 slice (a) — THE ANALYST'S BASELINE, REPRODUCED IN-REPO.
//
// Before any planner change, the helper must measure the 2026-11-10 giraffe program exactly as
// `analysis-1155/sweep2.mjs` did on the scratch share: fixtures copied here (`tris.json` — the mesh
// in the rod frame, +30 mm X baked in; `low-poly-giraffe.nc` sha 52c89acb…), R = 22.25, ⌀6 ball.
// The script's own numbers: max 1.116 mm, 264 moves > 0.3 mm, 15,635 samples > 0.3 mm, 184 > 1 mm.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseRotaryMoves, sweepRotaryPenetration, type RotaryPenetration } from './helpers/rotaryPenetration';

const DIR = join(process.cwd(), 'tests', 'unit', 'fixtures', 'giraffe-1155');

let cached: RotaryPenetration | null = null;

function baseline(): RotaryPenetration {
  if (cached !== null) return cached;
  const { tris } = JSON.parse(readFileSync(join(DIR, 'tris.json'), 'utf8')) as { tris: number[] };
  const nc = readFileSync(join(DIR, 'low-poly-giraffe.nc'), 'utf8');
  cached = sweepRotaryPenetration({
    triangles: tris,
    R: 22.25,
    moves: parseRotaryMoves(nc, () => 'all'),
    cutter: { radius: 3, shape: 'ball' },
  });
  return cached;
}

describe('#1164 the rotary penetration sweep reproduces the analyst baseline', () => {
  it('the giraffe program: max 1.116 mm, 264 moves > 0.3 mm, 15,635 samples > 0.3 mm, 184 > 1 mm', () => {
    const result = baseline();
    expect(result.worst).not.toBeNull();
    expect(result.worst!.penMm).toBeCloseTo(1.116, 2);
    expect(result.samples.total, 'the surface samples inside the rod').toBeGreaterThan(10_000);
    expect(result.samples.over03).toBe(15_635);
    expect(result.samples.over1).toBe(184);
    const over03 = result.moves.filter((move) => move.maxPenMm > 0.3).length;
    expect(over03).toBe(264);
  }, 600_000);

  it('with A negated the tool buries itself everywhere — the script\'s sign check', () => {
    const { tris } = JSON.parse(readFileSync(join(DIR, 'tris.json'), 'utf8')) as { tris: number[] };
    const nc = readFileSync(join(DIR, 'low-poly-giraffe.nc'), 'utf8');
    const negated = sweepRotaryPenetration({
      triangles: tris,
      R: 22.25,
      moves: parseRotaryMoves(nc, () => 'all').slice(0, 400),
      cutter: { radius: 3, shape: 'ball' },
      aSign: -1,
    });
    expect(negated.moves.filter((move) => move.maxPenMm > 1).length).toBeGreaterThan(100);
  }, 600_000);
});
