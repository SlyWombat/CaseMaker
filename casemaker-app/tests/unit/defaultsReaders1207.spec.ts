/**
 * #1207 review (analyst, 2026-11-13) — A REGISTERED KEY CANNOT EXIST WITHOUT A READER.
 *
 * A key in the shop-defaults registry is a promise: a plan, a check or a record reads it, and a
 * shop that changes it sees the change. A key nothing reads is worse than a literal — its page row
 * is editable and changes nothing. This guard holds the registry to product code:
 *
 *  - a registered key must appear as a quoted string that is NOT a registry declaration, somewhere
 *    under `src/`, `scripts/` or `src-tauri/src/`; comments use backticks and do not count;
 *  - the keys on {@link UNREAD_DEFAULT_KEYS} are the landed exception: registered, not yet read,
 *    each owned by #1256. The list may ONLY SHRINK — a new key without a reader fails, and a listed
 *    key that gains a reader fails until its line is removed.
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
import { UNREAD_DEFAULT_KEYS } from '@/platform/unreadDefaults';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Every place product code can read a key: the app, the CLI scripts, the desktop service. */
const ROOTS = ['src', 'scripts', join('src-tauri', 'src')];
/** Files that DECLARE keys rather than read them (the planner list is a list, not a reader). */
const DECLARATIONS = new Set([
  'src-tauri/src/defaults.rs',
  'src/platform/plannerDefaults.ts',
  // The unread list NAMES keys; it is not a reader.
  'src/platform/unreadDefaults.ts',
]);
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

/** A quoted key literal that is not a registry declaration (`'key': {`). */
function hasReader(key: string, texts: readonly string[]): boolean {
  for (const text of texts) {
    for (const quoted of [`'${key}'`, `"${key}"`]) {
      let at = text.indexOf(quoted);
      while (at >= 0) {
        const after = text.slice(at + quoted.length, at + quoted.length + 2).trimStart();
        if (!after.startsWith(':')) return true;
        at = text.indexOf(quoted, at + 1);
      }
    }
  }
  return false;
}

describe('#1207 — every registered default has a reader', () => {
  const texts = productTexts();
  const registered = new Set([
    ...Object.keys(KNOWN_DEFAULTS),
    ...Object.keys(KNOWN_FLAGS),
    ...Object.keys(MEASURED_ONLY),
  ]);
  const read = (key: string): boolean => {
    const computed = COMPUTED.find(
      (family) => key.startsWith(family.prefix) && texts.some((t) => t.includes(family.construction)),
    );
    return computed !== undefined || hasReader(key, texts);
  };

  it('no key is registered without product code that reads it, beyond the named unread list', () => {
    const unread = new Set(UNREAD_DEFAULT_KEYS);
    const missing = [...registered].filter((key) => !unread.has(key) && !read(key)).sort();
    expect(
      missing,
      'a registered key no product code reads changes nothing — wire its reader or name it on the unread list (and open its follow-up):\n' +
        missing.join('\n'),
    ).toEqual([]);
  });

  it('the unread list only shrinks: every name is registered and still unread', () => {
    const notRegistered = UNREAD_DEFAULT_KEYS.filter((key) => !registered.has(key));
    expect(
      notRegistered,
      'UNREAD_DEFAULT_KEYS names a key the registry does not hold — remove the line:',
    ).toEqual([]);
    const nowRead = UNREAD_DEFAULT_KEYS.filter((key) => read(key));
    expect(
      nowRead,
      'these keys now have readers — remove them from UNREAD_DEFAULT_KEYS (the list may only shrink):',
    ).toEqual([]);
  });
});
