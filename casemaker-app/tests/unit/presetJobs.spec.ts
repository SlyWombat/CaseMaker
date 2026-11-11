// #1100 — EVERY PRESET THAT MAKES A JOB FROM ITS DEFAULT NUMBERS REACHES THE FOUR GATES.
//
// The card is only a first-job door if its defaults post: this spec builds each preset's default
// document with the same builders the receipted runs used (`tests/tools/presetJobs.ts`), drives
// the real `cut` command in process with the fixture location (the owned cutters resolve there),
// and pins the receipt's facts under `tests/fixtures/presets/`. `ok` with a null `gate` is the
// four-gate pass (`RECEIPT_GATES`): generated, verified, simulated, prediction.
//
// THE HOLD IS PART OF THE DEFAULT: Cut out a shape is refused on a bare vise, so its default job
// carries the waste board under the part — the one radio the acceptance names. The fixture states
// that, and the run proves it.
//
// Regenerate the pins (a deliberate change, reviewed in the diff):
//   PRESET_RECEIPTS=update npx vitest run tests/unit/presetJobs.spec.ts

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import type { CommandOptions } from '../../scripts/lib/casemaker/output';
import { bootstrap } from '../../src/platform/headless/bootstrap';
import { parseReceipt, type Receipt } from '../../src/platform/headless/receipt';
import { presetDefaultJob, type ReceiptPresetId } from '../tools/presetJobs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCATION = join(HERE, 'fixtures', 'location-doc.json');
const RECEIPTS = join(HERE, '..', 'fixtures', 'presets');
const UPDATE = process.env.PRESET_RECEIPTS === 'update';
const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-preset-jobs-'));

beforeAll(async () => {
  await bootstrap({ location: LOCATION });
}, 120_000);

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface Pin {
  ok: boolean;
  gate: string | null;
  programCount: number;
  errorCodes: string[];
}

/** The receipt facts a preset pins: the four-gate pass, what it posted, and any refusal. */
function pinOf(receipt: Receipt): Pin {
  const details = receipt.details;
  return {
    ok: receipt.ok,
    gate: receipt.gate,
    // The receipt's details are a union (a job, a design, a coupon); these runs are jobs, and
    // `programs` is the discriminator the engine writes for them.
    programCount: 'programs' in details ? details.programs.length : 0,
    errorCodes: receipt.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
  };
}

async function cutPreset(id: ReceiptPresetId): Promise<{ code: number; receipt: Receipt | null }> {
  const outDir = join(SCRATCH, id);
  mkdirSync(outDir, { recursive: true });
  const jobPath = join(outDir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(presetDefaultJob(id), null, 2) + '\n');
  let receipt: Receipt | null = null;
  const options: CommandOptions = {
    json: true,
    sink: {
      progress: () => undefined,
      receipt: (r) => {
        receipt = parseReceipt(r);
      },
    },
  };
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', LOCATION], options);
  return { code, receipt };
}

describe('#1100 — the preset defaults reach the four gates', () => {
  for (const id of ['sign', 'cutout', 'pocket'] as const) {
    it(`${id}: posts and passes generated / verified / simulated / prediction`, async () => {
      const { code, receipt } = await cutPreset(id);
      expect(receipt).not.toBeNull();
      const pin = pinOf(receipt!);

      if (UPDATE) {
        mkdirSync(RECEIPTS, { recursive: true });
        writeFileSync(join(RECEIPTS, `${id}.json`), JSON.stringify(pin, null, 2) + '\n');
      } else {
        expect(pin, `${id} receipt drifted; regenerate with PRESET_RECEIPTS=update and review`).toEqual(
          JSON.parse(readFileSync(join(RECEIPTS, `${id}.json`), 'utf8')),
        );
      }

      expect(code, JSON.stringify(receipt!.diagnostics.filter((d) => d.severity === 'error'))).toBe(0);
      expect(pin.ok).toBe(true);
      expect(pin.gate).toBeNull();
      expect(pin.programCount).toBeGreaterThan(0);
      expect(pin.errorCodes).toEqual([]);
    }, 180_000);
  }
});

// #1103 item 8 — THE PRESET JOBS ARE SEATED BY THE RECOMMENDATION. The sign's 36 mm stick is above
// the vise floor, so the recommended seat is the block (the default vise says ledge); the pocket's
// 12 mm plate stays on the ledge; the cut-out keeps the waste board its own default states, which
// is the hold the receipt names. Red before `presetDefaultJob` seats through `applyRecommendedMount`.
describe('#1103 item 8 — the preset default jobs are seated through the recommendation', () => {
  it('the sign preset: the 36 mm stick sits on the vise floor (a block seat), not the ledge', () => {
    const job = presetDefaultJob('sign');
    expect(job.workholding.kind).toBe('vise');
    if (job.workholding.kind !== 'vise') return;
    expect(job.workholding.vise.seat).toBe('floor');
    expect(job.sacrificial.under).toBeNull();
  });

  it('the pocket preset keeps the ledge; the cut-out keeps its 6 mm waste board', () => {
    const pocket = presetDefaultJob('pocket');
    expect(pocket.workholding.kind).toBe('vise');
    if (pocket.workholding.kind !== 'vise') return;
    expect(pocket.workholding.vise.seat).toBe('ledge');
    const cutout = presetDefaultJob('cutout');
    expect(cutout.sacrificial.under?.thickness).toBe(6);
  });
});
