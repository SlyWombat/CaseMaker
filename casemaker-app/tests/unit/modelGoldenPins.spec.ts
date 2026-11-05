/**
 * #964 — THE POPULATED GOLDEN PINS, REGENERATED AND COMPARED (#965).
 *
 * Three seeded synthetic parts (two rectilinear, one filleted) planned through `planPocketsForTree`
 * (plan.ts), posted with the Z1 post. Each pin under `fixtures/golden/model/<id>/` carries the
 * posted text's hash and size MINUS its `;@MKR|TIME` line (the clock moves when the estimate
 * moves; the program must not), the plan in B's `ModelPlanOutput` shape, #927's terms and the
 * program facts, the seven-line card, and a parse-level verifier record.
 *
 * Regeneration is a deliberate act, exactly as the badge pins:
 *
 *   CASEMAKER_UPDATE_GOLDEN=1 npx vitest run tests/unit/modelGoldenPins.spec.ts
 *
 * Bytes that move without a landing note naming the artefact are the defect this spec catches.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildRandomPart, type PartKind } from '../tools/randomParts';
import { planPocketsForTree } from '@/engine/cnc/cam/model/plan';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { TOOL_CHANGE_SECONDS } from '@/engine/cnc/engrave/smartPick';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { parseGcode } from '@/engine/cnc';
import { measurePostedProgram, combinePostedFacts } from '../tools/postedFacts';
import { scoreSevenLines } from '../tools/sevenLines';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'fixtures', 'golden', 'model');
const UPDATE = process.env.CASEMAKER_UPDATE_GOLDEN === '1';

const HOUSE: Tool[] = [
  flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' }),
  flatEndMill(3.175, { number: 2, id: 'flat-3.175', name: 'flat-3.175' }),
  flatEndMill(2, { number: 3, id: 'flat-2', name: 'flat-2' }),
];

const CASES: { id: string; kind: PartKind; seed: number; note: string }[] = [
  { id: 'synth-rect-a', kind: 'rectilinear', seed: 1, note: 'rectilinear plate, seed 1' },
  { id: 'synth-rect-b', kind: 'rectilinear', seed: 3, note: 'rectilinear plate, seed 3' },
  { id: 'synth-fillet-a', kind: 'filleted', seed: 2, note: 'filleted pockets, seed 2' },
];

/** The pin's bytes: the posted text with its TIME record removed (the program, not the clock). */
const withoutTime = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => !/^;@MKR\|TIME\|/.test(line))
    .join('\n');

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('#964 golden pins for the rebuilt engine’s synthetic programs (#965)', () => {
  for (const c of CASES) {
    it(`${c.id}: the posted program is the pinned program`, () => {
      const part = buildRandomPart(c.seed, c.kind, tl);
      const result = planPocketsForTree(part.tree, {
        offset: makeClipperOffset(tl),
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
      const hash = sha(pinned);
      const bytes = Buffer.byteLength(pinned, 'utf8');
      const facts = combinePostedFacts(texts.map((text) => measurePostedProgram(text)));
      const plan = {
        perSetup: [
          {
            setupIndex: 0,
            features: part.tree,
            clGrid: [],
            ops: result.ops,
            sequence: result.sequence,
            linking: { rapidsCount: facts.rapidMoves, hopsCount: 0, airFractionPct: facts.airFraction * 100 },
            programs: result.programs.map((p) => p.ir),
            totalCostSeconds: facts.cycleSeconds,
          },
        ],
      };
      const estimate = {
        cycleSeconds: facts.cycleSeconds,
        rapidsPer1000FeedLines: facts.rapidsPer1000FeedLines,
        cutters: facts.cutters.length,
      };
      const card = scoreSevenLines({
        card: c.id,
        ours: {
          label: c.id,
          coverage: null,
          cutInto: {
            adjudicatedFraction: null,
            edgeBreakFraction: null,
            wallNotScoredFraction: null,
            shadowNotScoredFraction: null,
            rawFraction: null,
            maxMm: 0,
          },
          cycleSeconds: facts.cycleSeconds,
          toolChanges: Math.max(0, texts.length - 1),
          headerTimeSeconds: null,
          airFraction: facts.airFraction,
          rapidSeconds: facts.rapidSeconds,
          rapidMoves: facts.rapidMoves,
          rapidsPer1000FeedLines: facts.rapidsPer1000FeedLines,
          cutters: facts.cutters.length,
          cuttersOwned: true,
          postsAsFiled: { ok: true, holding: 'tape', pitchMm: 0.1 },
        },
        vendor: null,
      });
      const verifier = {
        ok: parseGcode(texts.join('\n')).diagnostics.every((d) => d.severity !== 'error'),
        note: 'synthetic pin: parse-level check of the posted text (the machine verifier needs a job; none exists for a generated part)',
        programs: texts.length,
      };

      const dir = join(GOLDEN, c.id);
      if (UPDATE) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'program.nc.sha256'), `sha256 ${hash} (${bytes} bytes)\n`);
        writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(plan)}\n`);
        writeFileSync(join(dir, 'estimate.json'), `${JSON.stringify(estimate, null, 1)}\n`);
        writeFileSync(join(dir, 'card.json'), `${JSON.stringify(card, null, 1)}\n`);
        writeFileSync(join(dir, 'verifier.json'), `${JSON.stringify(verifier, null, 1)}\n`);
        const manifestPath = join(GOLDEN, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          version: number;
          note: string;
          cases: { id: string; job: string; meshSha256: string; setupIndex?: number; note?: string }[];
        };
        const entry = { id: c.id, job: `synthetic:${c.kind} seed ${c.seed}`, meshSha256: part.target.sha256, setupIndex: 0, note: c.note };
        const at = manifest.cases.findIndex((x) => x.id === c.id);
        if (at === -1) manifest.cases.push(entry);
        else manifest.cases[at] = entry;
        manifest.note = 'Golden pins for the rebuilt engine’s programs (#957-#966): three seeded synthetic parts planned through planPocketsForTree, posted, hashed WITHOUT their ;@MKR|TIME line. Regenerate with CASEMAKER_UPDATE_GOLDEN=1 and a landing note naming the artefact.';
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
        return;
      }
      expect(existsSync(dir), `${c.id}: no pin; run CASEMAKER_UPDATE_GOLDEN=1`).toBe(true);
      const pin = readFileSync(join(dir, 'program.nc.sha256'), 'utf8').trim();
      expect(pin, `${c.id}: the posted program moved`).toBe(`sha256 ${hash} (${bytes} bytes)`);
      const pinnedEstimate = JSON.parse(readFileSync(join(dir, 'estimate.json'), 'utf8')) as typeof estimate;
      expect(pinnedEstimate.cutters).toBe(estimate.cutters);
      expect(pinnedEstimate.cycleSeconds).toBeCloseTo(estimate.cycleSeconds, 6);
      const pinnedCard = JSON.parse(readFileSync(join(dir, 'card.json'), 'utf8')) as { lines: unknown[] };
      expect(pinnedCard.lines).toHaveLength(7);
      const pinnedPlan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as { perSetup: unknown[] };
      expect(pinnedPlan.perSetup).toHaveLength(1);
    }, 120_000);
  }
});
