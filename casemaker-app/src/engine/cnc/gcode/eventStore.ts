/**
 * #899 — THE EVENT STREAM, PACKED.
 *
 * A program is almost all moves, and a `MoveEvent` held as an object costs about 500 bytes of JS
 * heap (the object, its four little arrays and their boxed doubles). Here a parser move costs
 * {@link PACKED_EVENT_BYTES}: its line, one flag word, its end point as three doubles and an index
 * into a run of (A, feed, power) triples that changes only when one of them does. The rest of the
 * move is what the stream already says:
 *
 *   - `from` is the previous packed move's `to` — the parser's position before the line — and is
 *     kept on its own only when it is not (a tool change forgot Z, a G92 moved the frame);
 *   - `values` are `to` on the commanded axes and null elsewhere for every absolute move, and are
 *     kept on their own only when they are not (a relative move, an inch program).
 *
 * Both are decided by comparing the exact doubles (`Object.is`) as the move goes in, so the object
 * made on read is the object that went in, field for field. Every other event (tool changes,
 * pauses, the runner's synthetic macro moves — a few per program) is kept as the object it is.
 *
 * {@link EventStore.view} is the `GcodeEvent[]` the parser and the timeline have always returned
 * (see `packedView`); {@link eventStoreOf} finds the store again for the sim's hot loops.
 */

import { grown, packedSource, packedView, trimmed } from './packedView';
import type { GcodeEvent, MoveEvent, Pos } from './types';

/** Bytes one packed move costs: kind, line, flags, `to` and the modal-triple index. */
export const PACKED_EVENT_BYTES = 1 + 4 + 2 + 24 + 4;

const K_MOVE = 0;
const K_OBJECT = 1;

const F_CUT = 1 << 0;
const F_MACHINE = 1 << 1;
const F_ARC = 1 << 2;
const F_RELATIVE = 1 << 3;
/** Bits 4–6: `commanded[0..2]`. */
const F_CMD0 = 4;
/** Bits 7–9: `to[0..2]` is null. */
const F_TO_NULL0 = 7;
/** `from` is the previous packed move's `to`. */
const F_FROM_PREV = 1 << 10;
/** `values` is `to` on the commanded axes and null elsewhere. */
const F_VALUES_STD = 1 << 11;

/** The modal triple's null bits. */
const M_A_NULL = 1;
const M_FEED_NULL = 2;
const M_POWER_NULL = 4;

const same = (a: number | null, b: number | null): boolean => Object.is(a, b);

/** Is this the parser's own move shape, exactly — the one the store packs? */
function isPlainMove(ev: GcodeEvent): ev is MoveEvent {
  if (ev.kind !== 'move' || ev.synthetic !== undefined) return false;
  // Thirteen own keys in the parser's order; anything else (a hand-built event with an extra
  // field) is kept whole, so a read gives back exactly what went in.
  let n = 0;
  for (const k in ev) {
    void k;
    n++;
  }
  return n === 13 && ev.from.length === 3 && ev.to.length === 3 && ev.values.length === 3 && ev.commanded.length === 3;
}

export class EventStore {
  private kinds = new Uint8Array(1024);
  private lines = new Int32Array(1024);
  private flags = new Uint16Array(1024);
  private tx = new Float64Array(1024);
  private ty = new Float64Array(1024);
  private tz = new Float64Array(1024);
  private modal = new Uint32Array(1024);
  /** The (A, feed, power) runs. */
  private ma = new Float64Array(64);
  private mf = new Float64Array(64);
  private mp = new Float64Array(64);
  private mnull = new Uint8Array(64);
  private nModal = 0;
  private readonly objects = new Map<number, GcodeEvent>();
  private readonly froms = new Map<number, Pos>();
  private readonly values = new Map<number, Pos>();
  private n = 0;
  /** The previous packed move's index, -1 before the first. */
  private lastMove = -1;
  private sealed = false;

  get length(): number {
    return this.n;
  }

