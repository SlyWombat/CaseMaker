// #1109 rule 3 — ONE COMPONENT SET, ACROSS THE WHOLE WIZARD. Every action button in every welcome
// component wears `sw-btn`; a fold toggle is not an action and says `data-fold` (and wears
// `sw-fold`). A new raw button without either fails here, so the next control added to a step cannot
// quietly keep its own styling.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '../../src/components/welcome');

const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.tsx'))
  .sort();

describe('#1109 the wizard’s component set', () => {
  for (const file of FILES) {
    it(`${file}: every action button wears sw-btn; a fold says data-fold`, () => {
      const source = readFileSync(join(DIR, file), 'utf8');
      const buttons = source.match(/<button\b[\s\S]*?>/g) ?? [];
      for (const tag of buttons) {
        if (/data-fold="true"/.test(tag)) {
          expect(tag, `a fold without sw-fold:\n${tag}`).toContain('sw-fold');
          continue;
        }
        expect(tag, `raw <button> without sw-btn in ${file}:\n${tag}`).toMatch(/className=[\s{"`]*sw-btn/);
      }
    });
  }
});
