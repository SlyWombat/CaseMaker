/**
 * #1215 — THE FIELDS MODULE STAYS SELF-CONTAINED.
 *
 * `src/engine/cnc/cam/fields/` is a decision aid with no dependencies on the app, the workers, the
 * post, the verifier or the planner's own modules: it may import only `../pocket`, `../profile`,
 * `../model/ops/pocket`, `../model/dropcutter` and its own files. A source gate, like
 * `gateImports.spec.ts`, so a later slice cannot quietly wire it into the pipeline.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIELDS = join(HERE, '..', '..', 'src', 'engine', 'cnc', 'cam', 'fields');

const FORBIDDEN = ['workers/', 'platform/', 'store/', 'components/', 'engrave/', '/post', 'gcode', 'emulator'];

describe('#1215 — the fields module', () => {
  it('stays self-contained', () => {
    const files = readdirSync(FIELDS).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const name of files) {
      const text = readFileSync(join(FIELDS, name), 'utf8');
      for (const line of text.split('\n')) {
        const isImport = line.startsWith('import ') || line.includes(' from ');
        if (!isImport) continue;
        for (const forbidden of FORBIDDEN) {
          expect(line, `${name} imports ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
  });
});
