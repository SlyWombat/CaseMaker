// The headless simulation session (#182 step 8b): simLoad -> simFrameAt -> simDispose, with no
// worker and no UI. `sim.worker.ts` is a thin Comlink shell over `createSimSession`, so the
// session is what is tested; the coalescer and the store are tested against it in-process.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tl } from './helpers/manifoldExec';
import { createSimSession, type SimFrame, type SimLoadOk } from '@/workers/sim/session';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import { STOCK_CACHE } from '@/workers/geometry/playback';
import { capsuleArea, MAX_CHECKPOINTS } from '@/workers/geometry/sweep';
import { parseGcode, setupFromHeader, stubSetup, libraryTool, type Setup } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { createFrameCoalescer } from '@/engine/jobs/frameCoalescer';
import { setSimClientLoader, useSimStore, type SimClient } from '@/store/simStore';

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const HOLD = { kind: 'tape-down' as const, contact: SLAB.outline };
const R = 0.5;
const N = segmentsForRadius(R);
const tool = flatEndMill(2 * R);
const setup = (o: Partial<Setup> = {}) => stubSetup(SLAB, HOLD, o);

// Three strokes at three depths, as in cncPlayback.spec.ts.
const THREE = [
  'S1000 M3',
  'G0 X10 Y10 Z1', 'G1 Z-0.5 F100', 'G1 X30',
  'G0 Z1', 'G0 X10 Y30', 'G1 Z-1.0', 'G1 X30',
  'G0 Z1', 'G0 X10 Y50', 'G1 Z-1.5', 'G1 X30',
].join('\n');
const V = (d: number) => capsuleArea(20, R, N) * d;

/** Volume of a closed triangle mesh, about its bbox centre to keep float32 error down. */
function meshVolume(m: NodeMeshOutput): number {
  const c = [0, 1, 2].map((i) => ((m.bbox.min[i] as number) + (m.bbox.max[i] as number)) / 2);
  const p = (i: number) => [0, 1, 2].map((a) => (m.positions[i * 3 + a] as number) - (c[a] as number));
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = p(m.indices[t] as number);
    const b = p(m.indices[t + 1] as number);
    const d = p(m.indices[t + 2] as number);
    v += (a[0]! * (b[1]! * d[2]! - b[2]! * d[1]!) - a[1]! * (b[0]! * d[2]! - b[2]! * d[0]!) + a[2]! * (b[0]! * d[1]! - b[1]! * d[0]!));
  }
  return v / 6;
}

function loaded(src: string, s: Setup = setup(), t = tool, machine: string | null = null) {
  const session = createSimSession(tl);
  const r = session.load(src, s, t, machine);
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return { session, r };
}
let gen = 0;
const frame = (session: ReturnType<typeof createSimSession>, k: number): SimFrame => {
  const f = session.frameAt(k, ++gen);
  if (!f) throw new Error(`no frame at ${k}`);
  return f;
};

describe('load -> frame -> dispose -> load -> frame', () => {
  it('runs twice on one session with no wasm throw, and agrees with itself', () => {
    const session = createSimSession(tl);
    const volumes: number[] = [];
    for (let round = 0; round < 3; round++) {
      const r = session.load(THREE, setup(), tool, null);
      expect(r.ok).toBe(true);
      expect(session.loaded).toBe(true);
      volumes.push(meshVolume(frame(session, 2).stock));
      frame(session, 0);
      frame(session, -1);
      session.dispose();
      expect(session.loaded).toBe(false);
    }
    expect(volumes[1]).toBeCloseTo(volumes[0] as number, 6);
    expect(volumes[2]).toBeCloseTo(volumes[0] as number, 6);
  });

  it('a second load WITHOUT an explicit dispose replaces the first (one session per worker)', () => {
    const session = createSimSession(tl);
    session.load(THREE, setup(), tool, null);
    const first = meshVolume(frame(session, 2).stock);
    const r = session.load('S1000 M3\nG0 X10 Y10 Z1\nG1 Z-0.5 F100\nG1 X30\n', setup(), tool, null);
    expect(r.ok && r.count).toBe(1);
    expect(frame(session, 99).k).toBe(0); // clamped to the NEW session's count
    expect(meshVolume(frame(session, 0).stock)).toBeGreaterThan(first);
    session.dispose();
    session.dispose(); // idempotent
  });

  it('after dispose, there is nothing to ask', () => {
    const { session } = loaded(THREE);
    session.dispose();
    expect(session.frameAt(0, ++gen)).toBeNull();
    expect(session.stateAt(0)).toBeNull();
    expect(session.toolPath(0, 5)).toHaveLength(0);
  });
});

