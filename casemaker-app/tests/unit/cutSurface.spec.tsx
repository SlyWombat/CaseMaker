// @vitest-environment jsdom
// #419 §3, slice 2 — the CUT SURFACE: freeze on green, the package line, the one shared plan, and
// run controls fed by the FROZEN texts rather than by the live Generate.
//
// The gate and the machine are inputs here: this spec is about what the surface does once the hub
// says "green" and what it refuses to do when it does not. The stock shelf is the same guarded fake
// the package store's own spec uses; nothing reaches a machine.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EngraveCutSurface } from '@/components/panels/EngraveCutSurface';
import type { MachineObservation } from '@/platform/machineProbe';
import type { PreflightHubReport } from '@/engine/cnc/preflight/hub';
import type { PreflightRow } from '@/engine/cnc/preflight/types';
import { setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import type { LocationView } from '@/platform/locationClient';
import { setMachineUploadLoader } from '@/platform/machineUpload';
import { programHash } from '@/platform/machineRun';
import { StockItemSchema, type StockItem } from '@/platform/stockClient';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { planRegistration } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { freezePackage, type FrozenPackage } from '@/engine/cnc/engrave/package';
import { frozenReleaseSources } from '@/engine/cnc/engrave/release';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';
import { ROTARY_UNMEASURED_REFUSAL } from '@/store/engraveRunGate';
import { machineKey, resetMachineRunStore, useMachineRunStore } from '@/store/machineRunStore';
import { resetEngraveReleaseStore, useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { resetEngravePackageStore, useEngravePackageStore } from '@/store/engravePackageStore';
import { resetEngraveRegistrationStore, useEngraveRegistrationStore } from '@/store/engraveRegistrationStore';
import type { SurfaceSpreadAssessment } from '@/engine/cnc/engrave/surfaceSpread';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRunStore, saveBlocker } from '@/store/engraveRunStore';
import { jobMachine } from '@/engine/cnc/calibration';
import { resetRunConfirmStore } from '@/store/runConfirmStore';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { useRunRecordStore } from '@/store/runRecordStore';
import { buildRunRecord, withActualSeconds } from '@/engine/cnc/engrave/runRecord';
import { clearStoredBaseline, resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetMachineChange, useMachineChangeStore } from '@/store/machineChangeStore';
import { resetManageMode, useManageModeStore } from '@/store/manageModeStore';
import { resetStockStore, useStockStore } from '@/store/stockStore';
import type { EngraveJob } from '@/types/engraveJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = { host: '192.0.2.10', port: 2222 };
const AT = '2026-10-17T14:02:00.000Z';
const VERIFY: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [1, 1, 0] } },
};

const NC1 = 'M331\nG0 X0 Y0\nM02\n';
const NC2 = 'G0 X1 Y1\nM332\nM02\n';
const P1: EngraveProgram = {
  setupIndex: 1,
  setupId: 'setup-1',
  toolKey: 'flat-1.0',
  nc: NC1,
  verify: VERIFY,
  frameNc: null,
  frameVerify: null,
  programHash: programHash(NC1),
  cam: null,
};
const P2: EngraveProgram = {
  setupIndex: 2,
  setupId: 'setup-2',
  toolKey: 'flat-3.175x12-metal',
  nc: NC2,
  verify: VERIFY,
  frameNc: null,
  frameVerify: null,
  programHash: programHash(NC2),
  cam: null,
};

function generated(programs: EngraveProgram[]): EngraveGenerated {
  return {
    ok: true,
    stage: 'done',
    findings: [],
    feeds: null,
    threads: null,
    threadMachining: null,
    cam: null,
    nc: programs[0]?.nc ?? null,
    verify: programs[0]?.verify ?? null,
    frameNc: null,
    frameVerify: null,
    facingNc: null,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    facingCam: null,
    predicted: [],
    programs,
    errors: [],
  } as unknown as EngraveGenerated;
}

/** #931 — a run that PASSED: the state the green-surface tests intend (never simulated otherwise). */
const OK_ORACLE = { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } };

function passRun(): void {
  useEngraveRunStore.setState({
    simStatus: 'ready',
    simDiagnostics: [],
    oracle: OK_ORACLE as never,
    phase: 'ready',
    staleSince: null,
    simStopped: false,
  });
}

function row(
  severity: 'error' | 'warning',
  code: string,
  message: string,
): PreflightRow {
  return {
    severity,
    code,
    message,
    owner: 'run',
    cause: { setupIndex: 0, toolKey: 'flat-1.0', hubTarget: null },
  };
}

function reportOf(rows: PreflightRow[] = []): PreflightHubReport {
  const errors = rows.filter((r) => r.severity === 'error');
  return {
    policyRows: rows,
    scopes: [],
    rows,
    firstBlocking: errors[0] ?? null,
    errorCount: errors.length,
    warningCount: rows.filter((r) => r.severity === 'warning').length,
  };
}

/** A job with two stored setups, so the plan has a setup for each program. */
function twoSetupJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.name = 'Two setup job';
  job.toolKey = 'flat-1.0';
  const first = jobSetups(job)[0]!;
  job.setups = [first, { ...first, id: 'setup-2', tools: ['flat-3.175x12-metal'] }];
  return job;
}

/** A job with a shelf blank, so freezing takes a hold this spec can watch. */
function shelfJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.stockEntry = { kind: 'shelf', shelfId: 'stock-plate1', file: null, form: 'plate', finish: 'finished', conductive: false };
  return job;
}

/** #724 W6 — a rod in the chuck: the job whose frozen mount is the FRAME, not the setup's word. */
function rotaryJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.stock = { ...job.stock, length: 100, width: 20, thickness: 20, shape: 'cylinder', diameter: 20, material: 'pla' };
  job.workholding = {
    kind: 'rotary-chuck',
    rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse-inner', tailstock: true, source: 'test' },
  };
  return job;
}

/** A job whose first setup carries an approved vise registration, so step ③ renders its Start. */
function plannedJob(): EngraveJob {
  const job = defaultEngraveJob();
  const { settings } = registrationSettings(null);
  const planned = planRegistration(
    {
      stock: { xMin: 0, yMin: 0, xMax: 38.1, yMax: 76.2, cornerRadius: 3 },
      mount: 'vise',
      expectedSurface: { machineZ: -56.172, from: 'the blank as the setup holds it' },
      seekFromMachineZ: -3,
      fixtureBelowSurfaceMm: 0.72,
      cutCentre: { x: 24, y: 43 },
    },
    settings,
  );
  if (!planned.ok) throw new Error(planned.reason);
  const setup = jobSetups(job)[0]!;
  job.setups = [
    {
      ...setup,
      mount: { kind: 'vise' },
      registration: { method: 'vise', plan: planned.plan, expected: 'XY from the fixed jaw ±0.1 mm, Z from the surface touch' },
    },
  ];
  return job;
}

function shelfItem(): StockItem {
  return StockItemSchema.parse({
    id: 'stock-plate1',
    material: 'aluminium-6061',
    form: 'plate',
    size: { length: 100, width: 100, thickness: 5 },
    layers: [],
    capMm: null,
    capSource: null,
    finish: 'rough',
    flatness: 'flat',
    domeHeight: null,
    conductive: true,
    quantity: 1,
    reservations: [],
    consumed: [],
    source: 'purchased',
    notes: null,
    addedAt: '2026-10-15T09:00:00.000Z',
  });
}

function frozen(job: EngraveJob, programs: EngraveProgram[]): FrozenPackage {
  const made = freezePackage(job, programs, AT);
  if (!made.ok) throw new Error(made.reason);
  return made.package;
}

function machineObservation(): MachineObservation {
  return {
    name: 'Z1',
    host: TARGET.host,
    port: TARGET.port,
    busy: false,
    ip: TARGET.host,
    mac: null,
    status: '<Idle|MPos:0,0,0>',
    profileId: 'z1',
    observedAt: AT,
    notes: [],
  };
}

/**
 * #695 — a location whose machine has a vise profile and a rotary profile, with `active` one of
 * them. The frozen job's setup mount is the vise, so the rotary-active record is the disagreement.
 */
function locationWith(active: 'vise' | 'rotary', probe: '3d' | 'wired' | null = null): LocationView {
  const placement = (mount: 'vise' | 'rotary') => ({
    id: `pl-${mount}`,
    fixture: `fx-${mount}`,
    where: { kind: 'pins' as const, pins: mount, anchor: null },
    count: null,
    frame: null,
    provenance: {},
  });
  return {
    machines: [
      {
        id: 'machine-695',
        address: { host: TARGET.host, port: TARGET.port },
        bedProfiles: [
          { id: 'bp-vise', placements: [placement('vise')], datums: {} },
          { id: 'bp-rotary', placements: [placement('rotary')], datums: {} },
        ],
        activeBedProfileId: active === 'vise' ? 'bp-vise' : 'bp-rotary',
      },
    ],
    accessories:
      probe === null
        ? []
        : [
            {
              id: probe === '3d' ? 'fx-probe-3d' : 'fx-probe-1',
              kind: 'probe',
              product: probe === '3d' ? 'Makera 3D Wired Probe' : 'Makera Wired Probe V2',
              variant: probe === '3d' ? '3d' : 'wired-touch',
              constants: {},
              unit: {},
              provenance: {},
              whereabouts: { kind: 'machine', machineId: 'machine-695', since: '2026-10-23T00:00:00.000Z' },
              history: [],
            },
          ],
  } as unknown as LocationView;
}

