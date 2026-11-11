/**
 * #1237 — THE CLI PLANS WITH THE LOCATION'S SHOP SETTINGS, AND THE RECEIPT SAYS WHICH.
 *
 * The one that would have caught the bug: the same small goal job planned through the command
 * twice, with two copies of the fixture location that differ in one planner key whose effect is
 * visible on the job. The receipts' plans differ, each matches the app-side planner under the
 * same install, and the changed key — and only the changed key — is in the receipt's provenance.
 *
 * The job is the near-sphere on a 30 × 30 × 30 blank held on tape: it posts a flat program and a
 * ball program, so the bit-change rule (read by `planModelCam` through the live source) has work
 * to price. Long-reach tool records are stated in both location copies, identically, so the only
 * difference between the arms is the one key.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { engraveShopOpts } from '@/engine/cnc/engrave/feeds';
import { readTargetObjectFile } from '@/engine/import/targetObject';
import { installShopDefaults, resetLiveShopDefaults, type ShopDefaults } from '@/platform/defaultsClient';
import type { Receipt } from '@/platform/headless/receipt';
import { engraveJobMain } from '../../scripts/lib/casemaker/engrave';
import { HUMAN, type CommandOptions } from '../../scripts/lib/casemaker/output';
import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';
import type { EngraveJob } from '@/types/engraveJob';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_LOCATION = join(APP, 'tests/unit/fixtures/location-doc.json');
const SCRATCH = mkdtempSync(join(tmpdir(), 'casemaker-cli-defaults-1237-'));
afterAll(() => {
  resetLiveShopDefaults();
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** The near-sphere job, built the way the app builds a goal job (the corpus helper's shape). */
async function nearSphereJob(): Promise<EngraveJob> {
  const name = 'near-sphere.stl';
  const bytes = readFileSync(join(APP, 'tests/fixtures/goals', name));
  const read = await readTargetObjectFile(new File([bytes], name), `goal-${name}`);
  if (!read.ok) throw new Error(read.error);
  const size = read.size as { x: number; y: number; z: number };
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'near-sphere',
    labels: [],
    shapes: [],
    drills: [],
    stock: { length: size.x, width: size.y, thickness: size.z, material: 'softwood' },
    workholding: {
      kind: 'tape',
      tape: { width: 20, thickness: 0.2, inset: 2, where: null, squareTo: 'front', fence: null, source: 'default' },
    },
    toolKey: 'user:1a2b3c4d5e',
    tool: {
      number: 1,
      id: null,
      name: '2 mm flat end',
      typeText: 'Flat End',
      shape: 'flat',
      handleDiameter: 3.175,
      tipDiameter: 2,
      diameter: 2,
      cornerRadius: 0,
      angle: null,
      halfAngle: null,
      fluteLength: 42,
      shoulderLength: 42,
      stickout: 55,
      centreCutting: false,
    },
    targetObject: {
      id: read.id,
      name: read.name,
      format: read.format,
      sha256: read.sha256,
      data: read.data,
      size: read.size,
      position: { x: size.x / 2, y: size.y / 2, z: 0 },
      rotation: 0,
      enabled: true,
      role: 'goal',
    },
  } as EngraveJob;
}

/** A copy of the fixture location with the long-reach tools, plus (when given) one changed key. */
function locationCopy(name: string, changed?: { key: string; value: number }): { path: string; defaults: ShopDefaults } {
  const location = JSON.parse(readFileSync(FIXTURE_LOCATION, 'utf8')) as {
    tools?: { tool: Record<string, unknown> }[];
    inventory?: { tool: Record<string, unknown> }[];
    defaults: ShopDefaults;
  };
  for (const e of [...(location.tools ?? []), ...(location.inventory ?? [])]) {
    e.tool.fluteLength = 42;
    e.tool.shoulderLength = 42;
    e.tool.stickout = 55;
  }
  if (changed !== undefined) {
    location.defaults[changed.key] = { value: changed.value, source: 'seeded', setAt: null, unit: 's', note: null };
  }
  const path = join(SCRATCH, `location-${name}.json`);
  writeFileSync(path, JSON.stringify(location, null, 1));
  return { path, defaults: location.defaults };
}

async function runCli(jobPath: string, locationPath: string): Promise<Receipt> {
  const outDir = join(SCRATCH, `out-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(outDir, { recursive: true });
  let receipt: Receipt | null = null;
  const options: CommandOptions = { ...HUMAN, sink: { receipt: (r) => { receipt = r; } } };
  const code = await engraveJobMain([jobPath, '--out', outDir, '--location', locationPath], options);
  expect(code, 'the command must succeed').toBe(0);
  expect(receipt, 'the command must emit a receipt').not.toBeNull();
  return receipt as unknown as Receipt;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The claimed run's own cycle, from the receipt's details (a job receipt; else undefined). */
const runCycleOf = (receipt: Receipt): { totalSeconds: number } | undefined =>
  (receipt.details as { runCycle?: { totalSeconds: number } }).runCycle;

describe('#1237 the CLI plans with the location’s settings', () => {
  it('a changed bit-change price changes the plan, and the receipt names it', async () => {
    const job = await nearSphereJob();
    const jobPath = join(SCRATCH, 'near-sphere.job.json');
    writeFileSync(jobPath, JSON.stringify(job, null, 1));
    const base = locationCopy('base');
    const changed = locationCopy('changed', { key: 'bitChange.attendedChangeSeconds', value: 3600 });

    const baseReceipt = await runCli(jobPath, base.path);
    const changedReceipt = await runCli(jobPath, changed.path);

    // The plans differ exactly where the key acts: the priced bit change, and so the cycle.
    const baseCycle = runCycleOf(baseReceipt)?.totalSeconds;
    const changedCycle = runCycleOf(changedReceipt)?.totalSeconds;
    expect(baseCycle).toBeGreaterThan(0);
    expect(changedCycle).toBeGreaterThan(baseCycle! * 1.5);

    // The receipt says which setting made the difference — and only the changed arm says it.
    const changedEntry = changedReceipt.provenance.find((p) => p.name === 'bitChange.attendedChangeSeconds');
    expect(changedEntry).toEqual({ name: 'bitChange.attendedChangeSeconds', value: 3600, unit: 's', source: 'located' });
    expect(baseReceipt.provenance.some((p) => p.name === 'bitChange.attendedChangeSeconds')).toBe(false);

    // And the app-side planner, with the same install, plans the same cycle as the CLI receipt.
    for (const [loc, receipt] of [[base, baseReceipt], [changed, changedReceipt]] as const) {
      resetLiveShopDefaults();
      installShopDefaults(() => loc.defaults);
      const generated = await generate(tl, job, null, [], undefined, engraveShopOpts(loc.defaults));
      expect(generated.ok).toBe(true);
      expect(generated.runCycle?.totalSeconds).toBeCloseTo(runCycleOf(receipt)?.totalSeconds as number, 6);
      // The programs the app-side planner generated are the files the CLI wrote.
      const cliHashes = receipt.outputs
        .filter((o) => String(o.path).endsWith('.nc'))
        .map((o) => o.sha256)
        .sort();
      const appHashes = generated.programs.map((p) => sha(p.nc)).sort();
      expect(appHashes).toEqual(cliHashes);
    }
  }, 300_000);
});