describe('what a load returns', () => {
  it('plain data and transferable meshes: no wasm handle, no events, no per-step state', () => {
    const { session, r } = loaded(THREE);
    expect(r.count).toBe(3);
    expect(Object.keys(r).sort()).toEqual(['checkpoints', 'count', 'diagnostics', 'meshes', 'ok', 'pauses', 'radius', 'segments', 'stats', 'stockTopZ', 'summary']);
    expect(() => structuredClone({ ...r, meshes: undefined })).not.toThrow();
    const all = [r.meshes.stock, r.meshes.result, r.meshes.removal, ...r.meshes.gouges.map((g) => g.mesh)].filter((m): m is NodeMeshOutput => m !== null);
    expect(all).toHaveLength(3);
    for (const m of all) {
      expect(m.positions.buffer).toBeInstanceOf(ArrayBuffer);
      expect(m.indices.buffer).toBeInstanceOf(ArrayBuffer);
      expect(m.positions.length).toBe(m.vertexCount * 3);
      expect(m.indices.length).toBe(m.triangleCount * 3);
    }
    expect(r.checkpoints).toHaveLength(3);
    expect(r.checkpoints[0]).toEqual({ segment: 0, z: -0.5, run: 0, firstStep: expect.any(Number), lastStep: expect.any(Number), moveCount: expect.any(Number), nonConstantZ: false });
    expect(r.checkpoints.every((c) => c.lastStep >= c.firstStep && c.moveCount >= 1)).toBe(true);
    expect(r.summary.diagnosticCounts).toBeDefined();
    session.dispose();
  });

  it('the stock mesh is the uncut slab and the result mesh is stock - removal, by volume', () => {
    const { session, r } = loaded(THREE);
    expect(meshVolume(r.meshes.stock)).toBeCloseTo(100 * 60 * 5, 0);
    expect(r.stats.stockVolume).toBeCloseTo(100 * 60 * 5, 6);
    expect(meshVolume(r.meshes.stock) - meshVolume(r.meshes.result)).toBeCloseTo(V(0.5) + V(1) + V(1.5), 0);
    expect(r.meshes.removal).not.toBeNull();
    session.dispose();
  });

  it('every gouge comes back as a mesh whose volume is the one reported', () => {
    const { session, r } = loaded('G0 X20 Y30 Z1\nG0 Z-1\nG0 X40\n');
    const errs = r.diagnostics.filter((d) => d.code === 'rapid-through-stock');
    expect(errs).toHaveLength(2);
    expect(r.meshes.gouges.map((g) => g.line)).toEqual([2, 3]);
    r.meshes.gouges.forEach((g, i) => {
      const reported = Number(/\(([\d.]+) mm³\)/.exec(errs[i]?.message ?? '')?.[1]);
      expect(meshVolume(g.mesh)).toBeCloseTo(reported, 1);
    });
    expect(r.stats.removedVolume).toBe(0); // never subtracted
    expect(r.meshes.removal).toBeNull();
    session.dispose();
  });

  it('diagnostics are tagged with the stage that raised them', () => {
    // A parser error (bad number), a runner diagnostic (cutting from an unknown position needs
    // a machine for the envelope), and a sweep one (holder unproven).
    const src = 'S1000 M3\nG0 X10 Y10 Z1\nG1 Z-0.6 F100\nG1 X30\nG1 Xabc\n';
    const { session, r } = loaded(src, setup(), tool, 'Z1');
    const by = (s: string) => r.diagnostics.filter((d) => d.source === s).map((d) => d.code);
    expect(by('parser').length).toBeGreaterThan(0);
    expect(by('runner')).toContain('outside-envelope');
    expect(by('sweep')).toContain('holder-unproven');
    expect(r.diagnostics.every((d) => ['parser', 'runner', 'sweep'].includes(d.source))).toBe(true);
    session.dispose();
  });

  it('the envelope error line keeps its severity past the cap, and the true count is in the summary', () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(`G0 X${10 + i} Y10 Z-1`);
    const { session, r } = loaded(lines.join('\n'), setup(), tool, 'Z1');
    expect(r.summary.diagnosticCounts['outside-envelope']).toBe(30);
    expect(r.diagnostics.find((d) => d.code === 'outside-envelope-more')?.severity).toBe('error');
    session.dispose();
  });
});

