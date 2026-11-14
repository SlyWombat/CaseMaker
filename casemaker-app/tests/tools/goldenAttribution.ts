/**
 * #1011 — THE GOLDEN PINS' ATTRIBUTION RUNNER (reusable; committed).
 *
 * Regenerates the three seeded synthetic programs `modelGoldenPins.spec.ts` pins — the posted text
 * with its `;@MKR|TIME` line removed, exactly the pin's bytes — and WRITES them to a directory,
 * without touching the fixtures. The point is the full-text diff between two checkouts' outputs:
 * every hunk of it is attributed to the commit range between them, so a re-pin can name which
 * merge moved which bytes and why (the T1-lite rule).
 *
 * RUN IT through the env-gated spec beside the pins, which is collected but skipped unless the
 * output directory is named:
 *
 *   CM_GOLDEN_OUT=/tmp/golden npx vitest run tests/unit/goldenAttribution.spec.ts
 *
 * Under vitest rather than plain Node because an older checkout's `ManifoldRuntime` has a
 * top-level `import … 'manifold-3d/manifold.wasm?url'`, which plain Node cannot resolve and vite
 * can. To attribute an OLD commit, copy this file and the spec into that checkout's working tree
 * as untracked files first (the tool postdates the commits it is used on), then run the same line.
 *
 * The generation below is the spec's own code, unchanged (same parts, same calls, same bytes), so
 * a tool bug cannot masquerade as a program change; it takes the caller's Manifold toplevel, the
 * convention `tests/tools` follows.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildRandomPart, type PartKind } from './randomParts';
import { planPocketsForTree } from '@/engine/cnc/cam/model/plan';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { TOOL_CHANGE_SECONDS } from '@/engine/cnc/engrave/smartPick';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { DEFAULT_RELEASE_TABS } from '@/engine/cnc/cam/model/plan';

const HOUSE: Tool[] = [
  flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' }),
  flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' }),
  flatEndMill(2, { number: 3, id: 'flat-2', name: 'flat-2' }),
];

/** The spec's own three cases, in its order. */
export const GOLDEN_ATTRIBUTION_CASES: readonly { id: string; kind: PartKind; seed: number }[] = [
  { id: 'synth-rect-a', kind: 'rectilinear', seed: 1 },
  { id: 'synth-rect-b', kind: 'rectilinear', seed: 3 },
  { id: 'synth-fillet-a', kind: 'filleted', seed: 2 },
];

/** The pin's bytes: the posted text with its TIME record removed (the program, not the clock). */
const withoutTime = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => !/^;@MKR\|TIME\|/.test(line))
    .join('\n');

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** One case's fact: the id, the pin's sha256 and its byte count. */
export interface GoldenAttributionFact {
  id: string;
  sha256: string;
  bytes: number;
}

/**
 * Regenerate every case's pinned text into `outDir` (`<id>.txt`, one trailing newline added so
 * the file is a text file — the hash is of the text WITHOUT it, exactly the pin). Returns each
 * case's pin fact so a caller can print or compare it.
 */
export function regenerateGoldenPins(tl: ManifoldToplevel, outDir: string): GoldenAttributionFact[] {
  mkdirSync(outDir, { recursive: true });
  const facts: GoldenAttributionFact[] = [];
  for (const c of GOLDEN_ATTRIBUTION_CASES) {
    const part = buildRandomPart(c.seed, c.kind, tl);
    const result = planPocketsForTree(part.tree, {
      tabs: DEFAULT_RELEASE_TABS, offset: makeClipperOffset(tl),
      houseFlats: HOUSE,
      stepDownMm: 1.5,
      feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
      rapid: Z1.rapidEstimate,
      toolChangeSeconds: TOOL_CHANGE_SECONDS,
      spindleRpm: 12000,
      air: true,
      maxCutters: HOUSE.length + 1,
      boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
    });
    const ctx: PostContext = {
      jobName: c.id,
      stock: { ...part.stock },
      materialName: 'hardwood',
      zDatum: 'probed-top-face',
      origin: 'topFrontLeft',
      camVersion: 'test-965',
      toolKey: 'multi',
    };
    const texts = result.programs.map((run) => {
      const posted = postZ1(run.ir, ctx, Z1);
      if (!posted.ok) throw new Error(`${c.id}: postZ1 refused — ${posted.errors.join('; ')}`);
      return posted.text;
    });
    const pinned = texts.map(withoutTime).join('\n--- program ---\n');
    writeFileSync(join(outDir, `${c.id}.txt`), `${pinned}\n`);
    facts.push({ id: c.id, sha256: sha(pinned), bytes: Buffer.byteLength(pinned, 'utf8') });
  }
  return facts;
}
