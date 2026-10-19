// #547 — the dry-run transform: strip the spindle and lift every work-frame Z, leaving the XY
// path byte-for-byte the real one, so a lifted program is safe to play with nothing clamped.
//
// Two fixtures: the committed `default-job.nc` (the default engrave job, posted by #173) proves the
// transform on the real artefact, and a hand-written program proves each rule in isolation. The
// transform is checked the way the verifier checks it — the lifted text is re-parsed and re-verified.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DRY_RUN_SAFE_Z,
  dryRunProgramFor,
  liftForDryRun,
  verifyDryRun,
} from '@/engine/cnc/engrave/dryRun';
import { releaseFileName, releasePrograms, type ReleaseSource } from '@/engine/cnc/engrave/release';
import { classifyLine, parseWords, splitLines, stripComment, type Word } from '@/engine/cnc/gcode/lexer';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { stockDepthLimit, verifyProgram } from '@/engine/cnc/verify';
import { HOP_Z } from '@/engine/cnc/cam/ir';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_NC = join(HERE, 'fixtures', 'default-job.nc');

// #516 item 5 — the default job no longer seeds a cutter; the fixture was posted for `flat-1.0`.
function dj(): ReturnType<typeof defaultEngraveJob> {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  return job;
}

/** The parsed words of every code line, in order. Header/comment/blank lines contribute none. */
function codeWords(nc: string): { raw: string; words: Word[] }[] {
  return splitLines(nc).map((raw) => {
    const kind = classifyLine(raw);
    if (kind.kind !== 'code') return { raw, words: [] };
    const { code } = stripComment(kind.text);
    return { raw, words: parseWords(code, 0, []) };
  });
}

const allWords = (nc: string): Word[] => codeWords(nc).flatMap((c) => c.words);
const mWord = (w: Word): boolean => w.letter === 'M' && (w.value === 3 || w.value === 4);
const xYWords = (nc: string): string[] =>
  allWords(nc)
    .filter((w) => w.letter === 'X' || w.letter === 'Y')
    .map((w) => `${w.letter}${w.text}`);

/** Every work-frame Z word (a `G53` line's machine Z is exempt). */
function workZWords(nc: string): number[] {
  const out: number[] = [];
  for (const { words } of codeWords(nc)) {
    if (words.some((w) => w.letter === 'G' && w.value === 53)) continue;
    for (const w of words) if (w.letter === 'Z') out.push(w.value);
  }
  return out;
}

describe('liftForDryRun (#547)', () => {
  it.skipIf(!existsSync(DEFAULT_NC))('lifts the committed default job: no M3/M4, every work Z at/above the safe plane, XY preserved', () => {
    const nc = readFileSync(DEFAULT_NC, 'utf8');
    const lifted = liftForDryRun(nc);

    // The hard requirement: the spindle never spins.
    expect(allWords(lifted).some(mWord)).toBe(false);
    // Every work-frame Z is at the safe plane (the `G53` machine clearance is exempt and kept).
    expect(workZWords(lifted).every((z) => z >= DRY_RUN_SAFE_Z)).toBe(true);
    expect(workZWords(nc).some((z) => z < 0)).toBe(true); // the original really does cut
    // The real XY path is untouched, so head-follow and progress behave as on a real run.
    expect(xYWords(lifted)).toEqual(xYWords(nc));
    // The `G53` machine-frame lift is preserved verbatim (it is already a safe clearance).
    expect(lifted).toContain('G53 G0 Z-3');
    // The spindle-off before M02 survives the transform (the ending still reads clean).
    expect(lifted).toContain('M05');
  });

  it('drops the S…M3 line whole and lifts a plunge, a hop and the retracts to the safe plane', () => {
    const nc = [
      'G90 G21', 'T1 M6', 'M331', 'G53 G0 Z-3', 'G0 X10 Y10', 'S12000 M3',
      'G0 Z5', 'G1 Z-2 F600', 'G1 X20 Y20', 'G0 Z1', 'G1 Z-3 F600', 'G0 Z15', 'M332', 'M05', 'G28', 'M02',
    ].join('\n');
    const lifted = liftForDryRun(nc);

    expect(allWords(lifted).some(mWord)).toBe(false);
    expect(lifted).not.toContain('S12000');
    // Every work-frame Z is lifted to the plane: the two plunges, the hop and the low retract.
    expect(workZWords(lifted)).toEqual([
      DRY_RUN_SAFE_Z, DRY_RUN_SAFE_Z, DRY_RUN_SAFE_Z, DRY_RUN_SAFE_Z, DRY_RUN_SAFE_Z,
    ]);
    // XY is preserved exactly.
    expect(xYWords(lifted)).toEqual(xYWords(nc));
  });

  it('leaves a machine-frame G53 Z and a Z already above the plane alone', () => {
    const nc = ['G90 G21', 'T1 M6', 'G53 G0 Z-3', 'G0 X0 Y0', 'S12000 M3', 'G0 Z20', 'M5', 'G28', 'M02'].join('\n');
    const lifted = liftForDryRun(nc);
    expect(lifted).toContain('G53 G0 Z-3');
    expect(lifted).toContain('G0 Z20'); // above the plane: not rewritten
    expect(allWords(lifted).some(mWord)).toBe(false);
  });

  it('a motion line that names no Z stays verbatim: the modal Z was already lifted on the plunge before it', () => {
    const nc = ['G90 G21', 'T1 M6', 'G53 G0 Z-3', 'G0 X0 Y0', 'G0 Z1', 'G0 X5 Y5', 'M5', 'G28', 'M02'].join('\n');
    const lifted = liftForDryRun(nc);
    // The `G0 Z1` hop is lifted to the plane; the following Z-less `G0 X5 Y5` is left untouched.
    expect(lifted).toContain(`G0 Z${DRY_RUN_SAFE_Z.toFixed(3)}`);
    expect(lifted).toContain('G0 X5 Y5');
    expect(workZWords(lifted).every((z) => z >= DRY_RUN_SAFE_Z)).toBe(true);
  });
});