describe('frames: seeks in both directions, against cncPlayback.spec.ts\'s closed forms', () => {
  it('stock volume at k = -1, 0, 1, 2 and back down again', () => {
    const { session } = loaded(THREE);
    const base = meshVolume(frame(session, -1).stock);
    expect(base).toBeCloseTo(100 * 60 * 5, 0);
    const removedAt = (k: number) => base - meshVolume(frame(session, k).stock);
    const want = [V(0.5), V(0.5) + V(1), V(0.5) + V(1) + V(1.5)];
    for (const k of [0, 1, 2, 1, 0, 2, 0]) expect(Math.abs(removedAt(k) - (want[k] as number))).toBeLessThan(0.3);
    session.dispose();
  });

  it('removalSoFar is null before any cut, and grows with k', () => {
    const { session } = loaded(THREE);
    expect(frame(session, -1).removalSoFar).toBeNull();
    const v = [0, 1, 2].map((k) => meshVolume(frame(session, k).removalSoFar as NodeMeshOutput));
    expect(v[1]).toBeGreaterThan(v[0] as number);
    expect(v[2]).toBeGreaterThan(v[1] as number);
    // It overshoots the stock top by 0.01 mm, so it is a little MORE than what was cut.
    expect(v[2]).toBeGreaterThan(V(0.5) + V(1) + V(1.5) - 0.3);
    expect(v[2]).toBeLessThan(V(0.5) + V(1) + V(1.5) + 1);
    session.dispose();
  });

  it('k is clamped to [-1, count-1], and a non-finite k is an error, not a guess', () => {
    const { session } = loaded(THREE);
    expect(frame(session, 99).k).toBe(2);
    expect(frame(session, -5).k).toBe(-1);
    expect(frame(session, 1.9).k).toBe(1);
    expect(() => session.frameAt(Number.NaN, ++gen)).toThrow(RangeError);
    session.dispose();
  });

  it('a STALE generation returns null and does not disturb the session', () => {
    const { session } = loaded(THREE);
    expect(session.frameAt(1, 10)).not.toBeNull();
    expect(session.frameAt(2, 9)).toBeNull(); // older than one already seen
    expect(session.frameAt(2, 10)).not.toBeNull(); // the same generation is not stale
    expect(session.frameAt(2, 11)).not.toBeNull();
    session.dispose();
  });

  it('after eviction (STOCK_CACHE + 1 seeks) an early frame is recomputed correctly, not read from a dead handle', () => {
    const lines = ['S1000 M3'];
    const n = STOCK_CACHE + 4;
    for (let i = 0; i < n; i++) lines.push(`G0 X${5 + i * 8} Y10 Z1`, `G1 Z${(-0.2 * (i + 1)).toFixed(1)} F100`, `G1 X${5 + i * 8 + 4}`, 'G0 Z1');
    const { session, r } = loaded(lines.join('\n'));
    expect(r.count).toBe(n);
    const first = meshVolume(frame(session, 0).stock);
    const firstRemoval = meshVolume(frame(session, 0).removalSoFar as NodeMeshOutput);
    for (let k = 1; k <= STOCK_CACHE + 1; k++) frame(session, k); // pushes k = 0 out of the cache
    const again = frame(session, 0);
    expect(meshVolume(again.stock)).toBeCloseTo(first, 6);
    expect(meshVolume(again.removalSoFar as NodeMeshOutput)).toBeCloseTo(firstRemoval, 6);
    session.dispose();
  });

  it('many checkpoints past an anchor span: scrub everywhere, then dispose, then load again', () => {
    const lines = ['S1000 M3'];
    for (let i = 0; i < 40; i++) {
      const x = 5 + (i % 8) * 12;
      const y = 5 + Math.floor(i / 8) * 11;
      lines.push(`G0 X${x} Y${y} Z1`, `G1 Z${(-0.1 * (i + 1)).toFixed(1)} F100`, `G1 X${x + 6}`, 'G0 Z1');
    }
    const session = createSimSession(tl);
    for (let round = 0; round < 2; round++) {
      const r = session.load(lines.join('\n'), setup(), tool, null) as SimLoadOk;
      expect(r.count).toBe(40);
      for (const k of [39, 0, 31, 32, 17, 39, 5, 38, 33]) expect(frame(session, k).k).toBe(k);
      session.dispose();
    }
  });
});

