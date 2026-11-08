// @vitest-environment jsdom
// #495 — the registration step: run the APPROVED plan over the console, show every touch and the
// margin verdict, write the origin only from a measurement inside the margin, and record the
// outcome in #494's seam. The console is a fake client; nothing reaches a machine.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobVise } from '@/engine/cnc/fixture';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  setMachineConsoleLoader,
  type ConsoleSend,
  type MachineConsoleClient,
} from '@/platform/machineConsole';
import { EngraveRegistrationStep } from '@/components/panels/EngraveRegistrationStep';
import { useLocationStore } from '@/store/locationStore';
import type { MachineRecord } from '@/platform/locationClient';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultRotaryChuck } from '@/engine/cnc/engrave/setupFlow';
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
import { resetRegistrationTouchesStore, useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import { useSettingsStore } from '@/store/settingsStore';
import { defaultBadgeParams } from '@/types/badge';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// #607 — vitest runs the WEB target, where the machine rows are compiled out; the axis-tap test
// flips the gate on just for itself (everything else in this file is the web build's behaviour).
const caps = vi.hoisted(() => ({ canReachMachine: false }));
vi.mock('@/platform/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/capabilities')>();
  return {
    ...actual,
    get canReachMachine() {
      return caps.canReachMachine;
    },
  };
});

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

/** #743 — a ⌀30 TAPE disc: the four rim scans the plan writes through the centre-lines. */
function makeDiscPlan(): RegistrationPlan {
  const { settings } = registrationSettings(null);
  const planned = planRegistration(
    {
      stock: { xMin: 0, yMin: 0, xMax: 30, yMax: 30, cornerRadius: 0 },
      mount: 'tape',
      expectedSurface: { machineZ: -55.131, from: 'the blank as the setup holds it' },
      seekFromMachineZ: -3,
      cutCentre: { x: 15, y: 15 },
      disc: { diameterMm: 30 },
    },
    { ...settings, fineStepMm: 0.05 },
  );
  if (!planned.ok) throw new Error(planned.reason);
  return planned.plan;
}

