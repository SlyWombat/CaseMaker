// @vitest-environment jsdom
// #725 — the bed-mount defects from the off-bench exercise (2026-10-27), pinned one by one:
//
//   B4  a blocked RUN names its first generation-time error at the button, with a Fix (the clamp
//       refusals used to read only "2 errors outstanding.");
//   B7  the bed's through facts reach the panel's own validation (a taped through cut on the
//       wasteboard is not refused, and a bare bed says the design's sentence);
//   W12 two clamps on top of each other are a document error, not only a Holding note;
//   W1  the panel's Hold line is the bed mount's (§3.7), not the vise's;
//   W10 a MEASURED vise is the machine's calibration, not an assertion — the bed's default mount
//       is taken on a machine with nothing on the pins, and the chuck's after a vise → rotary;
//   P8  the side view names the surface under the stock (wasteboard, not "bed");
//   P9  a clamp already on the right edge is offered the back edge, not "onto the right edge";
//   B5  the bracket row's Change the machine… asks the wizard to FIT the bracket.
//
// The machine-change wizard's own defects (W13, W14, W15, P14) live in
// `machineChangeWizard.spec.tsx` / `machineChange.spec.ts`; the 3D fixture is pinned in
// `engravePreview.spec.ts` (real Manifold).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngravePanel } from '@/components/panels/EngravePanel';
import { StartWizard } from '@/components/welcome/StartWizard';
import { MachineChangeWizard } from '@/components/machine-change';
import { bedUnderFacts } from '@/platform/bedProfiles';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clampPlacementsFor, jobMount, jobSetups, validateJob } from '@/engine/cnc/engrave/jobSetup';
import { bracketMount } from '@/engine/cnc/mounts/bracket';
import { jobVise } from '@/engine/cnc/fixture';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { resetMachineChange, useMachineChangeStore } from '@/store/machineChangeStore';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import { resetEngraveRows } from '@/store/engraveRowStore';
import {
  MachineRecordSchema,
  type BedProfile,
  type FixtureRecord,
  type LocationView,
  type MachineRecord,
} from '@/platform/locationClient';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { EngraveJob, EngraveShape, TapeHold } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'location-doc.json');
const DOC = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  id: string;
  name: string;
  createdAt: string;
  machines: unknown[];
  accessories: FixtureRecord[];
  defaults: Record<string, unknown>;
};

