// The headless refusal for raster import (#483). A Node run has neither `createImageBitmap` nor
// `document`, so tracing a bitmap cannot work here. It must say so by name —
// `headless-unsupported: raster-import` — with the route that asked, rather than throw
// `document is not defined` from inside a browser API.
//
// The second half of the spec walks the real `tsconfig.scripts.json` program: the browser-only
// export trigger is excluded by NOT being on any headless entry's import path, and this proves
// that stays true (a future script import would fail here, not at runtime).

import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

import {
  decodeImageFile,
  importRasterFromDisk,
  HeadlessUnsupportedError,
  HEADLESS_UNSUPPORTED,
  RASTER_IMPORT,
  headlessUnsupportedMessage,
} from '@/engine/import/imageDecode';

/** A few PNG magic bytes: enough for a decoder call that must be refused before it reads them. */
function bitmapBlob(): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
}

describe('headless raster import (#483)', () => {
  it('decodeImageFile refuses by name and carries the route', async () => {
    const caught = await decodeImageFile(bitmapBlob(), '--from-raster').catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(HeadlessUnsupportedError);
    const refusal = caught as HeadlessUnsupportedError;
    expect(refusal.code).toBe(HEADLESS_UNSUPPORTED);
    expect(refusal.feature).toBe(RASTER_IMPORT);
    expect(refusal.route).toBe('--from-raster');
    expect(refusal.message).toBe(headlessUnsupportedMessage('--from-raster'));
    expect(refusal.message).toContain('headless-unsupported: raster-import');
    expect(refusal.message).not.toContain('document is not defined');
  });

  it('decodeImageFile names itself when the caller supplies no route', async () => {
    const caught = await decodeImageFile(bitmapBlob()).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(HeadlessUnsupportedError);
    expect((caught as HeadlessUnsupportedError).route).toBe('decodeImageFile');
  });

  it('importRasterFromDisk returns the refusal before it reaches the file picker', async () => {
    const result = await importRasterFromDisk();

    expect(result).toEqual({
      ok: false,
      error: 'headless-unsupported: raster-import (route: importRasterFromDisk)',
      code: HEADLESS_UNSUPPORTED,
      route: 'importRasterFromDisk',
    });
  });

  it('the headless compile excludes the browser-only export trigger', () => {
    const appRoot = fileURLToPath(new URL('../../', import.meta.url));
    const configPath = join(appRoot, 'tsconfig.scripts.json');
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    expect(read.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
    const program = ts.createProgram(parsed.fileNames, parsed.options);

    // TypeScript's own file names may use either separator; compare on forward slashes.
    const files = program.getSourceFiles().map((f) => f.fileName.split('\\').join('/'));
    expect(files.some((f) => f.endsWith('/scripts/engrave-job.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('/src/engine/exportTrigger.ts'))).toBe(false);
  });
});