interface Props {
  job: EngraveJob;
  report: PreflightHubReport;
  pkg: FrozenPackage | null;
  generated: EngraveGenerated | null;
  canDrive?: boolean;
  staleSince?: number | null;
  /** #724 W5 — the gates' own sentence, as EngravePanel hands it down. */
  uploadBlocker?: string | null;
  releaseBlocker?: string | null;
  /** #796 — the panel's Generate action and its blocker sentence. */
  onGenerate?: () => void;
  generateBlocker?: string | null;
  /** #1123 review — a restored run not yet compared against settled house reads. */
  restoreChecking?: boolean;
}

/** #796 — the card's one action; the tests assert it was pressed rather than freezing here. */
const generateSpy = vi.fn();

/**
 * The panel's own wiring, minus the editor: `EngravePanel` reads the job (and its package block)
 * from the document store and hands them down, so a freeze is visible without remounting.
 * Reproducing that one line here is what lets the surface's freeze-on-green show in the same
 * visit, as it does in the app.
 */
function Harness(props: Props) {
  const open = useEngraveJobStore((state) => state.job);
  const job = open.id === props.job.id ? open : props.job;
  return (
    <EngraveCutSurface
      job={job}
      report={props.report}
      package={job.package ?? props.pkg}
      generated={props.generated}
      staleSince={props.staleSince ?? null}
      machine={props.canDrive === false ? null : machineObservation()}
      runContext={{}}
      uploadBlocker={props.uploadBlocker ?? null}
      releaseBlocker={props.releaseBlocker ?? null}
      onGenerate={props.onGenerate ?? generateSpy}
      generateBlocker={props.generateBlocker ?? null}
      restoreChecking={props.restoreChecking ?? false}
    />
  );
}

function draw(props: Props) {
  // #425 — the document owns the package. Seed the open job so a freeze has somewhere to land.
  useEngraveJobStore.setState({ job: props.pkg === null ? props.job : { ...props.job, package: props.pkg } });
  const rendered = render(<Harness {...props} />);
  return { ...rendered, show: (p: Props) => rendered.rerender(<Harness {...p} />) };
}

let shelfItems: StockItem[];
let uploads: { filename: string; content: string }[];

beforeEach(() => {
  generateSpy.mockClear();
  uploads = [];
  shelfItems = [shelfItem()];
  resetRunConfirmStore();
  resetMachineRunStore();
  resetStartWizard();
  useRunRecordStore.setState({ imported: [] });
  resetEngraveReleaseStore();
  useEngraveJobStore.getState().reset();
  resetEngravePackageStore();
  resetEngraveRegistrationStore();
  useEngraveRunStore.getState().reset();
  resetLocationStore();
  clearStoredBaseline();
  resetMachineChange();
  resetStockStore();
  resetManageMode();
  useStockStore.setState({ status: 'present', items: shelfItems, etag: '"s-1"' });

  let version = 1;
  const client = {
    call: async (method: string, path: string, body?: unknown): Promise<HouseCall> => {
      if (method === 'GET' && path === '/stock') {
        return { kind: 'ok', text: JSON.stringify(shelfItems), etag: `"s-${version}"` };
      }
      if (method === 'PATCH') {
        const id = decodeURIComponent(path.replace('/stock/', ''));
        shelfItems = shelfItems.map((item) => (item.id === id ? (body as StockItem) : item));
        useStockStore.setState({ items: shelfItems, etag: `"s-${version + 1}"` });
        version += 1;
        return { kind: 'ok', text: '' };
      }
      return { kind: 'ok', text: '' };
    },
  } as unknown as HouseClient;
  setHouseClientLoader(async () => client);
  setMachineUploadLoader(async () => ({
    status: async () => ({ ok: true, text: '<Idle|MPos:0,0,0>' }),
    upload: async (_target, program) => {
      uploads.push({ filename: program.filename, content: new TextDecoder().decode(program.content) });
      return { ok: true, bytes: program.content.length, packets: 1, alreadyPresent: false };
    },
  }));
});

afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
  setMachineUploadLoader(null);
});

/**
 * #797 — give the ONE statement at Cut step 1 for the program on screen. The clearance tick, the
 * probe-fitted ask and the at-machine boxes are this one statement now, so the upload and one
 * screen gates read it here.
 */
function giveStatement(): void {
  fireEvent.click(screen.getByTestId('engrave-ack'));
}

function storedPackage(job: EngraveJob): FrozenPackage {
  const pkg = useEngravePackageStore.getState().packageFor(job.id);
  if (pkg === null) throw new Error('no package was frozen');
  return pkg;
}