/** A disc job with the approved rim plan: one label near the centre, so the sheet has a cut. */
function discJobWithPlan(plan: RegistrationPlan): EngraveJob {
  const job = defaultEngraveJob();
  job.name = 'Disc registration fixture';
  job.stock = { length: 30, width: 30, thickness: 3, material: 'pla', shape: 'disc', diameter: 30 };
  job.labels = [
    {
      id: 'txt',
      text: 'HELLO',
      font: 'sans-default',
      weight: 'regular',
      size: 5,
      position: { x: 15, y: 17 },
      rotation: 0,
      depth: 0.5,
      enabled: true,
    },
  ];
  return attachPlan(job, plan);
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
    workholding: { kind: 'vise', vise: { ...jobVise(base), stockProud: 1.905 } },
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
  /** Alarm on the registration's tool-length measurement. */
  alarmAtM491?: boolean;
  /** Alarm on the surface seek's FAST touch (the first G38.3): a stop in relative mode. */
  alarmAtFastTouch?: boolean;
  /** #588 — the surface seek's FAST touch finds nothing: a clean, Idle stop (no alarm). */
  missFastTouch?: boolean;
  /** Answer the apply step's M491 with no PRB. */
  noCutterReading?: boolean;
  /** #475 — the surface the fake answers at each cut-extent touch, keyed by the sent XY. */
  spreadReadings?: readonly { x: number; y: number; z: number }[];
  /**
   * #933 — HOLD the first `G38.3`'s reply until `release()` is called: the run is then mid-touch,
   * which is what the Stop button must be able to interrupt.
   */
  holdTouch?: { release?: () => void };
  /**
   * #743 — the piece is a DISC with these true spans, centred on the planned box: each rim edge is
   * where that span puts it, so a test can make the blank a little larger or smaller than stated.
   */
  discSpans?: { x: number; y: number };
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
  /** The machine's own State word — settable so a test can alarm it; `$X` returns it to Idle. */
  let state = 'Idle';
  const stockZ = plan.seek.band.max - (plan.seek.band.max - plan.seek.band.min) / 2;

  const reply = (text: string): ConsoleSend => ({ ok: true, line: '', text, frames: 1, elapsedMs: 1 });

  return {
    async open() {
      return {
        async send(line: string): Promise<ConsoleSend> {
          sent.push(line);
          if (line === '?') return reply(`<${state}|MPos:0,0,0>`);
          if (line === '$X') return (state = 'Idle'), reply('ok');
          if (line === 'M491') {
            m491 += 1;
            if (opts.alarmAtM491 === true && m491 === 1) return (state = 'Alarm'), reply('ALARM: Probe fail');
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
            if (opts.holdTouch !== undefined && g38 === 1) {
              await new Promise<void>((resolve) => {
                opts.holdTouch!.release = resolve;
              });
              return reply(`[PRB:${lastX},${lastY},${stockZ}:1]\nok`);
            }
            if (opts.alarmAtFastTouch === true && g38 === 1) return (state = 'Alarm'), reply('ALARM: Probe fail');
            if (opts.missFastTouch === true && g38 === 1) return reply(`[PRB:${lastX},${lastY},${stockZ}:0]\nok`);
            // The first two are the surface seek's fast and slow touch, at the registration point.
            if (g38 <= 2) return reply(`[PRB:${lastX},${lastY},${stockZ}:1]\nok`);
            // #743 — a DISC's four scans share one centre-line, so the `along` match alone would
            // answer a right-edge scan with the left edge's rule. The side of the centre the probe
            // is on (`outward`) tells the two apart; a one-scan axis still matches by `along`.
            const centreX = (plan.stock.xMin + plan.stock.xMax) / 2;
            const centreY = (plan.stock.yMin + plan.stock.yMax) / 2;
            const xScans = plan.scans.filter(
              (s) => (s.edge === 'left' || s.edge === 'right') && Math.abs(lastY - s.along) < 1e-6,
            );
            const yScans = plan.scans.filter(
              (s) => (s.edge === 'front' || s.edge === 'back') && Math.abs(lastX - s.along) < 1e-6,
            );
            const pickSide = (list: typeof plan.scans, at: number, centre: number) =>
              list.length <= 1 ? list[0] : list.find((s) => Math.sign(at - centre) === s.outward);
            const scan = pickSide(xScans, lastX, centreX) ?? pickSide(yScans, lastY, centreY);
            if (scan === undefined) {
              // #475/#591 — the cut extents. The executor places each touch by the offset the scans
              // FOUND, which is only as exact as the scan's fine step and rim correction, so a touch
              // within that resolution of the planned point reads it — as the real blank would.
              const reading = opts.spreadReadings?.find(
                (r) => Math.abs(r.x - lastX) <= 0.6 && Math.abs(r.y - lastY) <= 0.6,
              );
              return reply(`[PRB:${lastX},${lastY},${reading?.z ?? stockZ}:1]\nok`);
            }
            const at = scan.edge === 'left' || scan.edge === 'right' ? lastX : lastY;
            // #743 — a disc's rim is where the span puts it about the planned box's centre.
            const discEdge =
              opts.discSpans === undefined
                ? null
                : scan.edge === 'left'
                  ? centreX - opts.discSpans.x / 2
                  : scan.edge === 'right'
                    ? centreX + opts.discSpans.x / 2
                    : scan.edge === 'front'
                      ? centreY - opts.discSpans.y / 2
                      : centreY + opts.discSpans.y / 2;
            const trueEdge = discEdge ?? scan.expectedAt + (opts.edgeShiftMm ?? 0);
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
  resetRegistrationTouchesStore();
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
  act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
  await act(async () => {
    fireEvent.click(screen.getByTestId('engrave-registration-start'));
  });
  // #519 item 1 — the per-scan readings left this component for the dock's Touches tab; what lands
  // here is the verdict (and the readings in the store, asserted below). A run that fails renders
  // the failure block instead, so the wait names both ends of the run.
  await screen.findByTestId('engrave-registration-verdict');
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

/** A location with the target machine and one bed profile, so the step's write chain runs. */
function beddedLocation() {
  useLocationStore.setState({
    status: 'present',
    etag: '"e1"',
    reason: null,
    location: {
      machines: [
        {
          id: 'm1',
          profileId: 'Z1',
          address: { host: TARGET.host, port: TARGET.port },
          bedProfiles: [
            {
              id: 'bp1',
              datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null },
              placements: [],
              surface: null,
              history: [],
            },
          ],
          activeBedProfileId: 'bp1',
          history: [],
          notes: [],
          observedAt: '2026-10-25T00:00:00.000Z',
        },
      ],
      accessories: [],
    } as unknown as NonNullable<ReturnType<typeof useLocationStore.getState>['location']>,
  });
}

describe('#636 — the write-backs read their answer', () => {
  it('a save that does not land is stated on the result, never reported as recorded', async () => {
    const plan = makePlan(-55.131);
    const job = jobWithPlan(plan);
    install(plan);
    beddedLocation();
    const calls: string[] = [];
    useLocationStore.setState({
      // Every attempt fails (two, because a 'failed' answer gets no retry beyond the stale rule).
      saveMachine: async () => {
        calls.push('failed');
        useLocationStore.setState({ writeNote: 'the location document changed elsewhere' });
        return 'failed';
      },
    });
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);
    await runStep();

    expect(calls).toEqual(['failed']);
    const notes = screen.getByTestId('engrave-registration-notes').textContent ?? '';
    expect(notes).toContain('the measurement was taken, but the record was not saved: the location document changed elsewhere');
    expect(notes).not.toContain('recorded');
  });

  it('a stale guard retries once against the re-read and records on the second answer', async () => {
    const plan = makePlan(-55.131);
    const job = jobWithPlan(plan);
    install(plan);
    beddedLocation();
    const answers: Array<'stale' | 'ok'> = ['stale', 'ok'];
    useLocationStore.setState({
      saveMachine: async () => answers.shift() ?? 'ok',
    });
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);
    await runStep();

    expect(answers).toHaveLength(0); // both answers consumed: one retry, then ok
    const notes = screen.queryByTestId('engrave-registration-notes')?.textContent ?? '';
    expect(notes).not.toContain('not saved');
  });
});

describe('#639 a re-run forgets the last clamping', () => {
  it('clears the record and the surface when the run starts, and a failed run leaves neither', async () => {
    const plan = makePlan(-55.131);
    const job = jobWithPlan(plan);
    const spreadPlan = spreadPlanFor(job);
    // The previous clamping: a recorded origin and a measured surface (a dome, so the Cut step would
    // carry its tick). The re-run below alarms out at the first touch after the operator re-seated.
    useEngraveRegistrationStore.getState().record(job.id, TARGET, plan, {
      usable: true,
      surfaceZ: -55.131,
      offset: { x: 0, y: 0 },
      measured: { x: true, y: true },
      problems: [],
      notes: [],
      correctedG54: { x: 0, y: 0 },
    } as never);
    useEngraveRegistrationStore.getState().measureSurface(job.id, TARGET, {
      plan: spreadPlan,
      touches: [],
      min: { z: -55.3 },
      max: { z: -55 },
      spread: 0.3,
      drops: { xMm: 0.3, yMm: 0 },
      z0: { z: -55.3, touchId: null, rule: 'lowest' },
      fit: { kind: 'plane', offset: -55.15, slopeX: 0, slopeY: 0, residual: 0.3 },
      tilt: { xMm: 0, yMm: 0 },
      ok: false,
      verdict: 'dome',
    } as never);
    expect(useEngraveRegistrationStore.getState().records[job.id]).toBeDefined();
    expect(useEngraveRegistrationStore.getState().surfaces[job.id]).toBeDefined();

    install(plan, { alarmAtFastTouch: true });
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);
    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-start'));
    });
    // The start cleared the previous clamping's record and surface...
    expect(useEngraveRegistrationStore.getState().records[job.id]).toBeUndefined();
    expect(useEngraveRegistrationStore.getState().surfaces[job.id]).toBeUndefined();
    // ...and the failed run leaves nothing behind: no "recorded" claim survives a stop.
    await screen.findByTestId('engrave-registration-failed');
    expect(useEngraveRegistrationStore.getState().records[job.id]).toBeUndefined();
    expect(useEngraveRegistrationStore.getState().surfaces[job.id]).toBeUndefined();
  });
});

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

    // #519 item 1 — every reading the executor landed is in the store, in order: the surface seek
    // first, then the scans, with each edge's classification. The same readings feed the viewport's
    // dots and the dock's table (asserted in machineDock.spec.tsx); the rail no longer prints them.
    const live = useRegistrationTouchesStore.getState().touches;
    expect(live[0]?.source).toBe('surface');
    const edges = live.filter((t) => t.source === 'edge');
    // One label per scan, in the plan's order — the bisection lands several touches per edge.
    expect([...new Set(edges.map((t) => t.label))]).toEqual(
      plan.scans.map((s) => s.label ?? `the ${s.edge} edge`),
    );
    expect(edges[0]?.kind).toBe('stock');
    expect(edges.some((t) => t.kind === 'miss')).toBe(true);
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

  it('#620 — outside the margin offers "Use the found position", which writes the origin', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    install(plan, { edgeShiftMm: 0.5 });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    await runStep();

    expect(screen.getByTestId('engrave-registration-use-found')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-use-found'));
    });
    // The cutter-fit prompt the origin write always asks, then the origin lands and the record is written.
    await screen.findByTestId('engrave-registration-continue');
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-continue'));
    });
    await screen.findByTestId('engrave-registration-written');
    expect(firstRegistrationFor(job.id, TARGET)).not.toBeNull();
  });

  it('#631 — a dome writes the origin (Z0 = lowest), shows the G32 route, and records no plane re-post', async () => {
    const plan = makePlan(-55.0);
    const job = badgeJobWithPlan(plan);
    const spread = spreadPlanFor(job);
    // Appendix C's badge dome: the centre 0.33 mm above every extent. A plane cannot explain a dome,
    // so the residual (4/5 of the dome height) exceeds the 0.2 mm band and the verdict is `dome`.
    const zs = [-55.0, -55.33, -55.33, -55.33, -55.33];
    install(plan, {
      spreadReadings: spread.touches.map((t, i) => ({ x: t.x, y: t.y, z: zs[i]! })),
    });
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    await runStep();

    expect(screen.getByTestId('engrave-registration-spread').getAttribute('data-ok')).toBe('false');
    // #501/#631 — the verdict is a DOME, in so many words; the dead-end refusal is gone.
    expect(screen.getByTestId('engrave-registration-shape').getAttribute('data-verdict')).toBe('dome');
    expect(screen.getByTestId('engrave-registration-shape').textContent).toContain('dome — a curved top, not a tilt');
    // #630 — the verdict says how far OUTSIDE the band the residual sits.
    expect(screen.getByTestId('engrave-registration-shape').textContent).toContain('miss the plane by');
    expect(screen.getByTestId('engrave-registration-shape').textContent).toContain('outside the 0.2 mm band');
    expect(screen.getByTestId('engrave-registration-spread').textContent).toContain('spread 0.33 mm against the 0.2 mm band');
    // #630 (amended) — the operator gets the routes IN ORDER (G32 first, the accepted miss second,
    // the re-seat note last and as information only), not a dead end. No issue numbers in the text.
    const guidance = screen.getByTestId('engrave-registration-dome-guidance').textContent!;
    expect(guidance.indexOf('G32 from the console levels the curved top')).toBe(0);
    expect(guidance.indexOf('write the origin anyway')).toBeGreaterThan(0);
    expect(guidance.indexOf('lighter re-seat')).toBeGreaterThan(guidance.indexOf('write the origin anyway'));
    expect(guidance).toContain('chip');
    expect(guidance).toContain('uploads FLAT');
    // #631 — the machine route names its assumption and the landing it does not check.
    expect(guidance).toContain('G32 follows the top');
    expect(guidance).toContain('no landing range is checked');
    expect(guidance).not.toMatch(/#\d/);
    // The dome block offers the machine-side route instead of a refusal.
    expect(screen.getByTestId('engrave-registration-dome').textContent).toContain('uploads FLAT');
    expect(screen.queryByTestId('engrave-registration-landing')).toBeNull();
    expect(screen.queryByTestId('engrave-registration-refusal')).toBeNull();
    // The origin IS written: the outcome is usable and the write button is offered.
    expect(screen.getByTestId('engrave-registration-verdict').getAttribute('data-usable')).toBe('true');
    expect(screen.getByTestId('engrave-registration-write')).toBeTruthy();

    await writeOrigin();
    await screen.findByTestId('engrave-registration-recorded');
    expect(sent.some((line) => line.startsWith('G10 L2'))).toBe(true);
    const recorded = firstRegistrationFor(job.id, TARGET);
    expect(recorded).not.toBeNull();
    // A dome cannot be re-posted against: the record carries no fitted surface.
    expect(recorded!.surface).toBeNull();

    // The MEASUREMENT is still kept: the run sheet prints the dome route, and #432 R9 reads the
    // blank's measured flatness.
    expect(surfaceSpreadFor(job.id, TARGET)?.assessment.spread).toBe(0.33);
    expect(surfaceSpreadFor(job.id, TARGET)?.assessment.verdict).toBe('dome');
    // #519 item 1 — the extents are emitted as readings too, and the dock's store closes with the
    // dome sentence. #630 — the transcript line carries the residual against the band.
    const live = useRegistrationTouchesStore.getState();
    expect(live.touches.some((t) => t.source === 'spread')).toBe(true);
    expect(live.spreadSentence).toContain('dome');
    expect(live.spreadSentence).toContain('outside the');
    // #496 — the job records the pair, each span on its own stock axis, not one ambiguous "across".
    expect(useEngraveJobStore.getState().job.stock.flatness).toMatchObject({
      xMm: 0.33,
      yMm: 0.33,
      source: 'measured',
      touchCount: 5,
      measuredAt: expect.any(String),
    });
  });

  it('#593 — a scan whose first touch misses searches inward and finds the edge, usable but outside the margin', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    // The stock sits 5 mm along the jaws, past `scanInsideMm` (3): the first touch of each scan is
    // air, and the executor steps inward until a touch lands on the stock, so the run completes
    // (usable) and the offset is simply far outside the margin — not a false refusal.
    install(plan, { edgeShiftMm: 5 });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    await runStep();

    expect(screen.getByTestId('engrave-registration-verdict').getAttribute('data-usable')).toBe('true');
    expect(screen.getByTestId('engrave-registration-verdict').getAttribute('data-within-margin')).toBe('false');
    expect(screen.getByTestId('engrave-registration-refusal').textContent).toContain('outside the');
    expect(screen.queryByTestId('engrave-registration-write')).toBeNull();
    expect(sent.some((line) => line.startsWith('G10 L2'))).toBe(false);
    expect(firstRegistrationFor(job.id, TARGET)).toBeNull();
  });

  it('stops and homes on an alarm, and records nothing', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    install(plan, { alarmAtM491: true });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-start'));
    });
    await screen.findByTestId('engrave-registration-failed');

    expect(screen.getByTestId('engrave-registration-failed').textContent).toContain('ALARM');
    // #588 — the state read answered Alarm, so exactly one `$X` cleared it before `$H`.
    expect(sent.filter((l) => l === '$X')).toHaveLength(1);
    expect(sent.indexOf('$X')).toBeLessThan(sent.lastIndexOf('$H'));
    expect(sent).toContain('$H');
    expect(firstRegistrationFor(job.id, TARGET)).toBeNull();
  });

  it('#588 — an Idle stop homes immediately: no `$X` is sent (an Idle machine would sit out the 60 s window)', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    // The fast surface seek finds nothing: a clean stop, the machine reads Idle throughout.
    install(plan, { missFastTouch: true });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-start'));
    });
    await screen.findByTestId('engrave-registration-failed');

    expect(screen.getByTestId('engrave-registration-failed').textContent).toContain('The machine is Idle; nothing to recover');
    expect(sent).not.toContain('$X');
    expect(sent).toContain('$H');
    expect(firstRegistrationFor(job.id, TARGET)).toBeNull();
  });

  it('#588 — an alarmed relative stop clears the alarm ONCE: stopped() sends `$X`, homeAfterStop re-reads Idle and does not send a second', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    // The fast surface seek answers a hard-limit alarm mid-`G91`: the stop is alarmed AND relative,
    // so the executor's `stopped()` clears it; the panel's `homeAfterStop` must not clear it again.
    install(plan, { alarmAtFastTouch: true });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-start'));
    });
    await screen.findByTestId('engrave-registration-failed');

    expect(screen.getByTestId('engrave-registration-failed').textContent).toContain('may be in alarm');
    expect(sent.filter((l) => l === '$X')).toHaveLength(1);
    expect(sent.indexOf('$X')).toBeLessThan(sent.lastIndexOf('$H'));
    expect(sent).toContain('$H');
    expect(firstRegistrationFor(job.id, TARGET)).toBeNull();
  });

  it('#933 — the Stop is live mid-run: the flag stops the next line, the app never homes after it, and Home is its own press', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    const hold: { release?: () => void } = {};
    install(plan, { holdTouch: hold });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    act(() => { useEngraveRunStore.setState({ acknowledged: true }); });
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-start'));
    });
    // The run is in flight on its first touch. The Stop is on screen even with no prompt pending.
    expect(screen.getByTestId('engrave-registration-stop')).toBeTruthy();
    await vi.waitFor(() => expect(sent.filter((l) => l.startsWith('G38.3'))).toHaveLength(1));

    // Press it while the move is still on the wire; the stop's own session reads Idle, so nothing
    // is aborted (`not-running`) — and the executor's flag stops the very next line.
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-stop'));
    });
    expect(screen.getByTestId('engrave-registration-stop-outcome').textContent).toContain('nothing was moving');
    await act(async () => {
      hold.release?.();
    });
    await screen.findByTestId('engrave-registration-failed');
    expect(screen.getByTestId('engrave-registration-failed').textContent).toContain('the operator pressed Stop');
    // #933 — never homed by the app after an operator Stop: the run's own opening `$H` is the only one.
    expect(sent.filter((l) => l === '$H')).toHaveLength(1);
    // The Home press is offered, and is what sends the second `$H`.
    expect(screen.getByTestId('engrave-registration-home')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-home'));
    });
    expect(sent.filter((l) => l === '$H')).toHaveLength(2);
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

  it('#1088 — a FLIPPED first setup with no stated pins refuses by name, and nothing is sent', () => {
    // Side 2 registers on the two ⌀6 bores side 1 left, and the setup's stored pins are the one
    // source of where they are. A flipped setup that states none has nothing to aim at: the step
    // refuses, never re-plans from a guess, and never runs side 1's routine on side 2.
    const plan = makePlan(-56.172);
    const base = jobWithPlan(plan);
    const setup = jobSetups(base)[0]!;
    const job: EngraveJob = { ...base, setups: [{ ...setup, flip: { method: 'tabs-in-blank', axis: 'left-right' } }] };
    render(<EngraveRegistrationStep job={job} target={TARGET} />);
    const refusal = screen.getByTestId('engrave-registration-flip-refusal');
    expect(refusal.textContent).toContain('side 2');
    expect(refusal.textContent).toContain('locating pins');
    // No Register button of any shape, and the console untouched.
    expect(screen.queryByTestId('engrave-registration-start')).toBeNull();
    expect(screen.queryByTestId('engrave-registration-approve-start')).toBeNull();
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


describe('#638 — the placement frame waits for the acceptance', () => {
  /**
   * A location whose machine has one bed with a VISE placement and nothing measured on it — the
   * record `mountTapFor` prefers for every later tap point. The saves are captured so a test can
   * read exactly what each write would have put on the house record.
   */
  function placedLocation(): MachineRecord[] {
    const saves: MachineRecord[] = [];
    useLocationStore.setState({
      status: 'present',
      etag: '"e1"',
      reason: null,
      location: {
        machines: [
          {
            id: 'm1',
            profileId: 'Z1',
            address: { host: TARGET.host, port: TARGET.port },
            bedProfiles: [
              {
                id: 'bp1',
                datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null },
                placements: [
                  {
                    id: 'pl-vise',
                    fixture: 'fx-vise-1',
                    where: { kind: 'pins', pins: 'vise', anchor: null },
                    count: null,
                    frame: null,
                    provenance: {},
                  },
                ],
                surface: null,
                history: [],
              },
            ],
            activeBedProfileId: 'bp1',
            history: [],
            notes: [],
            observedAt: '2026-10-25T00:00:00.000Z',
          },
        ],
        accessories: [],
      } as unknown as NonNullable<ReturnType<typeof useLocationStore.getState>['location']>,
      saveMachine: async (record: MachineRecord) => {
        saves.push(record);
        return 'ok';
      },
    });
    return saves;
  }

  function bedOf(record: MachineRecord) {
    return record.bedProfiles?.find((p) => p.id === record.activeBedProfileId) ?? null;
  }

  function visePlacementOf(record: MachineRecord) {
    const bed = bedOf(record);
    return bed?.placements.find((pl) => pl.where.kind === 'pins' && pl.where.pins === 'vise') ?? null;
  }

  async function useFoundPosition(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-use-found'));
    });
    await screen.findByTestId('engrave-registration-continue');
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-continue'));
    });
    await screen.findByTestId('engrave-registration-written');
  }

  it('holds the frame and the surface top on a run outside the margin, and writes them when the operator uses the found position', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    install(plan, { edgeShiftMm: 0.5 });
    const saves = placedLocation();
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    await runStep();

    // The blank is found 0.5 mm off: usable, outside the margin. Nothing that says WHERE the jaw is
    // goes on the record — the next plan and every later jaw tap are aimed from the frame, and the
    // operator is about to re-seat the blank.
    expect(screen.getByTestId('engrave-registration-verdict').getAttribute('data-within-margin')).toBe('false');
    // #653 — nothing changed on the record, so nothing was written at all: no PUT of an unchanged
    // machine that a 412 could report as "the record was not saved".
    expect(saves).toHaveLength(0);

    await useFoundPosition();

    // "Use the found position" is the acceptance: the frame and the top land with the origin, from
    // the result the run held.
    expect(saves).toHaveLength(1);
    const recorded = firstRegistrationFor(job.id, TARGET)!;
    const written = saves[0]!;
    expect(visePlacementOf(written)?.frame?.fixedJawFaceX).toBeCloseTo(recorded.outcome.correctedG54.x, 3);
    expect(visePlacementOf(written)?.provenance.fixedJawFaceX).toMatch(/^measured:/);
    // The fake answers the surface seek at the band's centre; the writing surface point is the plan's.
    const stockZ = plan.seek.band.max - (plan.seek.band.max - plan.seek.band.min) / 2;
    const top = bedOf(written)?.datums.surfaceTopZ;
    expect(top?.value).toBeCloseTo(stockZ, 3);
    expect(top?.at).toEqual([plan.surfacePoint.x, plan.surfacePoint.y]);
  });

  it('writes the frame at measurement time when the blank is inside the margin, and does not write it twice', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    install(plan);
    const saves = placedLocation();
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    await runStep();

    expect(screen.getByTestId('engrave-registration-verdict').getAttribute('data-within-margin')).toBe('true');
    expect(saves).toHaveLength(1);
    const stockZ = plan.seek.band.max - (plan.seek.band.max - plan.seek.band.min) / 2;
    expect(visePlacementOf(saves[0]!)?.frame).not.toBeNull();
    expect(bedOf(saves[0]!)?.datums.surfaceTopZ?.value).toBeCloseTo(stockZ, 3);

    await writeOrigin();
    await screen.findByTestId('engrave-registration-recorded');

    // The frame is the measured face, on the record BEFORE the origin was written…
    const recorded = firstRegistrationFor(job.id, TARGET)!;
    expect(visePlacementOf(saves[0]!)?.frame?.fixedJawFaceX).toBeCloseTo(recorded.outcome.correctedG54.x, 3);
    // …and the acceptance found it already there: no second frame write.
    expect(saves).toHaveLength(1);
  });

  it('#642 the surface top written is the CENTRE reading, not the spread’s lowest touch', async () => {
    const plan = makePlan(-55.0);
    const job = badgeJobWithPlan(plan);
    const spread = spreadPlanFor(job);
    // The badge dome: centre −55.0, every extent −55.33. The outcome's `surfaceZ` is Z0 — the LOWEST
    // touch — so a write-back that used it would record a top 0.33 mm below the one the centre
    // actually measured. Reading `r.data.surface.z` (the centre) is the point of #619's write.
    const zs = [-55.0, -55.33, -55.33, -55.33, -55.33];
    install(plan, { spreadReadings: spread.touches.map((t, i) => ({ x: t.x, y: t.y, z: zs[i]! })) });
    const saves = placedLocation();
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    await runStep();
    await writeOrigin();
    await screen.findByTestId('engrave-registration-recorded');

    const recorded = firstRegistrationFor(job.id, TARGET)!;
    expect(recorded.outcome.surfaceZ).toBe(-55.33);
    expect(bedOf(saves[0]!)?.datums.surfaceTopZ?.value).toBeCloseTo(-55.0, 3);
  });

  it('#652 the accepted frame uses the jaw start the run measured with, not a later edit', async () => {
    const plan = makePlan(-56.172);
    const job = jobWithPlan(plan);
    install(plan, { edgeShiftMm: 0.5 });
    const saves = placedLocation();
    useEngraveJobStore.setState({ job });
    const { rerender } = render(<EngraveRegistrationStep job={job} target={TARGET} />);

    await runStep();

    // The typed jaw start is edited after the measurement, before the operator accepts the position.
    // The frame's Y is correctedG54.y + the jaw start the RUN measured against.
    const runJawStartY = jobVise(job).jawStartY;
    const edited: EngraveJob = {
      ...job,
      workholding: { kind: 'vise', vise: { ...jobVise(job), jawStartY: runJawStartY + 5 } },
    };
    useEngraveJobStore.setState({ job: edited });
    rerender(<EngraveRegistrationStep job={edited} target={TARGET} />);

    await useFoundPosition();

    const recorded = firstRegistrationFor(job.id, TARGET)!;
    const frame = visePlacementOf(saves[saves.length - 1]!)?.frame;
    expect(frame?.jawStartY).toBeCloseTo(recorded.outcome.correctedG54.y + runJawStartY, 3);
    expect(frame?.jawStartY).not.toBeCloseTo(recorded.outcome.correctedG54.y + runJawStartY + 5, 3);
  });

  it('records the plan the measurement ran under, not the one rendered at the press', async () => {
    const planA = makePlan(-56.172);
    const planB = makePlan(-55.0);
    const jobA = jobWithPlan(planA);
    // The same job, its setup's approved plan replaced after the run — an edit the write must not
    // retroactively call "the plan that was measured".
    const jobB = attachPlan(jobA, planB);
    install(planA);
    useEngraveJobStore.setState({ job: jobA });
    const { rerender } = render(<EngraveRegistrationStep job={jobA} target={TARGET} />);
    await runStep();

    useEngraveJobStore.setState({ job: jobB });
    rerender(<EngraveRegistrationStep job={jobB} target={TARGET} />);

    await writeOrigin();
    await screen.findByTestId('engrave-registration-recorded');

    const recorded = firstRegistrationFor(jobA.id, TARGET)!;
    expect(recorded.plan).toEqual(planA);
    expect(recorded.plan).not.toEqual(planB);
  });
});

