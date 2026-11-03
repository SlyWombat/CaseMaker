/**
 * #914 — THE FACE DECISION, MADE REACH-AWARE. `goalFlipPlan` (#872) ranks sides by raw VISIBLE
 * area with no idea whether the cutter can physically get there; #914 adds that awareness as an
 * opt-in `reach` input, not a rewrite — a caller that does not ask for it sees today's
 * geometry-only numbers unchanged (`goalFlipPlan.spec.ts` pins that).
 *
 * THE SHAPE, on the committed proxy. `tests/fixtures/goals/figure.stl` at the real elephant stick
 * job's own placement (#945's j29: a 36 × 100 × 36 mm stick, `rotation: 90`, `scale: 0.6533`,
 * `tests/unit/goalCorpus873.spec.ts`'s own fixture) stands the figure on its stock exactly as the
 * real elephant/panther jobs do. At that scale the figure's own deepest point sits roughly 27 mm
 * below the stock top (the design note's own measured number) — deeper than a single setup's
 * usable band with a short cutter, so reach genuinely binds: a GEOMETRY-ONLY top setup claims
 * area a short-reach cutter cannot touch, and a reach-aware top setup must claim less of it.
 *
 * THE CUTTER is a ⌀3.175 mm ball with a 22 mm stated flute — the design note's own "owned ball,
 * 22 mm catalogue reach" figure — giving a 21 mm usable band (`GOAL_BAND_CLEARANCE_MM` = 1 mm).
 * Two such bands, one from each side of a top+bottom flip, overlap by a few millimetres in the
 * middle of the figure's ~27 mm depth (the design note's corrected number, not its first draft's
 * ~15 mm): short alone, sufficient together.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { clearTargetObjectMeshCache, readTargetObjectFile, targetObjectMesh } from '@/engine/import/targetObject';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import {
  goalFlipPlan,
  reachSidesSentence,
  type FlipPlanReachInput,
} from '@/engine/cnc/engrave/goalFlipPlan';
import type { CoverageMesh } from '@/engine/cnc/engrave/goalCoverage';
import type { MountSpec } from '@/engine/cnc/setups/types';
import type { Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveTargetObject } from '@/types/engraveJob';

afterEach(() => clearTargetObjectMeshCache());

const here = (name: string): string => fileURLToPath(new URL(`../fixtures/goals/${name}`, import.meta.url));

const STOCK = { x: 36, y: 100, z: 36 };
const VISE: MountSpec = { kind: 'vise', viseOpeningMm: 120 };

/** The design note's own "owned ball, 22 mm catalogue reach" — a ⌀3.175 mm ball end mill whose
 *  flute is stated directly, so no catalogue lookup is needed to know its reach. */
const OWNED_BALL: Tool = {
  number: 1,
  id: 'owned-3-175-ball',
  name: '3.175mm Ball Nose',
  typeText: 'Ball Nose Engraving',
  shape: 'ball',
  handleDiameter: 3.175,
  tipDiameter: 3.175,
  diameter: 3.175,
  cornerRadius: 1.5875,
  angle: null,
  halfAngle: null,
  fluteLength: 22,
  shoulderLength: 22,
  stickout: null,
  centreCutting: null,
};

const REACH: FlipPlanReachInput = {
  tools: [OWNED_BALL],
  entries: [{ key: 'inv:owned-3-175-ball', tool: OWNED_BALL, provenance: 'test' }] as ToolLibraryEntry[],
};

/**
 * The design note's own restriction for a STICK format: `left`/`right` are the vise-jaw-clamped
 * faces and `front`/`back` are the length-overhang ends — neither is a cuttable surface on this
 * stock, so a plan must never offer them, and must SAY so rather than silently never finding a
 * gain there. This is the CALLER'S decision (`FlipPlanInput.candidateFaces`), not a "stick" rule
 * `goalFlipPlan` invents on its own — this test states it exactly as the approved note does.
 */
const STICK_FACES = {
  faces: ['bottom'] as const,
  excludedReason:
    'on a stick stock, left/right are the vise-jaw faces and front/back are the length-overhang ends — not cuttable surfaces',
};

