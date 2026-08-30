// Keep the two copies of each document identical.
//
// Five documents exist twice, and the duplication is not an accident:
//
//   - `CHANGELOG.md` and `CONTRIBUTING.md` belong at the REPO ROOT, where
//     GitHub looks for them.
//   - The three manuals belong in `casemaker-app/src/docs/`, because
//     `src/docs/index.ts` imports them with `?raw` and the in-app 📖 Docs
//     viewer serves exactly those bytes.
//
// Each one also has to be readable from the other place, so each has a mirror.
// Left alone, the mirrors drift — and they had: the version of CONTRIBUTING
// shipping inside the app was four months old and told contributors to register
// boards in a file that no longer has an import list, and the in-app CHANGELOG
// still listed April's issues as "Unreleased".
//
// The direction matters more than the copying. A test that only said "these
// must match" would leave the next person a coin flip about which side to
// overwrite, which is how the stale copies won last time. So the direction
// lives here, in one table, and `tests/unit/docsMirror.spec.ts` reads the same
// table and names the fix in its failure message.
//
//   npm run docs:sync          write the mirrors
//   npm run docs:sync -- --check   fail if any mirror is out of date

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** canonical → mirror. The canonical side is the one you edit. */
export const DOC_PAIRS = [
  // Root is canonical: GitHub convention, and these are repo-wide documents.
  { canonical: 'CHANGELOG.md', mirror: 'casemaker-app/src/docs/CHANGELOG.md' },
  { canonical: 'CONTRIBUTING.md', mirror: 'casemaker-app/src/docs/CONTRIBUTING.md' },
  // src/docs is canonical: these are what the app actually serves.
  { canonical: 'casemaker-app/src/docs/user-manual.md', mirror: 'docs/user-manual.md' },
  {
    canonical: 'casemaker-app/src/docs/technical-reference.md',
    mirror: 'docs/technical-reference.md',
  },
  { canonical: 'casemaker-app/src/docs/getting-started.md', mirror: 'docs/getting-started.md' },
];

/**
 * The mirror is a byte-for-byte copy with LF endings.
 *
 * Nothing is rewritten on the way across, which is why every cross-document
 * link in these files is an absolute GitHub URL: a relative link cannot be
 * right in both locations at once, and the ones that used to be here were
 * written for `docs/` and resolved to nothing at all from `src/docs/`.
 *
 * Normalising endings is not cosmetic either. Two of these files were CRLF and
 * their partners were LF, which made `diff` report 435 changed lines where the
 * real drift was 35 — enough noise to hide the drift completely.
 */
export function canonicalText(absPath) {
  return readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
}

export function readPair(pair) {
  const canonical = canonicalText(join(ROOT, pair.canonical));
  let mirror = null;
  try {
    mirror = canonicalText(join(ROOT, pair.mirror));
  } catch {
    mirror = null;
  }
  return { canonical, mirror, inSync: mirror === canonical };
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const pair of DOC_PAIRS) {
    const { canonical, inSync } = readPair(pair);
    if (inSync) {
      console.log(`  ok    ${pair.mirror}`);
      continue;
    }
    stale++;
    if (check) {
      console.log(`  STALE ${pair.mirror}  <- copy from ${pair.canonical}`);
    } else {
      writeFileSync(join(ROOT, pair.mirror), canonical);
      console.log(`  wrote ${pair.mirror}  <- ${pair.canonical}`);
    }
  }
  if (stale === 0) console.log('\nall mirrors up to date');
  else if (check) {
    console.log(`\n${stale} mirror(s) out of date — run: npm run docs:sync`);
    process.exit(1);
  } else console.log(`\n${stale} mirror(s) updated`);
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') main();
