/**
 * The headless `casemaker engrave` run the two #786 headless specs drive (#1180).
 *
 * Both specs write a job into a scratch directory, run the real command in process against the
 * fixture location, and read the receipt and the written programs. The two tests are independent
 * (different jobs), so they live in their own files and run on parallel workers; this module is the
 * plumbing they share.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { engraveJobMain } from '../../../scripts/lib/casemaker/engrave';
import type { CommandOptions } from '../../../scripts/lib/casemaker/output';
import type { Receipt } from '../../../src/platform/headless/receipt';
import type { EngraveJob } from '../../../src/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..', '..');

export const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');
export const NOW = new Date('2026-10-31T12:00:00.000Z');

export interface Run {
  code: number;
  receipt: Receipt | null;
  outDir: string;
  progress: string[];
}

/** A per-file scratch directory; the caller removes it in afterAll. */
export function scratchFor(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function disposeScratch(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Write the job, run the real command against the fixture location, and collect its answers. */
export async function engrave(scratchDir: string, job: EngraveJob, name: string): Promise<Run> {
  const outDir = join(scratchDir, name);
  mkdirSync(outDir, { recursive: true });
  const jobPath = join(outDir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + '\n');
  let receipt: Receipt | null = null;
  const progress: string[] = [];
  const options: CommandOptions = {
    json: true,
    now: NOW,
    sink: {
      progress: (line) => progress.push(line),
      receipt: (r) => {
        receipt = r;
      },
    },
  };
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', LOCATION], options);
  return { code, receipt, outDir, progress };
}
