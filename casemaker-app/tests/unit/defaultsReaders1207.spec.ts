/**
 * #1207 review (analyst, 2026-11-13) — A REGISTERED KEY CANNOT EXIST WITHOUT A READER.
 *
 * A key in the shop-defaults registry is a promise: a plan, a check or a record reads it, and a
 * shop that changes it sees the change. A key nothing reads is worse than a literal — it appears
 * on Manage › Advanced › All values, it is editable, and it changes nothing. This guard holds the
 * registry to product code: every registered key must appear as a quoted string that is NOT a
 * registry declaration, somewhere under `src/`, `scripts/` or `src-tauri/src/` (the two files that
 * DECLARE keys are excluded; comments use backticks and do not count).
 *
 * One family is read through a computed key and is allowed by its construction site: the wear
 * weights are `tools.wearWeight.${wearClassFor(material, fibre)}` in `runEnd.ts`, passed to the
 * store's `wearWeight` callback, which reads the map. The guard checks that construction exists.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { KNOWN_DEFAULTS, KNOWN_FLAGS, MEASURED_ONLY } from '@/platform/defaultsClient';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Every place product code can read a key: the app, the CLI scripts, the desktop service. */
const ROOTS = ['src', 'scripts', join('src-tauri', 'src')];
/** Files that DECLARE keys rather than read them (the planner list is a list, not a reader). */
const DECLARATIONS = new Set(['src-tauri/src/defaults.rs', 'src/platform/plannerDefaults.ts']);
/** Keys read through a computed name, with the construction that makes them readable. */
const COMPUTED = [{ prefix: 'tools.wearWeight.', construction: 'tools.wearWeight.${' }];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|rs|mts)$/.test(entry)) out.push(path);
  }
  return out;
}

function productTexts(): string[] {
  const texts: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(APP, root))) {
      if (DECLARATIONS.has(relative(APP, file).split('\\').join('/'))) continue;
      texts.push(readFileSync(file, 'utf8'));
    }
  }
  return texts;
}

describe('#1207 — every registered default has a reader', () => {
  it('no key is registered without product code that reads it', () => {
    const texts = productTexts();
    const keys = [
      ...Object.keys(KNOWN_DEFAULTS),
      ...Object.keys(KNOWN_FLAGS),
      ...Object.keys(MEASURED_ONLY),
    ];
    const missing: string[] = [];
    for (const key of keys) {
      const computed = COMPUTED.find(
        (family) => key.startsWith(family.prefix) && texts.some((t) => t.includes(family.construction)),
      );
      if (computed !== undefined) continue;
      let read = false;
      for (const text of texts) {
        for (const quoted of [`'${key}'`, `"${key}"`]) {
          let at = text.indexOf(quoted);
          while (at >= 0) {
            const after = text.slice(at + quoted.length, at + quoted.length + 2).trimStart();
            // A registry declaration is `'key': {`; a read is a literal passed to a reader.
            if (!after.startsWith(':')) {
              read = true;
              break;
            }
            at = text.indexOf(quoted, at + 1);
          }
          if (read) break;
        }
        if (read) break;
      }
      if (!read) missing.push(key);
    }
    expect(
      missing,
      'a registered key no product code reads changes nothing — wire its reader or withdraw the key:\n' +
        missing.join('\n'),
    ).toEqual([]);
  });
});