describe('stateAt and toolPath, on demand', () => {
  it('stateAt is the timeline\'s state; toolPath is the work-frame polyline of known positions', () => {
    const { session, r } = loaded(THREE);
    const last = r.summary.steps - 1;
    expect(session.stateAt(last)?.work).toEqual([30, 50, -1.5]); // the end of the third stroke
    expect(session.stateAt(last)).toEqual(session.stateAt(last + 100)); // clamped, as the timeline does
    const p = session.toolPath(0, last);
    expect(p.length % 3).toBe(0);
    expect(Array.from(p.slice(-3))).toEqual([30, 50, -1.5]);
    expect(session.toolPath(5, 3)).toHaveLength(3); // a reversed range collapses to one step
    session.dispose();
  });
});

describe('refusals: each leaves NO session, even over a good one', () => {
  const refusal = (src: string, s: Setup, t = tool, machine: string | null = null) => {
    const session = createSimSession(tl);
    expect(session.load(THREE, setup(), tool, null).ok).toBe(true);
    const r = session.load(src, s, t, machine);
    expect(r.ok).toBe(false);
    expect(session.loaded).toBe(false);
    expect(session.frameAt(0, ++gen)).toBeNull();
    return r.diagnostics;
  };

  const sweepCodes = (d: { source: string; code: string }[]) => d.filter((x) => x.source === 'sweep').map((x) => x.code);
  it('a laser job', () => expect(sweepCodes(refusal('M321\nG0 X20 Y30 Z0\nG1 X40 S0.5 F100\nM322\n', setup()))).toEqual(['laser-job']));
  it('a rotary job', () => expect(sweepCodes(refusal('S1000 M3\nG0 X20 Y30 Z0\nG1 X40 A90 F100\n', setup()))).toEqual(['rotary-job']));

  it(`more than ${MAX_CHECKPOINTS} checkpoints`, () => {
    const lines = ['S1000 M3'];
    for (let i = 0; i < MAX_CHECKPOINTS + 1; i++) {
      lines.push(`G0 X${10 + (i % 50)} Y${10 + (i % 7)} Z1`, `G1 Z${i % 2 ? -0.5 : -1} F100`, `G1 X${12 + (i % 50)}`, 'G0 Z1');
    }
    const d = refusal(lines.join('\n'), setup());
    expect(d.find((x) => x.code === 'dense-3d-refused')?.source).toBe('sweep');
  });

  it('an unknown tool shape, named', () => {
    const d = refusal(THREE, setup(), { ...flatEndMill(1), name: 'Mystery', typeText: 'Quux', shape: 'unknown' });
    expect(sweepCodes(d)).toEqual(['tool-refused']);
    expect(d.find((x) => x.code === 'tool-refused')?.message).toMatch(/Mystery/);
  });

  it('a V-bit and a bull nose', () => {
    expect(sweepCodes(refusal(THREE, setup(), { ...flatEndMill(1), name: 'V', shape: 'engraving', typeText: 'Engraving' }))).toEqual(['tool-refused']);
    expect(sweepCodes(refusal(THREE, setup(), flatEndMill(1, { name: 'Bull', cornerRadius: 0.2 })))).toEqual(['tool-refused']);
  });

  it('a bad stock: a cylinder, and a zero-thickness prism', () => {
    expect(sweepCodes(refusal(THREE, setup({ part: { kind: 'cylinder', diameter: 20, length: 50 } })))).toEqual(['stock-unsupported']);
    expect(sweepCodes(refusal(THREE, setup({ part: { ...SLAB, thickness: 0 } })))).toEqual(['stock-invalid']);
  });

  it('an unknown machine id', () => expect(refusal(THREE, setup(), tool, 'Carvera')[0]?.code).toBe('machine-unknown'));

  it('a refusal still carries the parser diagnostics that preceded it', () => {
    const session = createSimSession(tl);
    const r = session.load('M321\nG1 Xabc\n', setup(), tool, null);
    expect(r.ok).toBe(false);
    expect(new Set(r.diagnostics.map((d) => d.source))).toEqual(new Set(['parser', 'sweep']));
  });
});

