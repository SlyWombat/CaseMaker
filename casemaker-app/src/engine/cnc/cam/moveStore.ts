/**
 * #889 — PACKED MOVE STORAGE for the goal CAM.
 *
 * A goal program can run to hundreds of thousands of moves. Held as one `CamMove` object each, a
 * move costs about 130 bytes of JS heap (the object, its boxed doubles and the array slot); packed
 * here it costs {@link PACKED_MOVE_BYTES}: four Float64 coordinates and a kind byte. The doubles
 * are the same doubles the objects held, so the post formats exactly the numbers it did before and
 * the posted text is byte-identical.
 *
 * The store sits BEHIND THE EXISTING MOVE INTERFACE: {@link MoveStore.view} returns a read-only
 * array view whose elements are ordinary `CamMove` objects made on read, so the post, the cycle
 * estimate, the sweep and every test read it as the `CamMove[]` they always have. Nothing writes
 * through the view.
 *
 * The arrays are plain typed arrays — {@link MoveStore.buffers} hands them out and
 * {@link MoveStore.fromBuffers} takes them back — so a worker that builds part of a program (one
 * roughing level each) can post them as transferables and the parts concatenate with
 * {@link MoveStore.append}.
 *
 * #889 item 3 — COLLINEAR FEEDS MERGE ON THE WAY IN. A raster emits one step per grid cell; along a
 * level stretch every one of those steps lies on the same line. Only LEVEL lines merge (see
 * `openLine`: the column sweep reads a long sloped move high). With a positive
 * `mergeToleranceMm`, a feed that continues the previous feed's line (same feed rate, moving
 * forward, every dropped point within the tolerance of the segment that replaces it) REPLACES the
 * previous end point instead of adding a move. The guarantee: each dropped point lies within half
 * the tolerance of the line the run started on, and so does the new end, so every dropped point is
 * within the full tolerance of the merged segment.
 */

import type { CamMove } from './ir';

/** Bytes one packed move costs: x, y, z, f as Float64 and one kind byte. */
export const PACKED_MOVE_BYTES = 33;

/**
 * #889 — the merge tolerance the goal CAM uses, mm: well under the 0.01 mm the finish is judged to
 * and the post's own 0.001 mm resolution is finer still, so a merged path is the same surface.
 */
export const GOAL_MERGE_TOLERANCE_MM = 0.002;

const KIND_RAPID = 0;
const KIND_FEED = 1;
const FLAG_PECK = 2;

/** The typed arrays one store holds, trimmed to its length — transferable as they are. */
export interface MoveBuffers {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** The feed rate of a feed move; 0 on a rapid. */
  f: Float64Array;
  /** Bit 0: feed (1) or rapid (0). Bit 1: a drill's peck retract. */
  kind: Uint8Array;
  /** The rotary A word, when any move carries one; else null. */
  a: Float64Array | null;
}

export interface MoveStoreOpts {
  /** Merge collinear feeds within this distance, mm; 0 or absent: never merge. */
  mergeToleranceMm?: number;
  /** Starting capacity, moves. */
  capacity?: number;
  /**
   * COUNT ONLY: keep just the last few moves (what merging reads) and count the rest, so a
   * program's size is known without holding it. {@link MoveStore.view} refuses on such a store.
   */
  countOnly?: boolean;
}

export class MoveStore {
  private xs: Float64Array;
  private ys: Float64Array;
  private zs: Float64Array;
  private fs: Float64Array;
  private ks: Uint8Array;
  private as: Float64Array | null = null;
  private n = 0;
  /** Moves a count-only store has let go of (its `length` still counts them). */
  private dropped = 0;
  private readonly countOnly: boolean;
  private readonly halfTol: number;
  /** The open merge line: its anchor, unit direction, and the end's distance along it. */
  private lineOpen = false;
  private ax = 0;
  private ay = 0;
  private az = 0;
  private dx = 0;
  private dy = 0;
  private dz = 0;
  private tEnd = 0;
  /** How many feeds were merged away (the count the panel can quote). */
  merged = 0;