describe('#419 §3 the Cut surface', () => {
  it('freezes on green, once, and says what the package holds and what the shelf did', async () => {
    const job = defaultEngraveJob();
    const made = generated([P1]);
    passRun();
    draw({ job, report: reportOf(), pkg: null, generated: made });
    giveStatement();

    await waitFor(() => expect(screen.getByTestId('engrave-package').dataset.state).toBe('current'));
    const pkg = storedPackage(job);
    expect(pkg.programs).toHaveLength(1);
    expect(useEngravePackageStore.getState().packages).toHaveLength(1);

    // #796 — CHECKED AND FROZEN ARE ONE READINESS LINE: the program is checked, it is this
    // design's, and it carries the program's own estimate. There is no Package line repeating it.
    const step1 = screen.getByTestId('engrave-cut-step-1-summary').textContent ?? '';
    expect(step1).toContain('Program checked');
    expect(step1).toContain('matches the design');
    const line = screen.getByTestId('engrave-package').textContent ?? '';
    expect(line).not.toContain('The package');
    expect(line).not.toContain('1 program · 1 setup');
    expect(screen.queryByTestId('engrave-package-state')).toBeNull();
    // #550 — the package key lives on the element as data, not in the rendered sentence.
    expect(screen.getByTestId('engrave-package').getAttribute('data-key')).toBe(pkg.hash);
    // The job's stock is not a shelf entry: nothing was taken, and the line says so in operator terms.
    expect(screen.getByTestId('engrave-package-reservation').textContent).toContain('no blank needs to be held');
  });

  it('the Run step quotes the rotary bench sentence the gates refuse with (#724 W5)', () => {
    const job = defaultEngraveJob();
    const rotaryProgram = { ...P1, frame: 'rotary' as const };
    const pkg = frozen(job, [rotaryProgram]);
    const view = draw({
      job,
      report: reportOf(),
      pkg,
      generated: generated([rotaryProgram]),
      uploadBlocker: ROTARY_UNMEASURED_REFUSAL,
    });

    // The collapsed line says what the step will say, so it is visible with the step folded.
    const step3 = screen.getByTestId('engrave-cut-step-3-summary').textContent ?? '';
    expect(step3).toContain('the rotary’s bench check first');
    // …and the body quotes the gates' own sentence, with ONE period.
    const line = screen.getByTestId('engrave-cut-rotary-bench').textContent ?? '';
    expect(line).toBe(ROTARY_UNMEASURED_REFUSAL);
    expect(line).not.toContain('..');
    expect(line).not.toContain('can be checked and saved');

    // A run the gates do not refuse for the rotary carries no bench line.
    view.show({ job, report: reportOf(), pkg, generated: generated([P1]), uploadBlocker: null });
    expect(screen.queryByTestId('engrave-cut-rotary-bench')).toBeNull();
  });

  it('#703 — steps 1 and 3 print the program’s estimate, not the plan’s setup-inclusive total', () => {
    const job = defaultEngraveJob();
    const pkg = frozen(job, [P1]);
    // The program's cycle estimate — the number the Generate row and the simulator show — is 86 s:
    // "about 1 min 26 s". The plan's own total is a different figure (setup plus the
    // cut), and it keeps its place in the plan's fold.
    const made: EngraveGenerated = {
      ...generated([P1]),
      cam: { operations: 1, cuttingMoves: 1, estimatedSeconds: 86, passes: 1 },
    };
    passRun();
    draw({ job, report: reportOf(), pkg, generated: made });

    const step1 = screen.getByTestId('engrave-cut-step-1-summary').textContent ?? '';
    const step3 = screen.getByTestId('engrave-cut-step-3-summary').textContent ?? '';
    expect(step1).toContain('about 1 min 26 s');
    expect(step3).toContain('about 1 min 26 s');

    // The fold still says the plan's setup-inclusive total, and the two step lines never print it:
    // one cut has one time (audit B15).
    const total = screen.getByTestId('run-plan-total').textContent ?? '';
    const totalTime = total.replace(/^Total (at least )?/, '').replace(/ — .*$/, '').trim();
    expect(totalTime).not.toBe('1 min 26 s');
    expect(step1).not.toContain(totalTime);
    expect(step3).not.toContain(totalTime);
  });

  it('#726 P16 — a step number and its title stay on one line', () => {
    const job = defaultEngraveJob();
    const pkg = frozen(job, [P1]);
    draw({ job, report: reportOf(), pkg, generated: generated([P1]) });

    // The summary beside the label wraps; the label itself never does — "3 / Start cut" across two
    // lines read as two steps.
    const title = screen.getByTestId('engrave-cut-step-3-title');
    expect(title.textContent).toContain('3 Start cut');
    expect(title.style.whiteSpace).toBe('nowrap');
    expect(title.style.flexShrink).toBe('0');
    // #720 moved the mesh bytes out of the document: the Cut surface states no 4 MB cap, and
    // nothing here should reintroduce it.
    expect(screen.getByTestId('engrave-cut-surface').textContent).not.toContain('4 MB');
  });

  it('#726 W20 — step 1 is ONE line; the gate’s rows are its details fold', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    // Clear with one warning the operator can read in the line: the rows stay folded.
    const warning = row('warning', 'note-x', 'a note');
    passRun();
    draw({ job, report: reportOf([warning]), pkg, generated: generated([P1]), canDrive: true });
    const details = screen.getByTestId('engrave-cut-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // #747 review — a warning is not hidden inside a closed fold: step 1's own line counts it.
    // A withheld frame is exactly this case: the gate is green, the `no-frame` row is a warning,
    // and without the count the operator would have to guess to open the fold and read it.
    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain('1 warning');

    // A blocking row opens the fold by itself: the sentence must be seen, not hidden.
    const blocking = row('error', 'err-x', 'the blank is not held');
    cleanup();
    draw({ job, report: reportOf([blocking]), pkg, generated: generated([P1]), canDrive: true });
    expect((screen.getByTestId('engrave-cut-details') as HTMLDetailsElement).open).toBe(true);
  });

  it('#726 W20 review — the fold is the operator’s: a click moves it, and the gate clearing folds it back', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    // A job that opens Cut blocked: the clearance tick has not been done yet, so `open` is true
    // from the first render. The browser fires `toggle` for that prop change too — the state must
    // not record it as the operator having opened the fold.
    const made = {
      ...generated([P1]),
      findings: [{ severity: 'warning', code: 'vise-default', message: 'the vise is the shop default' }],
    } as EngraveGenerated;
    useEngraveRunStore.setState({
      oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } } as never,
      acknowledged: false,
    });
    draw({ job, report: reportOf(), pkg, generated: made, canDrive: true });
    const details = () => screen.getByTestId('engrave-cut-details') as HTMLDetailsElement;
    expect(details().open).toBe(true);

    // Ticking the clearance clears the gate: step 1 is one line again.
    fireEvent.click(screen.getByTestId('engrave-ack'));
    expect(details().open).toBe(false);

    // The operator's own clicks move it — open, then closed again.
    fireEvent.click(details().querySelector('summary')!);
    expect(details().open).toBe(true);
    fireEvent.click(details().querySelector('summary')!);
    expect(details().open).toBe(false);
  });

  it('#689 — the clearance acknowledgement lives in step 1 and blocks Run until it is ticked', async () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    // A warning the run gate recognises: the vise's seat is still the shop default, so somebody
    // must look at the clearance before anything is sent.
    const made = {
      ...generated([P1]),
      findings: [{ severity: 'warning', code: 'vise-default', message: 'the vise is the shop default' }],
    } as EngraveGenerated;
    useEngraveRunStore.setState({
      oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } } as never,
      acknowledged: false,
    });
    draw({ job, report: reportOf(), pkg, generated: made, canDrive: true });

    // Step 1 is the only open step, and the acknowledgement is its one action.
    expect(screen.getByTestId('engrave-cut-step-1')).toHaveProperty('open', true);
    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain('clearance not acknowledged');
    const ack = screen.getByTestId('engrave-ack') as HTMLInputElement;
    expect(ack.checked).toBe(false);

    // #795 — THE STATEMENT IS THE STEP'S FIRST LINE: above the gate's fold, not under it.
    const ackBox = screen.getByTestId('engrave-cut-ack');
    const fold = screen.getByTestId('engrave-cut-details');
    expect(screen.getByTestId('engrave-cut-step-1').contains(ackBox)).toBe(true);
    expect(ackBox.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // #788 — the statement asks for the probe to be fitted, so the head diagram stands with it,
    // drawn for the probe the job will use. (This draw has no machine record yet; the probe cases
    // are their own test below.)

    // Run is blocked with its ONE sentence.
    const go = screen.getByTestId('engrave-cut-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(screen.getByTestId('engrave-cut-go-blocked').textContent).toContain('tick the statement in Cut, step 1');

    // #726 W16 — the Design panel's Save gate reads the same run findings and the same flag: the
    // box that appears here is the one that clears Save there (one source, no deadlock).
    const gateView = () => ({
      ...useEngraveRunStore.getState(),
      generated: made,
      simStatus: 'ready' as const,
      machine: jobMachine(job, null),
      rotaryHeld: false,
    });
    expect(saveBlocker(gateView())).toBe('tick the statement in Cut, step 1');
    // #797 — TICKING THE ONE STATEMENT arms the press AND records the gate's own flag: the
    // clearance tick and the at-machine ask are the same statement now, not two.
    fireEvent.click(ack);
    expect(useEngraveRunStore.getState().acknowledged).toBe(true);
    expect(screen.queryByTestId('engrave-cut-go-blocked')).toBeNull();
    expect(go.disabled).toBe(false);
    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain('clearance acknowledged');
    expect(saveBlocker(gateView())).toBeNull();
  });

  it('#788 — the statement draws the head for the probe the job uses, and none without one', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    useEngraveRunStore.setState({
      oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } } as never,
      acknowledged: false,
    });
    // The job's machine carries the Makera 3D probe: the drawing names the 3D probe cable and
    // Makera's own line.
    useLocationStore.setState({ status: 'ready', location: locationWith('vise', '3d'), etag: '"loc-1"' } as never);
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    const first = screen.getByTestId('engrave-cut-ack').querySelector('[data-testid="probe-fit-diagram"]');
    expect(first).not.toBeNull();
    expect(first!.textContent).toContain('3D probe cable in here');
    expect(first!.textContent).toContain('Unplug the wired probe connector and connect the 3D probe cable.');

    // The wired probe V2: the V2's own line, and never the instruction to unplug it.
    cleanup();
    useLocationStore.setState({ status: 'ready', location: locationWith('vise', 'wired'), etag: '"loc-2"' } as never);
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    const wired = screen.getByTestId('engrave-cut-ack').querySelector('[data-testid="probe-fit-diagram"]');
    expect(wired).not.toBeNull();
    expect(wired!.textContent).toContain('Plug the wired probe in here.');
    expect(wired!.textContent).not.toContain('Unplug the wired probe connector');

    // No probe checked out: no diagram at all, so the ask does not carry a picture on every job.
    cleanup();
    useLocationStore.setState({ status: 'ready', location: locationWith('vise', null), etag: '"loc-3"' } as never);
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    expect(screen.getByTestId('engrave-cut-ack').querySelector('[data-testid="probe-fit-diagram"]')).toBeNull();
  });

  it('#796 — a program older than the design disables the one-screen press and the upload until Generate', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    // The job moved after the freeze: the old program is still in the package and still uploadable.
    const edited: EngraveJob = {
      ...job,
      labels: job.labels.map((label, i) => (i === 0 ? { ...label, depth: label.depth + 0.1 } : label)),
    };
    useEngraveRunStore.setState({
      oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } } as never,
      acknowledged: false,
    });
    draw({
      job: edited,
      report: reportOf([row('error', 'package-stale', 'the job changed since it was frozen: label depth changed')]),
      pkg,
      generated: generated([P1]),
    });

    const sentence = 'The program is older than the design — press Generate in step 1.';
    // The statement is ticked so only the stale package can hold the press.
    fireEvent.click(screen.getByTestId('engrave-ack'));
    const go = screen.getByTestId('engrave-cut-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(screen.getByTestId('engrave-cut-go-blocked').textContent).toBe(sentence);

    // The expert path's upload takes the same first blocker, and a disabled press sends nothing.
    const upload = screen.getByTestId('engrave-upload') as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
    expect(screen.getByTestId('engrave-upload-blocked').textContent).toContain(sentence);
    fireEvent.click(upload);
    expect(screen.queryByTestId('engrave-upload-confirm')).toBeNull();
    expect(uploads).toHaveLength(0);
  });

  it('#689 review — a blocking pre-flight finding disables the press with the finding’s own sentence', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    useEngraveRunStore.setState({
      oracle: { ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } } as never,
      acknowledged: false,
    });
    draw({
      job,
      report: reportOf([row('error', 'tool-too-big', 'the cutter cannot reach the label')]),
      pkg,
      generated: generated([P1]),
    });

    // The report row's own words, not a generic "clear step 1".
    fireEvent.click(screen.getByTestId('engrave-ack'));
    const go = screen.getByTestId('engrave-cut-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(screen.getByTestId('engrave-cut-go-blocked').textContent).toBe('the cutter cannot reach the label');

    const upload = screen.getByTestId('engrave-upload') as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
    expect(screen.getByTestId('engrave-upload-blocked').textContent).toContain('the cutter cannot reach the label');
    fireEvent.click(upload);
    expect(screen.queryByTestId('engrave-upload-confirm')).toBeNull();
    expect(uploads).toHaveLength(0);
  });

  it('#689 — Run says there is no machine instead of showing controls that cannot send', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: false });

    expect(screen.getByTestId('engrave-cut-no-machine').textContent).toBe(
      'No machine is connected — connect one in Manage › Machines.',
    );
    fireEvent.click(screen.getByTestId('engrave-cut-open-machines'));
    expect(useManageModeStore.getState().open).toBe(true);
    expect(useManageModeStore.getState().scope).toBe('machines');
    expect(screen.queryByTestId('engrave-cut-confirm')).toBeNull();
    expect(screen.queryByTestId('engrave-cut-run')).toBeNull();
    // The plan is still readable without a machine.
    expect(screen.getByTestId('engrave-cut-plan')).toBeTruthy();
  });

  it('#547 — the dry-run selector surfaces, and a full dry run sends the lifted text under a -dry name', async () => {
    const job = defaultEngraveJob();
    job.name = 'Dry job';
    const pkg = frozen(job, [P1]);
    draw({ job, report: reportOf(), pkg, generated: generated([P1]) });

    await waitFor(() => expect(screen.getByTestId('engrave-package').dataset.state).toBe('current'));
    giveStatement();

    const select = screen.getByTestId('engrave-dry-run-level') as HTMLSelectElement;
    expect(select.value).toBe('off');
    expect(screen.queryByTestId('engrave-dry-run-note')).toBeNull();

    fireEvent.change(select, { target: { value: 'full' } });
    expect(screen.getByTestId('engrave-dry-run-note').textContent).toContain('spindle stays off');

    // The single-file upload path is fed the lifted program under its own -dry file name.
    fireEvent.click(screen.getByTestId('engrave-upload'));
    await waitFor(() => {
      expect(screen.getByTestId('engrave-upload-confirm').textContent).toContain('-dry.nc');
    });
  });

  it('does not freeze while the gate is red', async () => {
    const job = defaultEngraveJob();
    draw({
      job,
      report: reportOf([row('error', 'tool-too-big', 'the cutter cannot reach the label')]),
      pkg: null,
      generated: generated([P1]),
    });

    // Give the freeze effect every chance to run before saying it did not.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(useEngravePackageStore.getState().packages).toEqual([]);
    expect(screen.getByTestId('engrave-package').dataset.state).toBe('none');
    expect(screen.queryByTestId('engrave-cut-plan')).toBeNull();
  });

  it('keeps a stale program and its blank, and replaces it only through Generate', async () => {
    const job = shelfJob();
    const pkg = frozen(job, [P1]);
    useStockStore.setState({
      items: [{ ...shelfItem(), reservations: [{ jobId: job.id, quantity: 1, at: AT }] }],
    });
    shelfItems = useStockStore.getState().items;

    const edited: EngraveJob = {
      ...job,
      labels: job.labels.map((label, i) => (i === 0 ? { ...label, depth: label.depth + 0.1 } : label)),
    };
    const staleRow = row('error', 'package-stale', 'the job changed since it was frozen: label depth changed');
    const view = draw({ job: edited, report: reportOf([staleRow]), pkg, generated: generated([P1]) });

    await waitFor(() => expect(screen.getByTestId('engrave-package').dataset.state).toBe('stale'));
    // #796 — ONE CARD, ONE ACTION: the stale sentence names the reason and the button is Generate;
    // the reservation line is the ONE place the hold is stated.
    const staleState = screen.getByTestId('engrave-package-state').textContent ?? '';
    expect(staleState).toContain('older than the design');
    expect(staleState).not.toContain('Its blank stays held');
    expect(screen.getByTestId('engrave-package-reservation').textContent).toContain('held for you');

    const regenerate = screen.getByTestId('engrave-package-generate') as HTMLButtonElement;
    expect(regenerate.textContent).toBe('Generate');
    expect(regenerate.disabled).toBe(false);
    // Nothing moved on staleness alone.
    expect(storedPackage(job).hash).toBe(pkg.hash);
    expect(
      useStockStore.getState().items[0]!.reservations.filter((r) => r.jobId === job.id),
    ).toHaveLength(1);

    fireEvent.click(regenerate);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // The Generate the card pressed comes back clear, and FREEZING FOLLOWS IT: the stale package
    // is replaced and the blank's hold moves once, not twice.
    view.show({ job: edited, report: reportOf(), pkg, generated: generated([P1]) });
    await waitFor(() => expect(screen.getByTestId('engrave-package').dataset.state).toBe('current'));

    const after = storedPackage(job);
    expect(after.hash).not.toBe(pkg.hash);
    expect(useEngravePackageStore.getState().packages).toHaveLength(1);
    const holds = useStockStore.getState().items[0]!.reservations.filter((r) => r.jobId === job.id);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.quantity).toBe(1);
    expect(screen.getByTestId('engrave-package-reservation').textContent).toContain('held for you');
  });

  it('plays the frozen texts even when the live Generate holds different text', async () => {
    const job = twoSetupJob();
    const pkg = frozen(job, [P1, P2]);
    // The live result carries the SAME verifier keys but different text: the reports are matched by
    // hash, while the file that is sent must be the package's.
    const live = generated([
      { ...P1, nc: 'LIVE P1\n', programHash: P1.programHash },
      { ...P2, nc: 'LIVE P2\n', programHash: P2.programHash },
    ]);
    draw({ job, report: reportOf(), pkg, generated: live });
    giveStatement();

    fireEvent.click(await screen.findByTestId('engrave-release-upload'));
    fireEvent.click(screen.getByTestId('engrave-release-upload-confirm-send'));
    await screen.findByTestId('engrave-release-start');

    const files = useEngraveReleaseStore.getState().records[`${TARGET.host}:${TARGET.port}`]?.files ?? [];
    expect(files.map((f) => f.nc)).toEqual([NC1, NC2]);
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.content).toContain('M331');
    expect(uploads[1]!.content).toContain('M332');
    expect(uploads.some((u) => u.content.includes('LIVE'))).toBe(false);
  });

  it('refuses a frozen text with no verifier report, in the surface and in the store', async () => {
    const job = twoSetupJob();
    const pkg = frozen(job, [P1, P2]);
    // A fresh session with no Generate: no report matches the frozen texts.
    draw({ job, report: reportOf(), pkg, generated: null });
    giveStatement();

    await waitFor(() =>
      expect(screen.getByTestId('engrave-release-blocked').textContent).toContain(
        'program 1 has no verifier report in this session',
      ),
    );
    expect(screen.queryByTestId('engrave-release-upload')).toBeNull();

    // The store refuses too: verified-only is not a disabled button.
    const sources = frozenReleaseSources(
      job,
      pkg,
      new Map([[P1.programHash, VERIFY]]), // program 2's frozen text has no report
    );
    await act(async () => {
      useEngraveReleaseStore.getState().plan(TARGET, job, sources);
      await useEngraveReleaseStore.getState().uploadAll(TARGET);
    });
    expect(uploads).toHaveLength(1);
    const rec = useEngraveReleaseStore.getState().records[`${TARGET.host}:${TARGET.port}`];
    expect(rec?.phase).toBe('failed');
    expect(rec?.notes.join('\n')).toContain('no verifier report for its frozen text');
  });

  it('shows ONE plan under Cut, and the run controls only when a machine is connected', async () => {
    const job = twoSetupJob();
    const pkg = frozen(job, [P1, P2]);
    const props = { job, report: reportOf(), pkg, generated: generated([P1, P2]) };
    const view = draw({ ...props, canDrive: true });

    expect(screen.getAllByTestId('run-plan')).toHaveLength(1);
    expect(screen.getByTestId('machine-strip')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-plan')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-run')).toBeTruthy();

    // Same plan, no controls: with no machine there is nothing to send to. The build target is not
    // consulted (#656 review) — the machine store is the gate, wherever the machine can be driven.
    view.show({ ...props, canDrive: false });
    expect(screen.getAllByTestId('run-plan')).toHaveLength(1);
    expect(screen.getByTestId('machine-strip')).toBeTruthy();
    expect(screen.queryByTestId('engrave-cut-run')).toBeNull();
  });

  it('#586 — the current step opens when it becomes current, and a machine reconnect does not fold it', async () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    const gen = generated([P1]);
    const red = reportOf([row('error', 'tool-too-big', 'the cutter cannot reach the label')]);

    // A red gate folds the Register step (it is not the current step yet).
    passRun();
    const view = draw({ job, report: red, pkg, generated: gen, canDrive: true });
    expect(screen.getByTestId('engrave-cut-step-2')).toHaveProperty('open', false);

    // The gate clears: step ③ becomes the step the operator is on and opens itself, so its Start is
    // visible rather than stranded inside a folded <details>.
    view.show({ job, report: reportOf(), pkg, generated: gen, canDrive: true });
    expect(screen.getByTestId('engrave-cut-step-2')).toHaveProperty('open', true);
    expect(screen.getByTestId('engrave-registration-start')).toBeTruthy();

    // A machine reconnect (the target goes away, then comes back) must not fold it again.
    view.show({ job, report: reportOf(), pkg, generated: gen, canDrive: false });
    expect(screen.queryByTestId('engrave-registration-start')).toBeNull(); // no machine to start from
    view.show({ job, report: reportOf(), pkg, generated: gen, canDrive: true });
    expect(screen.getByTestId('engrave-cut-step-2')).toHaveProperty('open', true);
    expect(screen.getByTestId('engrave-registration-start')).toBeTruthy();
  });

  it('#631 — a dome refuses the plane re-post and gates Upload on the G32 tick', async () => {
    const job = defaultEngraveJob();
    const made = generated([P1]);
    // A dome measurement on this machine: the Cut step shows the G32 route and holds Upload until
    // the operator confirms the grid was run from the console.
    useEngraveRegistrationStore.getState().measureSurface(job.id, TARGET, {
      verdict: 'dome',
      tilt: { xMm: 0, yMm: 0 },
      recommendation: {
        gcode: 'G32 R1 X1 Y1 A2 B2 I3 J3 H3',
        dump: 'M375.1',
        after: 'M370',
        sentence:
          'The top is a dome, not a tilt: the machine’s own leveling follows a curved top and the program uploads FLAT. ' +
          'Run G32 R1 X1 Y1 A2 B2 I3 J3 H3 from the console, M375.1 to dump the grid, M370 after. G32 is never uploaded in a file.',
      },
    } as unknown as SurfaceSpreadAssessment);

    draw({ job, report: reportOf(), pkg: null, generated: made });
    giveStatement();
    await waitFor(() => expect(screen.getByTestId('engrave-package').dataset.state).toBe('current'));

    // The dome route is shown with the recipe and the operator's tick; no tilt re-post section.
    expect(screen.getByTestId('engrave-cut-dome-g32')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-dome-g32-recipe').textContent).toContain('G32 R1 X');
    // #631 — the route states what it assumes and the landing it does not check.
    expect(screen.getByTestId('engrave-cut-dome-assumption').textContent).toContain('G32 follows the top');
    expect(screen.getByTestId('engrave-cut-dome-assumption').textContent).toContain('no landing range is checked');
    expect(screen.queryByTestId('engrave-cut-repost')).toBeNull();

    // Upload is gated until the operator confirms G32 ran for this clamping.
    expect((screen.getByTestId('engrave-upload') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('engrave-upload-blocked').textContent).toContain('G32');

    // The tick lifts the gate.
    fireEvent.click(screen.getByTestId('engrave-cut-dome-g32-ack'));
    expect((screen.getByTestId('engrave-upload') as HTMLButtonElement).disabled).toBe(false);
  });

  it('#642 a fresh measurement is a fresh clamping: the G32 tick resets', async () => {
    const job = defaultEngraveJob();
    const made = generated([P1]);
    const dome = (): SurfaceSpreadAssessment =>
      ({
        verdict: 'dome',
        tilt: { xMm: 0, yMm: 0 },
        recommendation: {
          gcode: 'G32 R1 X1 Y1 A2 B2 I3 J3 H3',
          dump: 'M375.1',
          after: 'M370',
          sentence:
            'The top is a dome, not a tilt: the machine’s own leveling follows a curved top and the program uploads FLAT. ' +
            'Run G32 R1 X1 Y1 A2 B2 I3 J3 H3 from the console, M375.1 to dump the grid, M370 after. G32 is never uploaded in a file.',
        },
      }) as unknown as SurfaceSpreadAssessment;
    useEngraveRegistrationStore.getState().measureSurface(job.id, TARGET, dome());

    draw({ job, report: reportOf(), pkg: null, generated: made });
    giveStatement();
    await waitFor(() => expect(screen.getByTestId('engrave-package').dataset.state).toBe('current'));

    // The tick is the operator saying "the grid was run for THIS clamping".
    fireEvent.click(screen.getByTestId('engrave-cut-dome-g32-ack'));
    expect((screen.getByTestId('engrave-upload') as HTMLButtonElement).disabled).toBe(false);

    // A new registration measures the blank again — a new clamping, with a top the old grid may not
    // describe. Both confirmations belong to the old blank and must not carry over.
    act(() => {
      useEngraveRegistrationStore.getState().measureSurface(job.id, TARGET, dome());
    });

    expect((screen.getByTestId('engrave-cut-dome-g32-ack') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('engrave-upload') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('engrave-upload-blocked').textContent).toContain('G32');
  });

  it('#631 (c) — a dome also offers "write the origin anyway", which records the decision and clears Upload', async () => {
    const job = defaultEngraveJob();
    const made = generated([P1]);
    // The same dome, but the operator skips G32: the accept-floor route states the centre miss
    // (c + maxBelow − band) and clears the gate on its own.
    useEngraveRegistrationStore.getState().measureSurface(job.id, TARGET, {
      verdict: 'dome',
      tilt: { xMm: 0, yMm: 0 },
      fit: { kind: 'plane', offset: -0.4, slopeX: 0, slopeY: 0, residual: 0.32 },
      plan: { band: { width: 0.2 } },
      touches: [
        { id: 'surface-1', x: 24, y: 43, z: 0, at: "the cut area's centre", source: 'stated' },
        { id: 'surface-2', x: 11, y: 43, z: -0.4, at: "the cut area's left extent", source: 'probe' },
        { id: 'surface-3', x: 37, y: 43, z: -0.4, at: "the cut area's right extent", source: 'probe' },
        { id: 'surface-4', x: 24, y: 10, z: -0.4, at: "the cut area's front extent", source: 'probe' },
        { id: 'surface-5', x: 24, y: 76, z: -0.4, at: "the cut area's back extent", source: 'probe' },
      ],
      recommendation: {
        gcode: 'G32 R1 X1 Y1 A2 B2 I3 J3 H3',
        dump: 'M375.1',
        after: 'M370',
        sentence:
          'The top is a dome, not a tilt: the machine’s own leveling follows a curved top and the program uploads FLAT. ' +
          'Run G32 R1 X1 Y1 A2 B2 I3 J3 H3 from the console, M375.1 to dump the grid, M370 after. G32 is never uploaded in a file.',
      },
    } as unknown as SurfaceSpreadAssessment);

    draw({ job, report: reportOf(), pkg: null, generated: made });
    giveStatement();
    await waitFor(() => expect(screen.getByTestId('engrave-package').dataset.state).toBe('current'));

    // The alternative route carries the computed miss (here 0.4 + 0 − 0.2 = 0.2 mm at the centre).
    const accept = screen.getByTestId('engrave-cut-dome-accept-floor') as HTMLInputElement;
    expect(accept.closest('label')?.textContent).toContain('Write the origin anyway');
    expect(accept.closest('label')?.textContent).toContain('up to 0.2 mm at the centre');

    // Upload is gated until one of the two routes is chosen.
    expect((screen.getByTestId('engrave-upload') as HTMLButtonElement).disabled).toBe(true);

    // Choosing "write the origin anyway" records the decision and clears the block.
    fireEvent.click(accept);
    expect(accept.checked).toBe(true);
    expect((screen.getByTestId('engrave-upload') as HTMLButtonElement).disabled).toBe(false);
  });

  it('#695 — a frozen mount the machine no longer holds: step 1 offers the change and its card names the machine', () => {
    const job = defaultEngraveJob();
    const pkg = frozen(job, [P1]);
    // The package was frozen for the job's vise setup; the machine's active bed holds the rotary.
    useLocationStore.setState({ status: 'ready', location: locationWith('rotary'), etag: '"loc-1"' } as never);
    passRun();
    draw({ job, report: reportOf(), pkg, generated: generated([P1]) });

    // Step 1 is the open step; its one sentence names the disagreement, with the one action.
    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain(
      'the machine no longer holds the vise',
    );
    const sentence = screen.getByTestId('engrave-cut-mount-sentence').textContent ?? '';
    expect(sentence).toContain('made for the vise');
    expect(sentence).toContain('the rotary on the pins');

    fireEvent.click(screen.getByTestId('engrave-cut-change-machine'));
    const request = useMachineChangeStore.getState().request;
    expect(useMachineChangeStore.getState().open).toBe(true);
    expect(request.target).toBe('vise');
    expect(request.forJob).toEqual({
      name: job.name,
      holding: 'made for the vise',
      frozen: true,
      frozenMount: 'vise',
    });

    // The PROGRAM is fine; the MACHINE is wrong. Step 1 says so, and its card offers no Generate —
    // regenerating would not change the mount.
    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain('no longer holds the vise');
    const box = screen.getByTestId('engrave-package');
    expect(box.dataset.state).toBe('stale');
    expect(screen.queryByTestId('engrave-package-generate')).toBeNull();

    // The wizard writes the vise back (the refresh re-renders from the record): both lines clear.
    act(() => {
      useLocationStore.setState({ location: locationWith('vise') });
    });
    expect(screen.queryByTestId('engrave-cut-mount')).toBeNull();
    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain(
      'matches the design',
    );
    expect(screen.getByTestId('engrave-package').dataset.state).toBe('current');
  });

  // #724 W6 — THE FROZEN MOUNT READS THE FRAME. A chuck job's derived setup carries the setups
  // engine's word (`vise`), because that vocabulary has no rotary (#240). Before this, step 1
  // said "frozen for the vise" and called the package stale on a machine holding the right thing.
  it('#724 W6 — a rotary-framed package reads as the rotary it was frozen for, not the setup’s vise', () => {
    const job = rotaryJob();
    const rotaryProgram = { ...P1, frame: 'rotary' as const };
    const pkg = frozen(job, [rotaryProgram]);
    // The defect's input, stated: the frozen setup itself says vise.
    expect(pkg.setups[0]?.mount.kind).toBe('vise');

    // On the rotary the job was frozen for there is no disagreement: step 1 is clear, step 2 current.
    useLocationStore.setState({ status: 'ready', location: locationWith('rotary'), etag: '"loc-1"' } as never);
    draw({ job, report: reportOf(), pkg, generated: generated([rotaryProgram]) });

    expect(screen.queryByTestId('engrave-cut-mount')).toBeNull();
    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).not.toContain('no longer holds');
    expect(screen.getByTestId('engrave-package').dataset.state).toBe('current');
  });

  it('#724 W6 — on a machine holding the vise, a rotary-framed package names the rotary', () => {
    const job = rotaryJob();
    const rotaryProgram = { ...P1, frame: 'rotary' as const };
    const pkg = frozen(job, [rotaryProgram]);
    useLocationStore.setState({ status: 'ready', location: locationWith('vise'), etag: '"loc-1"' } as never);
    draw({ job, report: reportOf(), pkg, generated: generated([rotaryProgram]) });

    const sentence = screen.getByTestId('engrave-cut-mount-sentence').textContent ?? '';
    expect(sentence).toContain('made for the rotary');
    expect(sentence).toContain('the vise on the pins');

    // The one action asks the wizard for the rotary, and the request says what the job is frozen for.
    fireEvent.click(screen.getByTestId('engrave-cut-change-machine'));
    const request = useMachineChangeStore.getState().request;
    expect(request.target).toBe('rotary');
    expect(request.forJob).toEqual({
      name: job.name,
      holding: 'made for the rotary',
      frozen: true,
      frozenMount: 'rotary',
    });
  });
});

