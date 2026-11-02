// #899 — the parser's events and the timeline's checkpoints are held packed and read back through
// the same `GcodeEvent[]` / `Checkpoint[]` views. These pin that a read gives back exactly what went
// in (the doubles, the nulls, the key order) and what the packing costs per line.
import { describe, it, expect } from 'vitest';
import { buildTimeline, parseGcode, stubSetup } from '@/engine/cnc';
import type { GcodeEvent, MoveEvent } from '@/engine/cnc/gcode';
import { EventStore, eventLine, eventStoreOf, PACKED_EVENT_BYTES } from '@/engine/cnc/gcode/eventStore';
import { CheckpointStore, checkpointStoreOf } from '@/engine/cnc/emulator/checkpointStore';

const part = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 70] as [number, number] }, thickness: 20 };
const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline });

const move = (o: Partial<MoveEvent>): MoveEvent => ({
  kind: 'move',
  line: 1,
  mode: 'cut',
  frame: 'work',
  from: [0, 0, 0],
  to: [1, 0, 0],
  a: null,
  feed: 500,
  power: null,
  fromArc: false,
  commanded: [true, false, false],
  values: [1, null, null],
  relative: false,
  ...o,
});

describe('EventStore (#899)', () => {
  it('gives back every event exactly, field for field and in the same key order', () => {
    const events: GcodeEvent[] = [
      { kind: 'spindle', line: 1, state: 'cw', rpm: 12000 },
      move({ line: 2, from: [null, null, null], to: [1, 2, null], commanded: [true, true, false], values: [1, 2, null] }),
      // `from` continues the last move; Z still unknown.
      move({ line: 3, from: [1, 2, null], to: [-0, 2, -1.5], commanded: [true, false, true], values: [-0, null, -1.5] }),
      // A relative move: `values` are deltas, kept on their own.
      move({ line: 4, from: [-0, 2, -1.5], to: [0.5, 2, -1.5], relative: true, values: [0.5, null, null] }),
      { kind: 'tool-change', line: 5, tool: 2, noOpIfActive: true, noOp: false, stoppedSpindle: true },
      // After the change the parser forgot Z: `from` is not the last `to`.
      move({ line: 6, mode: 'rapid', feed: null, from: [0.5, 2, null], to: [3, 4, 5], commanded: [true, true, true], values: [3, 4, 5] }),
      move({ line: 7, frame: 'machine', a: 12.5, power: 30, fromArc: true, from: [3, 4, 5], to: [3, 4, 6], commanded: [false, false, true], values: [null, null, 6] }),
      // A runner-made synthetic move is kept whole.
      { ...move({ line: 7, mode: 'rapid', feed: null }), synthetic: 'tool-change-macro' },
    ];
    const store = new EventStore();
    for (const ev of events) store.push(ev);
    const view = store.seal().view();
    expect(view.length).toBe(events.length);
    expect(Array.isArray(view)).toBe(true);
    expect(view).toEqual(events);
    expect(JSON.stringify(view)).toBe(JSON.stringify(events));
    expect([...view].map((e) => e.line)).toEqual(events.map((e) => e.line));
    // -0 survives the packing.
    expect(Object.is((view[2] as MoveEvent).to[0], -0)).toBe(true);
    expect(eventStoreOf(view)).toBe(store);
    expect(eventLine(view, 6)).toBe(7);
    expect(eventLine(view, 99)).toBeUndefined();
    expect(() => {
      (view as GcodeEvent[]).push(events[0] as GcodeEvent);
    }).toThrow(TypeError);
  });

  it('splits lines exactly as the old split did: CRLF, LF, a lone CR, and a trailing empty line', () => {
    const src = 'G0 X1\r\nG1 X2 F100\rG1 X3\n\nG1 X4\n';
    const p = parseGcode(src);
    expect(p.summary.lines).toBe(src.split(/\r\n|\n|\r/).length);
    expect(p.events.filter((e) => e.kind === 'move').map((e) => e.line)).toEqual([1, 2, 3, 5]);
  });

  it('a raster costs its packed bytes per line, not an object', () => {
    const lines = ['S10000 M3', 'G0 X0 Y0 Z5', 'G1 Z-1 F600'];
    for (let i = 0; i < 2000; i++) lines.push(`G1 X${(i * 0.05).toFixed(3)} Z${(-1 - Math.sin(i / 50)).toFixed(3)}`);
    const tl = buildTimeline(parseGcode(lines.join('\n')), setup);
    const events = eventStoreOf(tl.events);
    const cps = checkpointStoreOf(tl.checkpoints);
    expect(events).not.toBeNull();
    expect(cps).not.toBeNull();
    // Every move its own Z, so (almost) every move its own checkpoint: the worst case for the store.
    expect(tl.checkpoints.length).toBeGreaterThan(1500);
    const perLine = ((events?.byteLength ?? 0) + (cps?.byteLength ?? 0)) / lines.length;
    expect(perLine).toBeLessThan(64);
    expect(PACKED_EVENT_BYTES).toBeLessThanOrEqual(35);
  });
});