// ---------------------------------------------------------------------------------------
// Teardown order. The playback is disposed before the sweep handles "by construction" — a
// comment cannot fail — so it is observed here instead.
// ---------------------------------------------------------------------------------------
describe('dispose order: the playback goes first, then the sweep handles', () => {
  it('a normal dispose() releases the playback, then the sweep', () => {
    const seen: string[] = [];
    const session = createSimSession(tl, { onDispose: (what) => seen.push(what) });
    session.load(THREE, setup(), tool, null);
    seen.length = 0; // the first load disposed nothing: there was no session yet
    session.dispose();
    expect(seen).toEqual(['playback', 'sweep']);
    session.dispose(); // idempotent: nothing left to release, so nothing more is reported
    expect(seen).toEqual(['playback', 'sweep']);
  });

  it('a second load() replaces a session in the same order', () => {
    const seen: string[] = [];
    const session = createSimSession(tl, { onDispose: (what) => seen.push(what) });
    expect(session.load(THREE, setup(), tool, null).ok).toBe(true);
    seen.length = 0;
    const replaced = session.load(THREE, setup(), tool, null); // disposes the first, same order
    expect(replaced.ok).toBe(true);
    expect(seen).toEqual(['playback', 'sweep']);
    session.dispose();
  });
});

// ---------------------------------------------------------------------------------------
// The coalescer: at most one in flight, newest k wins, stale dropped.
// ---------------------------------------------------------------------------------------
describe('frame coalescing: in-flight, not a timer', () => {
  function harness() {
    const calls: { k: number; gen: number; resolve: (v: string | null) => void }[] = [];
    const delivered: [number, string][] = [];
    const errors: unknown[] = [];
    const c = createFrameCoalescer<string>({
      fetch: (k, g) => new Promise((resolve) => calls.push({ k, gen: g, resolve })),
      deliver: (k, f) => delivered.push([k, f]),
      onError: (e) => errors.push(e),
    });
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    return { c, calls, delivered, errors, tick };
  }

  it('sends one request at once; a burst collapses to the NEWEST k in a single pending slot', async () => {
    const { c, calls, delivered, tick } = harness();
    c.request(1);
    for (let k = 2; k <= 9; k++) c.request(k);
    expect(calls.map((x) => x.k)).toEqual([1]);
    calls[0]?.resolve('f1');
    await tick();
    expect(calls.map((x) => x.k)).toEqual([1, 9]); // 2..8 were never sent
    calls[1]?.resolve('f9');
    await c.idle();
    expect(delivered).toEqual([[1, 'f1'], [9, 'f9']]);
    expect(calls.map((x) => x.gen)).toEqual([1, 2]); // generations only go up
  });

  it('an idle coalescer answers immediately: no timer to wait out', () => {
    const { c, calls } = harness();
    c.request(4);
    expect(calls).toHaveLength(1);
    expect(c.inFlight).toBe(true);
  });

  it('a null (the worker called it stale) is dropped, and the pending slot still goes out', async () => {
    const { c, calls, delivered, tick } = harness();
    c.request(1);
    c.request(2);
    calls[0]?.resolve(null);
    await tick();
    calls[1]?.resolve('f2');
    await c.idle();
    expect(delivered).toEqual([[2, 'f2']]);
  });

  it('reset() drops what is in flight (a new session) and what is pending', async () => {
    const { c, calls, delivered, tick } = harness();
    c.request(1);
    c.request(2);
    c.reset();
    calls[0]?.resolve('old');
    await tick();
    expect(calls).toHaveLength(1); // the pending slot was cleared
    expect(delivered).toEqual([]);
    c.request(3); // and the coalescer still works afterwards
    calls[1]?.resolve('new');
    await c.idle();
    expect(delivered).toEqual([[3, 'new']]);
  });

  it('a silent request fetches but never delivers (the warm-up), and a real one replaces it', async () => {
    const { c, calls, delivered, tick } = harness();
    c.request(7, { silent: true });
    calls[0]?.resolve('warm');
    await c.idle();
    expect(delivered).toEqual([]);
    c.request(7, { silent: true });
    c.request(0);
    calls[1]?.resolve('warm2');
    await tick();
    calls[2]?.resolve('f0');
    await c.idle();
    expect(delivered).toEqual([[0, 'f0']]);
  });

  it('a failure is reported and does not wedge the queue', async () => {
    const h = harness();
    const c = createFrameCoalescer<string>({
      fetch: (k) => (k === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(`f${k}`)),
      deliver: (k, f) => h.delivered.push([k, f]),
      onError: (e) => h.errors.push(e),
    });
    c.request(1);
    await c.idle();
    c.request(2);
    await c.idle();
    expect(h.errors).toHaveLength(1);
    expect(h.delivered).toEqual([[2, 'f2']]);
  });
});

