/**
 * #562 — QUICKLZ, LEVEL 1: the codec Studio compresses uploads with (RE 05).
 *
 * The vendor's `QuickLZCLI.exe` ships beside Studio; its `.bin` uploads are QuickLZ level 1 — the
 * original 1.5 stream, not the later variants: a 9-byte long header, 32-bit little-endian control
 * words interleaved with the token bytes, literals as raw bytes (one control bit each), and a
 * two- or three-byte MATCH TOKEN that carries a 12-bit HASH instead of an offset — the decoder
 * finds the source through its own table, which both sides update on the same positions.
 *
 * This module is the ENCODER (what the upload needs) and the DECODER (what proves the encoder in
 * the tests, and what a future reader of a `.bin` on the card would use). The byte layout is
 * pinned against the reference C implementation's own rules — `qlz_size_compressed` reads bytes 1–4
 * little-endian and INCLUDES the header, byte 0 is `1 (compressed) | 2 (long header) | level<<2 |
 * 1<<6`, and the hash is `((fetch >> 12) ^ fetch) & 0xfff` over the 3 bytes at a position.
 *
 * WHY A JAVASCRIPT PORT RATHER THAN THE VENDOR'S BINARY. The upload runs in the app's own process
 * (the desktop bridge's JS side), where a bundled `QuickLZCLI.exe` cannot be spawned on every
 * platform this app ships on; and the round trip has to be testable without a machine. The stream
 * is small (a few hundred KB at most) and the encoder is the reference algorithm, not an
 * approximation of it.
 *
 * THE OUTPUT IS ONLY USED WHEN IT PAYS. `quicklzCompress` returns null when the payload would not
 * be smaller than the input (the reference encoder falls back to a raw stream there; an upload
 * has a better fallback — the plain file — so it is the caller's).
 */

/** The level-1 hash table: 12 bits, `QLZ_HASH_VALUES` in the reference. */
const HASH_VALUES = 4096;
const HASH_MASK = HASH_VALUES - 1;
/** `MINOFFSET`: a match must reach back more than this, so the one-byte-back case is not a match. */
const MINOFFSET = 2;
/** The reference gives up on the last 10 bytes as a match region (`UNCONDITIONAL_MATCHLEN + UNCOMPRESSED_END`). */
const MATCH_TAIL = 6 + 4;
/** The longest a match token can state in its 8-bit length byte. */
const MAX_MATCH = 255;
/** `CWORD_LEN`: the control word's four bytes. */
const CWORD_LEN = 4;
/** Sizes at or above this use the 9-byte long header (the reference's `216`). */
const SHORT_HEADER_LIMIT = 216;

/** The 3 bytes at `i` as a little-endian integer (bytes past the end read as 0). */
function fetch3(src: Uint8Array, i: number): number {
  return (src[i] ?? 0) | ((src[i + 1] ?? 0) << 8) | ((src[i + 2] ?? 0) << 16);
}

/** `qlz_compress`'s header flag byte for a compressed, long-header, level-1 stream. */
export const QLZ_LEVEL1_LONG_HEADER = 1 | 2 | (1 << 2) | (1 << 6); // 0x47

/**
 * Compress `source` to a QuickLZ level-1 stream (long header), or null when the result would not
 * be smaller than the input — the caller then uploads the plain file rather than a stream the
 * machine would have to decompress to no benefit.
 */
export function quicklzCompress(source: Uint8Array): Uint8Array | null {
  const size = source.length;
  if (size < SHORT_HEADER_LIMIT) return null; // the short header exists, but nothing this small pays
  const header = 9;
  const out = new Uint8Array(size + 400 + header); // the reference's documented upper bound
  let dst = header;
  out[dst] = 0; // reserve the first control word
  let cwordPtr = dst;
  dst += CWORD_LEN;
  let cword = 0x80000000 >>> 0;

  const hashOffset = new Int32Array(HASH_VALUES);
  const hashCache = new Int32Array(HASH_VALUES);

  let src = 0;
  const lastByte = size - 1;
  const lastMatchStart = lastByte - MATCH_TAIL;
  let fetch = src <= lastMatchStart ? fetch3(source, src) : 0;

  while (src <= lastMatchStart) {
    if ((cword & 1) === 1) {
      // Flush this control word and start the next.
      writeU32Le(out, cwordPtr, ((cword >>> 1) | 0x80000000) >>> 0);
      cwordPtr = dst;
      dst += CWORD_LEN;
      cword = 0x80000000 >>> 0;
      fetch = fetch3(source, src);
    }
    const hash = ((fetch >>> 12) ^ fetch) & HASH_MASK;
    const cached = (fetch ^ hashCache[hash]!) >>> 0;
    const offset = hashOffset[hash]!;
    hashCache[hash] = fetch;
    hashOffset[hash] = src;
    const same3 = (cached & 0xffffff) === 0;
    if (same3 && offset !== 0 && src - offset > MINOFFSET) {
      // A match. Extend it over the bytes both sides agree on, leaving the reference's tail.
      let matchlen = 3;
      while (src + matchlen <= lastByte - 4 && matchlen < MAX_MATCH && source[offset + matchlen] === source[src + matchlen]) {
        matchlen += 1;
      }
      const hashBits = (hash << 4) >>> 0;
      cword = ((cword >>> 1) | 0x80000000) >>> 0;
      if (matchlen < 18) {
        const v = ((matchlen - 2) | hashBits) & 0xffff;
        out[dst++] = v & 0xff;
        out[dst++] = (v >>> 8) & 0xff;
      } else {
        const v = ((matchlen << 16) | hashBits) >>> 0;
        out[dst++] = v & 0xff;
        out[dst++] = (v >>> 8) & 0xff;
        out[dst++] = (v >>> 16) & 0xff;
      }
      src += matchlen;
      fetch = src <= lastMatchStart ? fetch3(source, src) : 0;
    } else {
      // One literal: one control bit, shifted out; the byte goes after the control word.
      out[dst++] = source[src]!;
      src += 1;
      cword >>>= 1;
      fetch = src <= lastMatchStart ? fetch3(source, src) : 0;
    }
  }

  // The tail: the last bytes are literals, one per bit, hashing while three still remain.
  while (src <= lastByte) {
    if ((cword & 1) === 1) {
      writeU32Le(out, cwordPtr, ((cword >>> 1) | 0x80000000) >>> 0);
      cwordPtr = dst;
      dst += CWORD_LEN;
      cword = 0x80000000 >>> 0;
    }
    if (src <= lastByte - 3) {
      const tailFetch = fetch3(source, src);
      const hash = ((tailFetch >>> 12) ^ tailFetch) & HASH_MASK;
      hashOffset[hash] = src;
      hashCache[hash] = tailFetch;
    }
    out[dst++] = source[src]!;
    src += 1;
    cword >>>= 1;
  }
  while ((cword & 1) !== 1) cword >>>= 1;
  writeU32Le(out, cwordPtr, ((cword >>> 1) | 0x80000000) >>> 0);

  const total = Math.max(dst, 9);
  if (total >= size) return null; // not profitable: the caller uploads the plain file
  // The long header, exactly as `qlz_compress` writes it: flags, TOTAL length (header included),
  // then the original size — both little-endian, both at their documented offsets.
  out[0] = QLZ_LEVEL1_LONG_HEADER;
  writeU32Le(out, 1, total);
  writeU32Le(out, 5, size);
  return out.slice(0, total);
}

