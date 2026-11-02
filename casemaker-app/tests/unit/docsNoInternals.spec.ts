/**
 * #880 — THE END-USER DOCUMENTS SPEAK TO THEIR READER.
 *
 * A person reading the CNC Guide in the app owns a machine, not a checkout: an issue number, a
 * repo path or a design-doc reference is noise to them — or worse, a link they cannot follow. The
 * rule (maintainer, 2026-11-01): end-user docs carry no issue numbers, no repo paths and no
 * internal documents. Facts, numbers and reasons stay; their provenance as tracker entries does
 * not.
 *
 * This test is the gate that keeps it that way: a hand-in that pastes "(`/Fabrication.md` §7.5)"
 * or "(#535)" into a manual fails here, in the suite every hand-in runs.
 *
 * TWO THINGS ARE OUT OF SCOPE HERE:
 *  - image references — the image lint owns them (a figure must be bundled, never remote);
 *  - the FOR DEVELOPERS page, which may name repo paths (a builder needs them) but still carries
 *    no issue numbers. The developer-internal documents (Technical Reference, Contributing) are
 *    not held to either rule yet.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The end-user documents this lint holds: the Guide, the User Manual and Getting Started.
 */
const END_USER = [
  'casemaker-app/src/docs/cnc-guide.md',
  'casemaker-app/src/docs/user-manual.md',
  'casemaker-app/src/docs/getting-started.md',
];

/**
 * The For Developers page: a builder may meet repo paths (and needs them to clone and build), but
 * an issue number is still tracker provenance, not a fact. Only the issue rule applies here.
 */
const DEVELOPERS_PAGE = 'casemaker-app/src/docs/developers.md';

/** A `.md` a reader may meet: a link from one in-app document to another. */
const IN_APP_DOC = /(user-manual|getting-started|technical-reference|developers|CHANGELOG|CONTRIBUTING|cnc-guide)\.md$/;

/**
 * The same link, spelled as the full GitHub address the app renders. The URL happens to contain
 * `docs/`, but it is a link a reader can follow — not a path pointing into a checkout.
 */
const IN_APP_DOC_URL =
  /https?:\/\/github\.com\/[^)\s]+\/(?:docs|casemaker-app\/src\/docs)\/(?:user-manual|getting-started|technical-reference|developers|CHANGELOG|CONTRIBUTING|cnc-guide)\.md/g;

function docText(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** Image references belong to the image lint; strip them before looking for paths. */
function withoutImages(text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
}

/** Links between in-app documents are followable; a bare `docs/` path is not. */
function withoutInAppDocLinks(text: string): string {
  return text.replace(IN_APP_DOC_URL, '[in-app document]');
}

function offendingLines(text: string, re: RegExp): string[] {
  return text
    .split('\n')
    .flatMap((line, i) => (re.test(line) ? [`${i + 1}: ${line.trim()}`] : []));
}

/** Every `.md` reference that is not one of the in-app documents. */
function strayDocLinks(text: string): string[] {
  return text.split('\n').flatMap((line, i) => {
    const refs = [...line.matchAll(/[\w./-]+\.md\b/g)].map((m) => m[0]);
    const stray = refs.filter((ref) => !IN_APP_DOC.test(ref));
    return stray.length === 0 ? [] : [`${i + 1}: ${stray.join(', ')}`];
  });
}

describe('#880 the end-user documents carry no tracker entries and no repo paths', () => {
  for (const doc of END_USER) {
    it(`${doc}: no issue numbers`, () => {
      expect(
        offendingLines(docText(doc), /#\d{2,4}\b/),
        'issue numbers are provenance for developers, not a fact for the operator — say the fact in words',
      ).toEqual([]);
    });

    it(`${doc}: no repo paths or internal documents`, () => {
      const text = withoutInAppDocLinks(withoutImages(docText(doc)));
      expect(
        offendingLines(text, /\b(?:docs|src)\//),
        'repo paths do not exist for an installed app; describe the thing instead',
      ).toEqual([]);
      expect(
        strayDocLinks(text),
        'the only .md a reader may meet is a link between in-app documents',
      ).toEqual([]);
    });

    it(`${doc}: diagrams are drawn, not typed`, () => {
      const text = docText(doc);
      const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
      const art = fenced.filter((block) => /[┌┐└┘─│├┤┬┴┼▶═║╔╗╚╝╠╣]/.test(block) || /\+-{2,}/.test(block));
      expect(art, 'a box drawn in characters is a figure the app should draw (src/docs/img/)').toEqual([]);
    });
  }

  it(`${DEVELOPERS_PAGE}: a builder document may keep paths, never issue numbers`, () => {
    expect(
      offendingLines(docText(DEVELOPERS_PAGE), /#\d{2,4}\b/),
      'the For Developers page may name repo paths, but an issue number is tracker provenance',
    ).toEqual([]);
  });
});