  constructor(opts: MoveStoreOpts = {}) {
    const cap = Math.max(16, Math.floor(opts.capacity ?? 1024));
    this.xs = new Float64Array(cap);
    this.ys = new Float64Array(cap);
    this.zs = new Float64Array(cap);
    this.fs = new Float64Array(cap);
    this.ks = new Uint8Array(cap);
    const tol = opts.mergeToleranceMm ?? 0;
    this.halfTol = tol > 0 ? tol / 2 : 0;
    this.countOnly = opts.countOnly === true;
  }

  get length(): number {
    return this.dropped + this.n;
  }

  /** Bytes the store's arrays hold now (capacity, not length: what the heap really pays). */
  get byteLength(): number {
    return this.xs.length * PACKED_MOVE_BYTES + (this.as === null ? 0 : this.as.length * 8);
  }

  private grow(min: number): void {
    if (min <= this.xs.length) return;
    let cap = this.xs.length;
    while (cap < min) cap *= 2;
    const g = (src: Float64Array): Float64Array => {
      const out = new Float64Array(cap);
      out.set(src.subarray(0, this.n));
      return out;
    };
    this.xs = g(this.xs);
    this.ys = g(this.ys);
    this.zs = g(this.zs);
    this.fs = g(this.fs);
    if (this.as !== null) this.as = g(this.as);
    const k = new Uint8Array(cap);
    k.set(this.ks.subarray(0, this.n));
    this.ks = k;
  }

  private put(kind: number, x: number, y: number, z: number, f: number, a: number | undefined): void {
    if (this.countOnly && this.n === this.xs.length) {
      // Keep the last two (all that merging and `lastX`/`lastY` read); count the rest.
      const keep = 2;
      const from = this.n - keep;
      this.xs.copyWithin(0, from, this.n);
      this.ys.copyWithin(0, from, this.n);
      this.zs.copyWithin(0, from, this.n);
      this.fs.copyWithin(0, from, this.n);
      this.ks.copyWithin(0, from, this.n);
      if (this.as !== null) this.as.copyWithin(0, from, this.n);
      this.dropped += from;
      this.n = keep;
    }
    if (this.n === this.xs.length) this.grow(this.n + 1);
    const i = this.n++;
    this.xs[i] = x;
    this.ys[i] = y;
    this.zs[i] = z;
    this.fs[i] = f;
    this.ks[i] = kind;
    if (a !== undefined) {
      if (this.as === null) {
        this.as = new Float64Array(this.xs.length).fill(Number.NaN);
      }
      this.as[i] = a;
    } else if (this.as !== null) {
      this.as[i] = Number.NaN;
    }
  }

  rapid(x: number, y: number, z: number): void {
    this.lineOpen = false;
    this.put(KIND_RAPID, x, y, z, 0, undefined);
  }

  feed(x: number, y: number, z: number, f: number): void {
    const n = this.n;
    if (this.halfTol > 0 && n >= 2 && this.ks[n - 1] === KIND_FEED && this.fs[n - 1] === f && this.as === null) {
      if (this.lineOpen) {
        const vx = x - this.ax;
        const vy = y - this.ay;
        const vz = z - this.az;
        const t = vx * this.dx + vy * this.dy + vz * this.dz;
        if (t > this.tEnd + 1e-12) {
          const px = vx - t * this.dx;
          const py = vy - t * this.dy;
          const pz = vz - t * this.dz;
          if (px * px + py * py + pz * pz <= this.halfTol * this.halfTol) {
            const i = n - 1;
            this.xs[i] = x;
            this.ys[i] = y;
            this.zs[i] = z;
            this.tEnd = t;
            this.merged++;
            return;
          }
        }
      }
      this.put(KIND_FEED, x, y, z, f, undefined);
      this.openLine();
      return;
    }
    this.put(KIND_FEED, x, y, z, f, undefined);
    if (this.halfTol > 0 && n >= 1 && this.as === null) this.openLine();
    else this.lineOpen = false;
  }

