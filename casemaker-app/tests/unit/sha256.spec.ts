// #731 — the hash every picked file is recorded by.
//
// `crypto.subtle` is a secure-context API; the LAN rig is plain http, so the browser hides it and
// every .stl/.3mf/PNG pick failed with "could not be hashed". `meshStock.sha256Hex` now uses the
// browser's digest when there is one and the pure-TS implementation the run record always had when
// there is not. These tests hold the implementation to FIPS 180-4's vectors, to Node's own SHA-256
// on random buffers, and to the browser path with the fallback — same hex either way, or the stored
// hashes and the mesh blobs keyed by them would not survive the origin change.

import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sha256HexBytes, sha256HexText } from '@/engine/import/sha256';
import { sha256Hex } from '@/engine/import/meshStock';

function nodeHex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('#731 — SHA-256 in plain TypeScript', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(sha256HexText('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexText('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexText('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    // The 1 MB vector: a million 'a's, across 15 625 blocks.
    expect(sha256HexBytes(new Uint8Array(1_000_000).fill(0x61))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('equals Node’s SHA-256 on random buffers, including the padding edges', () => {
    const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 65_537];
    for (const size of sizes) {
      const bytes = new Uint8Array(randomBytes(size));
      expect(sha256HexBytes(bytes), `size ${size}`).toBe(nodeHex(bytes));
    }
  });

  it('hashes UTF-8 text as its bytes, not as code units', () => {
    const text = 'Zoomba ⌀ 3.175 mm · PLA';
    expect(sha256HexText(text)).toBe(nodeHex(new TextEncoder().encode(text)));
  });
});

describe('#731 — the file hash survives a page with no crypto.subtle', () => {
  it('uses the browser digest when the page is a secure context, and it equals the fallback', async () => {
    expect(typeof crypto.subtle).not.toBe('undefined');
    const bytes = new Uint8Array(randomBytes(4096));
    const viaSubtle = await sha256Hex(bytes.buffer);
    expect(viaSubtle).toBe(sha256HexBytes(bytes));
    expect(viaSubtle).toBe(nodeHex(bytes));
  });

  it('falls back to the pure implementation when crypto.subtle is absent (plain http on a LAN)', async () => {
    // What the browser exposes on an insecure origin: a `crypto` object with no `subtle` member.
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a });
    expect(crypto.subtle).toBeUndefined();
    const bytes = new Uint8Array(randomBytes(10_000));
    expect(await sha256Hex(bytes.buffer)).toBe(nodeHex(bytes));
    expect(await sha256Hex(new ArrayBuffer(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