// #656 — THE CHAIN AND THE ONE SCREEN, at the Cut surface's own level.
describe('#656 from the cutter prompt to the cut', () => {
  it('continues on its own: a measured tilt re-posts the frozen package once', async () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    const generateSpy = vi.fn(async () => {});
    useEngraveRunStore.setState({ generate: generateSpy as never });
    // The registration recorded a tilt; the frozen package is flat, so the surface gate holds.
    const surface = { plane: { offset: 0, slopeX: 0.01, slopeY: 0 }, z0: -55 };
    useEngraveRegistrationStore.getState().record(job.id, TARGET, {} as never, {} as never, surface);

    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });

    await waitFor(() => expect(generateSpy).toHaveBeenCalledTimes(1));
    expect(generateSpy).toHaveBeenCalledWith(surface);
  });

  // #934 — A TILT WAITS FOR THE OPERATOR: the automatic chain does not fire, the re-seat offer is
  // shown, and "Follow the tilt" is what runs the re-post.
  it('#934 — a measured tilt offers the re-seat first, and the chain waits for the operator', async () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    const generateSpy = vi.fn(async () => {});
    useEngraveRunStore.setState({ generate: generateSpy as never });
    const surface = { plane: { offset: 0, slopeX: 0.01, slopeY: 0 }, z0: -55 };
    useEngraveRegistrationStore.getState().measureSurface(job.id, TARGET, {
      verdict: 'tilt',
      tilt: { xMm: 0.12, yMm: 0 },
      recommendation: null,
    } as unknown as SurfaceSpreadAssessment);
    useEngraveRegistrationStore.getState().record(job.id, TARGET, {} as never, {} as never, surface);

    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    await Promise.resolve();
    expect(generateSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('engrave-cut-reseat').textContent).toContain(
      'Re-seat the blank (press down on the low side) and register again — or follow the tilt',
    );
    // "Register again" is the registration's own Start; the offer sits beside it.
    expect(screen.getByTestId('engrave-cut-reseat-register').textContent).toBe('Register again');

    fireEvent.click(screen.getByTestId('engrave-cut-reseat-follow'));
    await waitFor(() => expect(generateSpy).toHaveBeenCalledWith(surface));
  });

  it('does not re-post when the package already follows the tilt', async () => {
    const job = plannedJob();
    const pkg = { ...frozen(job, [P1]), surface: { plane: { offset: 0, slopeX: 0.01, slopeY: 0 }, z0: -55 } };
    const generateSpy = vi.fn(async () => {});
    useEngraveRunStore.setState({ generate: generateSpy as never });
    useEngraveRegistrationStore.getState().record(job.id, TARGET, {} as never, {} as never, {
      plane: { offset: 0, slopeX: 0.01, slopeY: 0 },
      z0: -55,
    });

    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    await Promise.resolve();
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it('offers the one screen and holds the steps behind a closed disclosure', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    useEngraveRunStore.setState({ oracle: OK_ORACLE as never });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });

    expect(screen.getByTestId('engrave-cut-confirm')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-confirm-program').textContent).toContain('job');
    // One press, held until the one statement is ticked.
    expect((screen.getByTestId('engrave-cut-go') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-ack'));
    expect((screen.getByTestId('engrave-cut-go') as HTMLButtonElement).disabled).toBe(false);
    // The expert path is there, unchanged, folded.
    expect((screen.getByTestId('engrave-cut-expert') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId('engrave-cut-plan')).toBeTruthy();
  });

  it('#1123 review — Generate does not wait on the restored-run check; Cut does', () => {
    const job = plannedJob();
    const sansPlan = {
      ...job,
      setups: [{ ...jobSetups(job)[0]!, registration: undefined }],
    } as EngraveJob;
    const pkg = frozen(sansPlan, [P1]);
    draw({
      job,
      report: reportOf(),
      pkg,
      generated: generated([P1]),
      canDrive: true,
      restoreChecking: true,
      staleSince: 1,
    });
    // A hung house must never leave the operator unable to regenerate: the stale-program Generate
    // is live while the restored run is still being checked; only the Cut press waits.
    expect((screen.getByTestId('engrave-package-generate') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('engrave-cut-go') as HTMLButtonElement).disabled).toBe(true);
  });

  it('#1123 review — a restored run is unverified until the shop reads settle: the Cut press is off', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    useEngraveRunStore.setState({ oracle: OK_ORACLE as never });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true, restoreChecking: true });
    fireEvent.click(screen.getByTestId('engrave-ack'));
    expect((screen.getByTestId('engrave-cut-go') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('engrave-cut-go-blocked').textContent).toContain(
      'checking the restored run against this shop',
    );
  });

  it('leaves a multi-program job to the release flow, with the disclosure open', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1, P2]);
    useEngraveRunStore.setState({ oracle: OK_ORACLE as never });
    draw({ job, report: reportOf(), pkg, generated: generated([P1, P2]), canDrive: true });

    expect(screen.queryByTestId('engrave-cut-confirm')).toBeNull();
    expect((screen.getByTestId('engrave-cut-expert') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByTestId('engrave-cut-run')).toBeTruthy();
  });
});

