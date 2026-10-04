// #213: "no sacrificial material behaves exactly as before", as bytes.
//
// The default engrave job's posted `.nc` is snapshotted to a golden file, and the SAME job with
// the jaw-strip preset chosen posts to the same bytes — the sacrificial model never reaches the
// toolpath IR (#173's `postZ1`). A real byte comparison, not an inspection: the emitted `.nc` is
// what the machine runs, so it is the strongest form the claim "unchanged" can take.
//
// The golden is generated on first run (`toMatchFileSnapshot` writes it when absent); later runs
// compare against it, and a change to the default job's toolpath fails here rather than silently
// shipping.

import { describe, it, expect } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { cuttingRadiusForSweep } from '@/engine/cnc/tool';
import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { labelProfile } from '@/engine/cnc/engrave/partPlan';
import { engravableProfile } from '@/engine/cnc/engrave/engravable';
import { generateEngrave, type EngraveRegion } from '@/engine/cnc/cam/engraveJob';
import { presetJawStrips } from '@/engine/cnc/sacrificial';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import { tl } from './helpers/manifoldExec';

/**
 * The default job, with its label ids pinned so the golden cannot depend on the id generator.
 * (Ids only reach the IR as an ordering tiebreaker, but pinning them removes the question.)
 */
function defaultJob(over: Partial<EngraveJob> = {}): EngraveJob {
  const job = defaultEngraveJob();
  job.labels.forEach((l, i) => (l.id = `lbl-fixed-${i + 1}`));
  return { ...job, ...over };
}

/** The default job's labels opened for the sweep of the IR generation, then posted to `.nc`. */
function defaultJobNc(job: EngraveJob): string {
  const tool = jobTool(job);
  if (!tool) throw new Error('the default job has no tool');
  const radius = cuttingRadiusForSweep(tool);
  if (!radius.ok) throw new Error(radius.reason);
  const feeds = feedsFor(job.stock.material, tool, Z1);
  if (!feeds.ok) throw new Error(feeds.reason);

  const opened = (label: EngraveLabel): Polygons => {
    const cs = executeProfile(tl, engravableProfile(labelProfile(label, []), radius.radius));
    const polygons = cs.toPolygons() as Polygons;
    cs.delete();
    return polygons;
  };
  const labels: EngraveRegion[] = job.labels
    .filter((l) => l.enabled && l.text.trim().length > 0)
    .map((l) => ({ id: l.id, text: l.text, depth: l.depth, polygons: opened(l) }));
  const ir = generateEngrave(tl, labels, tool, feeds.params);

  const ctx: PostContext = {
    jobName: job.name,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    materialName: job.stock.material,
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: '1.0.0',
  };
  const res = postZ1(ir, ctx, Z1);
  if (!res.ok) throw new Error(res.errors.join('; '));
  return res.text;
}

describe('#213: the default job posts byte-identical output with and without sacrificial material', () => {
  it('the default job (no sacrificial material) is the golden .nc', async () => {
    await expect(defaultJobNc(defaultJob())).toMatchFileSnapshot('./fixtures/default-job.nc');
  });

  it('the same job with the jaw-strip preset posts the exact same bytes', () => {
    const base = defaultJob();
    const withStrips = defaultJob({ sacrificial: presetJawStrips() });
    // Both are the same job but for `sacrificial`; the strips change nothing the machine sees.
    expect(withStrips.sacrificial).not.toEqual(base.sacrificial);
    expect(defaultJobNc(withStrips)).toBe(defaultJobNc(base));
  });
});
