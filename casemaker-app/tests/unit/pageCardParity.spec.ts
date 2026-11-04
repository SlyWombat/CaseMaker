/**
 * #964 — THE PAGE'S CARD ARTEFACTS READ BY THE SCORER, AND THE CLI THE PAGE CALLS.
 *
 * The demo page's build writes a run directory per card: the checker's `goalcheck.json`, the
 * app's `receipt.json` and the posted `.nc`. This spec reads a committed fixture of exactly that
 * shape through the same adapter the page uses, and then runs the CLI (`seven-lines.ts`) as a
 * subprocess and asserts it prints the same measurement. That is the seam the "one function, two
 * callers" contract rests on: the page's call and the specs' call go through one implementation,
 * and this spec fails if the CLI's JSON and the imported function drift.
 *
 * The fixture is synthetic (a 10 mm slot, a flat 3.175 mm cutter) and committed, so this runs in
 * T1-lite on any machine; the real #955 cards live in `.scratch/makerables` and are covered by
 * `parityMakerables.spec.ts`, which skips without them.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { measurePageCard } from '../tools/cardMeasurement';
import { scoreSevenLines, type ProgramScore, type SevenLineCard } from '../tools/sevenLines';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const CARD = join(HERE, 'fixtures', 'parity', 'card');

const runCli = (args: readonly string[]): unknown => {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const out = execFileSync(npx, ['tsx', '--tsconfig', 'tsconfig.scripts.json', 'tests/tools/seven-lines.ts', ...args], {
    cwd: APP,
    encoding: 'utf8',
    env: process.env,
  });
  return JSON.parse(out) as unknown;
};

describe('#964 a page card’s run directory becomes the scorer’s input', () => {
  it('reads coverage, cut-into, the posted program’s facts and the posting record', () => {
    const score = measurePageCard(CARD, { card: 'fixture', holding: 'bed + tape', pitchMm: 0.1 });
    expect(score.coverage).toBeCloseTo(0.99, 9);
    expect(score.cutInto.adjudicatedFraction).toBeCloseTo(0, 9);
    expect(score.cutInto.edgeBreakFraction).toBeCloseTo(0.004, 9);
    expect(score.cutInto.wallNotScoredFraction).toBeCloseTo(0.002, 9);
    expect(score.cutInto.shadowNotScoredFraction).toBeCloseTo(0.001, 9);
    expect(score.cutInto.rawFraction).toBeCloseTo(0.001, 9);
    expect(score.cutInto.maxMm).toBeCloseTo(0.02, 9);
    expect(score.cutters).toBe(1);
    expect(score.postsAsFiled).toEqual({ ok: true, holding: 'bed + tape', pitchMm: 0.1 });
    expect(score.cycleSeconds).toBeGreaterThan(0);
    expect(score.airFraction).toBeGreaterThan(0);
    expect(score.airFraction).toBeLessThan(1);
    // 2 rapids over 3 feed moves.
    expect(score.rapidsPer1000FeedLines).toBeCloseTo((2 / 3) * 1000, 6);
    expect(score.sources?.['cycle']).toContain('#927');
  });

  it('measures the page card and the CLI identically', () => {
    const direct = measurePageCard(CARD, { card: 'fixture', holding: 'bed + tape', pitchMm: 0.1 });
    const cli = runCli(['measure', '--run', CARD, '--name', 'fixture', '--holding', 'bed + tape', '--pitch', '0.1']) as ProgramScore;
    for (const key of ['coverage', 'cycleSeconds', 'airFraction', 'rapidsPer1000FeedLines', 'cutters'] as const) {
      expect(cli[key]).toBeCloseTo(direct[key] as number, 9);
    }
    expect(cli.cutInto).toEqual(direct.cutInto);
    expect(cli.postsAsFiled).toEqual(direct.postsAsFiled);
    expect(cli.label).toBe(direct.label);
  });

  it('the `card` command scores an unreferenced card honestly', () => {
    const scored = runCli(['card', '--run', CARD, '--name', 'fixture', '--holding', 'bed + tape', '--pitch', '0.1']) as {
      referenced: boolean;
      pass: boolean;
      failing: string[];
    };
    expect(scored.referenced).toBe(false);
    expect(scored.pass).toBe(false);
    expect(scored.failing).toContain('coverage');
  });

  it('the `score` command runs the same function on a supplied measurement document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-seven-lines-'));
    try {
      const direct = measurePageCard(CARD, { card: 'fixture', holding: 'bed + tape', pitchMm: 0.1 });
      const vendor: ProgramScore = {
        ...direct,
        label: 'reference',
        // The reference's file is the vendor's own program: its cycle is the file's own TIME.
        cycleSeconds: direct.cycleSeconds * 1.1,
        cuttersOwned: null,
        postsAsFiled: null,
      };
      const input = { card: 'fixture', ours: direct, vendor };
      const inputPath = join(dir, 'card.json');
      writeFileSync(inputPath, JSON.stringify(input));
      const expected = scoreSevenLines(input);
      const cli = runCli(['score', '--input', inputPath]) as SevenLineCard;
      // The CLI's JSON is the function's object on the wire; undefined keys drop the same way.
      expect(cli).toEqual(JSON.parse(JSON.stringify(expected)) as SevenLineCard);
      expect(cli.referenced).toBe(true);
      expect(cli.lines).toHaveLength(7);
      expect(cli.lines.find((l) => l.key === 'postsAsFiled')?.state).toBe('pass');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