// #934 — DISC REGISTRATION IS HIDDEN until its bench run: the planner refuses the rim routine by
// name, so the resize question cannot arise. The branch returns behind its own issue.
describe.skip('#743 D-2 — a different-sized disc asks the operator, and never refuses', () => {
  it('a disc 1.4 % large shows the question; the origin waits, and Resize scales the job', async () => {
    const plan = makeDiscPlan();
    const job = discJobWithPlan(plan);
    install(plan, { discSpans: { x: 30.42, y: 30.42 } });
    beddedLocation();
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);
    await runStep();

    const question = screen.getByTestId('engrave-registration-disc-question');
    expect(question.textContent).toContain('Resize the job to the measured diameter, or cut as is?');
    expect(question.textContent).toContain('⌀30.4');
    // The origin waits for the answer: no Write button, and the sentence says why.
    expect(screen.queryByTestId('engrave-registration-write')).toBeNull();
    expect(screen.getByTestId('engrave-registration-disc-wait').textContent).toContain(
      'Answer the disc’s size question first',
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-disc-resize'));
    });
    const scaled = useEngraveJobStore.getState().job;
    expect(scaled.stock.diameter).toBeGreaterThan(30.3);
    expect(scaled.stock.diameter).toBeLessThan(30.5);
    // The design scaled with the blank: the label's size and its position about the centre.
    expect(scaled.labels[0]!.size).toBeCloseTo(5 * (scaled.stock.diameter! / 30), 2);
    expect(screen.getByTestId('engrave-registration-disc-answer').textContent).toContain('resized');
    expect(screen.getByTestId('engrave-registration-write')).toBeTruthy();
  });

  it('Cut as is keeps the document and lets the origin be written', async () => {
    const plan = makeDiscPlan();
    const job = discJobWithPlan(plan);
    install(plan, { discSpans: { x: 30.42, y: 30.42 } });
    beddedLocation();
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);
    await runStep();

    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-disc-as-is'));
    });
    expect(useEngraveJobStore.getState().job.stock.diameter).toBe(30);
    expect(useEngraveJobStore.getState().job.labels[0]!.size).toBe(5);
    expect(screen.getByTestId('engrave-registration-disc-answer').textContent).toContain('Cutting as is');
    expect(screen.getByTestId('engrave-registration-write')).toBeTruthy();
  });
});

