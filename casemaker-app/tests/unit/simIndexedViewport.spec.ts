// #241 slice 3 — the INDEXED job in the simulation's viewport.
//
// The two-flat fixture of `docs/design/rotary-flow.md` §6 (0° / 180°, 1 mm deep on ⌀20, the same
// spec `indexedRotary.spec.ts` sweeps) is generated, posted, and loaded into a real session on the
// exact sweeper. The viewport's pure helpers are then read at steps inside each face:
//   - the stock group turns to the face's A, with the column engine's sign (+A about +X);
//   - the drawn path is carried into the stock frame, so at the current step it lands under the
//     still cutter once the group turns;
//   - a flat program does not turn, and a wrapped one is drawn as it was.
// And the store: a seek across the index turn keeps the step the user chose.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { tl } from './helpers/manifoldExec';
import { generateIndexed, type IndexedSpec } from '@/engine/cnc/cam/indexed';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { stubSetup, Z1, type Setup } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';
import type { CutParams } from '@/engine/cnc/feeds';
import { createSimSession, type SimLoadOk, type SimPath, type SimSession } from '@/workers/sim/session';
import { angleAtStep, drawnSimPath, simTurningRadians, stockFramePath, turningRadians } from '@/components/viewport/rotarySimView';
import { toolPositionAt } from '@/components/viewport/simGeometry';
import { setSimClientLoader, useSimStore, type SimClient, type SimState } from '@/store/simStore';

const RADIUS = 10;
const LENGTH = 30;
const STOCK = { kind: 'cylinder' as const, diameter: 2 * RADIUS, length: LENGTH };
const HOLD = { kind: 'rotary-chuck' as const, jawDiameter: 25, stickout: 30 };
const setup = (): Setup => stubSetup(STOCK, HOLD);
const PARAMS: CutParams = { rpm: 12000, feed: 800, plungeFeed: 200, stepDown: 1, stepOver: 1, peck: 1, air: true };
const WIDE = flatEndMill(10, { shoulderLength: 20, fluteLength: 15 });
const JAW_CLEAR = 5 + 3;
const END_X = LENGTH - 5;

const SPEC: IndexedSpec = {
  radius: RADIUS,
  faces: [
    { a: 0, fromX: JAW_CLEAR, toX: END_X, depth: 1 },
    { a: 180, fromX: JAW_CLEAR, toX: END_X, depth: 1 },
  ],
  tool: WIDE,
  params: PARAMS,
  rapid: Z1.rapidEstimate,
};

const CTX: PostContext = {
  jobName: 'indexed viewport fixture',
  stock: { length: LENGTH, width: 2 * RADIUS, thickness: 2 * RADIUS },
  materialName: 'softwood',
  zDatum: 'rotary-axis',
  origin: 'topFrontLeft',
  camVersion: '1.0.0',
  toolKey: 'fixture',
};

function twoFlatsGcode(): string {
  const posted = postZ1(generateIndexed(SPEC), CTX, Z1);
  if (!posted.ok) throw new Error(`the post refused the fixture: ${posted.errors.join('; ')}`);
  return posted.text;
}

const GCODE = twoFlatsGcode();

/** A step in the middle of the run cut at `a` — inside the face, not at its index turn. */
function stepInsideFace(ok: SimLoadOk, a: number): number {
  const cps = ok.checkpoints.filter((c) => c.a === a);
  expect(cps.length, `runs at A ${a}°`).toBeGreaterThan(0);
  const cp = cps[Math.floor(cps.length / 2)]!;
  return Math.floor((cp.firstStep + cp.lastStep) / 2);
}

