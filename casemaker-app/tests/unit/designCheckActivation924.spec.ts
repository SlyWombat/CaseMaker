/**
 * #924 activation — `engraveGenerate.ts` hands the raw design items it already builds
 * (`designById`/`vCarveById`'s V-carve items, the flat items' own cutter radius) to
 * `session.oracle`'s previously-dormant `designItems` param, through every program-result path
 * (`EngraveRegions` → `OneProgram` → `programOf`/`withOwnDesignItems`).
 *
 * This spec proves the WIRING on real jobs, not the check functions themselves —
 * `designCheck924.spec.ts` already proves `checkDesignReach`/`checkVolumeAgreement`'s own math
 * against independent quadrature and the issue's documented numbers, with hand-built fixtures.
 * Here the `designItems` come from the real `engraveGenerate` output on real job files, and the
 * design check runs through the real `session.oracle()` call, the same one `engraveGolden.spec.ts`
 * freezes the badge and laminate artefacts with.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generate } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';
import { checkDesignReach } from '@/engine/cnc/engrave/designCheck';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { resetRegistry, setInventoryEntries } from '@/engine/cnc/toolRegistry';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { createSimSession } from '@/workers/sim/session';
import type { EngraveJob } from '@/types/engraveJob';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
const REPO = join(APP, '..');

function jobFrom(path: string): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.ok) throw new Error(`${path} does not parse: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

async function generateOrThrow(job: EngraveJob): Promise<EngraveGenerated> {
  const gen = await generate(tl, job);
  if (!gen.ok || gen.nc === null) {
    throw new Error(`${job.name}: generation stopped at ${gen.stage}: ${gen.errors.map((e) => e.message).join('; ')}`);
  }
  return gen;
}

describe('#924 activation — real jobs reach the design check through the real pipeline', () => {
  it('badge-2026-10-24-vbit: designItems are built and the design check passes', async () => {
    const job = jobFrom(join(HERE, 'fixtures', 'badge-2026-10-24-vbit.job.json'));
    const gen = await generateOrThrow(job);
    // The wiring itself: a V-carve/cone program must never silently carry an empty list.
    expect(gen.designItems.length).toBeGreaterThan(0);
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${job.name}: no resolvable cutter`);
    const session = createSimSession(tl);
    try {
      const loaded = session.load(gen.nc!, toSetup(job, Z1), tool, Z1.id);
      if (!loaded.ok) throw new Error(`${job.name}: the sim refused the program: ${JSON.stringify(loaded.diagnostics)}`);
      const report = session.oracle(gen.predicted, null, gen.designItems);
      expect(report.designCheck).toBeDefined();
      expect(report.designCheck?.ok).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('450-laminate-base: designItems are built and the design check passes', async () => {
    const job = jobFrom(join(REPO, 'docs', 'bench', '450-laminate-base.job.json'));
    const gen = await generateOrThrow(job);
    expect(gen.designItems.length).toBeGreaterThan(0);
    const tool = jobTool(job);
    if (tool === null) throw new Error(`${job.name}: no resolvable cutter`);
    const session = createSimSession(tl);
    try {
      const loaded = session.load(gen.nc!, toSetup(job, Z1), tool, Z1.id);
      if (!loaded.ok) throw new Error(`${job.name}: the sim refused the program: ${JSON.stringify(loaded.diagnostics)}`);
      const report = session.oracle(gen.predicted, null, gen.designItems);
      expect(report.designCheck).toBeDefined();
      expect(report.designCheck?.ok).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('j13-tool-tray (flat pockets): designItems are built and the design check passes', async () => {
    // j13 names an inventory cutter, so register the k3 inventory row it was written against.
    const inventory = JSON.parse(readFileSync(join(HERE, 'fixtures', 'pick857', 'tools.json'), 'utf8')) as ToolLibraryEntry[];
    setInventoryEntries(inventory);
    const session = createSimSession(tl);
    try {
      const job = jobFrom(join(REPO, 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs', 'j13-tool-tray.json'));
      const gen = await generateOrThrow(job);
      expect(gen.designItems.length).toBeGreaterThan(0);
      const tool = jobTool(job);
      if (tool === null) throw new Error(`${job.name}: no resolvable cutter`);
      const loaded = session.load(gen.nc!, toSetup(job, Z1), tool, Z1.id);
      if (!loaded.ok) throw new Error(`${job.name}: the sim refused the program: ${JSON.stringify(loaded.diagnostics)}`);
      const report = session.oracle(gen.predicted, null, gen.designItems);
      expect(report.designCheck).toBeDefined();
      expect(report.designCheck?.ok).toBe(true);
    } finally {
      session.dispose();
      resetRegistry();
    }
  });

  // engrave.spec:180's job: a drilled hole beside a label read as that label's "too far" (0.39 mm²).
  it('the default job with a hole added passes: the hole is allowance, not a neighbour’s over-cut', async () => {
    useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), toolKey: 'flat-1.0' } });
    useEngraveJobStore.getState().addDrill('drill');
    const job = useEngraveJobStore.getState().job;
    const gen = await generateOrThrow(job);
    expect(gen.designItems.some((d) => d.allowOnly === true)).toBe(true);
    const session = createSimSession(tl);
    try {
      const loaded = session.load(gen.nc!, toSetup(job, Z1), jobTool(job)!, Z1.id);
      if (!loaded.ok) throw new Error(`the sim refused the program: ${JSON.stringify(loaded.diagnostics)}`);
      const report = session.oracle(gen.predicted, null, gen.designItems);
      expect(report.designCheck?.worst.tooFar).toBe(0);
      expect(report.designCheck?.ok).toBe(true);
      expect(report.ok).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('the #741 defect class (a flank widened past the shank) fails checkDesignReach, fed the REAL badge designItems and a REAL simulated slice', () => {
    // #741's engine bug was the swept removal reaching WIDER than the design's own outline allows
    // for the cutter's radius — not a synthetic shape, a real sweep disagreeing with the design.
    // Reproducing the historical trigger live needs the bench's own catalogue/location (the j11
    // regression jobs resolve no tool against the bare pipeline — confirmed by probing them here
    // before writing this spec; they need `pipelineIdentity.spec.ts`'s house-catalogue rig, out of
    // this commit's scope). So this proves the REAL wiring end to end instead: the badge's REAL
    // `designItems` (from `engraveGenerate`, the exact object `session.oracle` above is handed) and
    // the badge's REAL simulated cross-section (`session.levelCut`, the exact slice `checkDesignReach`
    // reads inside `session.oracle`) — with the slice grown past `r + band` the way a widened-flank
    // sweep would leave it, standing in for the swept-geometry defect `designCheck924.spec.ts`
    // already proves this function catches with hand-built/independent numbers.
    const job = jobFrom(join(HERE, 'fixtures', 'badge-2026-10-24-vbit.job.json'));
    return generateOrThrow(job).then((gen) => {
      const tool = jobTool(job);
      if (tool === null) throw new Error(`${job.name}: no resolvable cutter`);
      const session = createSimSession(tl);
      try {
        const loaded = session.load(gen.nc!, toSetup(job, Z1), tool, Z1.id);
        if (!loaded.ok) throw new Error(`${job.name}: the sim refused the program: ${JSON.stringify(loaded.diagnostics)}`);
        const items = gen.designItems;
        expect(items.length).toBeGreaterThan(0);
        const item = items[0]!;
        const widenPastShankMm = item.r + 1; // #741's excess was 20-60%; this is a clear, unmissable over-cut.
        const sliceAt = (z: number) => {
          const cut = session.levelCut(z);
          if (cut === null || cut.region === null) return null;
          return cut.region.offset(widenPastShankMm, 'Round', 2, 16);
        };
        const report = checkDesignReach(tl, items, sliceAt, {});
        expect(report.ok).toBe(false);
        expect(report.worst.tooFar).toBeGreaterThan(report.areaFloor);
        expect(report.worst.tooFarAt?.itemId).toBe(item.itemId);
      } finally {
        session.dispose();
      }
    });
  });
});