  /** Start a merge line on the last two stored points (the segment the last feed cut). */
  private openLine(): void {
    const i = this.n - 1;
    const ax = this.xs[i - 1] as number;
    const ay = this.ys[i - 1] as number;
    const az = this.zs[i - 1] as number;
    const vx = (this.xs[i] as number) - ax;
    const vy = (this.ys[i] as number) - ay;
    const vz = (this.zs[i] as number) - az;
    const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
    // LEVEL lines only. The column sweep reads a ramping move's floor at three points (its foot
    // and its two ends, #758); for a ball on a long sloped move the true lowest point lies between
    // them, so a merged slope would be swept up to tenths of a millimetre high — a finish the
    // simulation says leaves material the machine removes. A level move is read exactly, and the
    // roughing's levels are where the moves were.
    if (!(len > 1e-9) || Math.abs(vz) > this.halfTol) {
      this.lineOpen = false;
      return;
    }
    this.lineOpen = true;
    this.ax = ax;
    this.ay = ay;
    this.az = az;
    this.dx = vx / len;
    this.dy = vy / len;
    this.dz = vz / len;
    this.tEnd = len;
  }

  /** Append one `CamMove` as it is (merging when it is a feed and merging is on). */
  push(move: CamMove): void {
    if (move.a !== undefined || (move.kind === 'rapid' && move.peck === true)) {
      this.lineOpen = false;
      this.put(move.kind === 'feed' ? KIND_FEED : KIND_RAPID | (move.kind === 'rapid' && move.peck === true ? FLAG_PECK : 0), move.x, move.y, move.z, move.kind === 'feed' ? move.f : 0, move.a);
      return;
    }
    if (move.kind === 'feed') this.feed(move.x, move.y, move.z, move.f);
    else this.rapid(move.x, move.y, move.z);
  }

  /** Append every move of `moves` (a store, a view, or a plain array), in order. */
  append(moves: MoveStore | readonly CamMove[]): void {
    if (this.countOnly) throw new Error('a count-only move store cannot take whole lists');
    if (moves instanceof MoveStore) {
      if (moves.countOnly) throw new Error('a count-only move store holds no moves to append');
      // Packed to packed: copy the arrays, no objects. The seam is never merged across.
      this.lineOpen = false;
      const m = moves.n;
      if (m === 0) return;
      this.grow(this.n + m);
      this.xs.set(moves.xs.subarray(0, m), this.n);
      this.ys.set(moves.ys.subarray(0, m), this.n);
      this.zs.set(moves.zs.subarray(0, m), this.n);
      this.fs.set(moves.fs.subarray(0, m), this.n);
      this.ks.set(moves.ks.subarray(0, m), this.n);
      if (moves.as !== null || this.as !== null) {
        if (this.as === null) this.as = new Float64Array(this.xs.length).fill(Number.NaN);
        if (moves.as !== null) this.as.set(moves.as.subarray(0, m), this.n);
        else this.as.fill(Number.NaN, this.n, this.n + m);
      }
      this.n += m;
      return;
    }
    const packed = storeOf(moves);
    if (packed !== null) {
      this.append(packed);
      return;
    }
    for (const move of moves) this.push(move);
    this.lineOpen = false;
  }

  /** The move at `i`, as a fresh `CamMove` object. */
  at(i: number): CamMove | undefined {
    if (this.countOnly || !(i >= 0 && i < this.n)) return undefined;
    const k = this.ks[i] as number;
    const a = this.as === null ? Number.NaN : (this.as[i] as number);
    if ((k & KIND_FEED) !== 0) {
      return Number.isNaN(a)
        ? { kind: 'feed', x: this.xs[i] as number, y: this.ys[i] as number, z: this.zs[i] as number, f: this.fs[i] as number }
        : { kind: 'feed', x: this.xs[i] as number, y: this.ys[i] as number, z: this.zs[i] as number, f: this.fs[i] as number, a };
    }
    const move: CamMove = { kind: 'rapid', x: this.xs[i] as number, y: this.ys[i] as number, z: this.zs[i] as number };
    if (!Number.isNaN(a)) move.a = a;
    if ((k & FLAG_PECK) !== 0) move.peck = true;
    return move;
  }