/** A little-endian u32 at `at`. */
function writeU32Le(out: Uint8Array, at: number, v: number): void {
  out[at] = v & 0xff;
  out[at + 1] = (v >>> 8) & 0xff;
  out[at + 2] = (v >>> 16) & 0xff;
  out[at + 3] = (v >>> 24) & 0xff;
}

/** A little-endian u32 from `at` (bytes past the end read as 0 — the reference's padded read). */
function readU32Le(src: Uint8Array, at: number): number {
  return ((src[at] ?? 0) | ((src[at + 1] ?? 0) << 8) | ((src[at + 2] ?? 0) << 16) | ((src[at + 3] ?? 0) << 24)) >>> 0;
}

/** The reference decoder's literal-run table: the low nibble's first set bit + 1, or 4. */
const BITLUT = [4, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0];

/** `qlz_size_compressed` / `qlz_size_decompressed`, for a reader of a `.bin` on the card. */
export function quicklzSizes(stream: Uint8Array): { compressed: number; decompressed: number } {
  const long = (stream[0]! & 2) === 2;
  const n = long ? 4 : 1;
  const compressed = long ? readU32Le(stream, 1) : (stream[1] ?? 0);
  const decompressed = long ? readU32Le(stream, 1 + n) : (stream[2] ?? 0);
  return { compressed, decompressed };
}

/**
 * Decompress a level-1 stream (long or short header). Throws on a stream this decoder cannot read
 * — a raw (`compressed = 0`) stream is refused rather than guessed at.
 */
export function quicklzDecompress(stream: Uint8Array): Uint8Array {
  const flags = stream[0]!;
  if ((flags & 1) !== 1) throw new Error('this is a raw QuickLZ stream, not a compressed one');
  const long = (flags & 2) === 2;
  const header = long ? 9 : 3;
  const { compressed, decompressed } = quicklzSizes(stream);
  if (compressed > stream.length) throw new Error(`the stream says ${compressed} bytes but ${stream.length} are present`);
  const out = new Uint8Array(decompressed);
  const hashOffset = new Int32Array(HASH_VALUES);
  let lastHashed = -1;
  const updateUpto = (max: number): void => {
    while (lastHashed < max && lastHashed + 3 <= decompressed) {
      lastHashed += 1;
      const f = (out[lastHashed]! | (out[lastHashed + 1]! << 8) | (out[lastHashed + 2]! << 16)) >>> 0;
      hashOffset[((f >>> 12) ^ f) & HASH_MASK] = lastHashed;
    }
  };
  let src = header;
  let dst = 0;
  let cword = 1;
  while (dst < decompressed) {
    if (cword === 1) {
      cword = readU32Le(stream, src);
      src += CWORD_LEN;
    }
    if ((cword & 1) === 1) {
      // A match token: the hash finds the source in OUR table, exactly as the encoder's did.
      cword >>>= 1;
      const fetch = readU32Le(stream, src);
      const hash = (fetch >>> 4) & HASH_MASK;
      const offset = hashOffset[hash]!;
      let matchlen: number;
      if ((fetch & 0xf) !== 0) {
        matchlen = (fetch & 0xf) + 2;
        src += 2;
      } else {
        matchlen = stream[src + 2]!;
        src += 3;
      }
      for (let i = 0; i < matchlen; i += 1) out[dst + i] = out[offset + i]!;
      dst += matchlen;
      updateUpto(dst - matchlen);
      lastHashed = dst - 1;
    } else {
      // A literal run: the control word's low nibble says how many bytes follow.
      const n = Math.min(BITLUT[cword & 0xf]!, decompressed - dst);
      for (let i = 0; i < n; i += 1) out[dst + i] = stream[src + i]!;
      src += n;
      dst += n;
      cword >>>= n;
      updateUpto(dst - 3);
    }
  }
  return out;
}