// #819 — THE ENDED RUN OWNS THE SCREEN, AND ONLY WHEN IT IS THIS JOB'S.
describe('#819 the finished screen', () => {
  const ended = (jobId: string | undefined) => ({
    running: false,
    filename: 'job.nc',
    programHash: P1.programHash,
    progress: null,
    lines: [],
    outcome: { kind: 'finished', last: { line: 10, percent: 100, elapsedS: 12 }, homed: true, vacuumOff: true },
    stopAsked: false,
    paused: false,
    toolWaiting: null,
    context: jobId === undefined ? { nc: NC1 } : { nc: NC1, jobId },
    end: { kind: 'finished', lines: ['bookkeeping the card must not draw'], offcut: null, stockQuestion: null },
    pendingStock: null,
  });

  it('a finished run gives the Cut screen to its Done card — one line and one action — and a foreign run does not', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);

    // This job's run: the steps give way to the card and its one action.
    useMachineRunStore.setState({ runs: { [machineKey(TARGET)]: ended(job.id) } as never });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    expect(screen.queryByTestId('engrave-cut-step-1')).toBeNull();
    expect(screen.queryByTestId('engrave-cut-go')).toBeNull();
    expect(screen.getByTestId('engrave-run-end').dataset.kind).toBe('finished');
    expect(screen.getByTestId('engrave-run-done-title').textContent).toMatch(/^Finished · /);
    expect(screen.getByTestId('engrave-run-outcome').textContent).toBe('Vacuum off; homed.');
    expect(screen.queryByText('bookkeeping the card must not draw')).toBeNull();
    expect(screen.queryByTestId('engrave-run-start')).toBeNull();
    expect(screen.getByTestId('engrave-run-another')).toBeTruthy();

    // Another job's run on the same machine: this job's steps stay — with the press step 3 owns —
    // so the other job's end cannot take this screen. (The machine's own run panel still draws that
    // entry inside step 3, as it always has: the entry belongs to the machine, not to the job.)
    cleanup();
    useMachineRunStore.setState({ runs: { [machineKey(TARGET)]: ended('another-job') } as never });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    expect(screen.getByTestId('engrave-cut-step-1')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-go')).toBeTruthy();
  });

  // #927 — THE DONE CARD'S ONE TIME LINE. The last measured run of this job's program, against the
  // estimate that run's own record carries: 270 s against 250 s is 8 % over.
  it('#927 prints the last measured run against its record’s estimate, and says so when there is none', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    const recordWith = (estimatedSeconds: number | null) => {
      const cam = estimatedSeconds === null ? null : { operations: 1, cuttingMoves: 10, estimatedSeconds, passes: 1 };
      const built = buildRunRecord(
        job,
        { ...generated([P1]), cam } as unknown as Parameters<typeof buildRunRecord>[1],
        new Date('2026-11-02T00:00:00.000Z'),
      );
      return withActualSeconds(built, 270, new Date('2026-11-02T00:00:00.000Z'));
    };

    useMachineRunStore.setState({ runs: { [machineKey(TARGET)]: ended(job.id) } as never });
    useRunRecordStore.setState({ imported: [recordWith(250)] });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    expect(screen.getByTestId('engrave-cut-actual-time').textContent).toBe(
      'The run recorded on 2026-11-02 took 4 min 30 s against 4 min 10 s predicted — 8 % over.',
    );

    // A record with no estimate says so rather than inventing a percentage.
    cleanup();
    useRunRecordStore.setState({ imported: [recordWith(null)] });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    expect(screen.getByTestId('engrave-cut-actual-time').textContent).toBe(
      'The run recorded on 2026-11-02 took 4 min 30 s — no estimate recorded.',
    );

    // No record at all: the PROGRAM has an estimate, so the line says what is missing — the run.
    cleanup();
    useRunRecordStore.setState({ imported: [] });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    expect(screen.getByTestId('engrave-cut-actual-time').textContent).toBe('No timed run recorded for this job yet.');
  });
});


