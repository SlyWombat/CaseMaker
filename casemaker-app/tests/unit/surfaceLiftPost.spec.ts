// The post's air-cut rule after #608's surface lift (#624).
//
// `applySurfaceLift` shifts every FEED move's Z by the fitted plane's lift at its XY, so the local
// stock top is `lift(x, y)`, not work Z0. A feed at `−depth + lift` is above 0 AND a correct cut
// whenever the lift exceeds the local depth, so the post's "a cut in the air" check must judge a
// feed against `lift(x, y) + 1e-9`, not against `1e-9`. This file pins both sides of that rule:
//
//   * a FLAT program (no fitted frame, or a flat plane → lift ≈ 0) that cuts above work Z0 is still
//     refused — a genuinely wrong depth must not slip through the flat-top assumption's old guard;
//   * a TILTED program whose feeds climb only by the plane's lift at their XY is accepted — the CAM
//     intent is unchanged, and only the flat-top assumption was wrong.
//
// The direct post cases exercise the rule itself; the pipeline case is the issue's own repro: the
// default three-label job posted against the measured tilt used to stop at `post`.

import { describe, it, expect } from 'vitest';

import { estimateSeconds, type CamMove, type CamOperation, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { surfaceLift, type SurfaceFrame } from '@/engine/cnc/engrave/surfacePlane';
import { generate } from './helpers/engravePipeline';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTraceItem } from '@/types/engraveJob';
import { tl } from './helpers/manifoldExec';

const rapid = (x: number, y: number, z: number): CamMove => ({ kind: 'rapid', x, y, z });
const cut = (x: number, y: number, z: number, f: number): CamMove => ({ kind: 'feed', x, y, z, f });

function operation(number: number, name: string, labelId: string, depth: number, moves: CamMove[]): CamOperation {
  return { number, name, labelId, depth, moves, estimatedSeconds: estimateSeconds(moves) };
}

function makeIr(operations: CamOperation[], over: Partial<ToolpathIR> = {}): ToolpathIR {
  return {
    frame: 'flat',
    tool: flatEndMill(1),
    toolNumber: 1,
    spindleRpm: 12000,
    air: true,
    safeZ: 5,
    hopZ: 1,
    operations,
    ...over,
  };
}

const CTX: PostContext = {
  jobName: 'lifted feed',
  stock: { length: 100, width: 60, thickness: 12 },
  materialName: 'softwood',
  zDatum: 'probed-top-face',
  origin: 'topFrontLeft',
  camVersion: 'test',
  toolKey: 'flat-1.0',
};

/** The measured tilt from #623/#624: 0.36 mm across X and 0.24 mm across Y, `z0 = 0`. */
const TILT: SurfaceFrame = { plane: { offset: 0, slopeX: 0.006, slopeY: 0.004 }, z0: 0 };

/** A plane with no slope — the fitted "top" is Z0 everywhere, so the lift is 0 at every XY. */
const FLAT: SurfaceFrame = { plane: { offset: 0, slopeX: 0, slopeY: 0 }, z0: 0 };

/** The 30° engraver from the bench class, so the pipeline case can post text labels (#624 repro). */
const bit30 = (): Tool => ({
  number: 1,
  id: 'C1-BIT-ENGRAVE-30-0.3',
  name: 'Single Flute Engraving Bit 30 x 0.3',
  typeText: 'Engraving',
  shape: 'engraving',
  handleDiameter: 3.175,
  tipDiameter: 0.3,
  diameter: 3.175,
  cornerRadius: 0,
  angle: 30,
  halfAngle: 15,
  fluteLength: null,
  shoulderLength: null,
  stickout: null,
  centreCutting: null,
});

/**
 * A 0.3 mm V-trace running into the +X/+Y corner, where the tilt lifts the top 0.64–0.79 mm — the
 * feed Z is `−0.3 + lift`, above work Z0 everywhere the trace runs, yet exactly on the local top.
 * It is the end-to-end shape of #624: the worker hands the post the fitted frame, so the program
 * posts instead of stopping at `post`.
 */
