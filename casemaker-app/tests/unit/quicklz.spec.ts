// #562 — the QuickLZ level-1 codec behind compressed uploads. The reference implementation is the
// contract: the header's two little-endian sizes (the compressed one INCLUDING the header), the
// control word's one-bit-per-literal, and the match token that carries a hash rather than an
// offset. The round trip is the proof the encoder emits what a decoder of that format reads.

import { describe, expect, it } from 'vitest';
import {
  quicklzCompress,
  quicklzDecompress,
  quicklzSizes,
  QLZ_LEVEL1_LONG_HEADER,
} from '@/platform/desktop/quicklz';

/** G-code-like text: many repeated short lines, which is what a real `.nc` is made of. */
function gcode(lines: number): Uint8Array {
  const out: string[] = [';@MKR|BEGIN', 'G21', 'G90'];
  for (let i = 0; i < lines; i += 1) {
    out.push(`G1 X${(i % 120).toFixed(3)} Y${((i * 3) % 80).toFixed(3)} F600`);
    out.push(`G1 Z${(-((i % 7) + 1) * 0.2).toFixed(3)}`);
    if (i % 25 === 0) out.push('M331.4');
  }
  out.push('M02', ';@MKR|END');
  return new TextEncoder().encode(out.join('\n') + '\n');
}

describe('#562 QuickLZ level 1', () => {
  it('round-trips a G-code program: the decoder reproduces every byte', () => {
    const data = gcode(800);
    expect(data.length).toBeGreaterThan(4096);
    const packed = quicklzCompress(data);
    expect(packed).not.toBeNull();
    expect(packed!.length).toBeLessThan(data.length);
    expect(quicklzDecompress(packed!)).toEqual(data);
  });

  it('round-trips runs and mixed content', () => {
    const cases = [
      new Uint8Array(9000).fill(7), // one long run (overlapping matches)
      new TextEncoder().encode('abcabcabcabc'.repeat(500)),
      Uint8Array.from({ length: 5000 }, (_, i) => (i * 37 + (i >> 3)) & 0xff),
      new TextEncoder().encode('G1 X0 Y0\n'.repeat(400)),
    ];
    for (const data of cases) {
      const packed = quicklzCompress(data);
      if (packed === null) continue; // incompressible: the caller uploads it plain
      expect(quicklzDecompress(packed)).toEqual(data);
    }
  });

  it('writes the reference long header: flags, total length (header included), original size', () => {
    const data = gcode(400);
    const packed = quicklzCompress(data)!;
    expect(packed[0]).toBe(QLZ_LEVEL1_LONG_HEADER);
    expect(packed[0]).toBe(0x47); // compressed | long header | level 1 | bit 6
    const { compressed, decompressed } = quicklzSizes(packed);
    expect(compressed).toBe(packed.length); // the stored figure INCLUDES the 9-byte header
    expect(decompressed).toBe(data.length);
  });

  it('answers null when the bytes do not pay rather than a stream that grows', () => {
    // xorshift32: high-entropy bytes with no exploitable structure.
    const random = new Uint8Array(6000);
    let x = 0x9e3779b9;
    for (let i = 0; i < random.length; i += 1) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      random[i] = x & 0xff;
    }
    expect(quicklzCompress(random)).toBeNull();
    expect(quicklzCompress(new Uint8Array(10))).toBeNull(); // below the long-header threshold
  });

  it('refuses a raw stream instead of guessing at one', () => {
    const raw = new Uint8Array([0x46, 4, 0, 0, 0, 8, 0, 0, 0, 1, 2, 3, 4]);
    expect(() => quicklzDecompress(raw)).toThrow(/raw/);
  });
});
