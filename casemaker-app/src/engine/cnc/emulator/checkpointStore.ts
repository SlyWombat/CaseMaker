/**
 * #899 — THE TIMELINE'S CHECKPOINTS, PACKED.
 *
 * A `Checkpoint` holds its cutting moves as three number arrays (`steps`, `xy`, `zs`); built as
 * objects they cost about 340 bytes a line, and on a 3D raster — where every move is at its own Z,
 * so every move is its own checkpoint — most of that is the object and its three arrays. Here a
 * checkpoint costs {@link PACKED_CHECKPOINT_BYTES} and a move {@link PACKED_CUT_BYTES}: its step and
 * one flag byte. A move's six coordinates are what the program already says —
 *
 *   - its start is the previous move's end (a cut path is continuous), and
 *   - its end is the end the event store holds for its step (the parser's `to`, which is the work
 *     position the runner resolved for every ordinary G54 move);
 *
 * — and only a coordinate that is NOT that, compared as exact doubles (`Object.is`) as it goes in,
 * is kept, in a sparse list beside the moves. A read therefore gives back exactly the doubles that
 * went in.
 *
 * Moves are only ever added to the LAST checkpoint (a checkpoint is a contiguous run, and the
 * builders only extend the current one), so the moves of checkpoint k are one contiguous range.
 *
 * {@link CheckpointStore.view} is the `Checkpoint[]` the timeline has always returned; the sweeps
 * read the packed moves through {@link checkpointStoreOf} without making the arrays.
 */

import type { EventStore } from '../gcode/eventStore';
import { grown, packedSource, packedView, trimmed } from '../gcode/packedView';
import type { Checkpoint, ToolState } from './timeline';

/**
 * Bytes one checkpoint costs: its run of (segment, tool, A) — which changes only at a segment or an
 * index turn, so consecutive checkpoints share one — its zKey, Z, first move and a flag byte.
 */
export const PACKED_CHECKPOINT_BYTES = 4 + 4 + 8 + 4 + 1;
/** Bytes one move costs, before any coordinate kept on its own. */
export const PACKED_CUT_BYTES = 4 + 1;

const C_NON_CONSTANT_Z = 1;
const C_A_NULL = 2;
const C_TOOL_UNKNOWN = 4;

/** Slots, in the order a move's coordinates are listed: x0 y0 z0 x1 y1 z1. */
const X0 = 0;
const Y0 = 1;
const Z0 = 2;
const X1 = 3;
const Y1 = 4;
const Z1 = 5;

/** One move's coordinates, decoded. */
export interface PackedCut {
  step: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z0: number;
  z1: number;
}

export class CheckpointStore {
  // Per checkpoint.
  private runs = new Uint32Array(64);
  /** zKey, when it is an int32 (always, for a Z within ±2 km); otherwise in `bigKeys`. */
  private zKeys = new Int32Array(64);
  private readonly bigKeys = new Map<number, number>();
  private zs = new Float64Array(64);
  private firsts = new Int32Array(64);
  private cflags = new Uint8Array(64);
  private nCp = 0;
  // The (segment, tool, A) runs.
  private segments = new Int32Array(16);
  private tools = new Float64Array(16);
  private as = new Float64Array(16);
  private rflags = new Uint8Array(16);
  private nRun = 0;
  // Per move.
  private steps = new Int32Array(1024);
  /** Bit s set: slot s was predicted (and so is not in the kept list). */
  private mflags = new Uint8Array(1024);
  private nMv = 0;
  // The kept coordinates, in (move, slot) order.
  private exMove = new Int32Array(256);
  private exSlot = new Uint8Array(256);
  private exVal = new Float64Array(256);
  private nEx = 0;
  /** The last move's end, the next move's prediction for its start. */
  private px = 0;
  private py = 0;
  private pz = 0;
  private sealed = false;

  /**
   * `events` is the store the steps index, whose packed moves predict each move's end. Without it
   * (a timeline built from a hand-made list) every end is kept.
   */
  private readonly events: EventStore | null;

  constructor(events: EventStore | null) {
    this.events = events;
  }

  get length(): number {
    return this.nCp;
  }

