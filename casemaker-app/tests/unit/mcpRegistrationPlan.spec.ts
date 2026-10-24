// #605 — a job with a v2 registration plan keeps its probe and mountDatum through a round trip.
//
// `engraveJobSchema` strips keys its objects do not name, so a plan field that is not accepted on
// the way IN would vanish on reload. The planner produces a real plan carrying both the checked-out
// probe and the measured jaw-top datum; the job document must keep them.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRegistration, type PlanInput } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '@/store/engraveJobSchema';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };
const { settings: S } = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults));

const BLANK = { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 };
const SURFACE = -56.172;
const MOUNT_DATUM = { jawTopZ: SURFACE - 1.84, measuredAt: '2026-10-23T00:00:00.000Z', by: 'wired-probe' };
const PROBE = { id: 'fx-probe-1', variant: 'wired-touch', tip: { diameterMm: 3.0, rimOffsetMm: 0.9, rimOffsetUncertaintyMm: 0.2 } };

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    stock: BLANK,
    mount: 'vise',
    expectedSurface: { machineZ: SURFACE, from: 'the vise top and the blank’s proud height' },
    seekFromMachineZ: -3,
    fixtureBelowSurfaceMm: 0.72,
    mountDatum: MOUNT_DATUM,
    probe: PROBE,
    ...over,
  };
}

describe('#605 a v2 registration plan round-trips', () => {
  it('keeps its probe and mountDatum through the job document', () => {
    const r = planRegistration(input(), S);
    if (!r.ok) throw new Error(r.reason);

    const job = defaultEngraveJob();
    const setups = jobSetups(job).map((s) => ({
      ...s,
      orientation: { ...s.orientation },
      itemIds: [...s.itemIds],
      tools: [...s.tools],
    }));
    setups[0]!.registration = { method: 'vise', plan: r.plan, expected: 'Z from the surface touch' };
    job.setups = setups;

    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const reg = parsed.job.setups?.[0]?.registration;
    expect(reg?.plan.mountDatum).toEqual(MOUNT_DATUM);
    expect(reg?.plan.probe).toEqual(PROBE);
  });
});