// #797 follow-up — THE REGISTER CARD HOLDS THE ACTION.
describe('#797 follow-up — the Register card proposes the plan it runs', () => {
  /** A location whose machine carries a measured jaw-top datum and a checked-out wired probe. */
  function proposalLocation(): void {
    useLocationStore.setState({
      status: 'present',
      etag: '"e-proposal"',
      reason: null,
      location: {
        machines: [
          {
            id: 'm-proposal',
            profileId: 'Z1',
            address: { host: TARGET.host, port: TARGET.port },
            bedProfiles: [
              {
                id: 'bp-proposal',
                datums: {
                  surfaceTopZ: null,
                  viseJawTopZ: { value: -57.491, measuredAt: '2026-10-23T00:00:00.000Z', by: 'fx-probe-1', at: null },
                  bracketSeatZ: null,
                  rotaryAxis: null,
                },
                placements: [
                  {
                    id: 'pl-vise',
                    fixture: 'fx-vise-1',
                    where: { kind: 'pins', pins: 'vise', anchor: null },
                    count: null,
                    frame: { fixedJawFaceX: -181.2, jawStartY: -203.5 },
                    provenance: {},
                  },
                ],
                history: [],
              },
            ],
            activeBedProfileId: 'bp-proposal',
            history: [],
            notes: [],
            observedAt: '2026-10-23T00:00:00.000Z',
          },
        ],
        accessories: [
          {
            id: 'fx-probe-1',
            kind: 'probe',
            product: 'Makera Wired Probe V2',
            variant: 'wired-touch',
            unit: { tipDiameterMm: 2.0, rimOffsetMm: 0.7, rimOffsetUncertaintyMm: 0.25 },
            provenance: {},
            history: [],
            whereabouts: { kind: 'machine', machineId: 'm-proposal', since: '2026-10-23T00:00:00.000Z' },
          },
          {
            id: 'fx-vise-1',
            kind: 'vise',
            constants: { jawBarWidth: 10, jawLength: 100 },
            unit: { jawStartY: -203.5 },
            provenance: {},
            history: [],
            whereabouts: { kind: 'machine', machineId: 'm-proposal', since: '2026-10-01T00:00:00.000Z' },
          },
        ],
      } as unknown as NonNullable<ReturnType<typeof useLocationStore.getState>['location']>,
    });
  }

  it('shows the planner’s one-line proposal, and one Register press approves it and starts', async () => {
    // The default blank on the vise: a blank whose top stands proud of the jaws, which is the
    // configuration the planner can bracket. (The badge fixture's thin laminate sits flush.)
    const base = defaultEngraveJob();
    const setup0 = jobSetups(base)[0]!;
    const job: EngraveJob = { ...base, setups: [{ ...setup0, mount: { kind: 'vise' } }] };
    proposalLocation();
    useEngraveJobStore.setState({ job });
    useEngraveRunStore.setState({ acknowledged: false, acknowledgedFor: null });

    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    // The card proposes; the old dead end ("Plan and approve it in Design → Setups") is gone.
    const line = await screen.findByTestId('engrave-registration-proposal-line');
    expect(line.textContent).toContain('then the top');
    expect(line.textContent).toContain('touches');
    expect(line.textContent).toContain('wired probe');
    expect(screen.queryByTestId('engrave-registration-no-plan')).toBeNull();
    // The plan opens behind ›.
    fireEvent.click(screen.getByTestId('engrave-registration-proposal-open'));
    expect(screen.getByTestId('engrave-registration-proposal-detail').textContent).toContain('Home, fit the wired probe');

    // The ONE statement at Cut step 1 arms the press.
    const register = screen.getByTestId('engrave-registration-approve-start') as HTMLButtonElement;
    expect(register.textContent).toBe('Register');
    expect(register.disabled).toBe(true);
    act(() => {
      useEngraveRunStore.getState().acknowledgeProgram('program-key');
    });
    expect(register.disabled).toBe(false);

    // One press approves it AND starts: the job's setup carries the plan the card showed.
    await act(async () => {
      fireEvent.click(register);
    });
    const approved = useEngraveJobStore.getState().job.setups?.[0]?.registration;
    expect(approved).toBeDefined();
    expect(approved!.method).toBe('vise');
    expect(approved!.plan.scans.length).toBeGreaterThan(0);
    expect(approved!.expected.length).toBeGreaterThan(0);
  });
});