describe('verifyDryRun (#547)', () => {
  it.skipIf(!existsSync(DEFAULT_NC))('the lifted default job passes the verifier with nothing below the safe plane and no cutting moves', () => {
    const job = dj();
    const tool = jobTool(job);
    expect(tool).not.toBeNull();
    if (!tool) return;
    const deps = { setup: toSetup(job, Z1), machine: Z1, tool };
    const nc = readFileSync(DEFAULT_NC, 'utf8');

    // Sanity: the ORIGINAL is a real cutting program.
    const real = verifyProgram(nc, { ...deps, depthLimit: stockDepthLimit(job.stock, job.minFloor), minRapidZ: HOP_Z });
    expect(real.ok).toBe(true);
    expect(real.stats.cuttingMoves).toBeGreaterThan(0);

    const lifted = liftForDryRun(nc);
    const report = verifyDryRun(lifted, deps);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    // A dry run cuts nothing: the spindle never came on, so no move is a cutting move.
    expect(report.stats.cuttingMoves).toBe(0);
    expect(report.stats.deepestZ).toBe(0);
  });

  it.skipIf(!existsSync(DEFAULT_NC))('dryRunProgramFor returns the lifted text, its fresh report and its own FNV key', () => {
    const job = dj();
    const tool = jobTool(job);
    if (!tool) return;
    const nc = readFileSync(DEFAULT_NC, 'utf8');
    const dry = dryRunProgramFor(nc, { setup: toSetup(job, Z1), machine: Z1, tool });
    expect(dry.nc).toBe(liftForDryRun(nc));
    expect(dry.verify.ok).toBe(true);
    expect(dry.hash).not.toBe('');
    expect(allWords(dry.nc).some(mWord)).toBe(false);
  });

  it('a spindle-off cut below the stock would be refused, but the lifted text is not', () => {
    // A feed move at negative Z with the spindle off is the one check a lift must neutralise.
    const job = dj();
    const tool = jobTool(job);
    if (!tool) return;
    const deps = { setup: toSetup(job, Z1), machine: Z1, tool };
    const unlifted = ['G90 G21', 'T1 M6', 'G53 G0 Z-3', 'G0 X10 Y10', 'G0 Z1', 'G1 Z-2 F600', 'G1 X20 Y20 F600', 'M05', 'G28', 'M02'].join('\n');
    const un = verifyDryRun(unlifted, deps);
    expect(un.findings.some((f) => f.code === 'spindle-off-cut')).toBe(true);
    const lifted = verifyDryRun(liftForDryRun(unlifted), deps);
    expect(lifted.ok).toBe(true);
    expect(lifted.findings).toEqual([]);
  });
});

describe('dry-run release naming (#547)', () => {
  it('a dry-run program gets its own -dry file name, so it never overwrites the real program', () => {
    expect(releaseFileName('My job', 1, 1, true)).toBe('My-job-dry.nc');
    expect(releaseFileName('My job', 2, 3, true)).toBe('My-job-dry-p2.nc');
    expect(releaseFileName('My job', 1, 1)).toBe('My-job.nc');
  });

  it('releasePrograms carries the dry-run flag and the -dry name through', () => {
    const source: ReleaseSource = { setupIndex: 1, setupId: 's1', toolKey: 'flat-1.0', nc: 'G90 G21\nM5\nM2\n', hash: 'h1', verify: null, dryRun: true };
    const files = releasePrograms('Job', [source], []);
    expect(files[0]).toMatchObject({ filename: 'Job-dry.nc', dryRun: true });
  });
});
