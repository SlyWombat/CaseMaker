/**
 * #881 — A POOL REPLY'S MOVES ON THE WIRE: #889's `MoveStore` arrays, transferred.
 *
 * A level's plan is tens of thousands of `CamMove` objects; sending them back as structured-clone
 * objects copies every one in the sim worker's heap on every level. The pool worker packs its plan
 * into a `MoveStore` and hands out the store's arrays; the pool forwards them to the sim worker
 * with these same buffers on the transfer list, and the sim worker adopts them with
 * `MoveStore.fromBuffers`. No level's moves are ever copied across the channel, and the packing is
 * exact (Float64 coordinates both sides), so a pooled plan stays byte-identical to the serial one.
 */

import { MoveStore, type MoveBuffers } from './moveStore';
import type { CamMove } from './ir';

/** A level's moves as a store's arrays, trimmed to its length. */
export function moveBuffersOf(moves: readonly CamMove[]): MoveBuffers {
  const store = new MoveStore();
  store.append(moves);
  return store.buffers();
}

/** The buffers to hand `postMessage`'s transfer list. */
export function moveBufferTransfers(buffers: MoveBuffers): ArrayBuffer[] {
  const out: ArrayBuffer[] = [
    buffers.x.buffer as ArrayBuffer,
    buffers.y.buffer as ArrayBuffer,
    buffers.z.buffer as ArrayBuffer,
    buffers.f.buffer as ArrayBuffer,
    buffers.kind.buffer as ArrayBuffer,
  ];
  if (buffers.a !== null) out.push(buffers.a.buffer as ArrayBuffer);
  return out;
}
