/**
 * #881 — THE WIRE FORM OF A LEVEL'S MOVES: packed, transferable, exact.
 *
 * A level's plan is tens of thousands of `CamMove` objects; sending them back as structured-clone
 * objects copies every one, in the sim worker's heap, on every level. The pool sends typed arrays
 * instead — transferred, not copied — and the sim worker unpacks them once. The packing is exact:
 * the coordinates are JS doubles on both sides (Float64Array), so a pooled plan is still
 * byte-identical to the serial one.
 *
 * #889 moves the CAM's own storage to packed arrays; these are the buffers it will keep.
 */

import type { CamMove } from './ir';

export interface PackedMoves {
  /** x, y, z per move, in order (three doubles each). */
  xyz: Float64Array;
  /** 0 = rapid, 1 = feed. */
  kind: Uint8Array;
  /** The feed rate of a feed move; 0 on a rapid. */
  f: Float64Array;
  /** The rotary index where the move has one; NaN where it does not (a real `a` is finite). */
  a: Float64Array;
  /** 1 where a rapid is a drill's chip-clear peck (#727 F4). */
  peck: Uint8Array;
}

/** Pack moves for the wire. */
export function packMoves(moves: readonly CamMove[]): PackedMoves {
  const n = moves.length;
  const xyz = new Float64Array(n * 3);
  const kind = new Uint8Array(n);
  const f = new Float64Array(n);
  const a = new Float64Array(n);
  a.fill(Number.NaN);
  const peck = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const m = moves[i]!;
    xyz[i * 3] = m.x;
    xyz[i * 3 + 1] = m.y;
    xyz[i * 3 + 2] = m.z;
    if (m.kind === 'rapid') {
      if (m.peck === true) peck[i] = 1;
    } else {
      kind[i] = 1;
      f[i] = m.f;
    }
    if (m.a !== undefined) a[i] = m.a;
  }
  return { xyz, kind, f, a, peck };
}

/** The buffers to hand `postMessage`'s transfer list. */
export function packTransfers(packed: PackedMoves): ArrayBuffer[] {
  return [
    packed.xyz.buffer as ArrayBuffer,
    packed.kind.buffer as ArrayBuffer,
    packed.f.buffer as ArrayBuffer,
    packed.a.buffer as ArrayBuffer,
    packed.peck.buffer as ArrayBuffer,
  ];
}

/** The moves back, exactly as `planLevel` produced them. */
export function unpackMoves(packed: PackedMoves): CamMove[] {
  const n = packed.kind.length;
  const moves: CamMove[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = packed.xyz[i * 3] as number;
    const y = packed.xyz[i * 3 + 1] as number;
    const z = packed.xyz[i * 3 + 2] as number;
    const a = packed.a[i] as number;
    if (packed.kind[i] === 1) {
      moves[i] = { kind: 'feed', x, y, z, f: packed.f[i] as number, ...(Number.isFinite(a) ? { a } : {}) };
    } else {
      moves[i] = { kind: 'rapid', x, y, z, ...(Number.isFinite(a) ? { a } : {}), ...(packed.peck[i] === 1 ? { peck: true } : {}) };
    }
  }
  return moves;
}