function liftedTraceJob(): EngraveJob {
  const base = defaultEngraveJob();
  const trace: EngraveTraceItem = {
    kind: 'line',
    id: 'tr',
    position: { x: 0, y: 0 },
    rotation: 0,
    points: [
      [80, 40],
      [95, 55],
    ],
    closed: false,
    depth: 0.3,
    enabled: true,
  };
  return {
    ...base,
    name: 'surface lift post',
    stock: { length: 100, width: 60, thickness: 12, material: 'pla' },
    labels: [],
    shapes: [],
    toolKey: 'inv:kz-engrave-30-0-3',
    tool: bit30(),
    minFloor: 1,
    edgeMargin: 1,
    traces: [trace],
  };
}

describe('the post air-cut rule against the fitted surface (#624)', () => {
  it('still refuses a flat-plane program that cuts above work Z0', () => {
    // A single feed at Z = 0.5: above the stock top, below hopZ. With no fitted frame the top is
    // work Z0, and with a FLAT plane the lift is 0 at every XY — both must refuse exactly as before.
    const ir = makeIr([operation(1, 'air', 'a', 0.5, [rapid(0, 0, 1), cut(0, 0, 0.5, 200)])]);

    const noFrame = postZ1(ir, CTX, Z1);
    expect(noFrame.ok).toBe(false);
    if (!noFrame.ok) expect(noFrame.errors.join(' ')).toMatch(/cut in the air/);

    const flatPlane = postZ1(ir, { ...CTX, surface: FLAT }, Z1);
    expect(flatPlane.ok).toBe(false);
    if (!flatPlane.ok) expect(flatPlane.errors.join(' ')).toMatch(/cut in the air/);
  });

  it('accepts a lifted feed that only climbs by the plane’s lift at its XY', () => {
    // A 0.5 mm cut at (80, 40), where the tilt lifts the top 0.64 mm: the feed's Z is −0.5 + 0.64 =
    // 0.14, above work Z0 but exactly on the local top. With the fitted frame that is a correct cut;
    // without it, the flat-top guard must refuse it — the control that gives the accept its teeth.
    const lift = surfaceLift(TILT.plane, TILT.z0, 80, 40);
    expect(lift).toBeGreaterThan(0.5);
    const z = lift - 0.5;
    expect(z).toBeGreaterThan(0);
    const ir = makeIr([operation(1, 'lifted', 'a', 0.5, [rapid(0, 0, 1), cut(80, 40, z, 200)])]);

    const blind = postZ1(ir, CTX, Z1);
    expect(blind.ok).toBe(false);
    if (!blind.ok) expect(blind.errors.join(' ')).toMatch(/cut in the air/);

    const fitted = postZ1(ir, { ...CTX, surface: TILT }, Z1);
    expect(fitted.ok).toBe(true);
  });

  it('refuses a feed ABOVE the local top under a tilt (#642)', () => {
    // The same fitted tilt: a feed at lift(80, 40) + 0.1 mm is 0.1 mm into the air above the LOCAL
    // stock top. The lifted accept above must not turn the rule into "anything positive passes":
    // the bound moves with the plane, it does not vanish.
    const lift = surfaceLift(TILT.plane, TILT.z0, 80, 40);
    const ir = makeIr([operation(1, 'above', 'a', 0.5, [rapid(0, 0, 1), cut(80, 40, lift + 0.1, 200)])]);

    const fitted = postZ1(ir, { ...CTX, surface: TILT }, Z1);
    expect(fitted.ok).toBe(false);
    if (!fitted.ok) expect(fitted.errors.join(' ')).toMatch(/cut in the air/);
  });

  it('posts a lifted trace end to end: the worker hands the post the fitted frame (#624)', () => {
    const gen = generate(tl, liftedTraceJob(), null, [], undefined, { surface: TILT });
    if (gen.nc === null) {
      throw new Error(`generate refused at ${gen.stage}: ${gen.errors.map((e) => e.message).join('; ')}`);
    }
    // The package says which frame it was posted against — the frame the post judged the feeds in.
    // The trace's feeds are all above work Z0 (the tilt lifts 0.64–0.79 mm against a 0.3 mm cut), so
    // reaching `nc !== null` is itself the proof the worker passed the fitted frame to the post.
    expect(gen.surface).toEqual(TILT);
  });
});
