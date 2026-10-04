// Types for `sync-docs.mjs`, which `tests/unit/docsMirror.spec.ts` imports directly.
//
// The script is plain ESM JavaScript, so without this its import has no declaration and `tsc`
// reports three errors in that spec: an implicit `any`, a callback whose parameter is inferred
// from that `any`, and a `p` with no type. Written from the script's own exports (#193), not
// guessed — `DOC_PAIRS` is the canonical→mirror table and `canonicalText` reads one side with
// its line endings normalised to LF.

/** canonical → mirror: the left side is the one you edit (`npm run docs:sync` writes the right). */
export interface DocPair {
  canonical: string;
  mirror: string;
}

export const DOC_PAIRS: DocPair[];

/** Read a markdown file as UTF-8 with CRLF collapsed to LF, so the two copies compare equal. */
export function canonicalText(absPath: string): string;