  /** Coordinates of the last move, without making an object. */
  lastX(): number {
    return this.xs[this.n - 1] as number;
  }
  lastY(): number {
    return this.ys[this.n - 1] as number;
  }

  /** The arrays, trimmed to the length (copies when the capacity is larger), ready to transfer. */
  buffers(): MoveBuffers {
    if (this.countOnly) throw new Error('a count-only move store holds no moves');
    const n = this.n;
    const trim64 = (src: Float64Array): Float64Array => (src.length === n ? src : src.slice(0, n));
    const kind = this.ks.length === n ? this.ks : this.ks.slice(0, n);
    return {
      x: trim64(this.xs),
      y: trim64(this.ys),
      z: trim64(this.zs),
      f: trim64(this.fs),
      kind,
      a: this.as === null ? null : trim64(this.as),
    };
  }

  /** A store over arrays another store handed out (adopted, not copied). */
  static fromBuffers(b: MoveBuffers, opts: MoveStoreOpts = {}): MoveStore {
    const s = new MoveStore({ ...opts, capacity: 16 });
    s.xs = b.x;
    s.ys = b.y;
    s.zs = b.z;
    s.fs = b.f;
    s.ks = b.kind;
    s.as = b.a;
    s.n = b.kind.length;
    return s;
  }

  /** The store as a read-only `CamMove[]` (see the file header). */
  view(): CamMove[] {
    if (this.countOnly) throw new Error('a count-only move store holds no moves');
    return moveView(this);
  }
}

const STORE = Symbol('cm.moveStore');

/** The packed store behind a {@link MoveStore.view}, or null for an ordinary array. */
export function storeOf(moves: readonly CamMove[]): MoveStore | null {
  return ((moves as unknown as Record<symbol, unknown>)[STORE] as MoveStore | undefined) ?? null;
}

/** Packed bytes held behind `moves`, or the object estimate for a plain array. */
export function movesBytes(moves: readonly CamMove[]): number {
  const s = storeOf(moves);
  return s !== null ? s.byteLength : moves.length * PACKED_MOVE_BYTES;
}

function indexOf(key: string | symbol): number {
  if (typeof key !== 'string') return -1;
  const c = key.charCodeAt(0);
  if (c < 48 || c > 57) return -1;
  const i = Number(key);
  return Number.isInteger(i) && String(i) === key ? i : -1;
}

function moveView(store: MoveStore): CamMove[] {
  const iterate = function* (): IterableIterator<CamMove> {
    const n = store.length;
    for (let i = 0; i < n; i++) yield store.at(i) as CamMove;
  };
  const readOnly = (): never => {
    throw new TypeError('a packed move list is read-only');
  };
  // The target is a real (empty) array, so `Array.isArray` holds and every `Array.prototype`
  // method runs generically through `length` and the index reads below.
  return new Proxy([] as CamMove[], {
    get(target, key, receiver) {
      if (key === 'length') return store.length;
      if (key === STORE) return store;
      if (key === Symbol.iterator) return iterate;
      const i = indexOf(key);
      if (i >= 0) return store.at(i);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      const i = indexOf(key);
      if (i >= 0) return i < store.length;
      return key === STORE || Reflect.has(target, key);
    },
    ownKeys() {
      const keys: (string | symbol)[] = [];
      for (let i = 0; i < store.length; i++) keys.push(String(i));
      keys.push('length');
      return keys;
    },
    getOwnPropertyDescriptor(target, key) {
      if (key === 'length') return { value: store.length, writable: true, enumerable: false, configurable: false };
      const i = indexOf(key);
      if (i >= 0 && i < store.length) return { value: store.at(i), writable: false, enumerable: true, configurable: true };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    set: readOnly,
    defineProperty: readOnly,
    deleteProperty: readOnly,
  });
}
