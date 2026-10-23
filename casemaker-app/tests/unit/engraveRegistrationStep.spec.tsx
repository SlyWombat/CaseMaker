// @vitest-environment jsdom
// #495 — the registration step: run the APPROVED plan over the console, show every touch and the
// margin verdict, write the origin only from a measurement inside the margin, and record the
// outcome in #494's seam. The console is a fake client; nothing reaches a machine.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  setMachineConsoleLoader,
  type ConsoleSend,
  type MachineConsoleClient,
} from '@/platform/machineConsole';
import { EngraveRegistrationStep } from '@/components/panels/EngraveRegistrationStep';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { surfaceSpreadPlan } from '@/engine/cnc/engrave/surfaceSpread';
import { planRegistration, type RegistrationPlan } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import {
  firstRegistrationFor,
  resetEngraveRegistrationStore,
  surfaceSpreadFor,
} from '@/store/engraveRegistrationStore';
import { useSettingsStore } from '@/store/settingsStore';
import { defaultBadgeParams } from '@/types/badge';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = { host: '192.0.2.10', port: 2222 };
const STOCK = { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 };

/** A vise plan for the thin laminate blank: the jaw tops sit 0.72 mm below the registered face. */
function makePlan(surfaceZ: number): RegistrationPlan {
  const { settings } = registrationSettings(null);
  const planned = planRegistration(
    {
      stock: STOCK,
      mount: 'vise',
      expectedSurface: { machineZ: surfaceZ, from: 'the blank as the setup holds it' },
      seekFromMachineZ: -3,
      fixtureBelowSurfaceMm: 0.72,
      cutCentre: { x: 24, y: 43 },
    },
    settings,
  );
  if (!planned.ok) throw new Error(planned.reason);
  return planned.plan;
}

/** A job whose FIRST setup carries an approved registration, the shape #471 writes. */
function attachPlan(job: EngraveJob, plan: RegistrationPlan): EngraveJob {
  const setup = jobSetups(job)[0]!;
  return {
    ...job,
    setups: [
      {
        ...setup,
        mount: { kind: 'vise' },
        registration: {
          method: 'vise',
          plan,
          expected: 'XY from the fixed jaw ±0.1 mm, Z from the surface touch',
        },
      },
    ],
  };
}

function jobWithPlan(plan: RegistrationPlan): EngraveJob {
  const job = defaultEngraveJob();
  job.name = 'Registration step fixture';
  job.stock = { ...job.stock, length: 38.1, width: 76.2, thickness: 3, material: 'petg' };
  return attachPlan(job, plan);
}

const COLOUR_0_2 = { kind: 'printed' as const, capMm: 0.81, layerHeight: 0.2, firstLayerHeight: 0.2 };

/** #475 — the badge blank of Appendix C: a 0.2 mm depth band, and the issue's own readings. */
function badgeJobWithPlan(plan: RegistrationPlan): EngraveJob {
  const blank = badgeBlankFor(defaultBadgeParams({ print: undefined }));
  const base = defaultEngraveJob();
  const line = base.labels[0] as EngraveLabel;
  const job: EngraveJob = {
    ...base,
    name: 'Bowed badge fixture',
    stock: { ...blank.stock, colour: COLOUR_0_2 },
    workholding: { kind: 'vise', vise: { ...base.workholding.vise, stockProud: 1.905 } },
    keepOuts: blank.pocket ? [blank.pocket] : [],
    labels: [{ ...line, position: { x: 24, y: 43 }, depth: 1.1 }],
  };
  return attachPlan(job, plan);
}

/** The spread plan the step builds: the approved plan's count and the sheet's own margin. */
function spreadPlanFor(job: EngraveJob) {
  const plan = surfaceSpreadPlan(job, {
    touchCount: registrationSettings(null).settings.surfaceTouchCount,
    margin: effectiveMargins(job, useSettingsStore.getState().margins).boundaryMargin,
  });
  if (plan === null) throw new Error('the fixture job has no cut regions');
  return plan;
}

interface FakeOptions {
  /** How far the stock really is from where the plan expects it, mm (edge scans). */
  edgeShiftMm?: number;
  /** Make the first scan touch a miss, so the first edge has no reading at all. */
  missFirstScanTouch?: boolean;
  /** Alarm on the registration's tool-length measurement. */
  alarmAtM491?: boolean;
  /** Answer the apply step's M491 with no PRB. */
  noCutterReading?: boolean;
  /** #475 — the surface the fake answers at each cut-extent touch, keyed by the sent XY. */
  spreadReadings?: readonly { x: number; y: number; z: number }[];
}