const caps = vi.hoisted(() => ({ drive: true }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canDriveMachine() {
      return caps.drive;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOARDS_AND_TAPE: NonNullable<BedProfile['consumables']> = {
  tape: { widthMm: 20, thicknessMm: 0.2, provenance: 'typed' },
  boards: [{ material: 'MDF', size: [100, 100, 2], count: 4 }],
};

const BARE_SURFACE: BedProfile['surface'] = {
  kind: 'bare-bed',
  material: null,
  length: null,
  width: null,
  thickness: null,
  position: null,
  provenance: {},
  scars: [],
  lastResurfacedAt: null,
};

const ROTARY: FixtureRecord = {
  id: 'fx-rotary-1',
  kind: 'rotary-module',
  product: 'makera-4th-axis',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'machine', machineId: 'makera-z1-1a2b3c', since: '2026-10-27T09:00:00.000Z' },
  history: [],
};

/**
 * The fixture's machine with NOTHING ON THE PINS (unless `vise`), the bed optionally carrying the
 * bracket at anchor 1, the rotary on the pins, and/or a bare bed.
 */
function bedMachine(opts: { anchor?: boolean; bare?: boolean; vise?: boolean; rotary?: boolean } = {}): MachineRecord {
  const machine = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  const profile = machine.bedProfiles![0]!;
  if (opts.vise !== true) profile.placements = profile.placements.filter((pl) => pl.where.kind !== 'pins');
  if (opts.rotary === true) {
    profile.placements = [
      {
        id: 'pl-rotary',
        fixture: 'fx-rotary-1',
        where: { kind: 'pins', pins: 'rotary', anchor: null },
        count: null,
        frame: null,
        provenance: {},
      },
    ];
    profile.surface = { ...BARE_SURFACE };
  }
  if (opts.anchor === true) {
    profile.placements.push({
      id: 'pl-bracket',
      fixture: 'fx-bracket-thin',
      where: { kind: 'anchor', anchor: 1, pins: null },
      count: null,
      frame: null,
      provenance: {},
    });
  }
  if (opts.bare === true) profile.surface = { ...BARE_SURFACE };
  profile.consumables = BOARDS_AND_TAPE;
  return machine;
}

function seedLocation(machine: MachineRecord, accessories: FixtureRecord[] = [...DOC.accessories, ROTARY]): void {
  const location = {
    kind: 'casemaker-location',
    schemaVersion: 1,
    id: DOC.id,
    name: DOC.name,
    createdAt: DOC.createdAt,
    machines: [machine],
    accessories,
  } as unknown as LocationView;
  act(() => {
    useLocationStore.setState({ status: 'present', location, etag: '"e1"', reason: null });
  });
}

/** A 40 × 30 through rectangle inside an 80 × 60 sheet. */
const THROUGH_RECT: EngraveShape = {
  kind: 'rect',
  id: 'sh-tag',
  name: 'Tag',
  width: 40,
  height: 30,
  cornerRadius: 0,
  position: { x: 40, y: 30 },
  rotation: 0,
  depth: 2,
  through: true,
  enabled: true,
};

const TAPE: TapeHold = { width: 20, thickness: 0.2, inset: 2, where: null, squareTo: 'front', source: 'saved' };

function tapedJob(over: Partial<EngraveJob> = {}): EngraveJob {
  const job = defaultEngraveJob();
  return {
    ...job,
    labels: [],
    shapes: [THROUGH_RECT],
    toolKey: 'flat-1.0',
    stock: { ...job.stock, length: 80, width: 60, thickness: 2, material: 'pla' },
    workholding: { kind: 'tape', tape: { ...TAPE } },
    ...over,
  };
}

function bracketJob(
  clamps: Array<{ edge: 'back' | 'right'; at: number }> = [
    { edge: 'back', at: 22.5 },
    { edge: 'back', at: 30 },
  ],
): EngraveJob {
  const job = defaultEngraveJob();
  return {
    ...job,
    labels: [],
    // A pocket for the job to have work at all: `no-items` comes before any mount finding.
    shapes: [
      { kind: 'rect', id: 'sh-pocket', name: 'Pocket', width: 20, height: 10, cornerRadius: 0, position: { x: 50, y: 30 }, rotation: 0, depth: 0.5, enabled: true },
    ],
    toolKey: 'flat-1.0',
    stock: { ...job.stock, length: 100, width: 60, thickness: 6, material: 'pla' },
    workholding: {
      kind: 'bracket',
      bracket: { anchor: 1, variant: 'thin', clamps: clamps.map((c) => ({ ...c })), source: 'saved' },
    },
  };
}

/** The fixture's MEASURED vise (source 'measured'), the way step 2 seeds it from the machine. */
function withMeasuredVise(job: EngraveJob): EngraveJob {
  return {
    ...job,
    workholding: {
      kind: 'vise',
      vise: {
        seat: 'ledge',
        stockProud: 1.5,
        fixedJawThickness: 10,
        movingJawThickness: 10,
        jawLength: 100,
        jawStartY: -10,
        uncertainty: 0.1,
        source: 'measured',
        measuredAt: '2026-10-13T12:00:00.000Z',
      },
    },
  };
}

/** A client that answers every request with "no new preview" — the panel's fallback is under test. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

const findingsIn = (): HTMLElement[] => {
  const list = screen.queryByTestId('engrave-findings');
  return list === null ? [] : Array.from(list.querySelectorAll<HTMLElement>('[data-testid^="engrave-finding-"]'));
};

function refused(verifyFindings: Array<{ code: string; message: string }>): EngraveGenerated {
  return {
    ok: false,
    stage: 'verify',
    findings: [],
    feeds: null,
    threads: null,
    cam: { operations: 1, cuttingMoves: 10, estimatedSeconds: 5, passes: 2 },
    nc: ';@MKR|BEGIN\nG21 G90\nG1 Z-1.5 F200\nM02',
    verify: {
      ok: false,
      findings: verifyFindings.map((f) => ({ severity: 'error' as const, line: 3, ...f })),
      stats: { lines: 3, cuttingMoves: 1, deepestZ: -1.5, bbox: { min: [0, 0, -1.5], max: [1, 1, 0] } },
    },
    frameNc: null,
    frameVerify: null,
    facingNc: null,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    facingCam: null,
    predicted: [],
    programs: [],
    errors: [{ stage: 'verify', message: `${verifyFindings.length} verifier error(s)` }],
  } as unknown as EngraveGenerated;
}

function openHolding(job: EngraveJob, machine: MachineRecord): void {
  seedLocation(machine);
  act(() => {
    useEngraveJobStore.setState({ job });
    useStartWizardStore.getState().openWizard('holding');
  });
  render(
    <>
      <StartWizard />
      <MachineChangeWizard />
    </>,
  );
}

beforeEach(() => {
  caps.drive = true;
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  resetEngraveRows();
  resetStartWizard();
  resetMachineChange();
  resetLocationStore();
  resetMachineStore();
  useSettingsStore.getState().resetSettings();
  act(() => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });
  useEngravePreviewStore.getState().dispose();
});

afterEach(() => {
  cleanup();
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
  resetMachineChange();
  resetLocationStore();
});

describe('#725 B7/W11 — the bed reaches the panel’s own through rule', () => {
  it('a through cut taped on the wasteboard is not refused (the fallback reads the bed)', () => {
    seedLocation(bedMachine());
    act(() => useEngraveJobStore.setState({ job: tapedJob() }));
    render(<EngravePanel />);

    // A labelId finding sits on the item's row, not the footer list — the BUTTON is the gate.
    expect(screen.queryByTestId('engrave-generate-blocker')?.textContent ?? '').not.toContain('only the bed is under it');
    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a bare bed says the design’s sentence, naming the house board', () => {
    seedLocation(bedMachine({ bare: true }));
    act(() => useEngraveJobStore.setState({ job: tapedJob() }));
    render(<EngravePanel />);

    const blocker = screen.getByTestId('engrave-generate-blocker').textContent ?? '';
    expect(blocker).toContain('and only the bed is under it — put a 2 mm MDF board under it, or tape it on the wasteboard');
    expect(blocker).not.toContain('reaches the vise');
  });

  it('the engine and the run read one bed: bedUnderFacts resolves the wasteboard from the location', () => {
    const machine = bedMachine();
    const bed = bedUnderFacts(machine, DOC.defaults as never, 3);
    expect(bed).toMatchObject({ surface: 'wasteboard', wasteboardMm: 10 });
    const findings = validateJob(tapedJob(), null, { bed, defaults: DOC.defaults as never });
    expect(findings.filter((f) => f.code === 'through-needs-board')).toHaveLength(0);
  });
});

describe('#725 B4 — a blocked run names its first error and its Fix', () => {
  it('the verifier’s clamp refusal reaches the button, and the Fix opens Holding', () => {
    render(<EngravePanel />);
    const sentence =
      '“Tray” runs under the clamp on the back edge, 15 mm in from the left-hand corner — slide the clamp along the back edge, or move it to the right edge, clear of the cut.';
    act(() => {
      useEngraveRunStore.setState({
        generated: refused([{ code: 'clamp-in-path', message: sentence }]),
        simStatus: null,
        simDiagnostics: [],
        phase: 'blocked',
        staleSince: null,
      });
    });

    // #724 B2 owns the sentence in the row; #725 B4 adds the Fix beside it.
    expect(screen.getByTestId('engrave-run-errors').textContent).toContain('runs under the clamp on the back edge');
    expect(screen.getByTestId('engrave-run-errors').textContent).not.toContain('error outstanding');
    expect(screen.getByTestId('engrave-run-blocker-fix').textContent).toBe('▸ Fix');

    fireEvent.click(screen.getByTestId('engrave-run-blocker-fix'));
    expect(useStartWizardStore.getState().open).toBe(true);
  });

  it('a STALE run keeps no Fix: an edit re-opens Generate', () => {
    render(<EngravePanel />);
    act(() => {
      useEngraveRunStore.setState({
        generated: refused([{ code: 'clamp-in-path', message: 'a clamp is in the way' }]),
        simStatus: null,
        simDiagnostics: [],
        phase: 'blocked',
        staleSince: Date.now(),
      });
    });
    // The row still names the last run's error (#724 B2), but a stale verdict offers no control.
    expect(screen.getByTestId('engrave-run-errors').textContent).toContain('a clamp is in the way');
    expect(screen.queryByTestId('engrave-run-blocker-fix')).toBeNull();
  });

  it('a document finding still wins over the run’s own, so the button and the run cannot disagree', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-label-expand-0'));
    fireEvent.change(screen.getByTestId('engrave-label-depth-0'), { target: { value: '11.5' } });
    act(() => {
      useEngraveRunStore.setState({
        generated: refused([{ code: 'clamp-in-path', message: 'a clamp is in the way' }]),
        simStatus: null,
        simDiagnostics: [],
        phase: 'blocked',
        staleSince: null,
      });
    });
    expect(screen.getByTestId('engrave-generate-blocker').textContent).toContain('11.5 mm deep');
  });
});

describe('#725 W12 — overlapping clamps are a document error', () => {
  it('the engine raises clamps-overlap with the Holding step’s own sentence', () => {
    const findings = validateJob(bracketJob(), null, { defaults: DOC.defaults as never });
    const overlap = findings.filter((f) => f.code === 'clamps-overlap');
    expect(overlap).toHaveLength(1);
    expect(overlap[0]!.severity).toBe('error');
    expect(overlap[0]!.message).toContain('sit on top of each other');
  });

  it('Generate is blocked by it, and its Fix opens Holding', () => {
    seedLocation(bedMachine({ anchor: true }));
    act(() => useEngraveJobStore.setState({ job: bracketJob() }));
    render(<EngravePanel />);

    expect((screen.getByTestId('engrave-generate') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('engrave-generate-blocker').textContent).toContain('sit on top of each other');
    fireEvent.click(screen.getByTestId('engrave-generate-fix'));
    expect(useStartWizardStore.getState().open).toBe(true);
  });

  it('clamps clear of each other raise nothing', () => {
    const findings = validateJob(
      bracketJob([
        { edge: 'back', at: 22.5 },
        { edge: 'back', at: 77.5 },
      ]),
      null,
      { defaults: DOC.defaults as never },
    );
    expect(findings.filter((f) => f.code === 'clamps-overlap')).toHaveLength(0);
  });
});

describe('#725 W1 — the panel’s Hold line is the mount’s', () => {
  it('a taped job says the tape, the surface under it and where it is', () => {
    seedLocation(bedMachine());
    act(() => useEngraveJobStore.setState({ job: tapedJob() }));
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-group-hold').textContent).toContain(
      'On the bed, taped · wasteboard under · 20 mm tape · the middle of the bed',
    );
    expect(screen.getByTestId('engrave-bed-card')).toBeTruthy();
    expect(screen.queryByTestId('engrave-vise-card')).toBeNull();
  });

  it('a bracket job says the bracket, its clamps and its corner', () => {
    seedLocation(bedMachine({ anchor: true }));
    act(() =>
      useEngraveJobStore.setState({
        job: bracketJob([
          { edge: 'back', at: 22.5 },
          { edge: 'back', at: 77.5 },
        ]),
      }),
    );
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-group-hold').textContent).toContain(
      'Bracket at anchor 1 · 2 clamps on the back edge, 12 mm tall · X 0 Y 0 at its corner',
    );
  });
});

describe('#725 W10 — a measured vise is not an assertion', () => {
  it('with nothing on the pins the bed’s default mount is taken', () => {
    openHolding(withMeasuredVise(tapedJob({ shapes: [] })), bedMachine());
    expect(useEngraveJobStore.getState().job.workholding.kind).toBe('tape');
    expect((screen.getByTestId('engrave-setup-mount-bed-tape') as HTMLInputElement).checked).toBe(true);
  });

  it('after a vise → rotary change a round rod goes into the chuck', () => {
    const base = defaultEngraveJob();
    const rod = withMeasuredVise({
      ...base,
      labels: [],
      toolKey: 'flat-1.0',
      stock: { ...base.stock, length: 20, width: 20, thickness: 100, material: 'pla' },
      stockEntry: { kind: 'made', shelfId: null, file: null, form: 'rod', finish: 'unknown', conductive: false },
    });
    openHolding(rod, bedMachine({ vise: true }));
    expect(useEngraveJobStore.getState().job.workholding.kind).toBe('vise');
    // The machine change writes the new active profile: the module is on the pins.
    seedLocation(bedMachine({ rotary: true }));
    expect(useEngraveJobStore.getState().job.workholding.kind).toBe('rotary-chuck');
    expect((screen.getByTestId('engrave-setup-mount-rotary') as HTMLInputElement).checked).toBe(true);
  });
});

describe('#725 P8/P9 — the picture’s words', () => {
  it('the side view names the wasteboard, not “bed”', () => {
    openHolding(tapedJob({ shapes: [] }), bedMachine());
    expect(screen.getByTestId('engrave-setup-holding-side-surface').textContent).toBe('wasteboard');
  });

  it('the side view says “bed” on the bare bed', () => {
    openHolding(tapedJob({ shapes: [] }), bedMachine({ bare: true }));
    expect(screen.getByTestId('engrave-setup-holding-side-surface').textContent).toBe('bed');
  });

  it('a clamp on the right edge is offered the back edge, not “onto the right edge”', () => {
    openHolding(bracketJob([{ edge: 'right', at: 30 }]), bedMachine({ anchor: true }));
    const label = screen.getByTestId('engrave-setup-holding-clamp-label').textContent ?? '';
    expect(label).toContain('the clamp on the right edge');
    expect(label).toContain('round the corner onto the back edge');
    expect(label).not.toContain('onto the right edge');
  });
});

describe('#725 B5 — asking for the bracket asks the wizard to fit it', () => {
  it('the bracket row’s escape carries fitBracket from a vise job', () => {
    const base = defaultEngraveJob();
    openHolding({ ...base, labels: [], stock: { ...base.stock, length: 100, width: 60, thickness: 6 } }, bedMachine({ vise: true }));
    fireEvent.click(screen.getByTestId('engrave-setup-change-bed-bracket'));
    expect(useMachineChangeStore.getState().request).toMatchObject({ target: 'bed', fitBracket: true });
  });
});

describe('#727 F1 — a bracket job with stored setups keeps its clamp check', () => {
  it('setBedHold rewrites every stored setup’s mount, so jobMount answers the holding', () => {
    const base = defaultEngraveJob();
    const job: EngraveJob = {
      ...base,
      labels: [],
      toolKey: 'flat-1.0',
      stock: { ...base.stock, length: 100, width: 60, thickness: 6, material: 'pla' },
      // The blocker's sequence: a job planned in the VISE's stored setup, then switched to the bed.
      setups: [{ ...jobSetups(base)[0]!, mount: { kind: 'vise' } }],
    };
    act(() => useEngraveJobStore.setState({ job }));
    act(() =>
      useEngraveJobStore.getState().setBedHold(
        {
          anchor: 1,
          variant: 'thin',
          clamps: [
            { edge: 'back', at: 22.5 },
            { edge: 'back', at: 77.5 },
          ],
          source: 'saved',
        },
        jobVise(base),
        base.sacrificial,
      ),
    );

    const held = useEngraveJobStore.getState().job;
    expect(held.workholding.kind).toBe('bracket');
    // #727 F1 — the stored setup followed the physical holding: one mount, one truth.
    expect(held.setups?.[0]?.mount).toEqual({ kind: 'bracket', board: false });
    expect(jobMount(held)).toBe('bracket');
    const mount = bracketMount(
      { x: held.stock.length, y: held.stock.width, z: held.stock.thickness },
      jobMount(held),
      DOC.defaults as never,
      0,
      clampPlacementsFor(held),
    );
    expect(mount?.obstacles.map((o) => o.id)).toEqual(['bracket-front-arm', 'bracket-left-arm', 'clamp-1', 'clamp-2']);
  });
});
