/**
 * #902 — THE TIMELINE'S AIR MOVES, PACKED, in the `eventStore.ts` / `checkpointStore.ts` idiom.
 *
 * An `AirMove` held as an object costs its six-double `from`/`to` pair as two nested arrays plus
 * the object shell — on a dense 3D raster, where every row ends in a retract, this runs to the
 * same order of count as the cutting moves themselves. Here a move costs
 * {@link PACKED_AIR_MOVE_BYTES}: its step, line, a one-byte flag (the kind, and whether `aFrom` /
 * `aTo` are null) and its six coordinates as `Float64Array` slots, plus the two A angles.
 *
 * `lifted` is never set by the builder (`buildTimeline` pushes only the five base fields in their
 * own order) — it is added afterwards, by `unliftTimeline`'s `Array.prototype.map`, onto a fresh
 * plain object, so the packed store never needs to carry it.
 *
 * {@link AirMoveStore.view} is the `AirMove[]` the timeline has always returned (see
 * `packedView`); {@link airMoveStoreOf} finds the store again for a caller that wants the packed
 * fields directly instead of one object per move.
 */

import { grown, packedSource, packedView, trimmed } from '../gcode/packedView';
import type { AirMove } from './timeline';

/** Bytes one packed air move costs: step, line, flags, `from`, `to`, `aFrom`, `aTo`. */
export const PACKED_AIR_MOVE_BYTES = 4 + 4 + 1 + 24 + 24 + 8 + 8;

const F_FEED_SPINDLE_OFF = 1 << 0;
const F_A_FROM_NULL = 1 << 1;
const F_A_TO_NULL = 1 << 2;

export class AirMoveStore {
  private steps = new Int32Array(64);
  private lines = new Int32Array(64);
  private flags = new Uint8Array(64);
  private froms = new Float64Array(64 * 3);
  private tos = new Float64Array(64 * 3);
  private aFroms = new Float64Array(64);
  private aTos = new Float64Array(64);
  private n = 0;
  private sealed = false;

  get length(): number {
    return this.n;
  }

  /** Append one air move, in the builder's own field order. */
  push(m: AirMove): void {
    if (this.sealed) throw new Error('the air-move store is sealed');
    const i = this.n;
    if (i >= this.steps.length) {
      this.steps = grown(this.steps, i, i + 1);
      this.lines = grown(this.lines, i, i + 1);
      this.flags = grown(this.flags, i, i + 1);
      this.froms = grown(this.froms, i * 3, i * 3 + 3);
      this.tos = grown(this.tos, i * 3, i * 3 + 3);
      this.aFroms = grown(this.aFroms, i, i + 1);
      this.aTos = grown(this.aTos, i, i + 1);
    }
    this.steps[i] = m.step;
    this.lines[i] = m.line;
    let f = m.kind === 'feed-spindle-off' ? F_FEED_SPINDLE_OFF : 0;
    const aFrom = m.aFrom ?? null;
    const aTo = m.aTo ?? null;
    if (aFrom === null) f |= F_A_FROM_NULL;
    if (aTo === null) f |= F_A_TO_NULL;
    this.flags[i] = f;
    this.froms[i * 3] = m.from[0];
    this.froms[i * 3 + 1] = m.from[1];
    this.froms[i * 3 + 2] = m.from[2];
    this.tos[i * 3] = m.to[0];
    this.tos[i * 3 + 1] = m.to[1];
    this.tos[i * 3 + 2] = m.to[2];
    this.aFroms[i] = aFrom ?? 0;
    this.aTos[i] = aTo ?? 0;
    this.n++;
  }

  /** Drop the growth slack. Nothing can be added afterwards. */
  seal(): this {
    if (this.sealed) return this;
    this.sealed = true;
    const n = this.n;
    this.steps = trimmed(this.steps, n);
    this.lines = trimmed(this.lines, n);
    this.flags = trimmed(this.flags, n);
    this.froms = trimmed(this.froms, n * 3);
    this.tos = trimmed(this.tos, n * 3);
    this.aFroms = trimmed(this.aFroms, n);
    this.aTos = trimmed(this.aTos, n);
    return this;
  }

  /** Bytes the typed arrays hold now. */
  get byteLength(): number {
    return this.steps.length * PACKED_AIR_MOVE_BYTES;
  }

  at(i: number): AirMove {
    const f = this.flags[i] as number;
    return {
      step: this.steps[i] as number,
      line: this.lines[i] as number,
      kind: f & F_FEED_SPINDLE_OFF ? 'feed-spindle-off' : 'rapid',
      from: [this.froms[i * 3] as number, this.froms[i * 3 + 1] as number, this.froms[i * 3 + 2] as number],
      to: [this.tos[i * 3] as number, this.tos[i * 3 + 1] as number, this.tos[i * 3 + 2] as number],
      aFrom: f & F_A_FROM_NULL ? null : (this.aFroms[i] as number),
      aTo: f & F_A_TO_NULL ? null : (this.aTos[i] as number),
    };
  }

  /** The store as a read-only `AirMove[]`. */
  view(): AirMove[] {
    return packedView<AirMove>(this);
  }
}

/** The packed store behind an air-move list, or null for an ordinary array. */
export function airMoveStoreOf(airMoves: readonly AirMove[]): AirMoveStore | null {
  const s = packedSource<unknown>(airMoves);
  return s instanceof AirMoveStore ? s : null;
}