/** The goal's triangles in setup 1's work frame — j29's own placement (#945), the real elephant
 *  stick job's scale and turn, substituting the committed figure.stl for the local-only mesh. */
async function stickFigureMesh(): Promise<CoverageMesh> {
  const bytes = readFileSync(here('figure.stl'));
  const read = await readTargetObjectFile(new File([bytes], 'figure.stl'), 'goal-figure-914');
  if (!read.ok) throw new Error(read.error);
  const target: EngraveTargetObject = {
    id: read.id,
    name: read.name,
    format: read.format,
    sha256: read.sha256,
    data: read.data,
    size: read.size,
    position: { x: STOCK.x / 2, y: 50, z: 0 },
    rotation: 90,
    enabled: true,
    role: 'goal',
    scale: { x: 0.6533, y: 0.6533, z: 0.6533 },
  };
  const mesh = targetObjectMesh(target);
  const { place } = placeTarget(target, mesh);
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const [x, y, z] = place(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!);
    positions[i] = x;
    positions[i + 1] = y;
    positions[i + 2] = z;
  }
  return { positions, indices: mesh.indices };
}

describe('#914 the reach-aware flip plan, on the stick-scale figure proxy', () => {
  it('the goal really is deeper than a 21 mm band — the premise reach-awareness needs', async () => {
    const mesh = await stickFigureMesh();
    const plan = goalFlipPlan({ mesh, firstUp: 'top', mount: VISE, stockSize: STOCK, pitchMm: 0.3 });
    // #914 — always present, even with no `reach` input: the top setup's own needed depth.
    expect(plan.sides[0]!.neededMm).toBeGreaterThan(21);
  });

  it('reach-aware top-only coverage is LOWER than geometry-only — the cap actually bites', async () => {
    const mesh = await stickFigureMesh();
    const geomOnly = goalFlipPlan({ mesh, firstUp: 'top', mount: VISE, stockSize: STOCK, pitchMm: 0.3 });
    const reachAware = goalFlipPlan({ mesh, firstUp: 'top', mount: VISE, stockSize: STOCK, pitchMm: 0.3, reach: REACH });

    const geomTopFraction = geomOnly.sides[0]!.visibleMm2 / geomOnly.totalAreaMm2;
    const reachTopFraction = reachAware.sides[0]!.visibleMm2 / reachAware.totalAreaMm2;

    // THE RED-FIRST ASSERTION: before #914, `reach` is not read at all, so these two numbers are
    // identical (byte-for-byte the same geometry-only plan) and this fails.
    expect(reachTopFraction).toBeLessThan(geomTopFraction);
    expect(reachAware.sides[0]!.beyondReachMm2).toBeGreaterThan(0);
    expect(reachAware.reach).not.toBeNull();
    expect(reachAware.reach!.mm).toBe(22);
    expect(reachAware.reach!.bandMm).toBe(21);

    // eslint-disable-next-line no-console
    console.log(
      `#914 figure.stl @ j29 scale: geometry-only top-only ${(geomTopFraction * 100).toFixed(1)}%, ` +
        `reach-aware (22 mm ball, 21 mm band) top-only ${(reachTopFraction * 100).toFixed(1)}%`,
    );
  });

  it('UNRESTRICTED, the greedy keeps going past bottom (the union alone does not reach 95%) — why the stick restriction below is not optional', async () => {
    const mesh = await stickFigureMesh();
    const reachAware = goalFlipPlan({ mesh, firstUp: 'top', mount: VISE, stockSize: STOCK, pitchMm: 0.3, reach: REACH });
    // eslint-disable-next-line no-console
    console.log(
      `#914 UNRESTRICTED sides: ${reachAware.sides.map((s) => s.faceUp).join(', ')}; stopped: ${reachAware.stopped}; ` +
        `reached ${(reachAware.reachedFraction * 100).toFixed(1)}%`,
    );
    expect(reachAware.sides[0]!.faceUp).toBe('top');
    expect(reachAware.sides[1]!.faceUp).toBe('bottom');
    // Left/right/front/back are HOLDABLE on this stock (a 120 mm vise opening, no narrower rule
    // stated), so with no restriction the greedy is free to add one for the stick's own geometry
    // — exactly the gap the design note's own restriction (below) exists to close.
  });

  it('RESTRICTED to the stick’s cuttable faces: exactly top+bottom, the other four named in `dropped`', async () => {
    const mesh = await stickFigureMesh();
    const reachAware = goalFlipPlan({
      mesh,
      firstUp: 'top',
      mount: VISE,
      stockSize: STOCK,
      pitchMm: 0.3,
      reach: REACH,
      candidateFaces: STICK_FACES,
    });
    expect(reachAware.sides.map((s) => s.faceUp)).toEqual(['top', 'bottom']);
    for (const face of ['left', 'right', 'front', 'back'] as const) {
      expect(reachAware.dropped).toContainEqual({ faceUp: face, reason: STICK_FACES.excludedReason });
    }

    const total = reachAware.totalAreaMm2;
    const topOnlyFraction = reachAware.sides[0]!.visibleMm2 / total;
    const unionFraction = reachAware.reachedFraction;

    // THE CORE #914 CLAIM: a single reach-capped side reads low; the flip's SECOND side reaches
    // its own band from the OTHER direction and the union reads materially higher — the two short
    // bands overlap in the middle rather than each independently falling short.
    expect(unionFraction).toBeGreaterThan(topOnlyFraction + 0.1);
    expect(reachAware.sides[1]!.neededMm).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(
      `#914 figure.stl @ j29 scale, RESTRICTED to top+bottom: top-only ${(topOnlyFraction * 100).toFixed(1)}%, ` +
        `top+bottom union ${(unionFraction * 100).toFixed(1)}%, stopped: ${reachAware.stopped} ` +
        `(top needs ${reachAware.sides[0]!.neededMm.toFixed(1)} mm, bottom needs ${reachAware.sides[1]!.neededMm.toFixed(1)} mm; ` +
        `top cuts to ${reachAware.sides[0]!.creditedMaxDepthMm.toFixed(1)} mm, bottom cuts to ${reachAware.sides[1]!.creditedMaxDepthMm.toFixed(1)} mm)`,
    );
  });

  it('a caller that asks for no reach pool sees exactly today’s geometry-only plan', async () => {
    const mesh = await stickFigureMesh();
    const withoutReach = goalFlipPlan({ mesh, firstUp: 'top', mount: VISE, stockSize: STOCK, pitchMm: 0.3 });
    expect(withoutReach.reach).toBeNull();
    expect(withoutReach.sides[0]!.beyondReachMm2).toBeUndefined();
  });

  it('the per-side sentence states each side’s own CUT depth (within its band) and the band it was scored against', async () => {
    const mesh = await stickFigureMesh();
    const plan = goalFlipPlan({
      mesh,
      firstUp: 'top',
      mount: VISE,
      stockSize: STOCK,
      pitchMm: 0.3,
      reach: REACH,
      candidateFaces: STICK_FACES,
    });
    const sentence = reachSidesSentence(plan);
    expect(sentence).toMatch(/^top \(\d/);
    expect(sentence).toMatch(/bottom \(\d/);
    expect(sentence).toMatch(/21 mm usable band/);
    // Every stated depth is a side's own CREDITED cut — never more than the 21 mm band, unlike
    // the goal's raw `neededMm` (27/36 mm) which the sentence does NOT state.
    for (const side of plan.sides) expect(side.creditedMaxDepthMm).toBeLessThanOrEqual(21 + 1e-6);
    // The brief's own requirement: the excluded faces are STATED in the sentence, not left silent
    // in `dropped` alone.
    expect(sentence).toMatch(/excluded/);
    expect(sentence).toMatch(/left edge\/right edge\/front edge\/back edge/);
    expect(sentence).toMatch(/vise-jaw faces/);
  });
});