describe('#607 — the Register step of a chuck job carries the axis tap', () => {
  /** The target machine with an address, a measured surface and the measured 3D probe on it. */
  function rotaryLocation(): void {
    useLocationStore.setState({
      status: 'present',
      etag: '"e1"',
      reason: null,
      location: {
        machines: [
          {
            id: 'm-rotary',
            profileId: 'Z1',
            address: { host: TARGET.host, port: TARGET.port },
            bedProfiles: [
              {
                id: 'bp-rotary',
                datums: {
                  surfaceTopZ: { value: -76, measuredAt: '2026-10-31T00:00:00.000Z', by: 'fx-probe-3d', at: null },
                  viseJawTopZ: null,
                  bracketSeatZ: null,
                  rotaryAxis: null,
                },
                placements: [],
                surface: null,
                history: [],
              },
            ],
            activeBedProfileId: 'bp-rotary',
            history: [],
            notes: [],
            observedAt: '2026-10-31T00:00:00.000Z',
          },
        ],
        accessories: [
          {
            id: 'fx-probe-3d',
            kind: 'probe',
            product: 'Makera 3D Probe',
            variant: '3d',
            unit: { tipDiameterMm: 2, rimOffsetMm: 0.875, rimOffsetUncertaintyMm: 0.01 },
            provenance: {},
            history: [],
            whereabouts: { kind: 'machine', machineId: 'm-rotary', since: '2026-10-31T00:00:00.000Z' },
          },
        ],
      } as unknown as NonNullable<ReturnType<typeof useLocationStore.getState>['location']>,
    });
  }

  it('offers the 4th-axis tap on a chuck job, plan or no plan', () => {
    caps.canReachMachine = true;
    const base = defaultEngraveJob();
    const job: EngraveJob = { ...base, workholding: { kind: 'rotary-chuck', rotary: defaultRotaryChuck(base) } };
    rotaryLocation();
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);
    expect(screen.getByTestId('engrave-rotary-tap')).toBeTruthy();
  });

  it('leaves the axis tap off a vise job', () => {
    caps.canReachMachine = true;
    const job = defaultEngraveJob();
    rotaryLocation();
    useEngraveJobStore.setState({ job });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);
    expect(screen.queryByTestId('engrave-rotary-tap')).toBeNull();
  });
});