/**
 * A controller that plays back the executor's conversation. It tracks the last commanded XY so a
 * touch's PRB is where the line was sent, and it puts the edge where the stock really is: the probe
 * reads stock until its centre is the plan's rim offset past the true edge.
 */
function controller(plan: RegistrationPlan, sent: string[], opts: FakeOptions = {}): MachineConsoleClient {
  let g38 = 0;
  let m491 = 0;
  let lastX = 0;
  let lastY = 0;
  let missedScan = false;
  const stockZ = plan.seek.band.max - (plan.seek.band.max - plan.seek.band.min) / 2;

  const reply = (text: string): ConsoleSend => ({ ok: true, line: '', text, frames: 1, elapsedMs: 1 });

  return {
    async open() {
      return {
        async send(line: string): Promise<ConsoleSend> {
          sent.push(line);
          if (line === '?') return reply('<Idle|MPos:0,0,0>');
          if (line === 'M491') {
            m491 += 1;
            if (opts.alarmAtM491 === true && m491 === 1) return reply('ALARM: Probe fail');
            if (opts.noCutterReading === true && m491 > 1) return reply('ok');
            return reply('ok\n[PRB:0,0,-80.000:1]');
          }
          if (line.startsWith('G0 X') || line.startsWith('G53 G0 X')) {
            const x = /X(-?[\d.]+)/.exec(line);
            const y = /Y(-?[\d.]+)/.exec(line);
            if (x !== null) lastX = Number(x[1]);
            if (y !== null) lastY = Number(y[1]);
            return reply('ok');
          }
          if (line.startsWith('G38.3')) {
            g38 += 1;
            // The first two are the surface seek's fast and slow touch, at the registration point.
            if (g38 <= 2) return reply(`[PRB:${lastX},${lastY},${stockZ}:1]\nok`);
            const scan = plan.scans.find((s) =>
              s.edge === 'left' || s.edge === 'right'
                ? Math.abs(lastY - s.along) < 1e-6
                : Math.abs(lastX - s.along) < 1e-6,
            );
            if (scan === undefined) {
              // #475/#591 — the cut extents. The executor places each touch by the offset the scans
              // FOUND, which is only as exact as the scan's fine step and rim correction, so a touch
              // within that resolution of the planned point reads it — as the real blank would.
              const reading = opts.spreadReadings?.find(
                (r) => Math.abs(r.x - lastX) <= 0.6 && Math.abs(r.y - lastY) <= 0.6,
              );
              return reply(`[PRB:${lastX},${lastY},${reading?.z ?? stockZ}:1]\nok`);
            }
            if (opts.missFirstScanTouch === true && !missedScan) {
              missedScan = true;
              return reply(`[PRB:${lastX},${lastY},${stockZ - plan.settings.capBelowSurfaceMm}:0]\nok`);
            }
            const at = scan.edge === 'left' || scan.edge === 'right' ? lastX : lastY;
            const trueEdge = scan.expectedAt + (opts.edgeShiftMm ?? 0);
            const inside = scan.outward * (at - trueEdge) < plan.settings.tipRadiusMm;
            return inside
              ? reply(`[PRB:${lastX},${lastY},${stockZ}:1]\nok`)
              : reply(`[PRB:${lastX},${lastY},${stockZ - plan.settings.capBelowSurfaceMm}:0]\nok`);
          }
          return reply('ok');
        },
        async close() {},
      };
    },
  };
}

const sent: string[] = [];
let savedJob: EngraveJob;

beforeEach(() => {
  sent.length = 0;
  savedJob = useEngraveJobStore.getState().job;
  resetEngraveRegistrationStore();
});

afterEach(() => {
  cleanup();
  setMachineConsoleLoader(null);
  useEngraveJobStore.setState({ job: savedJob });
});

function install(plan: RegistrationPlan, opts: FakeOptions = {}): void {
  setMachineConsoleLoader(async () => controller(plan, sent, opts));
}

async function runStep(): Promise<void> {
  fireEvent.click(screen.getByTestId('engrave-registration-at-machine'));
  await act(async () => {
    fireEvent.click(screen.getByTestId('engrave-registration-start'));
  });
  await screen.findByTestId('engrave-registration-touches');
}

async function writeOrigin(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('engrave-registration-write'));
  });
  await screen.findByTestId('engrave-registration-continue');
  await act(async () => {
    fireEvent.click(screen.getByTestId('engrave-registration-continue'));
  });
}

