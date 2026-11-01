/**
 * #880 — A DOCUMENT'S PICTURES SHIP WITH THE APP.
 *
 * The bug: the CNC guide hot-linked its 12 pictures to raw.githubusercontent.com. The desktop
 * shell's CSP allows images from `'self'`, `data:` and `blob:` only, so the guide showed twelve
 * broken pictures in the app and on a LAN install — which may have no internet at all.
 *
 * The rule this lint holds: every picture a served document uses is a file bundled with the app
 * (`img/<file>`, resolved by `src/docs/images.ts` via Vite). A remote image reference fails here,
 * and so does a reference to a file that is not in `src/docs/img/`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docImageUrl } from '@/docs/images';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOCS = join(ROOT, 'casemaker-app/src/docs');

/** The documents the app serves (the same list docsMirror.spec reads from the index). */
function servedDocs(): string[] {
  const index = readFileSync(join(DOCS, 'index.ts'), 'utf8');
  return [...index.matchAll(/from '\.\/([\w.-]+\.md)\?raw'/g)].map((m) => `casemaker-app/src/docs/${m[1]}`);
}

/** Every image reference in a document, in source order. */
function imageRefs(text: string): string[] {
  return [...text.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)].map((m) => m[1]!);
}

describe('#880 a served document’s pictures are bundled, never remote', () => {
  it('no served document references a remote image', () => {
    const offenders: string[] = [];
    for (const doc of servedDocs()) {
      for (const ref of imageRefs(readFileSync(join(ROOT, doc), 'utf8'))) {
        if (/^(https?:)?\/\//.test(ref)) offenders.push(`${doc}: ${ref}`);
      }
    }
    expect(
      offenders,
      'a remote image is a broken picture under the app’s CSP — put the file in src/docs/img/ and refer to it as img/<file>',
    ).toEqual([]);
  });

  it('every img/<file> reference resolves to a bundled figure', () => {
    const missing: string[] = [];
    for (const doc of servedDocs()) {
      for (const ref of imageRefs(readFileSync(join(ROOT, doc), 'utf8'))) {
        if (!ref.startsWith('img/')) continue;
        const file = ref.slice('img/'.length);
        if (!existsSync(join(DOCS, 'img', file))) missing.push(`${doc}: ${ref} (no such file)`);
        else if (docImageUrl(file) === null) missing.push(`${doc}: ${ref} (not in the bundle map)`);
      }
    }
    expect(missing, 'a figure the document names must exist in src/docs/img/ and be bundled').toEqual([]);
  });

  it('the guide’s twelve pictures are all present', () => {
    // The regression itself: the guide had 12 pictures and all 12 were remote.
    const guide = readFileSync(join(DOCS, 'cnc-guide.md'), 'utf8');
    const refs = imageRefs(guide);
    expect(refs.length).toBeGreaterThanOrEqual(12);
    expect(refs.every((ref) => ref.startsWith('img/'))).toBe(true);
    const bundled = new Set(readdirSync(join(DOCS, 'img')).filter((f) => /\.(png|webp|svg)$/i.test(f)));
    for (const ref of refs) expect(bundled.has(ref.slice('img/'.length)), ref).toBe(true);
  });
});
