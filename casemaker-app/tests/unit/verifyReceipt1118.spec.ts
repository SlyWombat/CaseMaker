// #1118 — A VERIFY-STAGE REFUSAL NAMES ITS ERROR.
//
// The j20 card was refused with the sentence "3 verifier error(s)": the three findings existed
// only inside the failed generation — the receipt's refusal carried the bare count, so neither the
// card nor the operator could see the code, the line or the location. (The receipt's diagnostics
// already map `verify.findings`; the REFUSAL SENTENCE did not name one.)
//
// The job below fails verify the way the engraveGenerate suite's under-surface void does: a 10 mm
// square cut 2.0 mm into a blank whose keep-out leaves a 1.8 mm membrane at that spot. The
// verifier's own finding is `cut-too-deep`; the refusal must name it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob, EngraveKeepOut } from '@/types/engraveJob';
import { parseReceipt, type Receipt } from '../../src/platform/headless/receipt';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');
/** The fixture location's own 2 mm flat end — the job names it so the engine has a cutter. */
const TOOL_KEY = 'user:1a2b3c4d5e';
const NOW = new Date('2026-11-10T12:00:00.000Z');

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-verify-receipt-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

/** The void: a 30 × 20 pocket with its ceiling 10 mm off the blank's bottom (a 1.8 mm membrane). */
const POCKET: EngraveKeepOut = {
  id: 'pocket',
  name: 'Magnet pocket',
  kind: 'rect',
  position: { x: 50, y: 30 },
  rotation: 0,
  enabled: true,
  zCeiling: 10,
  width: 30,
  height: 20,
  cornerRadius: 0,
};

function deepJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'deep cut over a void',
    toolKey: TOOL_KEY,
    labels: [],
    keepOuts: [POCKET],
    shapes: [
      // Over the pocket: 2.0 mm into a membrane the job's boundary margin holds to 1.8 mm.
      {
        id: 'deep',
        name: 'Deep',
        kind: 'rect',
        position: { x: 50, y: 30 },
        rotation: 0,
        depth: 2.0,
        enabled: true,
        width: 10,
        height: 10,
        cornerRadius: 0,
      },
      // Clear of the pocket: the same depth over solid stock, the control.
      {
        id: 'solid',
        name: 'Solid',
        kind: 'rect',
        position: { x: 85, y: 30 },
        rotation: 0,
        depth: 2.0,
        enabled: true,
        width: 10,
        height: 10,
        cornerRadius: 0,
      },
    ],
  };
}

interface Run {
  code: number;
  receipt: Receipt;
}

async function deepRun(): Promise<Run> {
  const outDir = join(SCRATCH, 'out');
  mkdirSync(outDir, { recursive: true });
  const jobPath = join(SCRATCH, 'deep.json');
  writeFileSync(jobPath, JSON.stringify(deepJob()));
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', LOCATION], {
    json: true,
    now: NOW,
  });
  return { code, receipt: parseReceipt(JSON.parse(written.join(''))) };
}

describe('#1118 a verify-stage refusal names its findings', () => {
  it('the receipt carries the verifier finding and the refusal names the first error', async () => {
    const { code, receipt } = await deepRun();
    expect(code).toBe(1);
    expect(receipt.ok).toBe(false);
    expect(receipt.stage).toBe('verify');

    // The finding rides the receipt's diagnostics with its own code and source.
    const verifyDiagnostics = receipt.diagnostics.filter((d) => d.source === 'verify');
    const deep = verifyDiagnostics.find((d) => d.code === 'cut-too-deep');
    expect(deep, `verify diagnostics: ${JSON.stringify(verifyDiagnostics)}`).toBeDefined();
    expect(deep!.severity).toBe('error');

    // The refusal sentence names the FIRST error — never only "N verifier error(s)".
    const first = verifyDiagnostics.find((d) => d.severity === 'error');
    expect(first).toBeDefined();
    const stageError = receipt.refusals.find((r) => r.code === 'stage-error');
    expect(stageError).toBeDefined();
    expect(stageError!.reason).toMatch(/\d+ verifier error\(s\)/);
    expect(stageError!.reason).toContain(first!.code);
    expect(stageError!.reason).toContain(first!.message);
  }, 240_000);
});