  /** Open a new checkpoint (the next run) and return its index. */
  open(segment: number, tool: ToolState, zKey: number, a: number | null, z: number): number {
    if (this.sealed) throw new Error('the checkpoint store is sealed');
    const k = this.nCp;
    if (k >= this.runs.length) {
      this.runs = grown(this.runs, k, k + 1);
      this.zKeys = grown(this.zKeys, k, k + 1);
      this.zs = grown(this.zs, k, k + 1);
      this.firsts = grown(this.firsts, k, k + 1);
      this.cflags = grown(this.cflags, k, k + 1);
    }
    // The run: the last one again when nothing changed.
    const rf = (a === null ? C_A_NULL : 0) | (tool === 'unknown' ? C_TOOL_UNKNOWN : 0);
    const tv = tool === 'unknown' ? 0 : tool;
    const av = a ?? 0;
    let r = this.nRun - 1;
    if (!(r >= 0 && this.segments[r] === segment && this.rflags[r] === rf && Object.is(this.tools[r], tv) && Object.is(this.as[r], av))) {
      r = this.nRun;
      if (r >= this.segments.length) {
        this.segments = grown(this.segments, r, r + 1);
        this.tools = grown(this.tools, r, r + 1);
        this.as = grown(this.as, r, r + 1);
        this.rflags = grown(this.rflags, r, r + 1);
      }
      this.segments[r] = segment;
      this.tools[r] = tv;
      this.as[r] = av;
      this.rflags[r] = rf;
      this.nRun++;
    }
    this.runs[k] = r;
    if ((zKey | 0) === zKey && !Object.is(zKey, -0)) this.zKeys[k] = zKey;
    else this.bigKeys.set(k, zKey);
    this.zs[k] = z;
    this.firsts[k] = this.nMv;
    this.cflags[k] = 0;
    this.nCp++;
    return k;
  }

  /** The last checkpoint's Z (its lowest so far). */
  get lastZ(): number {
    return this.zs[this.nCp - 1] as number;
  }

  /** Lower the last checkpoint's Z. */
  setLastZ(z: number): void {
    this.zs[this.nCp - 1] = z;
  }

  markLastNonConstantZ(): void {
    this.cflags[this.nCp - 1] = (this.cflags[this.nCp - 1] as number) | C_NON_CONSTANT_Z;
  }

  private keep(slot: number, v: number): void {
    const e = this.nEx;
    if (e >= this.exMove.length) {
      this.exMove = grown(this.exMove, e, e + 1);
      this.exSlot = grown(this.exSlot, e, e + 1);
      this.exVal = grown(this.exVal, e, e + 1);
    }
    this.exMove[e] = this.nMv;
    this.exSlot[e] = slot;
    this.exVal[e] = v;
    this.nEx++;
  }

  /** Add a move to the LAST checkpoint. */
  add(step: number, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): void {
    const j = this.nMv;
    if (j >= this.steps.length) {
      this.steps = grown(this.steps, j, j + 1);
      this.mflags = grown(this.mflags, j, j + 1);
    }
    let f = 0;
    if (j > 0 && Object.is(x0, this.px)) f |= 1 << X0;
    else this.keep(X0, x0);
    if (j > 0 && Object.is(y0, this.py)) f |= 1 << Y0;
    else this.keep(Y0, y0);
    if (j > 0 && Object.is(z0, this.pz)) f |= 1 << Z0;
    else this.keep(Z0, z0);
    const ev = this.events;
    const packed = ev !== null && step >= 0 && step < ev.length && ev.isPackedMove(step);
    if (packed && Object.is(x1, ev.toAxis(step, 0))) f |= 1 << X1;
    else this.keep(X1, x1);
    if (packed && Object.is(y1, ev.toAxis(step, 1))) f |= 1 << Y1;
    else this.keep(Y1, y1);
    if (packed && Object.is(z1, ev.toAxis(step, 2))) f |= 1 << Z1;
    else this.keep(Z1, z1);
    this.steps[j] = step;
    this.mflags[j] = f;
    this.px = x1;
    this.py = y1;
    this.pz = z1;
    this.nMv++;
  }

  /** Drop the growth slack. Nothing can be added afterwards. */
  seal(): this {
    if (this.sealed) return this;
    this.sealed = true;
    const k = this.nCp;
    this.runs = trimmed(this.runs, k);
    this.zKeys = trimmed(this.zKeys, k);
    this.zs = trimmed(this.zs, k);
    const r = this.nRun;
    this.segments = trimmed(this.segments, r);
    this.tools = trimmed(this.tools, r);
    this.as = trimmed(this.as, r);
    this.rflags = trimmed(this.rflags, r);
    this.firsts = trimmed(this.firsts, k);
    this.cflags = trimmed(this.cflags, k);
    this.steps = trimmed(this.steps, this.nMv);
    this.mflags = trimmed(this.mflags, this.nMv);
    this.exMove = trimmed(this.exMove, this.nEx);
    this.exSlot = trimmed(this.exSlot, this.nEx);
    this.exVal = trimmed(this.exVal, this.nEx);
    return this;
  }

