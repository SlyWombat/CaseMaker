// Six documents exist in two places, and the copies had drifted badly enough
// to ship wrong instructions: the CONTRIBUTING inside the app was four months
// old and told contributors to register boards in a file that no longer has an
// import list, and the in-app CHANGELOG still listed April's issues under
// "Unreleased".
//
// This guards the copies AND the direction. "These two files must match" would
// leave the next person a coin flip about which side to overwrite — which is
// exactly how the stale copies won last time — so the pair table names the
// canonical side and the failure message names the fix.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOC_IMAGE_DIRS, DOC_PAIRS, canonicalText } from '../../scripts/sync-docs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('documentation mirrors', () => {
  it.each(DOC_PAIRS)('$mirror matches $canonical', ({ canonical, mirror }) => {
    const want = canonicalText(join(ROOT, canonical));
    const got = canonicalText(join(ROOT, mirror));
    expect(
      got,
      `${mirror} is out of date — run \`npm run docs:sync\` (canonical: ${canonical})`,
    ).toBe(want);
  });

  it('names a canonical side for every document the app serves', () => {
    // Whatever `src/docs/index.ts` imports is what the 📖 Docs viewer shows, so
    // every one of those must be in the pair table on one side or the other.
    // Otherwise a document can go stale in the app with nothing to catch it.
    const index = readFileSync(join(ROOT, 'casemaker-app/src/docs/index.ts'), 'utf8');
    const served = [...index.matchAll(/from '\.\/([\w.-]+\.md)\?raw'/g)].map((m) => m[1]!);
    expect(served.length, 'index.ts should import seven docs').toBe(7);
    for (const name of served) {
      const path = `casemaker-app/src/docs/${name}`;
      const listed = DOC_PAIRS.some((p) => p.canonical === path || p.mirror === path);
      expect(listed, `${name} is served by the app but has no entry in DOC_PAIRS`).toBe(true);
    }
  });

  it('keeps cross-document links absolute, so they work from both copies', () => {
    // A relative link cannot be correct in both locations at once. The ones
    // that used to be here were written for `docs/` and resolved to paths that
    // do not exist from `src/docs/` — `../CHANGELOG.md` became
    // `casemaker-app/src/CHANGELOG.md`, and the in-app viewer renders plain
    // anchors, so it was a 404 rather than a fallback.
    //
    // #880 — A FIGURE IS THE ONE RELATIVE REFERENCE THAT IS RIGHT IN BOTH: `img/<file>` is a file
    // in the document's own folder (bundled by the app, mirrored for the repo), so it resolves
    // beside each copy. It is checked to exist rather than banned.
    for (const { canonical } of DOC_PAIRS) {
      const text = canonicalText(join(ROOT, canonical));
      const hrefs = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!);
      for (const href of hrefs.filter((h) => h.startsWith('img/'))) {
        const file = href.slice('img/'.length);
        expect(
          existsSync(join(ROOT, 'casemaker-app/src/docs/img', file)),
          `${canonical} refers to ${href}, which is not a bundled figure`,
        ).toBe(true);
      }
      const relative = hrefs.filter((href) => !/^(https?:|#|mailto:|img\/)/.test(href));
      expect(relative, `${canonical} has links that only resolve from one copy`).toEqual([]);
    }
  });

  it('mirrors every figure byte for byte (#880)', () => {
    for (const dir of DOC_IMAGE_DIRS) {
      const files = readdirSync(join(ROOT, dir.canonical)).filter((f) => /\.(png|webp|svg)$/i.test(f));
      expect(files.length, `${dir.canonical} should carry the guide's figures`).toBeGreaterThan(0);
      for (const file of files) {
        const canonical = readFileSync(join(ROOT, dir.canonical, file));
        const mirrorPath = join(ROOT, dir.mirror, file);
        expect(existsSync(mirrorPath), `${dir.mirror}/${file} is missing — run \`npm run docs:sync\``).toBe(true);
        expect(
          readFileSync(mirrorPath).equals(canonical),
          `${dir.mirror}/${file} is out of date — run \`npm run docs:sync\``,
        ).toBe(true);
      }
    }
  });
});
