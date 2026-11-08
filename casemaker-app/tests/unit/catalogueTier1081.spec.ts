/**
 * #1081 — WHICH FEED TIER ANSWERED IS PART OF THE RUN, AND ITS ABSENCE IS STATED.
 *
 * The headless CLI reads `catalogue.json` beside the `--location` document (loadCatalogue). When
 * no catalogue is found the run planned silently on the shop's starting table: the SAME tray
 * bottom job posted F400/F150 with 0.6 mm levels instead of the catalogue tier's F1000/F300 with
 * 1.0 mm levels — 44,830 s against the delivered 18,619 s (#1074's record). The run now states the
 * tier once, in the CLI output and in the receipt, and `--catalogue` (or `CM_CATALOGUE`) names the
 * document explicitly.
 *
 * These cases drive the real entry point (`engraveJobMain`) with an INVALID job document: the stop
 * (`invalidJob`) comes after the catalogue step and before any CAM, so it is fast and the receipt
 * is the run's own.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type { Receipt } from '../../src/platform/headless/receipt';
import type { CommandOptions } from '../../scripts/lib/casemaker/output';

const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-cli-catalogue-1081-'));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
afterEach(() => vi.resetModules());

const NO_CATALOGUE_BESIDE = "no Makera catalogue beside the location — feeds come from the shop's starting table";
const NO_CATALOGUE_DEFAULT = "no Makera catalogue in the app's data directory — feeds come from the shop's starting table";

/** A bare pre-#412 house document: enough to bootstrap, no catalogue anywhere near it. */
const LOCATION = JSON.stringify({ tools: [], inventory: [] }, null, 2) + '\n';

/** A minimal valid catalogue document (the parser accepts empty lists). */
function catalogueDoc(): string {
  return JSON.stringify({ kind: 'casemaker-catalogue', schemaVersion: 1, syncedAt: '2026-10-18T03:24:13.374Z', tools: [], feeds: [] }, null, 2) + '\n';
}

/** Parseable JSON that `parseEngraveJob` refuses — the run stops AFTER the catalogue step. */
const INVALID_JOB = JSON.stringify({ schemaVersion: 3, name: 'invalid for #1081' }, null, 2) + '\n';

interface CliRun {
  code: number;
  receipt: Receipt | null;
  progress: string[];
}

async function cliCut(name: string, opts: { extraArgs?: string[]; env?: string; sibling?: string } = {}): Promise<CliRun> {
  const { engraveJobMain } = await import('../../scripts/lib/casemaker/engrave');

  const dir = join(SCRATCH, name);
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, 'job.json');
  writeFileSync(jobPath, INVALID_JOB);
  const locationPath = join(dir, 'location.json');
  writeFileSync(locationPath, LOCATION);
  if (opts.sibling !== undefined) writeFileSync(join(dir, 'catalogue.json'), opts.sibling);

  const previous = process.env.CM_CATALOGUE;
  if (opts.env !== undefined) process.env.CM_CATALOGUE = opts.env;
  else delete process.env.CM_CATALOGUE;
  try {
    const progress: string[] = [];
    let receipt: Receipt | null = null;
    const options: CommandOptions = {
      json: true,
      sink: {
        progress: (line) => progress.push(line),
        receipt: (r) => {
          receipt = r;
        },
      },
    };
    const argv = [jobPath, '--out', join(dir, 'out'), '--location', locationPath, ...(opts.extraArgs ?? [])];
    const code = await engraveJobMain(argv, options);
    return { code, receipt, progress };
  } finally {
    if (previous === undefined) delete process.env.CM_CATALOGUE;
    else process.env.CM_CATALOGUE = previous;
  }
}

describe('#1081 the feed tier is stated', () => {
  it("with no catalogue beside the location: one plain line and the receipt's own tier row", async () => {
    const { code, receipt, progress } = await cliCut('none');
    // The invalid job stops the run (the stop is the harness, not the subject): a receipt still
    // comes back, and the absence line was stated exactly once before it.
    expect(code).toBe(1);
    expect(progress.filter((l) => l === NO_CATALOGUE_BESIDE)).toHaveLength(1);
    expect(receipt).not.toBeNull();
    const rows = receipt!.diagnostics.filter((d) => d.code === 'feeds-no-catalogue');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'feeds-no-catalogue', guideRow: 'feeds-no-catalogue', severity: 'info', message: NO_CATALOGUE_BESIDE, program: null });
  });

  it('with the sibling catalogue: named, and no absence line', async () => {
    const { progress, receipt } = await cliCut('sibling', { sibling: catalogueDoc() });
    const named = progress.filter((l) => l.startsWith("Makera's catalogue: "));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain(join(SCRATCH, 'sibling', 'catalogue.json'));
    expect(progress.filter((l) => l === NO_CATALOGUE_BESIDE || l === NO_CATALOGUE_DEFAULT)).toHaveLength(0);
    expect(receipt!.diagnostics.filter((d) => d.code === 'feeds-no-catalogue')).toHaveLength(0);
  });

  it('--catalogue names the document explicitly', async () => {
    const elsewhere = join(SCRATCH, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const path = join(elsewhere, 'catalogue.json');
    writeFileSync(path, catalogueDoc());
    const { progress, receipt } = await cliCut('flag', { extraArgs: ['--catalogue', path] });
    const named = progress.filter((l) => l.startsWith("Makera's catalogue: "));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain(path);
    expect(progress.filter((l) => l === NO_CATALOGUE_BESIDE)).toHaveLength(0);
    expect(receipt!.diagnostics.filter((d) => d.code === 'feeds-no-catalogue')).toHaveLength(0);
  });

  it('CM_CATALOGUE names the document explicitly', async () => {
    const elsewhere = join(SCRATCH, 'env-catalogue');
    mkdirSync(elsewhere, { recursive: true });
    const path = join(elsewhere, 'catalogue.json');
    writeFileSync(path, catalogueDoc());
    const { progress, receipt } = await cliCut('env', { env: path });
    const named = progress.filter((l) => l.startsWith("Makera's catalogue: "));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain(path);
    expect(receipt!.diagnostics.filter((d) => d.code === 'feeds-no-catalogue')).toHaveLength(0);
  });
});