describe('#495 — the registration step', () => {
  it.each([
    ['thin film, jaw tops below the face', -56.172],
    ['the badge blank', -55.131],
  ])('runs the approved plan, shows the touches, writes the origin and records the outcome — %s', async (_name, surfaceZ) => {
    const plan = makePlan(surfaceZ);
    const job = jobWithPlan(plan);
    install(plan);
    // The step records the blank's measured flatness on the job the sheet reads (#475).
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    // The plan is the approved one, in the Setups section's words.
    expect(screen.getByTestId('engrave-registration-plan').textContent).toContain('Setup 1');
    expect(screen.getByTestId('engrave-registration-plan-summary').textContent).toContain('touch the surface at');

    await runStep();

    // Each scan is drawn with its expected edge and every touch classified by the executor.
    expect(screen.getByTestId('engrave-registration-scan-0').getAttribute('data-edge')).toBe('left');
    expect(screen.getByTestId('engrave-registration-scan-1').getAttribute('data-edge')).toBe('front');
    expect(screen.getByTestId('engrave-registration-touch-0-0').getAttribute('data-kind')).toBe('stock');
    expect(screen.getAllByText(/MISS — nothing within the cap/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('engrave-registration-verdict').getAttribute('data-usable')).toBe('true');
    expect(screen.getByTestId('engrave-registration-verdict').getAttribute('data-within-margin')).toBe('true');

    await writeOrigin();
    await screen.findByTestId('engrave-registration-recorded');

    // #387's order: the cutter's M491, then G10 L2 with Z0 in the cutter's frame.
    const m491 = sent.map((line, i) => (line === 'M491' ? i : -1)).filter((i) => i >= 0);
    const g10 = sent.findIndex((line) => line.startsWith('G10 L2 P1'));
    expect(m491.length).toBe(2);
    expect(g10).toBeGreaterThan(m491[1]!);
    expect(sent[g10]).toContain(`Z${surfaceZ.toFixed(3)}`);

    // The one registration record #494's release gate reads.
    const recorded = firstRegistrationFor(job.id, TARGET);
    expect(recorded).not.toBeNull();
    expect(recorded!.plan).toEqual(plan);
    expect(recorded!.outcome.surfaceZ).toBe(surfaceZ);
    expect(recorded!.outcome.usable).toBe(true);

    // #475 — the measured spread is on the job for #432 R9's facing default. This fake answers
    // every extent at the same height, so the measured drops are 0 and their provenance is measured.
    // #496 — both spans, with the touch count and the date the surface was measured.
    expect(useEngraveJobStore.getState().job.stock.flatness).toMatchObject({
      xMm: 0,
      yMm: 0,
      source: 'measured',
      touchCount: 5,
      measuredAt: expect.any(String),
    });
    expect(surfaceSpreadFor(job.id, TARGET)?.assessment.spread).toBe(0);
  });

  it('refuses the origin when the measured edges are outside the margin, and records nothing', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    install(plan, { edgeShiftMm: 0.5 });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    await runStep();

    expect(screen.getByTestId('engrave-registration-verdict').getAttribute('data-usable')).toBe('true');
    expect(screen.getByTestId('engrave-registration-verdict').getAttribute('data-within-margin')).toBe('false');
    expect(screen.getByTestId('engrave-registration-refusal').textContent).toContain('outside the');
    expect(screen.queryByTestId('engrave-registration-write')).toBeNull();
    expect(sent.some((line) => line.startsWith('G10 L2'))).toBe(false);
    expect(firstRegistrationFor(job.id, TARGET)).toBeNull();
  });

  it('refuses a blank bowed wider than the cut’s band, writes no origin, and records the measured flatness (#475)', async () => {
    const plan = makePlan(-55.131);
    const job = badgeJobWithPlan(plan);
    const spread = spreadPlanFor(job);
    // The issue's five readings, in the plan's order: centre, left, right, front, back. The first
    // is the registration touch itself, so the executor reuses that reading.
    const zs = [-55.131, -55.269, -55.232, -55.315, -55.341];
    install(plan, {
      spreadReadings: spread.touches.map((t, i) => ({ x: t.x, y: t.y, z: zs[i]! })),
    });
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    await runStep();

    expect(screen.getByTestId('engrave-registration-spread').getAttribute('data-ok')).toBe('false');
    expect(screen.getByTestId('engrave-registration-spread').textContent).toContain('spread 0.21 mm against the 0.2 mm band');
    expect(screen.getByTestId('engrave-registration-spread-refusal').textContent).toBe(
      'this blank is bowed 0.21 mm across the cut; the floors cannot stay past the colour line and clear of the pocket',
    );
    expect(screen.queryByTestId('engrave-registration-landing')).toBeNull();
    expect(screen.getByTestId('engrave-registration-refusal').textContent).toContain(
      'No origin is written: this blank is bowed 0.21 mm',
    );
    expect(screen.getByTestId('engrave-registration-verdict').getAttribute('data-usable')).toBe('false');

    // A refusal writes nothing and records no origin, but the MEASUREMENT is still kept: the run
    // sheet prints the refusal, and #432 R9 reads the blank's measured flatness.
    expect(screen.queryByTestId('engrave-registration-write')).toBeNull();
    expect(sent.some((line) => line.startsWith('G10 L2'))).toBe(false);
    expect(firstRegistrationFor(job.id, TARGET)).toBeNull();
    expect(surfaceSpreadFor(job.id, TARGET)?.assessment.spread).toBe(0.21);
    expect(surfaceSpreadFor(job.id, TARGET)?.assessment.ok).toBe(false);
    // #496 — the job records the pair, each span on its own stock axis, not one ambiguous "across".
    expect(useEngraveJobStore.getState().job.stock.flatness).toMatchObject({
      xMm: 0.138,
      yMm: 0.21,
      source: 'measured',
      touchCount: 5,
      measuredAt: expect.any(String),
    });
  });

  it('refuses a scan that is already off the stock, writes nothing, and records nothing', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    install(plan, { missFirstScanTouch: true });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    await runStep();

    expect(screen.getByTestId('engrave-registration-verdict').getAttribute('data-usable')).toBe('false');
    expect(screen.getByTestId('engrave-registration-problems').textContent).toContain('already off the stock');
    expect(screen.queryByTestId('engrave-registration-write')).toBeNull();
    expect(sent.some((line) => line.startsWith('G10 L2'))).toBe(false);
    expect(firstRegistrationFor(job.id, TARGET)).toBeNull();
  });

  it('stops and homes on an alarm, and records nothing', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    install(plan, { alarmAtM491: true });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    fireEvent.click(screen.getByTestId('engrave-registration-at-machine'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-start'));
    });
    await screen.findByTestId('engrave-registration-failed');

    expect(screen.getByTestId('engrave-registration-failed').textContent).toContain('ALARM');
    expect(sent).toContain('$X');
    expect(sent).toContain('$H');
    expect(firstRegistrationFor(job.id, TARGET)).toBeNull();
  });

  it('writes no origin and records nothing when the cutter M491 has no reading', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    install(plan, { noCutterReading: true });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    await runStep();
    await writeOrigin();
    await screen.findByTestId('engrave-registration-write-failed');

    expect(screen.getByTestId('engrave-registration-write-failed').textContent).toContain('no tool-length reading');
    expect(sent.some((line) => line.startsWith('G10 L2'))).toBe(false);
    expect(firstRegistrationFor(job.id, TARGET)).toBeNull();
  });

  it('runs the plan that round-tripped through the job document, not a re-derived one', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const reloaded = parsed.job;
    expect(reloaded.setups![0]!.registration!.plan).toEqual(plan);

    install(plan);
    render(<EngraveRegistrationStep job={reloaded} target={TARGET} />);
    await runStep();
    await writeOrigin();
    await screen.findByTestId('engrave-registration-recorded');

    const recorded = firstRegistrationFor(reloaded.id, TARGET);
    expect(recorded).not.toBeNull();
    expect(recorded!.plan).toEqual(plan);
  });

  it('runs nothing and says where the plan comes from when the setup has no approved registration', () => {
    const job = defaultEngraveJob();
    render(<EngraveRegistrationStep job={job} target={TARGET} />);
    expect(screen.getByTestId('engrave-registration-no-plan').textContent).toContain('Design → Setups');
    expect(screen.queryByTestId('engrave-registration-start')).toBeNull();
    expect(sent).toEqual([]);
  });

  it('runs nothing without a machine target', () => {
    const plan = makePlan(-56.172);
    render(<EngraveRegistrationStep job={jobWithPlan(plan)} target={null} />);
    expect(screen.getByTestId('engrave-registration-no-machine').textContent).toContain('No machine is connected');
    expect(screen.queryByTestId('engrave-registration-start')).toBeNull();
    expect(sent).toEqual([]);
  });
});
