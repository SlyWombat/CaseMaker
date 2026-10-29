// #753 — THE BENCH PROGRAMS FOLLOW THE FIXTURE. The two posted helicoids under
// docs/bench/2026-10-28-z1-real-jobs/jobs/ are the generator's own text, and this test fails the
// moment the fixture changes without them. Regenerate the pair with:
//
//   CM_EXPORT_SPLIT_HELIX=1 npx vitest run tests/unit/exportSplitHelix.spec.ts
//
// The bench record and the acceptance then cannot drift: one helper (`helpers/splitHelix.ts`)
// builds the IR, posts it, and this file either checks the disk against it or writes it back.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPLIT_NC, splitNcDir, splitPosted } from './helpers/splitHelix';

const pieces = [
  ['A', 0],
  ['B', 180],
] as const;

describe('#753 the bench .nc files are the fixture’s own programs', () => {
  it.each(pieces)('piece %s is the generator’s exact text', (piece, offset) => {
    const file = path.join(splitNcDir(), SPLIT_NC[piece]);
    const text = splitPosted(offset).text;
    if (process.env.CM_EXPORT_SPLIT_HELIX === '1') {
      fs.writeFileSync(file, text);
      return;
    }
    expect(fs.readFileSync(file, 'utf8'), `${SPLIT_NC[piece]} has drifted — regenerate the pair`).toBe(text);
  });
});