  push(ev: GcodeEvent): void {
    if (this.sealed) throw new Error('the event store is sealed');
    const i = this.n;
    if (i >= this.kinds.length) {
      const min = i + 1;
      this.kinds = grown(this.kinds, i, min);
      this.lines = grown(this.lines, i, min);
      this.flags = grown(this.flags, i, min);
      this.tx = grown(this.tx, i, min);
      this.ty = grown(this.ty, i, min);
      this.tz = grown(this.tz, i, min);
      this.modal = grown(this.modal, i, min);
    }
    this.n++;
    this.lines[i] = ev.line;
    if (!isPlainMove(ev)) {
      this.kinds[i] = K_OBJECT;
      this.objects.set(i, ev);
      return;
    }
    this.kinds[i] = K_MOVE;
    let f = 0;
    if (ev.mode === 'cut') f |= F_CUT;
    if (ev.frame === 'machine') f |= F_MACHINE;
    if (ev.fromArc) f |= F_ARC;
    if (ev.relative) f |= F_RELATIVE;
    const t = ev.to;
    for (let k = 0; k < 3; k++) {
      if (ev.commanded[k]) f |= 1 << (F_CMD0 + k);
      if (t[k] === null) f |= 1 << (F_TO_NULL0 + k);
    }
    this.tx[i] = t[0] ?? 0;
    this.ty[i] = t[1] ?? 0;
    this.tz[i] = t[2] ?? 0;
    // `from`: the previous packed move's `to`, or kept whole.
    const p = this.lastMove;
    if (p >= 0 && same(ev.from[0], this.toAxis(p, 0)) && same(ev.from[1], this.toAxis(p, 1)) && same(ev.from[2], this.toAxis(p, 2))) f |= F_FROM_PREV;
    else this.froms.set(i, [ev.from[0], ev.from[1], ev.from[2]]);
    // `values`: `to` on the commanded axes, or kept whole.
    let std = true;
    for (let k = 0; k < 3 && std; k++) std = same(ev.values[k] as number | null, ev.commanded[k] ? (t[k] as number | null) : null);
    if (std) f |= F_VALUES_STD;
    else this.values.set(i, [ev.values[0], ev.values[1], ev.values[2]]);
    this.flags[i] = f;
    // The modal triple: reuse the last run when nothing changed.
    const m = this.nModal - 1;
    const nulls = (ev.a === null ? M_A_NULL : 0) | (ev.feed === null ? M_FEED_NULL : 0) | (ev.power === null ? M_POWER_NULL : 0);
    if (
      m >= 0 &&
      this.mnull[m] === nulls &&
      Object.is(this.ma[m], ev.a ?? 0) &&
      Object.is(this.mf[m], ev.feed ?? 0) &&
      Object.is(this.mp[m], ev.power ?? 0)
    ) {
      this.modal[i] = m;
    } else {
      const j = this.nModal;
      if (j >= this.ma.length) {
        this.ma = grown(this.ma, j, j + 1);
        this.mf = grown(this.mf, j, j + 1);
        this.mp = grown(this.mp, j, j + 1);
        this.mnull = grown(this.mnull, j, j + 1);
      }
      this.ma[j] = ev.a ?? 0;
      this.mf[j] = ev.feed ?? 0;
      this.mp[j] = ev.power ?? 0;
      this.mnull[j] = nulls;
      this.nModal++;
      this.modal[i] = j;
    }
    this.lastMove = i;
  }

  /** Drop the growth slack. Nothing can be pushed afterwards. */
  seal(): this {
    if (this.sealed) return this;
    this.sealed = true;
    const n = this.n;
    this.kinds = trimmed(this.kinds, n);
    this.lines = trimmed(this.lines, n);
    this.flags = trimmed(this.flags, n);
    this.tx = trimmed(this.tx, n);
    this.ty = trimmed(this.ty, n);
    this.tz = trimmed(this.tz, n);
    this.modal = trimmed(this.modal, n);
    const m = this.nModal;
    this.ma = trimmed(this.ma, m);
    this.mf = trimmed(this.mf, m);
    this.mp = trimmed(this.mp, m);
    this.mnull = trimmed(this.mnull, m);
    return this;
  }