  /** Bytes the typed arrays hold now. */
  get byteLength(): number {
    return this.runs.length * PACKED_CHECKPOINT_BYTES + this.segments.length * 21 + this.steps.length * PACKED_CUT_BYTES + this.exMove.length * 13;
  }

  /** The moves of checkpoint `k`: `[start, end)` in the store's move numbering. */
  moveStart(k: number): number {
    return this.firsts[k] as number;
  }

  moveEnd(k: number): number {
    return k + 1 < this.nCp ? (this.firsts[k + 1] as number) : this.nMv;
  }

  /** The step of move `j`. */
  stepOf(j: number): number {
    return this.steps[j] as number;
  }

  /** The first kept coordinate at or after move `j`. */
  private firstKept(j: number): number {
    let lo = 0;
    let hi = this.nEx;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.exMove[mid] as number) < j) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Decode moves `[from, to)` in order, calling `visit` with each. `out` is reused between calls:
   * copy what you keep.
   */
  forEachCut(from: number, to: number, visit: (c: PackedCut, j: number) => void): void {
    if (from >= to) return;
    const c: PackedCut = { step: 0, x0: 0, y0: 0, x1: 0, y1: 0, z0: 0, z1: 0 };
    // The previous move's end predicts the first one's start.
    let px = 0;
    let py = 0;
    let pz = 0;
    let e: number;
    if (from > 0) {
      e = this.firstKept(from - 1);
      const end = this.decode(from - 1, e, c);
      e = end;
      px = c.x1;
      py = c.y1;
      pz = c.z1;
    } else {
      e = 0;
    }
    for (let j = from; j < to; j++) {
      e = this.decode(j, e, c, px, py, pz);
      visit(c, j);
      px = c.x1;
      py = c.y1;
      pz = c.z1;
    }
  }

  /**
   * Decode move `j` into `c`, reading the kept list from cursor `e` (the first entry for move ≥ j);
   * returns the cursor past move `j`'s entries. `px/py/pz` is the previous move's end (only read
   * for a predicted start, which move 0 never has).
   */
  private decode(j: number, e: number, c: PackedCut, px = 0, py = 0, pz = 0): number {
    const f = this.mflags[j] as number;
    const step = this.steps[j] as number;
    const ev = this.events as EventStore;
    let x0 = f & (1 << X0) ? px : 0;
    let y0 = f & (1 << Y0) ? py : 0;
    let z0 = f & (1 << Z0) ? pz : 0;
    let x1 = f & (1 << X1) ? (ev.toAxis(step, 0) as number) : 0;
    let y1 = f & (1 << Y1) ? (ev.toAxis(step, 1) as number) : 0;
    let z1 = f & (1 << Z1) ? (ev.toAxis(step, 2) as number) : 0;
    while (e < this.nEx && this.exMove[e] === j) {
      const v = this.exVal[e] as number;
      switch (this.exSlot[e]) {
        case X0: x0 = v; break;
        case Y0: y0 = v; break;
        case Z0: z0 = v; break;
        case X1: x1 = v; break;
        case Y1: y1 = v; break;
        default: z1 = v;
      }
      e++;
    }
    c.step = step;
    c.x0 = x0;
    c.y0 = y0;
    c.z0 = z0;
    c.x1 = x1;
    c.y1 = y1;
    c.z1 = z1;
    return e;
  }

  segmentOf(k: number): number {
    return this.segments[this.runs[k] as number] as number;
  }

  toolOf(k: number): ToolState {
    const r = this.runs[k] as number;
    return (this.rflags[r] as number) & C_TOOL_UNKNOWN ? 'unknown' : (this.tools[r] as number);
  }

  zKeyOf(k: number): number {
    return this.bigKeys.size > 0 && this.bigKeys.has(k) ? (this.bigKeys.get(k) as number) : (this.zKeys[k] as number);
  }

  zOf(k: number): number {
    return this.zs[k] as number;
  }

  aOf(k: number): number | null {
    const r = this.runs[k] as number;
    return (this.rflags[r] as number) & C_A_NULL ? null : (this.as[r] as number);
  }

  nonConstantZOf(k: number): boolean {
    return ((this.cflags[k] as number) & C_NON_CONSTANT_Z) !== 0;
  }

  at(k: number): Checkpoint {
    const fl = this.cflags[k] as number;
    const start = this.moveStart(k);
    const end = this.moveEnd(k);
    const n = end - start;
    const steps: number[] = new Array<number>(n);
    const xy: number[] = new Array<number>(n * 4);
    const zs: number[] = new Array<number>(n * 2);
    this.forEachCut(start, end, (c, j) => {
      const i = j - start;
      steps[i] = c.step;
      xy[i * 4] = c.x0;
      xy[i * 4 + 1] = c.y0;
      xy[i * 4 + 2] = c.x1;
      xy[i * 4 + 3] = c.y1;
      zs[i * 2] = c.z0;
      zs[i * 2 + 1] = c.z1;
    });
    // The builders' own key order, so a read serialises exactly as the object they used to make.
    return {
      segment: this.segmentOf(k),
      tool: this.toolOf(k),
      zKey: this.zKeyOf(k),
      a: this.aOf(k),
      z: this.zs[k] as number,
      run: k,
      steps,
      xy,
      zs,
      nonConstantZ: (fl & C_NON_CONSTANT_Z) !== 0,
    };
  }

  /** The store as a read-only `Checkpoint[]`. */
  view(): Checkpoint[] {
    return packedView<Checkpoint>(this);
  }
}

