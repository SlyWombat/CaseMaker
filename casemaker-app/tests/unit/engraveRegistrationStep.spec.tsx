// @vitest-environment jsdom
// #495 — the registration step: run the APPROVED plan over the console, show every touch and the
// margin verdict, write the origin only from a measurement inside the margin, and record the
// outcome in #494's seam. The console is a fake client; nothing reaches a machine.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
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
import { resetRegistrationTouchesStore, useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
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
            if (opts.alarmAtFastTouch === true && g38 === 1) return (state = 'Alarm'), reply('ALARM: Probe fail');
            if (opts.missFastTouch === true && g38 === 1) return reply(`[PRB:${lastX},${lastY},${stockZ}:0]\nok`);
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
  fireEvent.click(screen.getByTestId('engrave-registration-at-machine'));
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
    fireEvent.click(screen.getByTestId('engrave-registration-at-machine'));
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

    fireEvent.click(screen.getByTestId('engrave-registration-at-machine'));
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

    fireEvent.click(screen.getByTestId('engrave-registration-at-machine'));
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

    fireEvent.click(screen.getByTestId('engrave-registration-at-machine'));
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