// #931 — THE CUT STEP TELLS THE TRUTH ABOUT THE SIMULATION. Design's four ticks and Cut step 1
// read one derivation: "matches the design" is the oracle's word and only a passed run earns it; a
// failed one states the first sentence the run produced and offers the press that resolves it; a
// run that never finished says which; a stopped run is not a failed one.
describe('#931 the Cut step against the simulation', () => {
  const FAILED = {
    source: 'sweep' as const,
    severity: 'error' as const,
    code: 'tool-into-fixture',
    message:
      'the facing pass (flat-1.0): checkpoint 0: the cutter drives 0.477 mm³ into the fixture ' +
      "'Vise moving jaw (right)' (vise-moving-jaw)",
  };

  it('a program never simulated is not “matches the design”', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });

    const summary = screen.getByTestId('engrave-cut-step-1-summary').textContent ?? '';
    expect(summary).not.toContain('matches the design');
    expect(summary).toContain('not simulated');
    expect(screen.getByTestId('engrave-cut-verdict').dataset.state).toBe('not-simulated');
    expect(screen.getByTestId('engrave-cut-verdict-line').textContent).toBe('The program has not been simulated.');
    // The step is not done, so the cut does not open on Register.
    expect((screen.getByTestId('engrave-cut-step-1') as HTMLDetailsElement).open).toBe(true);
    expect((screen.getByTestId('engrave-cut-step-2') as HTMLDetailsElement).open).toBe(false);
  });

  it('a failed sweep says “did not pass”, in the operator’s words, and its press opens Holding', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    useEngraveRunStore.setState({
      simStatus: 'ready',
      simDiagnostics: [FAILED] as never,
      oracle: null,
      phase: 'blocked',
      staleSince: null,
    });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });

    const summary = screen.getByTestId('engrave-cut-step-1-summary').textContent ?? '';
    expect(summary).toContain('did not pass');
    expect(summary).not.toContain('matches the design');
    // The same words Design's `engrave-run-errors` prints: no ids, the obstacle in operator terms.
    expect(screen.getByTestId('engrave-cut-verdict-sentence').textContent).toBe(
      'The facing pass would cut 0.477 mm³ into the vise’s moving jaw (right)',
    );
    const fix = screen.getByTestId('engrave-cut-verdict-fix');
    expect(fix.textContent).toBe('Open the Holding step');
    fireEvent.click(fix);
    expect(useStartWizardStore.getState().open).toBe(true);
    expect(useStartWizardStore.getState().initialStep).toBe('holding');
  });

  it('a passed run earns “matches the design”, and only then', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    passRun();
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });

    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain('matches the design');
    expect(screen.queryByTestId('engrave-cut-verdict')).toBeNull();
  });

  it('a stopped simulation is not a failed one, and offers no fix', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    useEngraveRunStore.setState({
      simStatus: null,
      simStopped: true,
      simDiagnostics: [],
      oracle: null,
      phase: 'blocked',
      staleSince: null,
    });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });

    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain(
      'the simulation stopped before it finished',
    );
    expect(screen.getByTestId('engrave-cut-verdict').dataset.state).toBe('stopped');
    expect(screen.queryByTestId('engrave-cut-verdict-fix')).toBeNull();
  });

  // #925 — THE DESIGN CHECK'S SEVERITY decides. The sweep's diagnostics are the design check's own
  // errors now (air-moves-unchecked/sweep-stalled); an ERROR fails a run whose oracle passed, and a
  // warning never does.
  it('#925 — an error-severity design finding reads “did not pass”; a warning leaves the pass', () => {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    const sweepDiag = (severity: 'error' | 'warning') => [
      {
        source: 'sweep' as const,
        severity,
        code: severity === 'error' ? 'air-moves-unchecked' : 'air-moves-note',
        message:
          severity === 'error'
            ? '12 air move(s) near the stock not checked: more than 4000 in the job'
            : 'a note from the sweep that does not undermine the verdict',
      },
    ];

    useEngraveRunStore.setState({
      simStatus: 'ready',
      simDiagnostics: sweepDiag('error') as never,
      oracle: OK_ORACLE as never,
      phase: 'blocked',
      staleSince: null,
      simStopped: false,
    });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain('did not pass');
    expect(screen.getByTestId('engrave-cut-verdict').dataset.state).toBe('failed');
    expect(screen.getByTestId('engrave-cut-verdict-sentence').textContent).toContain('air move(s) near the stock not checked');

    cleanup();
    useEngraveRunStore.setState({
      simStatus: 'ready',
      simDiagnostics: sweepDiag('warning') as never,
      oracle: OK_ORACLE as never,
      phase: 'ready',
      staleSince: null,
      simStopped: false,
    });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain('matches the design');
    expect(screen.queryByTestId('engrave-cut-verdict')).toBeNull();
  });
});