describe('#1070 the proposals need no saved setup for a bed-held job', () => {
  it('a bracket job with setups: [] shows the seat press — nothing walked, nothing saved', () => {
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      name: 'setups-less 1070',
      stock: { ...base.stock, length: 160, width: 126, thickness: 25, material: 'hardwood' },
      labels: [],
      shapes: [],
      setups: [],
      workholding: {
        kind: 'bracket',
        bracket: { anchor: 1, variant: 'thin', clamps: [{ edge: 'back', at: 63 }], source: 'default' },
      },
    };
    useEngraveJobStore.setState({ job });
    resetEngraveRegistrationStore();
    useEngraveRunStore.setState({ acknowledged: true });
    beddedLocation();
    // The machine's anchor-1 calibration with the soft endstop, and the 6 mm wasteboard bed with
    // NO seat datum yet: the proposal must be the seat press, planned from the job alone.
    const cal = {
      frame: { anchor1: [-190.89, -193.83], anchor2Offset: [88.5, 45], clearanceXY: [-11.6, -14.6], clearanceZ: -3, toolrackOffset: [48.8, 181], toolrackZ: -108 },
      machineId: 'Z1',
      measuredAt: '2026-11-07T20:00:00.000Z',
      softEndstop: { enabled: true, xMin: -207, yMin: -206, zMin: -102, source: 'config-get sd' },
      source: 'config',
    };
    useSettingsStore.setState({ machineCalibration: cal as unknown as ReturnType<typeof useSettingsStore.getState>['machineCalibration'] });
    render(<EngraveRegistrationStep job={job} target={TARGET} />);
    const button = screen.getByTestId('engrave-registration-approve-start') as HTMLButtonElement;
    expect(button.textContent).toContain('Measure the bracket seat');
    expect(screen.getByTestId('engrave-registration-proposal-line').textContent ?? '').toContain('seat');
  });
});

