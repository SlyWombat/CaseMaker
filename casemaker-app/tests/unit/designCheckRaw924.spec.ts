/**
 * #924 re-opened (progress review §3.1 B1/B2) — the design check reads the RAW outline and the
 * cutter's own radius, and looks above the floor where #741's flank widening lives.
 *
 * R1 (B2): the badge's real program, swept with a clone of its 30° bit at 60° — the same tip and
 * diameter. The floor's tip trace is unchanged; only the flank above it widens, as #741's did.
 * R2 (B1): the items handed to the check carry the raw outline as drawn, not the CAM's opening.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generate, regions } from './helpers/engravePipeline';
import { tl } from './helpers/manifoldExec';
import { jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import { createSimSession } from '@/workers/sim/session';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));

function badge(): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(HERE, 'fixtures', 'badge-2026-10-24-vbit.job.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.job;
}

describe('#924 re-opened — the raw outline, the tool’s radius, every level above the floor', () => {
  it('R1: the badge swept with a 60° clone of its 30° bit fails the design check above the floor', async () => {
    const job = badge();
    const tool = jobTool(job)!;
    expect(tool.halfAngle).toBe(15);
    const gen = await generate(tl, job);
    expect(gen.ok).toBe(true);
    const widened = { ...tool, halfAngle: 30, angle: null };
    const session = createSimSession(tl);
    try {
      const loaded = session.load(gen.nc!, toSetup(job, Z1), widened, Z1.id);
      if (!loaded.ok) throw new Error(`the sim refused the widened sweep: ${JSON.stringify(loaded.diagnostics)}`);
      const report = session.oracle(gen.predicted, null, gen.designItems);
      expect(report.designCheck?.ok).toBe(false);
      const worst = report.designCheck!.worst;
      expect(worst.tooFar).toBeGreaterThan(report.designCheck!.areaFloor);
      // The failure is above the floor, where the flank widened, and names an item.
      const failing = report.designCheck!.levels.filter((l) => l.tooFar > report.designCheck!.areaFloor);
      expect(failing.length).toBeGreaterThan(0);
      expect(failing.every((l) => l.itemId !== undefined)).toBe(true);
      const floorOf = new Map(gen.designItems.map((d) => [d.itemId, -d.depth]));
      expect(failing.some((l) => l.z > (floorOf.get(l.itemId) ?? 0) + 0.01)).toBe(true);
    } finally {
      session.dispose();
    }
  }, 120_000);

  it('R1 control: the same program swept with the real 30° bit passes', async () => {
    const job = badge();
    const gen = await generate(tl, job);
    const session = createSimSession(tl);
    try {
      const loaded = session.load(gen.nc!, toSetup(job, Z1), jobTool(job)!, Z1.id);
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.diagnostics));
      const report = session.oracle(gen.predicted, null, gen.designItems);
      expect(report.designCheck?.ok, JSON.stringify(report.designCheck?.worst)).toBe(true);
    } finally {
      session.dispose();
    }
  }, 120_000);

  it('R2: every graded item carries its raw outline as drawn, not the CAM’s opening', async () => {
    const job = badge();
    const gen = await generate(tl, job);
    const plan = regions(tl, job).plan;
    const rawArea = new Map(
      plan.engraves.map((e) => {
        const cs = executeProfile(tl, e.profile);
        const area = cs.area();
        cs.delete();
        return [e.id, area] as const;
      }),
    );
    const graded = gen.designItems.filter((d) => d.allowOnly !== true);
    expect(graded.length).toBeGreaterThan(0);
    for (const item of graded) {
      const cs = tl.CrossSection.ofPolygons(item.design);
      const area = cs.area();
      cs.delete();
      expect(area, `${item.itemId}: design area`).toBeCloseTo(rawArea.get(item.itemId!)!, 3);
    }
  }, 120_000);
});