describe('CheckpointStore (#899)', () => {
  it('gives back every move exactly, predicted or kept, and decodes from any start', () => {
    // An event store whose moves predict some ends and not others.
    const ev = new EventStore();
    const n = 400;
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < n; i++) ev.push(move({ line: i + 1, from: [i, i, -i], to: [i + 1, i * 2, -1 - (i % 5)], commanded: [true, true, true], values: [i + 1, i * 2, -1 - (i % 5)] }));
    ev.seal();
    const store = new CheckpointStore(ev);
    const ref: { segment: number; zKey: number; a: number | null; z: number; steps: number[]; xy: number[]; zs: number[]; nonConstantZ: boolean }[] = [];
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0 || rnd() < 0.3) {
        const z = -rnd() * 3;
        const a = rnd() < 0.5 ? null : Math.round(rnd() * 360);
        const zKey = rnd() < 0.05 ? -0 : Math.round(z * 1000);
        store.open(i % 3, 1, zKey, a, z);
        ref.push({ segment: i % 3, zKey, a, z, steps: [], xy: [], zs: [], nonConstantZ: false });
      }
      // Continuous most of the time; a jump now and then. Ends from the event, or not.
      const x0 = rnd() < 0.8 ? px : rnd() * 10;
      const y0 = rnd() < 0.8 ? py : -0;
      const z0 = rnd() < 0.8 ? pz : rnd();
      const x1 = rnd() < 0.7 ? i + 1 : rnd() * 10;
      const y1 = rnd() < 0.7 ? i * 2 : rnd() * 10;
      const z1 = rnd() < 0.7 ? -1 - (i % 5) : -rnd();
      store.add(i, x0, y0, x1, y1, z0, z1);
      const r = ref[ref.length - 1]!;
      r.steps.push(i);
      r.xy.push(x0, y0, x1, y1);
      r.zs.push(z0, z1);
      if (rnd() < 0.1) {
        store.markLastNonConstantZ();
        r.nonConstantZ = true;
      }
      if (z1 < store.lastZ) {
        store.setLastZ(z1);
        r.z = z1;
      }
      px = x1;
      py = y1;
      pz = z1;
    }
    const view = store.seal().view();
    expect(view.length).toBe(ref.length);
    view.forEach((cp, k) => {
      const r = ref[k]!;
      expect(cp.run).toBe(k);
      expect(cp.tool).toBe(1);
      expect(cp.segment).toBe(r.segment);
      expect(Object.is(cp.zKey, r.zKey)).toBe(true);
      expect(cp.a).toBe(r.a);
      expect(cp.z).toBe(r.z);
      expect(cp.nonConstantZ).toBe(r.nonConstantZ);
      expect(cp.steps).toEqual(r.steps);
      // Exact doubles, -0 included.
      expect(cp.xy.every((v, i) => Object.is(v, r.xy[i]))).toBe(true);
      expect(cp.zs.every((v, i) => Object.is(v, r.zs[i]))).toBe(true);
    });
    // Decoding a range that starts mid-checkpoint reads the same moves.
    const flat = ref.flatMap((r) => r.steps.map((s, i) => [s, r.xy[i * 4], r.xy[i * 4 + 1], r.xy[i * 4 + 2], r.xy[i * 4 + 3], r.zs[i * 2], r.zs[i * 2 + 1]]));
    const got: number[][] = [];
    store.forEachCut(137, 260, (c) => got.push([c.step, c.x0, c.y0, c.x1, c.y1, c.z0, c.z1]));
    expect(got).toEqual(flat.slice(137, 260));
  });

  it('keeps a checkpoint with no moves, as the timeline can open one', () => {
    const store = new CheckpointStore(null);
    store.open(0, 'unknown', 5, null, 0.005);
    store.open(0, 'unknown', 6, null, 0.006);
    store.add(3, 1, 2, 3, 4, 0.006, 0.006);
    const view = store.seal().view();
    expect(view[0]).toEqual({ segment: 0, tool: 'unknown', zKey: 5, a: null, z: 0.005, run: 0, steps: [], xy: [], zs: [], nonConstantZ: false });
    expect(view[1]?.steps).toEqual([3]);
  });
});
