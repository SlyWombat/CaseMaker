// @vitest-environment jsdom
// The transport bar (#198): the step-indexed scrubber with pause ticks, the buttons, and the one
// requestAnimationFrame loop that plays to completion and stops at pauses. The store is loaded
// with fake data (no worker, no wasm); rAF is a controllable stub so a frame is a function call
// with a chosen timestamp, which is what makes "stop at a pause on this frame" exact.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SimTransport } from '@/components/viewport/SimTransport';
import { setSimClientLoader, useSimStore, type SimClient, type SimState } from '@/store/simStore';
import type { PausePoint } from '@/engine/cnc';
import type { SimPath } from '@/workers/sim/session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A path of 101 vertices, steps 0…100, t = step/10 s, so step 50 completes at 5 s. */
function fakePath(): SimPath {
  const step: number[] = [];
  const t: number[] = [];
  const xyz: number[] = [];
  const kind: number[] = [];
  const line: number[] = [];
  for (let i = 0; i <= 100; i++) {
    step.push(i);
    t.push(i / 10);
    xyz.push(i, 0, 0);
    kind.push(1);
    line.push(i + 1);
  }
  return {
    xyz: Float32Array.from(xyz),
    step: Uint32Array.from(step),
    kind: Uint8Array.from(kind),
    t: Float32Array.from(t),
    line: Uint32Array.from(line),
  };
}

const toolChange = (step: number): PausePoint => ({ step, kind: 'tool-change', line: 12, fromTool: 1, toTool: 2 });

/** No-op client: with `info` null no seek is ever issued, and this keeps the loader off the worker. */
const NO_OP_CLIENT: SimClient = {
  setSimSinks: () => {},
  loadSim: async () => ({ ok: false, pathOnly: false, diagnostics: [] }),
  requestFrame: () => {},
  simPath: async () => fakePath(),
  disposeSim: async () => {},
} as unknown as SimClient;

const BASE: Partial<SimState> = {
  status: 'ready',
  pathOnly: false,
  path: fakePath(),
  info: null,
  step: 0,
  stepCount: 101,
  pauses: [],
  playing: false,
  speed: 100,
  seconds: 0,
  stoppedAt: null,
  k: -1,
};

function setStore(patch: Partial<SimState> = {}): void {
  act(() => {
    useSimStore.setState({ ...BASE, ...patch });
  });
}

/** The pending rAF callbacks, newest last; a frame is run by shifting one off and calling it. */
let frames: FrameRequestCallback[] = [];

function flushFrame(ts: number): void {
  const cb = frames.shift();
  if (!cb) throw new Error('no frame was scheduled');
  act(() => cb(ts));
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  setSimClientLoader(async () => NO_OP_CLIENT);
  setStore();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSimClientLoader(null);
});

describe('SimTransport (#198)', () => {
  it('renders nothing unless a simulation owns the scene', () => {
    setStore({ status: 'idle' });
    render(<SimTransport />);
    expect(screen.queryByTestId('sim-transport')).toBeNull();
  });

  it('draws exactly one tick per pause point, and no other ticks', () => {
    setStore({ pauses: [toolChange(20), toolChange(50), toolChange(80)] });
    render(<SimTransport />);
    expect(screen.getAllByTestId('sim-pause-tick')).toHaveLength(3);
  });

  it('dragging the scrubber moves the step on every input event', () => {
    render(<SimTransport />);
    fireEvent.change(screen.getByTestId('sim-scrubber'), { target: { value: '37' } });
    expect(useSimStore.getState().step).toBe(37);
    fireEvent.change(screen.getByTestId('sim-scrubber'), { target: { value: '64' } });
    expect(useSimStore.getState().step).toBe(64);
  });

  it('⏭ sets the last step; pressing play at the end restarts from 0', () => {
    render(<SimTransport />);
    fireEvent.click(screen.getByTestId('sim-to-end'));
    expect(useSimStore.getState().step).toBe(100);
    expect(useSimStore.getState().seconds).toBeCloseTo(10, 6);

    fireEvent.click(screen.getByTestId('sim-play'));
    expect(useSimStore.getState().step).toBe(0);
    expect(useSimStore.getState().seconds).toBe(0);
    expect(useSimStore.getState().playing).toBe(true);
  });

  it('playing from 0 stops at a pause: the callout shows, the step equals the pause step, the clock stops', () => {
    setStore({ pauses: [toolChange(50)], playing: true, step: 0, seconds: 0 });
    render(<SimTransport />);
    flushFrame(1000); // first frame only seeds the clock (dt = 0)
    flushFrame(1100); // 0.1 s × 100 = 10 s of program time, crossing the pause at 5 s

    const s = useSimStore.getState();
    expect(s.step).toBe(50);
    expect(s.playing).toBe(false);
    expect(s.stoppedAt?.step).toBe(50);
    expect(screen.getByTestId('sim-pause-callout').textContent).toContain('Tool change: T1 → T2');
    expect(screen.getByTestId('sim-pause-callout').textContent).toContain('Press play to continue');
  });

  it('playing with no pause runs to the end: the last step, the final frame, nothing left scheduled', () => {
    setStore({ pauses: [], playing: true, step: 0, seconds: 0, speed: 100 });
    render(<SimTransport />);
    flushFrame(1000);
    flushFrame(1100); // target 10 s = total: end
    const s = useSimStore.getState();
    expect(s.playing).toBe(false);
    expect(s.step).toBe(100);
    expect(s.seconds).toBeCloseTo(10, 6);
    expect(s.stoppedAt).toBeNull();
    // The loop ended without asking for another frame.
    expect(frames).toHaveLength(0);
  });

  it('the checkpoint note counts the checkpoints from info, in the honest checkpoint wording', () => {
    setStore({ info: { count: 10, checkpoints: [] } as unknown as SimState['info'] });
    render(<SimTransport />);
    expect(screen.getByTestId('sim-checkpoint-note').textContent).toContain('Material updates at 10 points');
  });

  it('Space toggles play, and arrow keys step, while no field is focused', () => {
    setStore({ step: 10, seconds: 1 });
    render(<SimTransport />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(useSimStore.getState().step).toBe(11);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(useSimStore.getState().step).toBe(10);
    fireEvent.keyDown(window, { key: ' ' });
    expect(useSimStore.getState().playing).toBe(true);
    fireEvent.keyDown(window, { key: ' ' });
    expect(useSimStore.getState().playing).toBe(false);
    fireEvent.keyDown(window, { key: 'End' });
    expect(useSimStore.getState().step).toBe(100);
    fireEvent.keyDown(window, { key: 'Home' });
    expect(useSimStore.getState().step).toBe(0);
  });
});