// #948 — THE GOAL CHECK'S LINE. The demo page's cards print the 3D goal verdict beside the 2.5D
// one; the Cut card prints the same three facts in one line under the gate's verdict: a pass, the
// worst cut-into with where it is, or the check saying it did not run (never a silent pass). The
// report states all three (`ran`/`reason`/`maxCutIntoAt`, C's #948 shape), so these pin the line's
// three states and its absence on a 2.5D run.
describe('#948 the goal check’s line', () => {
  const goal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ok: true,
    ran: true,
    reason: null,
    maxCutIntoAt: null,
    passCoverage: 0.95,
    goalCells: 100,
    pitchMm: 0.1,
    cutIntoFloorMm: 0.01,
    cutIntoFraction: 0,
    cutIntoAreaMm2: 0,
    cutIntoVolumeMm3: 0,
    maxCutIntoMm: 0,
    // #964 — the card names the cell the pass judged; the raw fields ride beside it.
    adjudicatedFraction: 0,
    adjudicatedMaxMm: 0,
    adjudicatedMaxAt: null,
    leftoverFractions: [0, 0, 0],
    leftoverVolumeMm3: 0,
    maxLeftoverMm: 0,
    coverageFraction: 0.96,
    medianDeltaMm: 0,
    sentence: 'goal check: no cell cut more than 0.01 mm into the goal (96.0 % of the goal within 0.01 mm).',
    ...over,
  });

  function drawWithOracle(oracle: unknown): void {
    const job = plannedJob();
    const pkg = frozen(job, [P1]);
    useEngraveRunStore.setState({
      simStatus: 'ready',
      simDiagnostics: [],
      oracle: oracle as never,
      phase: 'ready',
      staleSince: null,
      simStopped: false,
    });
    draw({ job, report: reportOf(), pkg, generated: generated([P1]), canDrive: true });
  }

  it('a passed goal check matches the design, in the page’s own words', () => {
    drawWithOracle({ ...OK_ORACLE, goalCutInto: goal() });
    const line = screen.getByTestId('engrave-cut-goal');
    expect(line.textContent).toBe('Matches the design (goal)');
    expect(line.dataset.state).toBe('match');
  });

  it('a cut-into goal says how deep and where the worst cell is', () => {
    drawWithOracle({
      ok: false,
      band: 0.016,
      levels: [],
      worst: { underCut: 0, overCut: 0 },
      goalCutInto: goal({
        ok: false,
        cutIntoFraction: 0.0008,
        maxCutIntoMm: 0.243,
        maxCutIntoAt: { x: 12.35, y: 8.1 },
        adjudicatedFraction: 0.0008,
        adjudicatedMaxMm: 0.243,
        adjudicatedMaxAt: { x: 12.35, y: 8.1 },
      }),
    });
    const line = screen.getByTestId('engrave-cut-goal');
    expect(line.textContent).toBe('Cuts 0.243 mm into the design at 12.35, 8.1');
    expect(line.dataset.state).toBe('cut-into');
  });

  it('prints the RAW reading beside the judged one — its own line, never the pass (#964)', () => {
    drawWithOracle({
      ...OK_ORACLE,
      goalCutInto: goal({
        ok: false,
        // The top clamp's shape: 1.98 % raw, judged 0.05 % at a 0.165 mm maximum after the
        // wall/shadow exclusions.
        cutIntoFraction: 0.0198,
        maxCutIntoMm: 2.448,
        maxCutIntoAt: { x: 10, y: 10 },
        adjudicatedFraction: 0.0005,
        adjudicatedMaxMm: 0.165,
        adjudicatedMaxAt: { x: 10, y: 10 },
      }),
    });
    const judged = screen.getByTestId('engrave-cut-goal');
    expect(judged.textContent).toBe('Cuts 0.165 mm into the design at 10, 10');
    expect(judged.dataset.state).toBe('cut-into');
    const raw = screen.getByTestId('engrave-cut-goal-raw');
    expect(raw.textContent).toBe('raw, before exclusions: 1.98 % cut-into, max 2.448 mm at 10, 10');
    // Never as the pass: the raw line is the muted fact, and the verdict line carries the state.
    expect(raw.dataset.state).toBeUndefined();
  });

  it('a check that did not run says why — never a silent pass', () => {
    drawWithOracle({
      ...OK_ORACLE,
      goalCutInto: goal({ ran: false, reason: 'a radial goal is sampled in its own map frame, which this run did not check' }),
    });
    const line = screen.getByTestId('engrave-cut-goal');
    expect(line.textContent).toBe(
      'Goal not checked: a radial goal is sampled in its own map frame, which this run did not check',
    );
    expect(line.dataset.state).toBe('not-checked');
  });

  // #948 review (wave2 T3) — A GOAL NOBODY COMPARED KEEPS STEP 1 OPEN, WITH ITS CARD. The
  // 'goal-unchecked' headline is not a done tick, so step 1 stays the current step: its body is
  // open, the details fold (the program's own four checks) is still in the card, and the summary
  // states the headline the operator reads. The rotary goal is the live case — its report is
  // `ran: false` — and the fold's `<summary>` must stay reachable inside the open step.
  it('#948 review — the goal-unchecked state keeps step 1 open, with its details fold', () => {
    drawWithOracle({
      ...OK_ORACLE,
      goalCutInto: goal({ ran: false, reason: 'a radial goal is sampled in its own map frame, which this run did not check' }),
    });
    expect(
      (screen.getByTestId('engrave-cut-step-1') as HTMLDetailsElement).open,
      'goal-unchecked is not a done tick: step 1 is the current step and stays open',
    ).toBe(true);
    const details = screen.getByTestId('engrave-cut-details') as HTMLDetailsElement;
    expect(details.querySelector('summary')?.textContent).toBe('details');
    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain(
      'Program checked — the goal was not compared (a radial goal is sampled in its own map frame, which this run did not check)',
    );
  });

  it('a 2.5D run has no goal line at all', () => {
    drawWithOracle(OK_ORACLE);
    expect(screen.queryByTestId('engrave-cut-goal')).toBeNull();
  });

  // #948 — THE PAGE'S TOP-SURFACE COVERAGE FACT under the goal line, in the page's own words. The
  // MEASURED figure is the checker's arithmetic on `leftoverFractions[0]` (j29's 16.42 % left over
  // > 0.1 mm → 83.58 %); `passCoverage` is the number the check JUDGED AGAINST (the shop's
  // `goal.passCoverage` default, 0.95) and is printed as the pass line, never as the reading. No
  // reach line: the report carries no reach field yet, and a "not stated" sentence on every goal
  // run would be noise (the manager's ruling, 2026-11-03).
  it('prints the measured coverage and the pass line, in the page’s words', () => {
    drawWithOracle({
      ...OK_ORACLE,
      goalCutInto: goal({ passCoverage: 0.95, leftoverFractions: [0.1642, 0.0503, 0] }),
    });
    const coverage = screen.getByTestId('engrave-cut-goal-coverage');
    expect(coverage.textContent).toBe('Top-surface coverage: 83.58 % (the pass line is 95 %)');
    expect(screen.queryByTestId('engrave-cut-goal-reach')).toBeNull();
    // The goal line itself is unchanged by the fact, and a COMPARED goal keeps the pass headline.
    expect(screen.getByTestId('engrave-cut-goal').textContent).toBe('Matches the design (goal)');
    expect(screen.getByTestId('engrave-cut-step-1-summary').textContent).toContain('matches the design');
  });

  // #948 — THE REPORT'S OWN FAILURE when `ok` is false for COVERAGE, not for a cut into the part:
  // j29 on the milestone's job reads ok false, zero cut-into cells, 46.49 % coverage, and the line
  // used to fall through to the cut-into branch and print "Cuts 0 mm into the design". It states
  // the coverage failure instead, with its own data-state; a cut-into keeps its branch.
  it('states a coverage failure when ok is false with no cut-into cells', () => {
    drawWithOracle({
      ok: false,
      band: 0.016,
      levels: [],
      worst: { underCut: 0, overCut: 0 },
      goalCutInto: goal({
        ok: false,
        passCoverage: 0.95,
        leftoverFractions: [0.5351, 0.2, 0.05],
        cutIntoFraction: 0,
        maxCutIntoMm: 0,
      }),
    });
    const line = screen.getByTestId('engrave-cut-goal');
    expect(line.textContent).toBe('Covers 46.49 % of the design’s top surface (the pass line is 95 %)');
    expect(line.dataset.state).toBe('coverage');
    expect(line.textContent).not.toContain('Cuts 0 mm');
  });

  // #948 review (A) — THE HEADLINE. A goal report that did not run must not head the Cut step with
  // "matches the design": the fourth cutVerdict state says the program checked and the goal was not
  // compared, with the report's reason. Neutral: the step is not a green tick and stays open.
  it('heads a goal that was never compared with the neutral fourth state, not the pass sentence', () => {
    drawWithOracle({
      ...OK_ORACLE,
      goalCutInto: goal({
        ok: true,
        ran: false,
        reason: 'a radial goal is sampled in its own map frame, which this run did not check',
      }),
    });
    const summary = screen.getByTestId('engrave-cut-step-1-summary').textContent ?? '';
    expect(summary).toContain(
      'Program checked — the goal was not compared (a radial goal is sampled in its own map frame, which this run did not check)',
    );
    expect(summary).not.toContain('matches the design');
    // Neutral styling: no done tick, and the step is the current one, so its body is open.
    expect(screen.getByTestId('engrave-cut-step-1-title').textContent).not.toContain('✓');
    expect((screen.getByTestId('engrave-cut-step-1') as HTMLDetailsElement).open).toBe(true);
  });

  // #948 review (A) — AN UNCHECKED GOAL IS NEVER A PASS MARK. `ok` stays true in the report (the run
  // is not wrong), but with `ran: false` the goal state renders neutral "not checked" — the goal
  // line's state is decided on `ran` BEFORE `ok`, so a green tick can never stand for a check that
  // did not run. No coverage fact either: its numbers are zero by construction.
  it('states no coverage fact, and a neutral not-checked goal state, for a check that did not run', () => {
    drawWithOracle({
      ...OK_ORACLE,
      goalCutInto: goal({
        ok: true,
        ran: false,
        reason: 'a radial goal is sampled in its own map frame, which this run did not check',
      }),
    });
    expect(screen.queryByTestId('engrave-cut-goal-coverage')).toBeNull();
    const line = screen.getByTestId('engrave-cut-goal');
    expect(line.dataset.state).toBe('not-checked');
    expect(line.dataset.state).not.toBe('match');
    expect(line.textContent).toContain('Goal not checked:');
    expect(line.textContent).not.toContain('Matches the design');
  });
});

// #986 (the ruling, E's review) — the background comparison's three card states.
describe('#986 the card reads the background comparison', () => {
  it('says "comparing…" while the ideal is out and "no material difference" when it lands with none', () => {
    const job = defaultEngraveJob();
    passRun();
    act(() => {
      useEngraveRunStore.setState({ idealPlan: { status: 'comparing', tradeoff: null } });
    });
    const view = draw({ job, report: reportOf(), pkg: null, generated: generated([P1]) });
    expect(screen.getByTestId('engrave-plan-comparing')).toBeTruthy();

    act(() => {
      useEngraveRunStore.setState({ idealPlan: { status: 'ready', tradeoff: { material: false, line: null, differences: [] } as never } });
    });
    view.show({ job, report: reportOf(), pkg: null, generated: generated([P1]) });
    expect(screen.queryByTestId('engrave-plan-comparing')).toBeNull();
    expect(screen.getByTestId('engrave-plan-no-difference')).toBeTruthy();
  });
});
