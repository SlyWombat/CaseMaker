/**
 * #1237 — THE SHOP'S SETTINGS REACH THE PLANNER IN BOTH PATHS, AND THE BELLY OF THE BUG.
 *
 * The planner's seven settings travel in `ModelPlanInput`; this spec proves the two halves the
 * analyst ruled on:
 *  1. the APP path — the same entry `sim.worker` uses for Generate: a location whose bit-change
 *     price differs from the recommendation plans to a cycle that differs by EXACTLY the price
 *     delta times the changes (one change), so the app cannot regress to fallbacks unseen;
 *  2. the CLI path — the same job through the command twice, with two copies of the location that
 *     differ only in that price: the receipts' plans differ by the same exact amount, and each
 *     arm matches the app-side planner byte for byte (the #922 parity, with a setting that
 *     differs from its recommendation), and the changed receipt names the key as `located`.
 *
 * The job is a half-scale near-sphere on a 15 × 15 × 15 blank held on tape: its flat program runs
 * ~1 min 14 s, so the ball change is ATTENDED (its price is exactly `bitChange.attendedChangeSeconds`,
 * not the rising interpolation), which is what makes the difference exact.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { engraveShopOpts } from '@/engine/cnc/engrave/feeds';
import { setRegistry } from '@/engine/cnc/toolRegistry';
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

/** A binary STL with every vertex scaled — the corpus sphere at half size, in the test's temp dir. */
function scaledStl(src: Buffer, k: number): Buffer {
  const out = Buffer.from(src);
  const triangles = out.readUInt32LE(80);
  for (let i = 0; i < triangles; i++) {
    const base = 84 + i * 50 + 12;
    for (let v = 0; v < 3; v++) {
      for (let a = 0; a < 3; a++) {
        const at = base + v * 12 + a * 4;
        out.writeFloatLE(out.readFloatLE(at) * k, at);
      }
    }
  }
  return out;
}

async function halfSphereJob(): Promise<EngraveJob> {
  const src = readFileSync(join(APP, 'tests/fixtures/goals/near-sphere.stl'));
  const bytes = scaledStl(src, 0.5);
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const read = await readTargetObjectFile(new File([view], 'near-sphere-half.stl'), 'goal-near-sphere-half');
  if (!read.ok) throw new Error(read.error);
  const size = read.size as { x: number; y: number; z: number };
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'near-sphere-half',
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

/** The app-side planner: the entry `sim.worker.engraveGenerate` calls, with the realm's install. */
async function appPlan(job: EngraveJob, location: { path: string; defaults: ShopDefaults }) {
  resetLiveShopDefaults();
  installShopDefaults(() => location.defaults);
  // The registry the CLI's bootstrap leaves behind (`bootstrap.ts`): the location's tool entries.
  setRegistry(JSON.parse(readFileSync(location.path, 'utf8')).tools ?? []);
  const generated = await generate(tl, job, null, [], undefined, engraveShopOpts(location.defaults, location.path));
  expect(generated.ok).toBe(true);
  return generated;
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The claimed run's own cycle, from the receipt's details (a job receipt; else undefined). */
const runCycleOf = (receipt: Receipt): { totalSeconds: number; changes: number } | undefined =>
  (receipt.details as { runCycle?: { totalSeconds: number; changes: number } }).runCycle;

describe('#1237 the planner reads the shop’s settings from its input', () => {
  it('the app path: a changed bit-change price moves the cycle by exactly the price difference × the changes', async () => {
    const job = await halfSphereJob();
    const base = locationCopy('app-base');
    const changed = locationCopy('app-changed', { key: 'bitChange.attendedChangeSeconds', value: 180 });
    const basePlan = await appPlan(job, base);
    const changedPlan = await appPlan(job, changed);

    const baseCycle = basePlan.runCycle;
    const changedCycle = changedPlan.runCycle;
    expect(baseCycle).not.toBeNull();
    expect(changedCycle).not.toBeNull();
    // The change is attended, so its price is exactly the key. One change: 180 − 120 s.
    expect(baseCycle!.changes).toBe(1);
    expect(changedCycle!.changes).toBe(1);
    const delta = changedCycle!.totalSeconds - baseCycle!.totalSeconds;
    expect(Math.round(delta * 1e6) / 1e6).toBe((180 - 120) * 1);
    // Nothing else moved: the posted programs are the same bytes.
    expect(changedPlan.programs.map((p) => sha(p.nc))).toEqual(basePlan.programs.map((p) => sha(p.nc)));
  }, 300_000);

  it('the CLI path: the same job plans the same (changed) cycle as the app, and the receipt names the key', async () => {
    const job = await halfSphereJob();
    const jobPath = join(SCRATCH, 'near-sphere-half.job.json');
    writeFileSync(jobPath, JSON.stringify(job, null, 1));
    const base = locationCopy('cli-base');
    const changed = locationCopy('cli-changed', { key: 'bitChange.attendedChangeSeconds', value: 180 });

    const baseReceipt = await runCli(jobPath, base.path);
    const changedReceipt = await runCli(jobPath, changed.path);
    const baseCycle = runCycleOf(baseReceipt);
    const changedCycle = runCycleOf(changedReceipt);
    expect(baseCycle?.changes).toBe(1);
    expect(Math.round(((changedCycle!.totalSeconds - baseCycle!.totalSeconds) * 1e6)) / 1e6).toBe(60);

    // The changed receipt names the setting; the recommended one lists no bit-change key.
    expect(changedReceipt.provenance.find((p) => p.name === 'bitChange.attendedChangeSeconds')).toEqual({
      name: 'bitChange.attendedChangeSeconds',
      value: 180,
      unit: 's',
      source: 'located',
    });
    expect(baseReceipt.provenance.some((p) => p.name === 'bitChange.attendedChangeSeconds')).toBe(false);

    // App and CLI agree byte for byte, and on the cycle, for each location.
    for (const [loc, receipt] of [[base, baseReceipt], [changed, changedReceipt]] as const) {
      const generated = await appPlan(job, loc);
      expect(generated.runCycle?.totalSeconds).toBeCloseTo(runCycleOf(receipt)!.totalSeconds, 6);
      const cliHashes = receipt.outputs
        .filter((o) => String(o.path).endsWith('.nc'))
        .map((o) => o.sha256)
        .sort();
      expect(generated.programs.map((p) => sha(p.nc)).sort()).toEqual(cliHashes);
    }
  }, 300_000);
});
