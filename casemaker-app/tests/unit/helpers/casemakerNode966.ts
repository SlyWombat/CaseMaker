/**
 * #1180 — the spawned-process plumbing the #966 ManifoldRuntime cases share. Each case lives in its
 * own spec file now (three workers run the three real Node processes in parallel); the constants
 * and `cliCut` are the same code, moved out of the old single file unchanged.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseReceipt, type Receipt } from '../../../src/platform/headless/receipt';
import type { EngraveJob } from '../../../src/types/engraveJob';
import { tsxArgs } from '../../tools/tsxCli';

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP = join(HERE, '..', '..', '..');
export const CLI_SCRIPT = join(APP, 'scripts', 'casemaker.ts');
export const MCP_SCRIPT = join(APP, 'scripts', 'mcp-server.ts');
export const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');

/** The child's environment: no CASEMAKER_MODEL_CAM at all (see the old file's header comment). */
export function childEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.CASEMAKER_MODEL_CAM;
  return env;
}

export interface CliRun {
  code: number;
  receipt: Receipt | null;
  stderr: string;
}

/** Spawns the real `casemaker cut` entry, exactly as `casemakerCutPrograms.spec.ts` does. */
export function cliCut(scratch: string, job: EngraveJob, name: string, locationText: string): CliRun {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + '\n');
  const locationPath = join(dir, 'location.json');
  writeFileSync(locationPath, locationText);
  const outDir = join(dir, 'out');
  const run = spawnSync(
    process.execPath,
    tsxArgs(CLI_SCRIPT, ['cut', jobPath, '--json', '--out', outDir, '--location', locationPath]),
    { cwd: APP, encoding: 'utf8', timeout: 180_000, env: childEnv() },
  );
  const receipt =
    run.stdout.trim() === ''
      ? null
      : (() => {
          try {
            return parseReceipt(JSON.parse(run.stdout));
          } catch {
            return null;
          }
        })();
  return { code: run.status ?? 1, receipt, stderr: run.stderr };
}