// ---------------------------------------------------------------------------------------
// The store, over a client that talks to a real in-process session instead of a Worker.
// ---------------------------------------------------------------------------------------
describe('simStore: plain data and meshes, never jobStore.nodes', () => {
  function fakeClient(): SimClient {
    const session = createSimSession(tl);
    let sink: ((k: number, f: SimFrame) => void) | null = null;
    let gen = 0;
    const frames = createFrameCoalescer<SimFrame>({
      fetch: async (k, g) => session.frameAt(k, g),
      deliver: (k, f) => sink?.(k, f),
    });
    return {
      setSimSinks: (f: typeof sink) => { sink = f; },
      loadSim: async (...a: Parameters<typeof session.load>) => {
        frames.reset();
        const r = session.load(...a);
        if (r.ok && r.count > 0) frames.request(r.count - 1, { silent: true });
        return r;
      },
      requestFrame: (k: number) => { void gen; frames.request(k); },
      disposeSim: async () => { frames.reset(); session.dispose(); },
    } as unknown as SimClient;
  }

  it('load -> seek -> dispose, with the store holding only data', async () => {
    const client = fakeClient();
    setSimClientLoader(async () => client);
    const store = useSimStore;
    await store.getState().loadProgram(THREE, setup(), tool, null);
    expect(store.getState().status).toBe('ready');
    expect(store.getState().info?.count).toBe(3);
    expect(store.getState().meshes?.stock.triangleCount).toBeGreaterThan(0);
    expect(store.getState().diagnostics).toBeDefined();
    store.getState().seek(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().k).toBe(1);
    expect(store.getState().frame?.k).toBe(1);
    // Nothing in the state is a wasm handle: it survives a structured clone intact.
    expect(() => structuredClone({ i: store.getState().info, m: store.getState().meshes, f: store.getState().frame })).not.toThrow();
    await store.getState().dispose();
    expect(store.getState().status).toBe('idle');
    expect(store.getState().meshes).toBeNull();
    setSimClientLoader(null);
  });

  it('a refused load is a status with its diagnostics, and seek does nothing', async () => {
    setSimClientLoader(async () => fakeClient());
    await useSimStore.getState().loadProgram('M321\nG0 X1 Y1 Z0\n', setup(), tool, null);
    const s = useSimStore.getState();
    expect(s.status).toBe('refused');
    expect(s.diagnostics[0]?.code).toBe('laser-job');
    expect(s.meshes).toBeNull();
    s.seek(0);
    expect(useSimStore.getState().frame).toBeNull();
    setSimClientLoader(null);
  });

  it('is not the job store: it exports no `nodes`', () => {
    expect('nodes' in useSimStore.getState()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// OPT-IN: a real vendor file (`npm run reference-gcode:fetch`). Skipped when absent.
// ---------------------------------------------------------------------------------------
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reference-gcode');

describe.skipIf(!existsSync(join(CORPUS, 'LED/ACRYLIC-Balloon.nc')))('a real corpus file, end to end', () => {
  it('LED/ACRYLIC-Balloon.nc with the owned 3.175 flat: load -> scrub -> dispose -> load, twice', () => {
    const text = readFileSync(join(CORPUS, 'LED/ACRYLIC-Balloon.nc'), 'latin1');
    const parsed = parseGcode(text);
    // Balloon has no STOCK header (a Carvera-era file), so `setupFromHeader` prefills nothing and
    // the slab is sized to the job, as cncSweep.spec.ts does.
    expect(setupFromHeader(parsed.header).patch).toEqual({});
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity;
    for (const e of parsed.events) {
      if (e.kind !== 'move' || e.mode !== 'cut') continue;
      for (const p of [e.from, e.to]) {
        if (p[0] !== null) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); }
        if (p[1] !== null) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
        if (p[2] !== null) minZ = Math.min(minZ, p[2]);
      }
    }
    const thickness = Math.ceil(-minZ + 1);
    const part = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [maxX - minX + 10, maxY - minY + 10] as [number, number] }, thickness };
    const s = stubSetup(part, { kind: 'tape-down', contact: part.outline });
    s.placement = { origin: [minX - 5, minY - 5, 0], rotationZ: 0, source: 'stub' };
    s.wcs = { origin: [0, 0, thickness], source: 'stub', uncertainty: 0.05 };
    const t = libraryTool('flat-3.175x12-metal');
    if (!t) throw new Error('tool missing');

    const session = createSimSession(tl);
    for (let round = 0; round < 2; round++) {
      const r = session.load(text, s, t, null);
      if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
      expect(r.count).toBe(10);
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(r.meshes.gouges).toEqual([]);
      expect(r.stats.removedVolume).toBeGreaterThan(0);
      // Meshes agree with the sweep's own totals.
      expect(Math.abs(meshVolume(r.meshes.stock) - r.stats.stockVolume)).toBeLessThan(r.stats.stockVolume * 1e-4);
      expect(Math.abs(meshVolume(r.meshes.stock) - meshVolume(r.meshes.result) - r.stats.removedVolume)).toBeLessThan(5);
      // Scrub up, down, to both ends. The removed volume only ever grows with k.
      const base = meshVolume(frame(session, -1).stock);
      const removed = (k: number) => base - meshVolume(frame(session, k).stock);
      const seen = new Map<number, number>();
      for (const k of [9, 0, 4, 9, 2, 7, 1, 8]) {
        const v = removed(k);
        if (seen.has(k)) expect(v).toBeCloseTo(seen.get(k) as number, 3);
        seen.set(k, v);
      }
      const ordered = [...seen.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      for (let i = 1; i < ordered.length; i++) expect(ordered[i]).toBeGreaterThanOrEqual((ordered[i - 1] as number) - 0.05);
      expect(Math.abs((seen.get(9) as number) - r.stats.removedVolume)).toBeLessThan(5);
      expect(session.toolPath(0, r.summary.steps - 1).length).toBeGreaterThan(3000);
      session.dispose();
    }
  });
});