  /** Bytes the typed arrays hold now (capacity, which is what the heap pays). */
  get byteLength(): number {
    return this.kinds.length * PACKED_EVENT_BYTES + this.ma.length * 25;
  }

  /** The source line of event `i`, without making the event. */
  lineAt(i: number): number {
    return this.lines[i] as number;
  }

  /** Is event `i` a packed (parser) move? */
  isPackedMove(i: number): boolean {
    return this.kinds[i] === K_MOVE;
  }

  /** `to[k]` of the packed move `i` (null when unknown). Only for a packed move. */
  toAxis(i: number, k: 0 | 1 | 2): number | null {
    if (((this.flags[i] as number) >> (F_TO_NULL0 + k)) & 1) return null;
    return (k === 0 ? this.tx[i] : k === 1 ? this.ty[i] : this.tz[i]) as number;
  }

  at(i: number): GcodeEvent {
    if (this.kinds[i] === K_OBJECT) return this.objects.get(i) as GcodeEvent;
    const f = this.flags[i] as number;
    const to: Pos = [this.toAxis(i, 0), this.toAxis(i, 1), this.toAxis(i, 2)];
    const commanded: [boolean, boolean, boolean] = [((f >> F_CMD0) & 1) === 1, ((f >> (F_CMD0 + 1)) & 1) === 1, ((f >> (F_CMD0 + 2)) & 1) === 1];
    let from: Pos;
    if (f & F_FROM_PREV) {
      let p = i - 1;
      while (this.kinds[p] !== K_MOVE) p--;
      from = [this.toAxis(p, 0), this.toAxis(p, 1), this.toAxis(p, 2)];
    } else {
      const kept = this.froms.get(i) as Pos;
      from = [kept[0], kept[1], kept[2]];
    }
    let values: Pos;
    if (f & F_VALUES_STD) values = [commanded[0] ? to[0] : null, commanded[1] ? to[1] : null, commanded[2] ? to[2] : null];
    else {
      const kept = this.values.get(i) as Pos;
      values = [kept[0], kept[1], kept[2]];
    }
    const m = this.modal[i] as number;
    const nulls = this.mnull[m] as number;
    // The parser's own key order, so a read serialises exactly as the object that went in.
    const ev: MoveEvent = {
      kind: 'move',
      line: this.lines[i] as number,
      mode: f & F_CUT ? 'cut' : 'rapid',
      frame: f & F_MACHINE ? 'machine' : 'work',
      from,
      to,
      a: nulls & M_A_NULL ? null : (this.ma[m] as number),
      feed: nulls & M_FEED_NULL ? null : (this.mf[m] as number),
      power: nulls & M_POWER_NULL ? null : (this.mp[m] as number),
      fromArc: (f & F_ARC) !== 0,
      commanded,
      values,
      relative: (f & F_RELATIVE) !== 0,
    };
    return ev;
  }

  /** The store as a read-only `GcodeEvent[]`. */
  view(): GcodeEvent[] {
    return packedView<GcodeEvent>(this);
  }
}

/** The packed store behind an event list, or null for an ordinary array. */
export function eventStoreOf(events: readonly GcodeEvent[]): EventStore | null {
  const s = packedSource<unknown>(events);
  return s instanceof EventStore ? s : null;
}

/** The source line of event `i` (-1 past the end), without making the event when it is packed. */
export function eventLine(events: readonly GcodeEvent[], i: number): number | undefined {
  const s = eventStoreOf(events);
  if (s !== null) return i >= 0 && i < s.length ? s.lineAt(i) : undefined;
  return events[i]?.line;
}

/** Event `i`, read from the store directly when the list is packed (no proxy, no cache). */
export function eventAt(events: readonly GcodeEvent[], i: number): GcodeEvent {
  const s = eventStoreOf(events);
  return (s !== null ? s.at(i) : events[i]) as GcodeEvent;
}
