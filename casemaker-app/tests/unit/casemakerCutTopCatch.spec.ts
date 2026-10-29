// #749 follow-up — ONE TOP-LEVEL CATCH COVERS THE WHOLE COMMAND, NOT ONLY ITS STAGES.
//
// The first guard caught the three kernel boundaries the command's own stages own (generator,
// sweep, removal union). The design/rest route reaches more Manifold/Clipper work outside those
// stages: `scanReach` measures every cutter, the `--preview` drawing calls `engraveRegions`, and
// `readDesign` reads the project file — and `casemaker cut --json` promises ONE receipt whatever
// threw. This spec forces a throw in `scanReach` and drives the real `--from-3mf` route through
// the tracked badge project, so the top-level catch is exercised where a stage guard cannot see
// it: the job document has already been recorded as an input, no program has been written.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { parseReceipt, type Receipt } from '../../src/platform/headless/receipt';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');
const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');
/** The committed badge project (#221): a real PrusaSlicer project the design route can read. */
const DESIGN = join(REPO, 'samples', 'badge-blank', 'single.3mf');
const NOW = new Date('2026-10-28T12:00:00.000Z');
const SCAN_BUG = 'reachability exploded';

// A plain JS bug in the reachability scan — the first call of the design route that is OUTSIDE
// the stages the first guard wraps. If the top-level catch is missing, this escapes the command
// and stdout is empty, which is exactly the #749 defect in a second place.
vi.mock('../../src/engine/cnc/engrave/reachability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/engine/cnc/engrave/reachability')>();
  return {
    ...actual,
    reachabilityFor: (): never => {
      throw new TypeError(SCAN_BUG);
    },
  };
});

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-top-catch-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

interface Run {
  code: number;
  stdout: string;
  stderr: string[];
}

/** Run the design route in process, capturing the two channels a `--json` caller reads. */
async function designRun(): Promise<{ run: Run; receipt: Receipt }> {
  const outDir = join(SCRATCH, 'design');
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });

  const code = await engraveJobMain(['--from-3mf', DESIGN, '--out', outDir, '--location', LOCATION], {
    json: true,
    now: NOW,
  });
  const stdout = written.join('');
  expect(stdout.trim(), `stdout was ${stdout.length} bytes`).not.toBe('');
  return { run: { code, stdout, stderr }, receipt: parseReceipt(JSON.parse(stdout)) };
}

describe('#749 the top-level catch gives an unguarded throw its receipt', () => {
  it('a throw in scanReach stops at `cam` with a receipt, not an empty stdout', async () => {
    const { run, receipt } = await designRun();

    expect(run.code, 'the throw is a stopped run').toBe(1);
    expect(receipt.ok).toBe(false);
    expect(receipt.command).toBe('engrave');
    expect(receipt.stage).toBe('cam');
    expect(receipt.gate).toBe('generated');
    expect(receipt.refusals.map((r) => r.code)).toEqual(['stage-error']);
    expect(receipt.refusals[0]!.reason).toContain(`TypeError: ${SCAN_BUG}`);
    expect(receipt.refusals[0]!.reason).toContain('preparing the cut');
    expect(receipt.refusals[0]!.reason).toContain('Nothing was written');
    // The input the command had already read is still on the receipt: the catch covers the
    // BODY, not a fresh minimal document.
    expect(receipt.inputs.map((i) => i.path)).toContain(DESIGN);
    expect(receipt.outputs).toEqual([]);
    // A plain bug is named as one, with its stack on the operator's channel.
    expect(receipt.refusals[0]!.reason).not.toContain('geometry kernel');
    expect(run.stderr.join('\n')).toMatch(/\n\s+at /);
  });
});
