// The picked-file-to-patch seam (#410 item 4). No wasm and no worker: the client is a fake, so
// what is under test is the part this module owns — the size guard, the bytes that reach the
// worker, the direction it asks for, and that every failure comes back as a SENTENCE rather than a
// throw or a silent no-op. The panel shows whatever comes back from here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  MAX_DESIGN_FILE_BYTES,
  readDesignFile,
  setDesignImportClient,
} from '@/engine/import/designImport';
import type { DesignJobPatch } from '@/engine/cnc/engrave/fromDesign';

const PATCH: DesignJobPatch = {
  name: 'Single Barrel Badge',
  stock: { length: 76.2, width: 38.1, thickness: 3.81, material: 'pla' },
  vectors: [],
  keepOut: null,
  sources: { stock: { length: 'computed', width: 'computed', thickness: 'computed', material: 'computed' } },
  notes: ['the file said so'],
};

/** What the fake client was asked, or null when it was never called. */
let asked: { bytes: ArrayBuffer; direction: string } | null = null;

function clientAnswering(patch: DesignJobPatch): void {
  asked = null;
  setDesignImportClient(async () => ({
    readDesign3mf: async (bytes, direction) => {
      asked = { bytes, direction };
      return patch;
    },
  }));
}

function clientThrowing(message: string): void {
  asked = null;
  setDesignImportClient(async () => ({
    readDesign3mf: async () => {
      throw new Error(message);
    },
  }));
}

beforeEach(() => {
  asked = null;
});

afterEach(() => {
  setDesignImportClient(null);
});

describe('readDesignFile (#410)', () => {
  it('hands the file’s own bytes to the worker, asks for the shipped quarter turn, and passes the patch back', async () => {
    clientAnswering(PATCH);
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'single.3mf');
    const result = await readDesignFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.filename).toBe('single.3mf');
    expect(result.patch).toBe(PATCH);
    // The BYTES, not a decoded string: a .3mf is a zip, and a `text()` read would hand the parser
    // mojibake. PK's own signature is what the zip reader looks for.
    expect(Array.from(new Uint8Array(asked!.bytes))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // No control for this in the panel, so the route must be asking for a stated one rather than
    // leaving it to a default that could change under the notes it writes.
    expect(asked!.direction).toBe('ccw');
  });

  it('reports the parser’s own sentence, without inventing a second one', async () => {
    // `parsePrusaThreeMf` and `readDesign` name what is wrong ("3MF: missing 3D/3dmodel.model
    // entry", a volume with no footprint). The person who picked the file is the audience, so that
    // sentence is passed through as it stands.
    clientThrowing('3MF: missing 3D/3dmodel.model entry');
    const result = await readDesignFile(new File([new Uint8Array([1])], 'not-a-project.3mf'));
    expect(result).toEqual({ ok: false, error: '3MF: missing 3D/3dmodel.model entry' });
  });

  it('refuses an oversized pick by name and by limit, WITHOUT spending the read on it', async () => {
    clientAnswering(PATCH);
    const tooBig = new File([new Uint8Array(8)], 'huge.3mf');
    // The size is stubbed rather than allocated: the guard is the subject, and a real 64 MB fixture
    // would cost the suite more than it proves.
    Object.defineProperty(tooBig, 'size', { value: MAX_DESIGN_FILE_BYTES + 1 });
    const result = await readDesignFile(tooBig);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.error).toContain('huge.3mf');
    expect(result.error).toContain('64 MB');
    expect(asked).toBeNull();
  });
});