/** The packed store behind a checkpoint list, or null for an ordinary array. */
export function checkpointStoreOf(checkpoints: readonly Checkpoint[]): CheckpointStore | null {
  const s = packedSource<unknown>(checkpoints);
  return s instanceof CheckpointStore ? s : null;
}

/**
 * #902 — the client's `CheckpointInfo[]` (`session.ts`), as plain typed arrays rather than one
 * object per checkpoint: `session.ts`'s own `checkpointInfos` reads these fields off this very
 * store (`segmentOf`, `zOf`, `stepOf`, `nonConstantZOf`, `aOf`) to build each `CheckpointInfo`; this
 * extracts them ONCE, per field, instead of per object. `firstStep`/`lastStep` carry -1 for a
 * checkpoint with no moves (`moveCount` is then 0), the sentinel `session.ts`'s view turns back
 * into `undefined`, exactly as reading `cp.steps[0]` of an empty array did.
 *
 * Plain numeric arrays, with no reference to `CheckpointInfo` or to `session.ts`: the sim worker
 * sends them across Comlink by structured clone (or transfer) instead of cloning N objects, and
 * `session.ts`'s `checkpointInfoView` turns them back into the `CheckpointInfo[]` shape on the far
 * side, in the one place that knows the wire format.
 */
export interface PackedCheckpointInfoArrays {
  count: number;
  segment: Int32Array;
  z: Float64Array;
  /** -1 when that checkpoint has no moves. */
  firstStep: Int32Array;
  /** -1 when that checkpoint has no moves. */
  lastStep: Int32Array;
  moveCount: Int32Array;
  /** 0/1. */
  nonConstantZ: Uint8Array;
  /** 1 when this checkpoint's `a` is null; `a[k]` is then meaningless. */
  aNull: Uint8Array;
  a: Float64Array;
}

/** Extract {@link PackedCheckpointInfoArrays} from a sealed store, one scan, typed arrays only. */
export function checkpointInfoArraysOf(store: CheckpointStore): PackedCheckpointInfoArrays {
  const n = store.length;
  const out: PackedCheckpointInfoArrays = {
    count: n,
    segment: new Int32Array(n),
    z: new Float64Array(n),
    firstStep: new Int32Array(n),
    lastStep: new Int32Array(n),
    moveCount: new Int32Array(n),
    nonConstantZ: new Uint8Array(n),
    aNull: new Uint8Array(n),
    a: new Float64Array(n),
  };
  for (let k = 0; k < n; k++) {
    const start = store.moveStart(k);
    const m = store.moveEnd(k) - start;
    out.segment[k] = store.segmentOf(k);
    out.z[k] = store.zOf(k);
    out.firstStep[k] = m > 0 ? store.stepOf(start) : -1;
    out.lastStep[k] = m > 0 ? store.stepOf(start + m - 1) : -1;
    out.moveCount[k] = m;
    out.nonConstantZ[k] = store.nonConstantZOf(k) ? 1 : 0;
    const a = store.aOf(k);
    if (a === null) out.aNull[k] = 1;
    else out.a[k] = a;
  }
  return out;
}
