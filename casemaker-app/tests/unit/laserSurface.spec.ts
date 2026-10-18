// #457 — the laser's lift bound, derived from the surface this job REGISTERED.
//
// The bound is work Z0 moved into machine Z (`registration/plan.ts`'s conversion: a work-frame
// `topZ` sits at `surfaceZ + topZ`), plus whatever stands above that surface on the mount — the
// vise jaws when the blank sits below their tops, or the bracket's arms and clamps. The guard in
// `machineLaser.ts` then asks one question of the result: is the fixed travel height above it?

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import { liftProblem } from '@/platform/machineLaser';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { laserSurfaceBound, laserLiftFor } from '@/engine/cnc/engrave/laserSurface';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { bracketMount } from '@/engine/cnc/mounts/bracket';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS: ShopDefaults = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);

/** The Z1's fixed travel height and soft-endstop floor, as the laser panels receive them. */
const LIFT = { zMachine: -3, zFloorMachine: -102 };

/** The job held on the bracket for its first setup (the Cut surface runs setup 0). */
function bracketJob(): EngraveJob {
  const job = defaultEngraveJob();
  const [implicit] = jobSetups(job);
  job.setups = [{ ...implicit!, id: 'setup-bracket', mount: { kind: 'bracket', board: false } }];
  return job;
}

describe('#457 the laser lift bound from the registered surface', () => {
  it('takes the JAW TOPS when a thin blank sits below them (top −57.6, jaw tops −56.6)', () => {
    const job = defaultEngraveJob();
    // The blank stands 1 mm BELOW the jaw tops: work Z −stockProud = +1 above its own top.
    job.workholding.vise.stockProud = -1;
    const bound = laserSurfaceBound(job, -57.6, DEFAULTS);
    expect(bound.surfaceMachineZ).toBe(-57.6);
    expect(bound.obstacle).toEqual({ label: 'the vise jaws', machineZ: -56.6 });
    // The lift clears the jaws, so the fixed −3 is allowed — and it is the JAWS that bound it, not
    // the top the registration measured.
    expect(bound.topMachineZ).toBe(-56.6);
    expect(liftProblem({ ...LIFT, stockTopMachineZ: bound.topMachineZ })).toBeNull();
  });

  it('leaves the surface as the bound when the jaws sit below the stock, and on tape', () => {
    const proud = defaultEngraveJob();
    // The blank stands 1.905 mm above the jaw tops: work Z −1.905, BELOW the registered top.
    proud.workholding.vise.stockProud = 1.905;
    expect(laserSurfaceBound(proud, -55.131, DEFAULTS)).toEqual({
      surfaceMachineZ: -55.131,
      obstacle: null,
      topMachineZ: -55.131,
    });

    const taped = bracketJob();
    taped.setups = [{ ...jobSetups(taped)[0]!, id: 'setup-tape', mount: { kind: 'tape', board: true } }];
    expect(laserSurfaceBound(taped, -55.131, DEFAULTS).obstacle).toBeNull();
  });

  it('takes the highest bracket or clamp top on the bracket mount, in machine Z', () => {
    const job = bracketJob();
    const mount = bracketMount(
      { x: job.stock.length, y: job.stock.width, z: job.stock.thickness },
      'bracket',
      DEFAULTS,
    )!;
    const highest = [...mount.obstacles].sort((a, b) => b.topZ - a.topZ)[0]!;
    const bound = laserSurfaceBound(job, -12, DEFAULTS);
    expect(bound.topMachineZ).toBe(-12 + highest.topZ);
    expect(bound.obstacle).toEqual({ label: highest.label, machineZ: -12 + highest.topZ });
  });

  it('REFUSES a fixed travel height a clamp stands above, naming the clamp', () => {
    // A surface far enough below machine zero that the stock's own top clears −3, while a clamp —
    // 12 mm above the stock's top — does not. Without the registered surface nothing would catch it.
    const job = bracketJob();
    const bound = laserSurfaceBound(job, -10, DEFAULTS);
    expect(bound.surfaceMachineZ).toBe(-10);
    expect(bound.topMachineZ).toBeGreaterThan(LIFT.zMachine);
    // The lift the panels actually receive, so the refusal names what it hit, not a bare number.
    const lift = laserLiftFor(job, { surfaceMachineZ: -10, measuredAt: '2026-10-18T02:14:00.000Z' }, DEFAULTS);
    expect(lift.zMachine).toBe(LIFT.zMachine);
    expect(liftProblem(lift)).toBe(
      'the travel height (machine Z -3) is not above the clamp on the back edge, 15 mm in from the left-hand corner (machine Z 2)',
    );
    // The same surface with NO registration is not refused — which is exactly the hole #457 closes.
    expect(liftProblem(LIFT)).toBeNull();
  });
});

describe('#457 the lift both laser panels receive', () => {
  it('carries the registered surface, its date and the obstacle above it', () => {
    const job = defaultEngraveJob();
    job.workholding.vise.stockProud = -1;
    const lift = laserLiftFor(job, { surfaceMachineZ: -57.6, measuredAt: '2026-10-18T02:14:00.000Z' }, DEFAULTS);
    expect(lift).toEqual({
      zMachine: -3,
      zFloorMachine: -102,
      stockTopMachineZ: -56.6,
      stockTop: {
        surfaceMachineZ: -57.6,
        measuredAt: '2026-10-18T02:14:00.000Z',
        obstacle: { label: 'the vise jaws', machineZ: -56.6 },
      },
    });
  });

  it('keeps the fixed height and claims no top when this job has no registration', () => {
    // No `stockTopMachineZ`, so `liftProblem` cannot pass a top it was never given, and the panels
    // print "no registration recorded" (#457) instead of implying the stock's top was checked.
    expect(laserLiftFor(defaultEngraveJob(), null, DEFAULTS)).toEqual({ zMachine: -3, zFloorMachine: -102 });
  });
});
