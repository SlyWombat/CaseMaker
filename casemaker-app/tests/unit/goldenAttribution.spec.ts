/**
 * #1011 — THE GOLDEN PINS' ATTRIBUTION RUNNER'S ENTRY. Collected, but SKIPPED unless the output
 * directory is named, so the normal suite pays nothing for it:
 *
 *   CM_GOLDEN_OUT=/tmp/golden npx vitest run tests/unit/goldenAttribution.spec.ts
 *
 * It writes the three synthetic programs `modelGoldenPins.spec.ts` pins (`<id>.txt` each, the
 * pin's bytes without the TIME line) and prints each pin's sha256/bytes. The diff between two
 * checkouts' outputs is the attributed diff a re-pin is proven by; the runner's own doc
 * (`tests/tools/goldenAttribution.ts`) carries the old-checkout workflow. It runs under vitest
 * because an older checkout's ManifoldRuntime has a top-level `manifold.wasm?url` import that
 * plain Node cannot resolve.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { regenerateGoldenPins } from '../tools/goldenAttribution';

const OUT = process.env.CM_GOLDEN_OUT;

describe.skipIf(OUT === undefined)('#1011 golden attribution runner', () => {
  it('writes the three pinned texts', () => {
    const facts = regenerateGoldenPins(tl, OUT!);
    expect(facts.map((f) => f.id)).toEqual(['synth-rect-a', 'synth-rect-b', 'synth-fillet-a']);
    console.log(facts.map((f) => `${f.id} sha256 ${f.sha256} (${f.bytes} bytes)`).join('\n'));
  }, 120_000);
});
