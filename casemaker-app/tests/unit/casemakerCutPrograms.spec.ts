// #733 item 1 — A JOB WITH SEVERAL CUTTERS POSTS ONE PROGRAM PER CUTTER.
//
// The bench exercise (docs/bench/2026-10-27-z1-typical-jobs) had to split every multi-cutter job
// into one file per cutter because `casemaker cut <job>` wrote only the top-level adapter program
// (`generated.nc`, the first program) and dropped the rest of `generated.programs`. This spec drives
// the real command in process, with the fixture location so the owned cutters resolve, and holds
// that a two-cutter setup posts two files with the two cutters' headers.
//
// Why the two cutters are assigned separate items: the generator measures a later cutter as a REST
// pass over the material the first program's sweep left. Assigning the setup's two items to the two
// cutters (#472's `toolItems`) makes the second program's cut a measured region rather than a
// rest-of-everything prediction, which is the shape the faceplate and relief jobs have.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import type { CommandOptions } from '../../scripts/lib/casemaker/output';
import { runSheetFileName } from '../../src/engine/cnc/engrave/runSheet';
import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import type { Receipt } from '../../src/platform/headless/receipt';
import type { EngraveJob, JobSetup } from '../../src/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const LOCATION = join(APP, 'tests', 'unit', 'fixtures', 'location-doc.json');
/** The fixture location's two owned flat cutters: 2 mm and a 3.175 mm clone. */
const FIRST = 'user:1a2b3c4d5e';
const SECOND = 'user:6f7a8b9c0d';
const NOW = new Date('2026-10-28T12:00:00.000Z');

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-cut-programs-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

interface CutRun {
  code: number;
  receipt: Receipt | null;
  outDir: string;
}

async function cut(job: EngraveJob, name: string): Promise<CutRun> {
  const outDir = join(SCRATCH, name);
  mkdirSync(outDir, { recursive: true });
  const jobPath = join(outDir, 'job.json');
  writeFileSync(jobPath, JSON.stringify(job, null, 2) + '\n');
  let receipt: Receipt | null = null;
  const options: CommandOptions = {
    json: true,
    now: NOW,
    sink: {
      receipt: (r) => {
        receipt = r;
      },
    },
  };
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', LOCATION], options);
  return { code, receipt, outDir };
}

/** A softwood job whose one setup names two cutters, each owning one of its two labels (#472). */
function twoCutterJob(): EngraveJob {
  const base = defaultEngraveJob();
  const labels = base.labels.slice(0, 2).map((label) => ({ ...label, depth: 0.5 }));
  const [a, b] = labels.map((label) => label.id);
  const setup: JobSetup = {
    id: 'setup-1',
    // A top-up vise setup is the identity record.
    orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
    mount: { kind: 'vise' },
    itemIds: [a!, b!],
    tools: [FIRST, SECOND],
    toolItems: { [FIRST]: [a!], [SECOND]: [b!] },
  };
  return {
    ...base,
    name: 'two-cutter bench job',
    toolKey: FIRST,
    labels,
    setups: [setup],
  };
}

describe('#733 a job posts one program per cutter', () => {
  it('writes the second cutter’s program, not only the first', async () => {
    const job = twoCutterJob();
    const stem = runSheetFileName(job.name);
    const stemNoExt = stem.replace(/\.nc$/, '');
    const run = await cut(job, 'two-cutter');

    expect(
      run.code,
      JSON.stringify({
        refusals: run.receipt?.refusals ?? null,
        diagnostics: run.receipt?.diagnostics ?? null,
      }),
    ).toBe(0);
    expect(run.receipt).not.toBeNull();
    expect(run.receipt!.ok).toBe(true);
    if (run.receipt!.command !== 'engrave') throw new Error('expected the engrave receipt');
    const details = run.receipt!.details;

    // Two programs, in cut order, named the way the run sheet and the release step name them: the
    // first keeps the job's own file name, a later one takes `-p<n>`.
    expect(details.programs.map((p) => p.ncFile)).toEqual([stem, `${stemNoExt}-p2.nc`]);
    for (const file of [stem, `${stemNoExt}-p2.nc`]) {
      expect(existsSync(join(run.outDir, file)), `${file} was written`).toBe(true);
    }

    // Each file names the cutter it was posted for, and the two are genuinely different programs.
    const first = readFileSync(join(run.outDir, stem), 'utf8');
    const second = readFileSync(join(run.outDir, `${stemNoExt}-p2.nc`), 'utf8');
    expect(first).toContain(`;@CM|TOOL|key=${FIRST}`);
    expect(second).toContain(`;@CM|TOOL|key=${SECOND}`);
    expect(second).not.toBe(first);

    // Each program's frame file is named after its own program, and the second one exists.
    expect(details.programs[1]!.frameFile).toBe(`${stemNoExt}-p2-frame.nc`);
    expect(existsSync(join(run.outDir, `${stemNoExt}-p2-frame.nc`))).toBe(true);

    // One sheet per job — the setup's one truth — carried by the program it names in its header.
    expect(details.programs[0]!.sheet?.file).toBe(`${stemNoExt}-run-sheet.md`);
    expect(details.programs[1]!.sheet).toBeNull();
  }, 120_000);
});
