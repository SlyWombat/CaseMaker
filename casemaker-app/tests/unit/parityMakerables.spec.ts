/**
 * #964 — THE MAKERABLES REFERENCES SCORED BY THE SPECS.
 *
 * The demo page's reference cards (#955) are judged on Makera Studio's own programs. This spec is
 * the specs' side of that gate: it reads the SAME local files by the manifest's sha256, recomputes
 * the program facts from them, and asserts the committed numbers equal the page's numbers. When
 * the evaluation-only files are not on the machine (they are never committed), every case skips
 * with the reason.
 *
 * The last block scores Case Maker's own tray attempt against Makera's program — the #955
 * comparison — as a BASELINE: today the card reads Deviates on the lines the issue named (cut-into
 * is not adjudicated yet under E's checker; cycle, air and rapids are the 29× gap). The rebuilt
 * engine
 * (#957–#966) is what turns them green, and this is the spec that will show it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  coverageFromPage,
  cutIntoFromPage,
  measurePostedFiles,
  measureVendorCard,
  readJson,
  type PageGoalCheck,
} from '../tools/cardMeasurement';
import {
  makerablesRoot,
  mismatchedShas,
  readMakerablesManifest,
  resolveMakerablesCard,
} from '../tools/makerables';
import { scoreSevenLines, type ProgramScore } from '../tools/sevenLines';

const manifest = readMakerablesManifest();
const ROOT = makerablesRoot();
const ENV_OVERRIDE = process.env['CM_MAKERABLES'];

describe('#964 the Makerables manifest — always checked', () => {
  it('names its injection door and the licence boundary', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.injection.env).toBe('CM_MAKERABLES');
    expect(manifest.injection.note.toLowerCase()).toContain('never committed');
  });

  it('has, for every card, a licence, an NC file and a goal check', () => {
    expect(manifest.cards.length).toBeGreaterThanOrEqual(2);
    for (const card of manifest.cards) {
      expect(card.licence.length).toBeGreaterThan(0);
      expect(card.files.some((f) => f.role === 'nc')).toBe(true);
      expect(card.files.some((f) => f.role === 'goalcheck')).toBe(true);
      expect(card.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
      expect(card.vendorScore.cycleSeconds).toBeGreaterThan(0);
      expect(card.vendorScore.cutters).toBeGreaterThan(0);
      expect(card.vendorScore.coverage).toBeGreaterThan(0.95);
      // The three excluded shares are nullable (not every card is scored by the new checker yet),
      // but the advisory 0.01-floor figure and the deepest cut are always stated.
      expect(card.vendorScore.cutInto.rawFraction).not.toBeNull();
      expect(card.vendorScore.cutInto.maxMm).toBeGreaterThan(0);
    }
  });

  it('keeps the vendor files out of the repository: every path is relative to the scratch root', () => {
    for (const card of manifest.cards) {
      for (const file of card.files) {
        expect(file.path.startsWith('/')).toBe(false);
        expect(file.path.startsWith('..')).toBe(false);
        expect(file.path).not.toContain('casemaker-app/tests');
      }
    }
  });

  it('ties every Case Maker attempt to a card in this manifest', () => {
    for (const ours of manifest.ours) {
      expect(manifest.cards.some((c) => c.card === ours.card)).toBe(true);
    }
  });

  it('states where the local root is (so a skip is actionable)', () => {
    expect(ROOT.length).toBeGreaterThan(0);
    if (!existsSync(ROOT)) {
      // The skip message must name the override, not just say "missing".
      expect(manifest.injection.env).toBe('CM_MAKERABLES');
      expect(ENV_OVERRIDE === undefined ? ROOT : ENV_OVERRIDE).toContain('.scratch');
    }
  });
});

for (const card of manifest.cards) {
  describe(`#964 reference ${card.card} (${card.licence})`, () => {
    const resolution = resolveMakerablesCard(card, ROOT);

    it.skipIf(!resolution.ok)(
      `the injected bytes are the page's (${resolution.ok ? 'present' : resolution.reason})`,
      () => {
        expect(mismatchedShas(card, ROOT)).toEqual([]);
      },
    );

    it.skipIf(!resolution.ok)('the vendor program’s own facts match the committed reference', () => {
      if (!resolution.ok) return;
      const facts = measurePostedFiles(resolution.resolved.ncFiles, card.card);
      expect(facts.parseErrors).toBe(0);
      // The vendor cycle is Makera's own ;@MKR|TIME, not our estimator's read of their file.
      expect(facts.headerTimeSeconds).toBeCloseTo(card.vendorScore.cycleSeconds, 6);
      // Their file's rapids/feed ratio and cutter count, as our parser counts them.
      expect(facts.rapidsPer1000FeedLines).toBeCloseTo(card.vendorScore.rapidsPer1000FeedLines, 5);
      expect(facts.cutters.length).toBe(card.vendorScore.cutters);
      // #927 on their file is carried as the page's calibration figure.
      if (card.vendorEstimateSeconds !== null) {
        expect(facts.cycleSeconds).toBeCloseTo(card.vendorEstimateSeconds, 2);
      }
      // #943 — THE RAPIDS LINE'S TIME BASIS. Line 5 judges `measurePostedProgram`'s rapidSeconds
      // on both sides; these pin the vendor's own readings so the basis cannot drift under the
      // line. The tray's figure is C's independent measurement on #962 (448.668 s, comment
      // 6660524949); the organizer's is the same read on its NC.
      const expectedRapidSeconds = card.card === 'tray70-top' ? 448.668 : card.card === 'organizer-top' ? 1424.5377183843116 : null;
      if (expectedRapidSeconds !== null) expect(facts.rapidSeconds).toBeCloseTo(expectedRapidSeconds, 3);
    });

    it.skipIf(!resolution.ok)('the page’s numbers are the manifest’s numbers', () => {
      if (!resolution.ok) return;
      const goalcheck = readJson<PageGoalCheck>(resolution.resolved.goalcheckPath);
      expect(goalcheck).not.toBeNull();
      expect(coverageFromPage(goalcheck)).toBeCloseTo(card.vendorScore.coverage, 9);
      const pageCut = cutIntoFromPage(goalcheck);
      const manifestCut = card.vendorScore.cutInto;
      // The old-format page file does not carry the excluded shares; the comparison activates as
      // soon as the page is rebuilt with E's checker. A card scored by the new checker (the tray)
      // then has to agree with the manifest to the last printed digit.
      if (manifestCut.adjudicatedFraction !== null && pageCut.adjudicatedFraction !== null) {
        expect(pageCut.adjudicatedFraction).toBeCloseTo(manifestCut.adjudicatedFraction, 9);
      }
      if (manifestCut.edgeBreakFraction !== null && pageCut.edgeBreakFraction !== null) {
        expect(pageCut.edgeBreakFraction).toBeCloseTo(manifestCut.edgeBreakFraction, 9);
      }
      if (manifestCut.wallNotScoredFraction !== null && pageCut.wallNotScoredFraction !== null) {
        expect(pageCut.wallNotScoredFraction).toBeCloseTo(manifestCut.wallNotScoredFraction, 9);
      }
      if (manifestCut.shadowNotScoredFraction !== null && pageCut.shadowNotScoredFraction !== null) {
        expect(pageCut.shadowNotScoredFraction).toBeCloseTo(manifestCut.shadowNotScoredFraction, 9);
      }
      // The advisory 0.01-floor figure and the deepest cut are on every checker version.
      if (manifestCut.rawFraction !== null && pageCut.rawFraction !== null) {
        expect(pageCut.rawFraction).toBeCloseTo(manifestCut.rawFraction, 9);
      }
      expect(pageCut.maxMm).toBeCloseTo(manifestCut.maxMm, 9);
    });

    it.skipIf(!resolution.ok)('the scorer reads the reference as a vendor score', () => {
      if (!resolution.ok) return;
      const vendor = measureVendorCard({
        card: card.card,
        goalcheckPath: resolution.resolved.goalcheckPath,
        ncFiles: resolution.resolved.ncFiles,
      });
      expect(vendor.coverage).toBeCloseTo(card.vendorScore.coverage, 9);
      expect(vendor.cycleSeconds).toBeCloseTo(card.vendorScore.cycleSeconds, 6);
      expect(vendor.cutters).toBe(card.vendorScore.cutters);
      expect(vendor.postsAsFiled).toBeNull();
      expect(vendor.cuttersOwned).toBeNull();
    });
  });
}

for (const ours of manifest.ours) {
  const card = manifest.cards.find((c) => c.card === ours.card);
  const resolution = card === undefined ? null : resolveMakerablesCard(card, ROOT);
  const runGoalcheck = join(ROOT, ours.runDir, 'goalcheck.json');
  const oursFiles = ours.ncFiles.map((path) => join(ROOT, path));
  const available =
    card !== undefined &&
    resolution !== null &&
    resolution.ok &&
    existsSync(runGoalcheck) &&
    oursFiles.every((path) => existsSync(path));
  const reason = !available
    ? `the local scratch run is not on this machine (${ours.source})`
    : '';

  describe(`#964 Case Maker vs the vendor — ${ours.card}`, () => {
    it.skipIf(!available)(`the baseline card reads Deviates on the #955 gaps (${reason})`, () => {
      if (!available || card === undefined || resolution === null || !resolution.ok) return;
      const goalcheck = readJson<PageGoalCheck>(runGoalcheck);
      expect(goalcheck).not.toBeNull();
      const facts = measurePostedFiles(oursFiles, ours.label);
      const oursScore: ProgramScore = {
        label: ours.label,
        coverage: coverageFromPage(goalcheck),
        cutInto: cutIntoFromPage(goalcheck),
        cycleSeconds: facts.cycleSeconds,
        airFraction: facts.airFraction,
        rapidSeconds: facts.rapidSeconds,
        rapidMoves: facts.rapidMoves,
        rapidsPer1000FeedLines: facts.rapidsPer1000FeedLines,
        cutters: facts.cutters.length,
        cuttersOwned: ours.cuttersOwned,
        postsAsFiled: {
          ok: ours.postsAsFiled.ok,
          holding: ours.holding,
          pitchMm: ours.pitchMm,
          ...(ours.postsAsFiled.note === undefined ? {} : { note: ours.postsAsFiled.note }),
        },
      };
      const vendor = measureVendorCard({
        card: card.card,
        goalcheckPath: resolution.resolved.goalcheckPath,
        ncFiles: resolution.resolved.ncFiles,
      });
      const scored = scoreSevenLines({ card: card.card, ours: oursScore, vendor });

      // THE BASELINE (2026-11-03, wave-2 clone fc43a78c, #955): coverage scrapes past the
      // vendor−1 line, the cut-into rule is not applied to this run's file yet (stated, not
      // passed), and the 23-hour program fails cycle, air and rapids. Pinned so the rebuilt engine's movement is
      // a number that changed, not a screenshot someone has to interpret.
      expect(scored.referenced).toBe(true);
      expect(scored.pass).toBe(false);
      expect(scored.failing).toEqual(['cutInto', 'cycle', 'air', 'rapids']);
      expect(scored.lines.find((l) => l.key === 'coverage')?.state).toBe('pass');
      expect(scored.lines.find((l) => l.key === 'cutters')?.state).toBe('pass');
      expect(scored.lines.find((l) => l.key === 'cycle')?.oursValue as number).toBeGreaterThan(6 * 3600);
      expect(scored.sentence).toContain('Deviates');
    });
  });
}
