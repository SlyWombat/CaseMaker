/**
 * #1252 (review 4) — THE ALL-DIRTY PICK ASKS EVERY FEASIBLE CHAIN, AND EACH ASK IS A VISIBLE TICK.
 *
 * The picker asks the goal check's own adjudication about the first-ranked chain and goes on only
 * while the answer is "cuts into the part". When EVERY chain is dirty it asks every feasible chain
 * (no cap: a cap would be a chosen limit that decides a pick), up to seconds a call, so each call
 * is preceded by a #1038 progress tick, "checking set k of N against the model", that reaches the
 * run through the CLI's `--events` stream. This spec drives the real path on #1258's small
 * committed goal job (the 27 x 10 block): with the count forced to at least one adjudicated cell
 * (the real check still runs on every call) every feasible chain is asked — one call and one tick
 * each, "checking set k of N"; with the real answer the pick asks ONCE. (Only the ideal plan has a
 * chain here, so the statements the adjudication builds are not on the posted plan: see the note in
 * the second test.) The block has ONE feasible chain (N = 1),
 * which is what proves the wiring reaches the run; the k = 1..N sequence for N > 1 is pinned in
 * rankCutInto1252.spec.ts (the picker) and was measured on real jobs (ref-accuracy: 16 calls, 16
 * ticks; ref-toolholder: 195 calls).
 *
 * (The wiring once sat on the wrong options object — a conditional spread the type checker cannot
 * see — and a real run printed no tick at all; this is the test that would have caught it.)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const control = { forceDirty: false, calls: 0 };
vi.mock('@/workers/sim/goalChainCutInto', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/workers/sim/goalChainCutInto')>();
  return {
    ...real,
    adjudicatedCellCount: (fraction: number, covered: number) => {
      control.calls++;
      const n = real.adjudicatedCellCount(fraction, covered);
      return n === null || !control.forceDirty ? n : Math.max(1, n);
    },
  };
});

import { resetLiveShopDefaults } from '@/platform/defaultsClient';
import type { Receipt } from '@/platform/headless/receipt';
import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';
import { blockJob, blockLocation, SETB } from './helpers/tabChoiceBlock1258';

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-tick-1252-'));
afterAll(() => {
  resetLiveShopDefaults();
  rmSync(SCRATCH, { recursive: true, force: true });
});

async function cutBlock(label: string): Promise<{ ticks: string[]; calls: number; receipt: Receipt }> {
  const jobPath = join(SCRATCH, `${label}.job.json`);
  writeFileSync(jobPath, JSON.stringify(blockJob()));
  const ticks: string[] = [];
  let receipt: Receipt | null = null;
  const options: CommandOptions = {
    ...HUMAN,
    json: true,
    events: true,
    now: new Date('2026-11-13T12:00:00.000Z'),
    sink: { progress: () => {}, receipt: (r) => { receipt = r; } },
  };
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]): boolean => {
    for (const line of String(chunk).split('\n')) if (/checking set \d+ of \d+ against the model/.test(line)) ticks.push((JSON.parse(line) as { label: string }).label);
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  };
  control.calls = 0;
  try {
    // `--tab-choice` answers the block's tab question (#1258) so the run goes on to the pick.
    await engraveJobMain(
      [jobPath, '--out', join(SCRATCH, `out-${label}`), '--location', blockLocation(join(SCRATCH, `loc-${label}`)), '--catalogue', join(SETB, 'catalogue.json'), '--tab-choice', 'inside-margin'],
      options,
    );
  } finally {
    (process.stderr as { write: unknown }).write = write;
  }
  return { ticks, calls: control.calls, receipt: receipt! };
}

describe('#1252 the adjudication ticks, on the real path', () => {
  it('a normal pick asks the goal check ONCE: one call, one tick', async () => {
    control.forceDirty = false;
    const run = await cutBlock('clean');
    expect(run.calls, 'one adjudication call for a clean first chain').toBe(1);
    expect(run.ticks).toHaveLength(1);
    expect(run.ticks[0]).toMatch(/checking set 1 of \d+ against the model/);
    expect(JSON.stringify(run.receipt)).not.toContain('goal-overcut');
  }, 600_000);

  it('every chain dirty: every feasible chain is asked, one tick each (k of N)', async () => {
    control.forceDirty = true;
    const run = await cutBlock('dirty');
    control.forceDirty = false;
    const total = Number(/of (\d+) against/.exec(run.ticks[0] ?? '')?.[1] ?? Number.NaN);
    expect(total, 'a tick named its set count').toBeGreaterThanOrEqual(1);
    expect(run.calls, 'every feasible chain was asked, uncapped').toBe(total);
    expect(run.ticks).toHaveLength(total);
    run.ticks.forEach((label, index) => expect(label).toMatch(new RegExp(`checking set ${index + 1} of ${total} against the model`)));
    // NOT asserted here: that the posted plan's findings carry `goal-overcut`. On this block only the
    // IDEAL plan has a pocket chain to ask about (the owned plan, the one that posts, has none), so the
    // knowing cut-into is built on a plan that does not post and no receipt line can show it. The
    // statement itself is pinned in rankCutInto1252.spec.ts (`adjudicationStatements`: an error,
    // `goal-overcut`) and was seen to reach the plan result's statements with a probe.
  }, 600_000);
});
