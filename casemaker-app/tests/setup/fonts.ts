/**
 * Vitest font seam (issue #180).
 *
 * The bundled faces are static assets the browser `fetch`es on first use, but vitest specs call
 * `resolveFont` synchronously with no fetch seam. Read the TTFs straight off disk and seed the
 * registry's parsed-font cache, exactly the way `registerBundledFontBytes` documents — this is
 * wired in as a vitest `setupFile`, so every spec that typesets a label starts with all six faces
 * loaded (regular + bold), and `resolveFont` never throws its "not loaded" guard in tests.
 *
 * Resolved from `process.cwd()` (the vitest root, `casemaker-app/`) rather than `import.meta.url`:
 * component specs run under a jsdom environment where `import.meta.url` is an `http:` URL and
 * `fileURLToPath` rejects it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BUNDLED_FONT_KEYS, registerBundledFontBytes } from '../../src/engine/fonts/registry';

const filesDir = path.resolve(process.cwd(), 'src/engine/fonts/files');

for (const key of BUNDLED_FONT_KEYS) {
  const buf = readFileSync(path.join(filesDir, `${key}.ttf`));
  // `fs` hands back a Buffer sharing a pooled ArrayBuffer; slice out just this file's bytes.
  registerBundledFontBytes(key, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