/** Lets the store's lazy client hand the seek on and the frame come back. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const X_AXIS = new THREE.Vector3(1, 0, 0);

describe('#241 slice 3 — the indexed stock turns to each face in the viewport', () => {
  let s: SimSession;
  let ok: SimLoadOk;
  let path: SimPath;

  beforeEach(() => {
    s = createSimSession(tl);
    const r = s.load(GCODE, setup(), WIDE, null);
    if (!r.ok) throw new Error(`the session refused the fixture: ${JSON.stringify(r.diagnostics)}`);
    ok = r as SimLoadOk;
    path = s.simPath();
  });
  afterEach(() => s.dispose());

  it('loads as an indexed job on the exact sweeper, its runs at 0° and 180°', () => {
    expect(ok.summary.rotaryClass).toBe('indexed');
    expect(ok.stats.engine).toBe('exact');
    expect(new Set(ok.checkpoints.map((c) => c.a))).toEqual(new Set([0, 180]));
  });

  it('the stock group turns by +A of the face being cut (column-engine sign), and Unroll does not turn', () => {
    const inFirst = stepInsideFace(ok, 0);
    const inSecond = stepInsideFace(ok, 180);
    expect(angleAtStep(path, inSecond)).toBe(180);
    expect(simTurningRadians(path, inFirst, false)).toBeCloseTo(0, 12);
    // Face 2: A = 180°, the group's rotation about +X is +π — the same `+A` the column engine's
    // `φ = θ − A` gives (a column at θ is under the tool when A = θ).
    expect(simTurningRadians(path, inSecond, false)).toBeCloseTo(Math.PI, 12);
    expect(simTurningRadians(path, inSecond, false)).toBe(turningRadians(180));
    expect(simTurningRadians(path, inSecond, true)).toBe(0);
  });

  it('the drawn path is in the stock frame: turned by the group, the current vertex is under the cutter', () => {
    const drawn = drawnSimPath(path, ok.summary.rotaryClass, false);
    expect(drawn).not.toBe(path);
    for (const step of [stepInsideFace(ok, 0), stepInsideFace(ok, 180)]) {
      const tip = toolPositionAt(path, step)!; // work frame: where the still cutter is drawn
      const drawnTip = toolPositionAt(drawn!, step)!; // stock frame
      const onScreen = new THREE.Vector3(...drawnTip).applyAxisAngle(X_AXIS, simTurningRadians(path, step, false));
      expect(onScreen.x).toBeCloseTo(tip[0], 4);
      expect(onScreen.y).toBeCloseTo(tip[1], 4);
      expect(onScreen.z).toBeCloseTo(tip[2], 4);
    }
    // Face 2's passes lie on the BOTTOM of the stock frame — where the exact sweeper put that
    // face's removal (its solid reaches below −10 mm, `simSessionRotary.spec.ts`).
    const step2 = stepInsideFace(ok, 180);
    const z2 = toolPositionAt(drawn!, step2)![2];
    expect(z2).toBeLessThan(0);
    const frame = s.frameAt(ok.checkpoints.length - 1, 1);
    expect(frame?.removalSoFar?.bbox.min[2]).toBeLessThan(-RADIUS + 1.01);
  });

  it('a WRAPPED or flat path is drawn exactly as before, and a flat one never turns', () => {
    expect(drawnSimPath(path, 'wrapped', false)).toBe(path);
    expect(drawnSimPath(path, 'none', false)).toBe(path);
    expect(drawnSimPath(path, 'indexed', true)).toBe(path);
    expect(drawnSimPath(null, 'indexed', false)).toBeNull();
    const flat: SimPath = { ...path, a: undefined };
    expect(stockFramePath(flat)).toBe(flat);
    expect(simTurningRadians(flat, stepInsideFace(ok, 180), false)).toBe(0);
    expect(simTurningRadians(null, 0, false)).toBe(0);
  });

  it('a wrapped job still turns by the A at the step, as #716 drew it', () => {
    const w = createSimSession(tl);
    const WRAPPED = ['S1000 M3', 'G0 X0 Y0 Z30 A0', 'G1 Z5 F100', 'G1 A360 F500', 'G0 Z30'].join('\n');
    const r = w.load(WRAPPED, setup(), flatEndMill(3.175), null);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r as SimLoadOk).summary.rotaryClass).toBe('wrapped');
    const wp = w.simPath();
    for (let i = 0; i < wp.step.length; i++) {
      const step = wp.step[i]!;
      const a = angleAtStep(wp, step);
      expect(simTurningRadians(wp, step, false)).toBe(a === null ? 0 : turningRadians(a));
    }
    w.dispose();
  });
});

describe('#241 slice 3 — the stock-frame sign (0° / 180° cannot tell it apart, 90° can)', () => {
  it('a tip on top at A 90° is the stock point at θ = 90° (+Y), as the column engine and the sweeper say', () => {
    // Column engine: a column at θ (from +Z toward +Y) is under the tool when A = θ.
    // Sweeper: a work point lies on the stock point R_x(−a)·p (`intoStockFrame`).
    const p: SimPath = {
      xyz: Float32Array.from([5, 0, RADIUS]),
      step: Uint32Array.from([0]),
      kind: Uint8Array.from([1]),
      t: Float32Array.from([0]),
      line: Uint32Array.from([1]),
      a: Float64Array.from([90]),
      rapidsTimed: true,
    };
    const q = stockFramePath(p).xyz;
    expect(q[0]).toBeCloseTo(5, 6);
    expect(q[1]).toBeCloseTo(RADIUS, 5);
    expect(q[2]).toBeCloseTo(0, 5);
    // And the group's +A turn brings it back to the top, under the cutter.
    const back = new THREE.Vector3(q[0], q[1], q[2]).applyAxisAngle(X_AXIS, simTurningRadians(p, 0, false));
    expect(back.y).toBeCloseTo(0, 5);
    expect(back.z).toBeCloseTo(RADIUS, 5);
  });
});

describe('#241 slice 3 — a seek across the index turn keeps the step', () => {
  let s: SimSession;
  let requested: number[];

  /** A client over a REAL session: frames are answered synchronously, as the worker would later. */
  function sessionClient(): SimClient {
    let onFrame: ((k: number, f: NonNullable<ReturnType<SimSession['frameAt']>>) => void) | null = null;
    let gen = 0;
    return {
      setSimSinks: (f: typeof onFrame) => {
        onFrame = f;
      },
      loadSim: async (text: string, st: Setup, tool: Parameters<SimSession['load']>[2], machineId: string | null) =>
        s.load(text, st, tool, machineId),
      requestFrame: (k: number) => {
        requested.push(k);
        const frame = s.frameAt(k, ++gen);
        if (frame && onFrame) onFrame(frame.k, frame);
      },
      simPath: async () => s.simPath(),
      disposeSim: async () => {},
    } as unknown as SimClient;
  }

  beforeEach(() => {
    s = createSimSession(tl);
    requested = [];
    const client = sessionClient(); // ONE client: the store asks the loader again on every seek
    setSimClientLoader(async () => client);
    useSimStore.setState({ status: 'idle', step: -1, stepCount: 0, path: null, info: null } as Partial<SimState>);
  });
  afterEach(async () => {
    await useSimStore.getState().dispose();
    setSimClientLoader(null);
    s.dispose();
  });

  it('setStep and seekSeconds past the boundary land on the sought step, never step 0', async () => {
    await useSimStore.getState().loadProgram(GCODE, setup(), WIDE, 'Z1');
    const st = useSimStore.getState();
    expect(st.status).toBe('ready');
    const info = st.info!;
    const ok = { checkpoints: info.checkpoints } as SimLoadOk;
    const first = stepInsideFace(ok, 0);
    const second = stepInsideFace(ok, 180);
    const secondK = info.checkpoints.findIndex((c) => c.firstStep <= second && second <= c.lastStep);
    const firstK = info.checkpoints.findIndex((c) => c.firstStep <= first && first <= c.lastStep);
    expect(info.checkpoints[secondK]!.a).toBe(180);

    // Scrub into face 1, then across the index turn into face 2.
    useSimStore.getState().setStep(first);
    expect(useSimStore.getState().step).toBe(first);
    useSimStore.getState().setStep(second);
    await settle();
    let now = useSimStore.getState();
    expect(now.step).toBe(second);
    expect(now.k).toBe(secondK);
    expect(now.frame?.k).toBe(secondK);
    expect(requested.at(-1)).toBe(secondK);
    expect(simTurningRadians(now.path, now.step, false)).toBeCloseTo(Math.PI, 12);

    // And back again across the same turn: face 1's step, face 1's A.
    useSimStore.getState().setStep(first);
    await settle();
    now = useSimStore.getState();
    expect(now.step).toBe(first);
    expect(now.frame?.k).toBe(firstK);
    expect(simTurningRadians(now.path, now.step, false)).toBeCloseTo(0, 12);

    // Playback's own clock (`seekSeconds`) crossing the turn: the step is the one at that time.
    const path = now.path!;
    const vi = Array.from(path.step).findIndex((v) => v >= second);
    expect(vi).toBeGreaterThanOrEqual(0);
    useSimStore.getState().seekSeconds(path.t[vi]!);
    await settle();
    now = useSimStore.getState();
    expect(now.step).toBeGreaterThanOrEqual(path.step[vi]!);
    expect(info.checkpoints[now.k]!.a).toBe(180);
    expect(simTurningRadians(now.path, now.step, false)).toBeCloseTo(Math.PI, 12);
    expect(now.step).not.toBe(0);
  });
});
