// #487 item 5 — the two programs the issue was filed from, as fixtures.
//
// They are the 2026-10-17 Single Barrel bench run:
//   - `single-barrel.job.json`        the rough program's job (2 mm flat, PLA)
//   - `single-barrel.before.nc`       that program as it was cut, in the pre-#487 order
//   - `single-barrel-rest.job.json`   the rest program's job (0.6 mm flat) — the one whose
//                                     1.82 : 1 air-to-cut ratio raised the issue
//   - `single-barrel-rest.before.nc`  that program as it was cut, in the pre-#487 order
//
// The claim under test is the issue's own: the ordered rest pass cuts the SAME AREA — the simulated
// removal is the same to floating point — while the rapid travel is at least halved, and the order
// is deterministic (the same input posts the same file twice).
//
// The .nc files are read for two numbers only: the rapid travel the old order really spent, and the
// material its sweep removed. Both are measured off the committed files, never retyped.

import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { engraveGenerate, type EngraveGenerated } from '@/workers/sim/engraveGenerate';
import { createSimSession } from '@/workers/sim/session';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import type { EngraveJob } from '@/types/engraveJob';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const jobOf = (name: string): EngraveJob => JSON.parse(fixture(name)) as EngraveJob;

/**
 * XY rapid travel in a posted file, in the same units `travelStats` uses: every G0's XY hop. The
 * IR's first move is the Z-only retract, not an XY rapid, so the file's first XY hop IS charged —
 * it is the one the old emitter spent flying from the origin to the first entry. Modal Y is
 * carried, so a line that names only X is a real move — the files are full of them.
 */
function ncRapidMm(text: string): number {
  let x = 0;
  let y = 0;
  let total = 0;
  for (const line of text.split('\n')) {
    const m = /^(G0|G1) X(-?\d+(?:\.\d+)?)(?: Y(-?\d+(?:\.\d+)?))?/.exec(line);
    if (m === null) continue;
    const nx = Number(m[2]);
    const ny = m[3] === undefined ? y : Number(m[3]);
    if (m[1] === 'G0') total += Math.hypot(nx - x, ny - y);
    x = nx;
    y = ny;
  }
  return total;
}

/** Generate a fixture job with the cutter its file says it was cut with. */
function generate(job: EngraveJob, tool: Tool): EngraveGenerated {
  // The pipeline refuses a job whose named cutter is not in the registry (`tool-missing`) before it
  // looks at the `tool` argument, so the fixture's own entry is registered for the run.
  setRegistry([{ key: job.toolKey, provenance: 'bench fixture', tool }]);
  return engraveGenerate(tl, job, tool, []);
}

/** mm³ the program's sweep removed, simulated from a blank. */
function removedVolume(job: EngraveJob, tool: Tool, nc: string): number {
  const session = createSimSession(tl);
  try {
    const load = session.load(nc, toSetup(job, Z1), tool, Z1.id);
    if (!load.ok) throw new Error(`the fixture program no longer simulates: ${JSON.stringify(load.diagnostics)}`);
    return load.stats.removedVolume;
  } finally {
    session.dispose();
  }
}

afterAll(() => {
  resetRegistry();
});

describe('the bench pair, ordered (#487)', () => {
  it('the rest pass cuts the same material with at least half the air travel', () => {
    const job = jobOf('single-barrel-rest.job.json');
    const tool = flatEndMill(0.6);
    const generated = generate(job, tool);
    expect(generated.ok, JSON.stringify(generated.errors)).toBe(true);
    expect(generated.nc).not.toBeNull();
    const before = fixture('single-barrel-rest.before.nc');

    const cam = generated.cam;
    expect(cam?.ordering).toBe('proximity');
    // The report's own before figure and the committed file agree about the old order.
    expect(cam!.baselineRapidMm).toBeCloseTo(ncRapidMm(before), 0);
    // The issue's acceptance: rapid travel at least halved.
    expect(cam!.rapidMm).toBeLessThanOrEqual(ncRapidMm(before) / 2);

    // Same cut: the two files sweep the same material off the same blank.
    const oldVolume = removedVolume(job, tool, before);
    const newVolume = removedVolume(job, tool, generated.nc!);
    expect(Math.abs(newVolume - oldVolume)).toBeLessThan(oldVolume * 1e-4);
  }, 180_000);

  it('the rough pass does not spend more air than before', () => {
    const job = jobOf('single-barrel.job.json');
    const tool = flatEndMill(2);
    const generated = generate(job, tool);
    expect(generated.ok, JSON.stringify(generated.errors)).toBe(true);
    expect(generated.nc).not.toBeNull();
    const before = fixture('single-barrel.before.nc');

    expect(generated.cam!.rapidMm).toBeLessThan(ncRapidMm(before));

    const oldVolume = removedVolume(job, tool, before);
    const newVolume = removedVolume(job, tool, generated.nc!);
    expect(Math.abs(newVolume - oldVolume)).toBeLessThan(oldVolume * 1e-4);
  }, 180_000);

  it('posts the same file twice (the order is deterministic)', () => {
    const job = jobOf('single-barrel-rest.job.json');
    const tool = flatEndMill(0.6);
    const first = generate(job, tool);
    const second = generate(job, tool);
    expect(first.ok).toBe(true);
    expect(second.nc).toBe(first.nc);
  }, 180_000);
});