describe('#1088 — a flipped setup registers side 2 on the bores', () => {
  const SURFACE = -67.25; // side 2's top, machine Z: seat −87.25 + the measured 20 mm thickness
  const SEAT = -87.25;
  const G54 = { x: 100, y: 50 }; // the frame in force before the run — side 1's origin
  const BORE_R = 3; // ⌀6
  const BALL_R = 1; // the probe's measured ⌀2 tip
  const PINS = [
    { x: 70, y: 15 },
    { x: 20, y: 15 },
  ] as const;

  /** A job whose FIRST setup is the flipped one, on its two stored pins (90 × 60 stock). */
  function flipJob(): EngraveJob {
    const base = defaultEngraveJob();
    const setup = jobSetups(base)[0]!;
    return {
      ...base,
      name: 'flip registration fixture',
      stock: { ...base.stock, length: 90, width: 60, thickness: 20, material: 'hardwood' },
      labels: [],
      shapes: [],
      setups: [
        {
          ...setup,
          mount: { kind: 'bracket' },
          flip: { method: 'tabs-in-blank', axis: 'left-right' },
          pins: { at: [{ ...PINS[0] }, { ...PINS[1] }] },
        } as never,
      ],
    } as EngraveJob;
  }

  /** The machine: a measured ⌀2 probe, and the bracket's seat datum that probe wrote. */
  function flipLocation(): void {
    useLocationStore.setState({
      status: 'present',
      etag: '"e1"',
      reason: null,
      location: {
        machines: [
          {
            id: 'm1',
            profileId: 'Z1',
            address: { host: TARGET.host, port: TARGET.port },
            bedProfiles: [
              {
                id: 'bp1',
                datums: {
                  surfaceTopZ: null,
                  viseJawTopZ: null,
                  bracketSeatZ: { value: SEAT, measuredAt: '2026-11-08T00:00:00.000Z', by: 'fx-probe-1' },
                  rotaryAxis: null,
                },
                placements: [],
                surface: null,
                history: [],
              },
            ],
            activeBedProfileId: 'bp1',
            history: [],
            notes: [],
            observedAt: '2026-11-08T00:00:00.000Z',
          },
        ],
        accessories: [
          {
            id: 'fx-probe-1',
            kind: 'probe',
            product: 'Makera 3D Probe',
            variant: 'xyz',
            unit: { tipDiameterMm: 2, rimOffsetMm: 1, rimOffsetUncertaintyMm: 0.05 },
            provenance: {},
            history: [],
            whereabouts: { kind: 'machine', machineId: 'm1', since: '2026-11-08T00:00:00.000Z' },
          },
        ],
      } as never,
    });
  }

  /** The #475 measurement side 1's run left: its highest touch is side 1's top. */
  function measuredSideOne(job: EngraveJob): void {
    useEngraveRegistrationStore.getState().measureSurface(job.id, TARGET, {
      plan: { band: { width: 0.2 } },
      touches: [{ z: SEAT + 20, x: 20, y: 20, at: 'the cut extent', source: 'spread', id: 't1' }],
      min: { z: SEAT + 20, x: 20, y: 20, at: 'the cut extent', source: 'spread', id: 't1' },
      max: { z: SEAT + 20, x: 20, y: 20, at: 'the cut extent', source: 'spread', id: 't1' },
      spread: 0,
      drops: { xMm: 0, yMm: 0 },
      z0: { z: SEAT + 20, touchId: 't1', rule: 'lowest' },
      fit: { kind: 'plane', offset: SEAT + 20, slopeX: 0, slopeY: 0, residual: 0 },
      tilt: { xMm: 0, yMm: 0 },
      ok: true,
      verdict: 'flat',
    } as never);
  }

  /**
   * The flip executor's conversation. Touches land on the model's own rule (the probe reads the
   * stock until its centre is the tip's rim past the edge); the two ⌀6 bores sit on the pins in
   * side-2 WORK XY, and every PRB is MACHINE XY — `G54` right, `G54` back.
   */
  function flipController(sentLines: string[], frontZ = SURFACE): MachineConsoleClient {
    const pos = { x: 0, y: 0, z: 0 };
    const reply = (text: string): ConsoleSend => ({ ok: true, line: '', text, frames: 1, elapsedMs: 1 });
    const prb = (z: number, touched: boolean): string =>
      `[PRB:${(pos.x + G54.x).toFixed(3)},${(pos.y + G54.y).toFixed(3)},${z.toFixed(3)}:${touched ? 1 : 0}]`;
    /** Material under the ball: the blank, minus the two bores. The corner touches are the front pair. */
    const materialAt = (x: number, y: number): boolean =>
      x > -BALL_R && y > -BALL_R && !PINS.some((p) => Math.hypot(x - p.x, y - p.y) <= BORE_R);
    const topAt = (y: number): number => (y < 5 ? frontZ : SURFACE);
    return {
      async open() {
        return {
          async send(line: string): Promise<ConsoleSend> {
            sentLines.push(line);
            if (line === '?') return reply('<Idle|MPos:0,0,0>');
            if (line === 'M491') return reply('ok\n[PRB:0,0,-80.000:1]');
            if (line === 'M119') return reply('X_min:0 Y_min:0 Z_min:0 X_max:0 Y_max:0 Z_max:0 Probe:0');
            if (['G54', 'G92.1', 'M831', 'M832', 'G90', 'G91'].includes(line)) return reply('ok');
            let m = /^G53 G0 Z(-?[\d.]+)$/.exec(line);
            if (m) return (pos.z = Number(m[1])), reply('ok');
            // The seek's relative lift (G91): `G0 Z<+lift>`, never a drop here.
            m = /^G0 Z(-?[\d.]+)$/.exec(line);
            if (m) return (pos.z += Number(m[1])), reply('ok');
            m = /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
            if (m) return (pos.x = Number(m[1])), (pos.y = Number(m[2])), reply('ok');
            m = /^G38\.3 Z-([\d.]+) F[\d.]+$/.exec(line);
            if (m) {
              const target = pos.z - Number(m[1]);
              const top = topAt(pos.y);
              if (materialAt(pos.x, pos.y) && top >= target && top <= pos.z) {
                pos.z = top;
                return reply(prb(top, true));
              }
              pos.z = target;
              return reply(prb(target, false));
            }
            m = /^G38\.3 ([XY])(-?[\d.]+) F[\d.]+$/.exec(line);
            if (m) {
              const axis = m[1] === 'X' ? 'x' : 'y';
              const travel = Number(m[2]);
              const reach = BORE_R - BALL_R;
              for (const p of PINS) {
                const other = axis === 'x' ? pos.y - p.y : pos.x - p.x;
                const sq = reach * reach - other * other;
                if (sq < 0) continue;
                const wall = (axis === 'x' ? p.x : p.y) + Math.sign(travel) * Math.sqrt(sq);
                const along = axis === 'x' ? pos.x : pos.y;
                const end = along + travel;
                const hit = travel > 0 ? wall <= end && wall >= along : wall >= end && wall <= along;
                if (hit) {
                  if (axis === 'x') pos.x = wall;
                  else pos.y = wall;
                  return reply(prb(pos.z, true));
                }
              }
              if (axis === 'x') pos.x += travel;
              else pos.y += travel;
              return reply(prb(pos.z, false));
            }
            return reply('ok');
          },
          async close() {},
        };
      },
    };
  }

  it('plans side 2 from the stored pins, runs the flip executor, and the press writes G54 from the bores', async () => {
    const job = flipJob();
    flipLocation();
    measuredSideOne(job);
    useEngraveJobStore.setState({ job });
    const lines: string[] = [];
    setMachineConsoleLoader(async () => flipController(lines));
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    // The card is side 2's: the bores and the carried Z0, never side 1's plan.
    const card = screen.getByTestId('engrave-registration-flip');
    expect(card.textContent).toContain('⌀6 bores');
    expect(card.textContent).toContain('carried side-2 top');
    expect(screen.queryByTestId('engrave-registration-plan')).toBeNull();

    act(() => {
      useEngraveRunStore.setState({ acknowledged: true });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-start'));
    });
    const verdict = await screen.findByTestId('engrave-registration-verdict', undefined, { timeout: 5000 });
    expect(verdict.textContent).toContain('Side 2 registered on the bores side 1 left');
    // Eight sideways touches, each released, and both entry seeks at the pins.
    expect(lines.filter((l) => /^G38\.3 [XY]/.test(l))).toHaveLength(8);
    expect(lines.filter((l) => l.startsWith('G38.5')).length).toBeGreaterThanOrEqual(8);
    // Each bore: the entry seek at its pin, then each sideways touch starts from that pin's centre.
    expect(lines.filter((l) => /^G0 X(70|20)(\.000)? Y15(\.000)?$/.test(l))).toHaveLength(10);

    // THE PRESS WRITES THE ORIGIN THE BORES STATE: the G54 in force was 100/50 off the work zero.
    await writeOrigin();
    const written = screen.getByTestId('engrave-registration-written');
    const line = /G10 L2 P1 X(-?[\d.]+) Y(-?[\d.]+) Z(-?[\d.]+)/.exec(written.textContent ?? '');
    expect(line).not.toBeNull();
    expect(Math.abs(Number(line![1]) - G54.x)).toBeLessThan(0.01);
    expect(Math.abs(Number(line![2]) - G54.y)).toBeLessThan(0.2);
    expect(Math.abs(Number(line![3]) - SURFACE)).toBeLessThan(0.01);
    // #1088 — THE RECORD IS THE SETUP'S OWN: filed under the flipped setup's id, never over the
    // job-keyed entry (which is side 1's).
    expect(useEngraveRegistrationStore.getState().records[job.id]).toBeUndefined();
    expect(useEngraveRegistrationStore.getState().bySetup[`${job.id}::${job.setups![0]!.id}`]).toBeDefined();
    expect(screen.getByTestId('engrave-registration-recorded').textContent).toContain('Setup 1’s registration recorded');
  }, 60_000);

  it('routes by the Cut screen’s CURRENT setup: setup 2 is the flipped card and files its own record, setup 1 is the ordinary one', async () => {
    // A real two-setup flip job: side 1 at setups[0] (registered, as the sheet prints it), the flip
    // at setups[1]. The card must follow the setup the Cut screen says is next, not setups[0].
    const sideOne = jobWithPlan(makePlan(-56.172));
    const flipped = flipJob().setups![0]!;
    const job: EngraveJob = {
      ...sideOne,
      stock: { ...sideOne.stock, length: 90, width: 60, thickness: 20 },
      setups: [sideOne.setups![0]!, { ...flipped, id: 'setup-flip' }],
    };
    flipLocation();
    measuredSideOne(job);
    useEngraveJobStore.setState({ job });

    // SETUP 1 SELECTED: the ordinary card, exactly as before — no flip card, side 1's plan named.
    const one = render(<EngraveRegistrationStep job={job} target={TARGET} setupIndex={1} />);
    expect(screen.getByTestId('engrave-registration-plan').textContent).toContain('Setup 1');
    expect(screen.queryByTestId('engrave-registration-flip')).toBeNull();
    one.unmount();

    // SETUP 2 SELECTED: the flipped card, and the run's record lands under setup 2's own id.
    const lines: string[] = [];
    setMachineConsoleLoader(async () => flipController(lines));
    render(<EngraveRegistrationStep job={job} target={TARGET} setupIndex={2} />);
    expect(screen.getByTestId('engrave-registration-flip')).toBeTruthy();
    expect(screen.queryByTestId('engrave-registration-plan')).toBeNull();

    act(() => {
      useEngraveRunStore.setState({ acknowledged: true });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-start'));
    });
    await screen.findByTestId('engrave-registration-verdict', undefined, { timeout: 5000 });
    await writeOrigin();

    // #1088 — the record is setup 2's, and setup 1's job-keyed record is untouched.
    const setupRecord = useEngraveRegistrationStore.getState().bySetup[`${job.id}::setup-flip`];
    expect(setupRecord).toBeDefined();
    expect(setupRecord!.setupId).toBe('setup-flip');
    expect(useEngraveRegistrationStore.getState().records[job.id]).toBeUndefined();
    expect(screen.getByTestId('engrave-registration-recorded').textContent).toContain('Setup 2’s registration recorded');
  }, 60_000);

  it('a corner Z outside the carried Z0’s band stops the run by name, and no bore is entered', async () => {
    const job = flipJob();
    flipLocation();
    measuredSideOne(job);
    useEngraveJobStore.setState({ job });
    const lines: string[] = [];
    // A chip under the blank's front edge: the corner touches read 0.45 mm below the carried top.
    setMachineConsoleLoader(async () => flipController(lines, SEAT + 20 - 0.45));
    render(<EngraveRegistrationStep job={job} target={TARGET} />);

    act(() => {
      useEngraveRunStore.setState({ acknowledged: true });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-registration-start'));
    });
    const failed = await screen.findByTestId('engrave-registration-failed', undefined, { timeout: 5000 });
    expect(failed.textContent).toContain('corner Z touches');
    expect(failed.textContent).toContain('carried Z0');
    expect(failed.textContent).toContain('no origin is written');
    // Nothing more measured: no bore was entered and no wall touched, and no Write press exists.
    expect(lines.filter((l) => /^G38\.3 [XY]/.test(l))).toHaveLength(0);
    expect(screen.queryByTestId('engrave-registration-write')).toBeNull();
    expect(useEngraveRegistrationStore.getState().records[job.id]).toBeUndefined();
  }, 60_000);
});
