// @vitest-environment jsdom
// #471 — the Setups section's states (§2) and its actions. The engine supplies every plan and every
// reason; these specs pin what the section SHOWS and that nothing is written until the person does
// it (render is never a write), plus the two approvals the run needs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { jobVise } from '@/engine/cnc/fixture';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EngraveSetupsSection } from '@/components/panels/EngraveSetupsSection';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useShopDefaultsStore, resetShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useSettingsStore } from '@/store/settingsStore';
import { resetEngraveRows, useEngraveRowStore } from '@/store/engraveRowStore';
import { useMachineStore, resetMachineStore } from '@/store/machineStore';
import { useLocationStore, resetLocationStore } from '@/store/locationStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { flatEndMill } from '@/engine/cnc/tool';
import { resetRegistry, setInventoryEntries } from '@/engine/cnc/toolRegistry';
import { orient } from '@/engine/cnc/setups/orient';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { setHouseClientLoader, type HouseClient } from '@/platform/houseClient';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { MachineObservation } from '@/platform/machineProbe';
import type { LocationView } from '@/platform/locationClient';
import type { EngraveCircleShape, EngraveDrillItem, EngraveJob, JobSetup } from '@/types/engraveJob';

vi.mock('@/engine/exportTrigger', () => ({ saveText: vi.fn(), saveEngraveProgram: vi.fn() }));
// #637 — the mount-tap runner is stubbed so the HOOK's plumbing (prompt, busy, completion) is what
// these tests drive; the protocol itself is bracketTap.spec's subject.
const operatorPrompts: string[] = [];
vi.mock('@/engine/cnc/registration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/cnc/registration')>();
  return {
    ...actual,
    runMountTap: vi.fn(async (_tap: unknown, _from: unknown, _settings: unknown, deps: { operator: (s: { kind?: string; text: string }) => Promise<boolean> }) => {
      operatorPrompts.push('fit-probe');
      const ok = await deps.operator({ kind: 'fit-probe', text: 'Fit the wired probe in the spindle, then continue.' });
      if (!ok) return { ok: false as const, reason: 'stopped: the probe was not fitted', transcript: [] };
      return { ok: true as const, z: -56.82, at: { x: -186.2, y: -180 }, probe: { lengthZ: -76.063, rest: 'Probe: 0' }, transcript: [{ line: '?', reply: '<Idle|MPos:-1,-1,-1>' }] };
    }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETUP_ORIENTATION = {
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
  front: 'front',
  back: 'back',
} as const;

const CAL: MachineCalibration = {
  machineId: 'Z1',
  frame: { anchor1: [-190.89, -193.83], anchor2Offset: [88.5, 45], toolrackOffset: [48.8, 181], clearanceXY: [-5, -21], clearanceZ: -3, toolrackZ: -60 },
  softEndstop: {} as MachineCalibration['softEndstop'],
  source: 'config-get sd on 192.168.10.43',
  measuredAt: '2026-10-07T18:00:00.000Z',
};

/** A machine observation whose address matches `DATUM_LOCATION`'s machine record (#598). */
const OBS: MachineObservation = {
  host: '192.0.2.10',
  port: 2222,
  name: 'Z1',
  busy: null,
  ip: null,
  mac: null,
  status: null,
  profileId: 'Z1',
  observedAt: '2026-10-23T00:00:00.000Z',
  notes: [],
};

/** A location whose machine carries a measured jaw-top datum and a checked-out probe (#598). */
const DATUM_LOCATION = {
  machines: [
    {
      id: 'machine-1a2b3c',
      address: { host: '192.0.2.10', port: 2222 },
      bedProfiles: [
        {
          id: 'bp-1',
          datums: { viseJawTopZ: { value: -56.82, measuredAt: '2026-10-23T00:00:00.000Z', by: 'fx-probe-1', at: null } },
          placements: [
            { id: 'pl-vise', fixture: 'fx-vise-1', where: { kind: 'pins', pins: 'vise', anchor: null }, count: null, frame: { fixedJawFaceX: -181.2, jawStartY: -203.5 }, provenance: {} },
          ],
        },
      ],
      activeBedProfileId: 'bp-1',
    },
  ],
  accessories: [
    {
      id: 'fx-probe-1',
      kind: 'probe',
      product: 'Makera Wired Probe V2',
      variant: 'wired-touch',
      unit: { tipDiameterMm: 2.0, rimOffsetMm: 0.7, rimOffsetUncertaintyMm: 0.25 },
      whereabouts: { kind: 'machine', machineId: 'machine-1a2b3c', since: '2026-10-23T00:00:00.000Z' },
    },
    {
      id: 'fx-vise-1',
      kind: 'vise',
      constants: { jawBarWidth: 10, jawLength: 100 },
      unit: { jawStartY: -10 },
      whereabouts: { kind: 'machine', machineId: 'machine-1a2b3c', since: '2026-10-23T00:00:00.000Z' },
    },
  ],
} as unknown as LocationView;

function savedJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.setups = jobSetups(job).map((s) => ({
    ...s,
    orientation: { ...s.orientation },
    itemIds: [...s.itemIds],
    tools: [...s.tools],
  }));
  return job;
}

const shape = (over: Partial<EngraveCircleShape> = {}): EngraveCircleShape => ({
  kind: 'circle',
  id: 'shp-1',
  name: 'a round pocket',
  position: { x: 30, y: 30 },
  rotation: 0,
  depth: 1.5,
  enabled: true,
  diameter: 8,
  ...over,
});

const drill = (over: Partial<EngraveDrillItem> = {}): EngraveDrillItem => ({
  kind: 'drill',
  id: 'drl-1',
  name: 'a hole',
  position: { x: 20, y: 20 },
  rotation: 0,
  depth: 2,
  enabled: true,
  through: false,
  ...over,
});

/**
 * A job whose document can express two setups: a top pocket and a through hole that opens to the
 * bottom. The saved list is the multi-setup fixture the issue asked for, since no ordinary document
 * states a bottom cut yet.
 */
function twoSetupJob(onlyTop = false): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [];
  job.shapes = [shape()];
  job.drills = [drill({ id: 'drl-through', name: 'a through hole', through: true })];
  const mount = { kind: 'bracket' } as const;
  const bottom = orient('bottom', mount, { x: job.stock.length, y: job.stock.width, z: job.stock.thickness });
  if (!bottom.ok) throw new Error(bottom.reason);
  const setups: JobSetup[] = [
    { id: 'setup-top', orientation: { ...SETUP_ORIENTATION }, mount: { kind: 'vise' }, itemIds: ['shp-1'], tools: [job.toolKey] },
    {
      id: 'setup-bottom',
      orientation: { ...bottom.orientation },
      mount,
      itemIds: ['drl-through'],
      tools: [job.toolKey],
    },
  ];
  job.setups = onlyTop ? [setups[0]!] : setups;
  return job;
}

beforeEach(() => {
  resetEngraveRows();
  resetShopDefaultsStore();
  useSettingsStore.getState().resetSettings();
  resetMachineStore();
  resetLocationStore();
  act(() => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });
});

afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
});

describe('#471 the Setups section — the states of §2', () => {
  it('reads a job with no saved list as one planned top-up setup and writes nothing on render', () => {
    const before = useEngraveJobStore.getState().job;
    render(<EngraveSetupsSection />);
    expect(screen.getByTestId('engrave-setups')).toBeTruthy();
    expect(screen.getByTestId('engrave-setups-badge').textContent).toBe('planned');
    expect(screen.getByTestId('engrave-setups-implicit').textContent).toContain('One setup');
    expect(screen.getByTestId('engrave-setup-ordinal-1').textContent).toBe('Setup 1');
    expect(screen.getByTestId('engrave-setup-face-words-1').textContent).toContain('top up');
    // Showing the compatibility reading is not a document write.
    expect(useEngraveJobStore.getState().job).toBe(before);
    expect(useEngraveJobStore.getState().job.setups).toBeUndefined();
  });

  it('#667 — the setups line names the rest pair when the setup has a second cutter', () => {
    const job = defaultEngraveJob();
    job.toolKey = 'flat-3.175x12-metal';
    const first = jobSetups(job)[0]!;
    job.setups = [{ ...first, tools: ['flat-3.175x12-metal', 'flat-1.0'] }];
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);
    expect(screen.getByTestId('engrave-setup-pair-1').textContent).toBe('⌀3.175 mm rough · ⌀1 mm rest');
  });

  it('#677 — a V first with a flat cutter after it is named as the core clearance', () => {
    const V = flatEndMill(3.175, {
      name: '3.175 mm 90° V',
      typeText: 'Chamfer',
      shape: 'chamfer',
      tipDiameter: null,
      diameter: 3.175,
      angle: 90,
      halfAngle: null,
    });
    act(() => setInventoryEntries([{ key: 'inv:v-677', tool: V, provenance: 'setups core spec' }]));
    const job = defaultEngraveJob();
    job.toolKey = 'inv:v-677';
    const first = jobSetups(job)[0]!;
    job.setups = [{ ...first, tools: ['inv:v-677', 'flat-1.0'] }];
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);
    expect(screen.getByTestId('engrave-setup-pair-1').textContent).toBe('⌀3.175 mm V-carve · ⌀1 mm core');
    act(() => resetRegistry());
  });

  it('“Edit setups” materialises the implicit setup; the row is then editable', () => {
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setups-edit'));
    const saved = useEngraveJobStore.getState().job.setups;
    expect(saved).toHaveLength(1);
    expect(saved![0]!.itemIds.length).toBeGreaterThan(0);
    expect(screen.getByTestId('engrave-setups-badge').textContent).toBe('saved');
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    expect(screen.getByTestId('engrave-setup-face-1')).toBeTruthy();
  });

  it('an empty job says there is nothing to plan, and Add setup gives the engine’s reason', () => {
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [];
    job.drills = [];
    job.threads = [];
    job.keepOuts = [];
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);
    expect(screen.getByTestId('engrave-setups-badge').textContent).toBe('empty');
    expect(screen.getByTestId('engrave-setups-empty').textContent).toContain('No cuts to plan');
    const add = screen.getByTestId('engrave-setups-add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByTestId('engrave-setups-add-reason').textContent).toContain('the job has no cuts to plan');
  });

  it('Add setup is disabled with the engine’s words when every cut already opens to a held face', () => {
    act(() => useEngraveJobStore.setState({ job: savedJob() }));
    render(<EngraveSetupsSection />);
    const add = screen.getByTestId('engrave-setups-add') as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getByTestId('engrave-setups-add-reason').textContent).toContain(
      'every cut opens to the top face, which is already a setup',
    );
  });

  it('on the two-setup fixture Add setup is offered (a through hole opens to the bottom), and writes a setup', () => {
    act(() => useEngraveJobStore.setState({ job: twoSetupJob(true) }));
    render(<EngraveSetupsSection />);
    const add = screen.getByTestId('engrave-setups-add') as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    expect(useEngraveJobStore.getState().job.setups).toHaveLength(2);
    expect(useEngraveJobStore.getState().job.setups![1]!.orientation.top).toBe('bottom');
  });

  it('the facing pass is named in setup 1, never as a second setup', () => {
    const job = savedJob();
    job.facing = { enabled: true, depth: 0.4 };
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);
    expect(screen.getByTestId('engrave-setup-facing-1').textContent).toContain('facing pass');
    expect(useEngraveJobStore.getState().job.setups).toHaveLength(1);
  });
});

describe('#471 a saved list that no longer matches the document', () => {
  it('shows setup-item-missing on the line and in the open row, and removes the id only on the press', () => {
    const job = savedJob();
    const gone = job.labels[0]!.id;
    job.labels = job.labels.filter((l) => l.id !== gone);
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);

    expect(screen.getByTestId('engrave-setups-badge').textContent).toBe('stale');
    expect(screen.getByTestId('engrave-setup-finding-1-setup-item-missing')).toBeTruthy();
    // Reported, not rewritten.
    expect(useEngraveJobStore.getState().job.setups![0]!.itemIds).toContain(gone);

    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    expect(screen.getByTestId(`engrave-setup-missing-1-${gone}`).textContent).toContain('no longer in the job');
    fireEvent.click(screen.getByTestId(`engrave-setup-remove-item-1-${gone}`));
    expect(useEngraveJobStore.getState().job.setups![0]!.itemIds).not.toContain(gone);
  });

  it('a disabled item is “not cut in this setup”, distinct from missing', () => {
    const job = savedJob();
    const off = job.labels[0]!.id;
    job.labels[0]!.enabled = false;
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);
    expect(screen.queryByTestId('engrave-setup-finding-1-setup-item-missing')).toBeNull();
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    expect(screen.getByTestId('engrave-setup-not-cut-1').textContent).toContain(off);
  });

  it('a cut item in no setup is surfaced as unassigned, with the badge stale', () => {
    const job = savedJob();
    const kept = job.labels[0]!.id;
    job.setups![0]!.itemIds = [kept];
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);
    expect(screen.getByTestId('engrave-setups-badge').textContent).toBe('stale');
    const unassigned = screen.getByTestId('engrave-setups-unassigned');
    expect(unassigned.textContent).toContain('Cut items in no setup');
  });

  it('an item chip opens that item’s row through expandEngraveRow (#411)', () => {
    act(() => useEngraveJobStore.setState({ job: savedJob() }));
    render(<EngraveSetupsSection />);
    const id = useEngraveJobStore.getState().job.setups![0]!.itemIds[0]!;
    fireEvent.click(screen.getByTestId(`engrave-setup-item-${id}`));
    expect(useEngraveRowStore.getState().open.has(id)).toBe(true);
  });

  it('Re-plan previews the planner’s fresh suggestion and Use this plan writes it', () => {
    const job = savedJob();
    const gone = job.labels[0]!.id;
    job.labels = job.labels.filter((l) => l.id !== gone);
    act(() => useEngraveJobStore.setState({ job }));

    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setups-replan'));
    expect(screen.getByTestId('engrave-setups-badge').textContent).toBe('suggested');
    expect(screen.getByTestId('engrave-setups-suggested')).toBeTruthy();
    // Still nothing written.
    expect(useEngraveJobStore.getState().job.setups![0]!.itemIds).toContain(gone);

    fireEvent.click(screen.getByTestId('engrave-setups-use-plan'));
    const written = useEngraveJobStore.getState().job.setups!;
    expect(written.every((s) => !s.itemIds.includes(gone))).toBe(true);
    expect(screen.getByTestId('engrave-setups-badge').textContent).toBe('saved');
  });
});

describe('#471 registration — planned only after approval, refused with the engine’s reason', () => {
  it('a vise setup plans from the stated seat and stores nothing until Approve', () => {
    act(() => useEngraveJobStore.setState({ job: savedJob() }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));

    expect(screen.getByTestId('engrave-setup-reg-unplanned-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('engrave-setups-use-typed-seat'));
    // #726 P6 — the expert seat is a machine Z, and says so in millimetres.
    expect(screen.getByTestId('engrave-setup-seat-1').closest('label')?.textContent).toContain('mm');
    fireEvent.change(screen.getByTestId('engrave-setup-seat-1'), { target: { value: '-66' } });
    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));
    expect(screen.getByTestId('engrave-setup-reg-summary-1').textContent).toContain('Home, fit the wired probe');
    expect(useEngraveJobStore.getState().job.setups![0]!.registration).toBeUndefined();

    fireEvent.click(screen.getByTestId('engrave-setup-approve-reg-1'));
    const registration = useEngraveJobStore.getState().job.setups![0]!.registration;
    expect(registration).toBeDefined();
    expect(registration!.method).toBe('vise');
    expect(registration!.expected).toContain('surface touch');
    expect(screen.getByTestId('engrave-setup-reg-approved-1')).toBeTruthy();
  });

  it('asks to tap the fixed jaw instead of inventing a datum (a custom, non-Z1 vise)', () => {
    const job = savedJob();
    jobVise(job).source = 'saved';
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));
    expect(screen.getByTestId('engrave-setup-reg-need-datum-1').textContent).toContain('tap the jaw first — Measure… on the machine card');
    expect(useEngraveJobStore.getState().job.setups![0]!.registration).toBeUndefined();
  });

  it('#614 a shipped-vise job with no datum and the override off plans to need-datum, not the seeded seat', () => {
    act(() => useEngraveJobStore.setState({ job: savedJob() }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));
    expect(screen.getByTestId('engrave-setup-reg-need-datum-1')).toBeTruthy();
    expect(useEngraveJobStore.getState().job.setups![0]!.registration).toBeUndefined();
  });

  it('defaults the vise seat to the shipped Z1 vise’s provisional aim (−55) behind the override', () => {
    act(() => useEngraveJobStore.setState({ job: savedJob() }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));

    fireEvent.click(screen.getByTestId('engrave-setups-use-typed-seat'));
    const seat = screen.getByTestId('engrave-setup-seat-1') as HTMLInputElement;
    expect(seat.value).toBe('-55');

    // It is an aim, not a stored reading: planning works with no typed value, and nothing is
    // written until Approve.
    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));
    expect(screen.getByTestId('engrave-setup-reg-summary-1').textContent).toContain('Home, fit the wired probe');
    expect(useEngraveJobStore.getState().job.setups![0]!.registration).toBeUndefined();
  });

  it('leaves the seat empty for a measured/custom vise behind the override', () => {
    const job = savedJob();
    jobVise(job).source = 'measured';
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    fireEvent.click(screen.getByTestId('engrave-setups-use-typed-seat'));
    expect((screen.getByTestId('engrave-setup-seat-1') as HTMLInputElement).value).toBe('');
  });

  it('#598 a machine with a measured jaw-top datum plans from it, with no seat input', () => {
    useMachineStore.setState({ machine: OBS });
    useLocationStore.setState({ location: DATUM_LOCATION });
    act(() => useEngraveJobStore.setState({ job: savedJob() }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));

    // No seat input is shown on the datum path; the override disclosure is still offered.
    expect(screen.queryByTestId('engrave-setup-seat-1')).toBeNull();
    expect(screen.getByTestId('engrave-setups-use-typed-seat')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));
    expect(screen.getByTestId('engrave-setup-reg-summary-1').textContent).toContain('Home, fit the wired probe');
    expect(screen.queryByTestId('engrave-setup-reg-need-datum-1')).toBeNull();
  });

  it('#611 a jaw-top datum tapped by a different probe reads as absent and names that probe', () => {
    useMachineStore.setState({ machine: OBS });
    useLocationStore.setState({
      location: {
        ...DATUM_LOCATION,
        machines: [
          {
            ...DATUM_LOCATION.machines[0]!,
            bedProfiles: [
              {
                ...DATUM_LOCATION.machines[0]!.bedProfiles![0]!,
                datums: {
                  ...DATUM_LOCATION.machines[0]!.bedProfiles![0]!.datums,
                  viseJawTopZ: { value: -56.82, measuredAt: '2026-10-23T00:00:00.000Z', by: 'fx-probe-old', at: null },
                },
              },
            ],
          },
        ],
        // #640 — the sentence names WHICH probe tapped the datum by its product, not by its id.
        accessories: [
          ...(DATUM_LOCATION.accessories ?? []),
          { id: 'fx-probe-old', kind: 'probe', product: 'Makera Wired Probe V1', variant: 'wired-touch', constants: {}, unit: {}, provenance: {}, whereabouts: { kind: 'box' }, history: [] },
        ],
      },
    });
    act(() => useEngraveJobStore.setState({ job: savedJob() }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));

    const row = screen.getByTestId('engrave-setup-reg-need-datum-1');
    expect(row.textContent).toContain('Makera Wired Probe V1');
    expect(row.textContent).not.toContain('fx-probe-old');
    expect(row.textContent).toContain('tap the fixed jaw with the current probe first');
    // The tap is offered with the current probe, and nothing is written until the person acts.
    expect(screen.getByTestId('engrave-setup-tap-jaw-1')).toBeTruthy();
    expect(useEngraveJobStore.getState().job.setups![0]!.registration).toBeUndefined();
  });

  // #637 — the tap's prompt carries testids, the button is disabled while the tap runs, and
  // Continue completes it through the shared hook.
  it('#637 the mount tap prompts with testids, disables while busy, and completes on Continue', async () => {
    useMachineStore.setState({ machine: OBS });
    useLocationStore.setState({
      location: {
        ...DATUM_LOCATION,
        accessories: (DATUM_LOCATION.accessories ?? []).map((a) =>
          a.kind === 'probe' ? { ...a, constants: {}, provenance: {}, history: [] } : a,
        ),
        machines: [
          {
            ...DATUM_LOCATION.machines[0]!,
            bedProfiles: [
              {
                ...DATUM_LOCATION.machines[0]!.bedProfiles![0]!,
                datums: {
                  ...DATUM_LOCATION.machines[0]!.bedProfiles![0]!.datums,
                  viseJawTopZ: { value: -56.82, measuredAt: '2026-10-23T00:00:00.000Z', by: 'wired-probe', at: null },
                },
                history: [],
              },
            ],
          },
        ],
      },
    });
    // The write-back is not this spec's subject: the save answers ok so the note is the success one.
    useLocationStore.setState({ saveMachine: async () => 'ok' });
    act(() => useEngraveJobStore.setState({ job: savedJob() }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));

    const tapButton = screen.getByTestId('engrave-setup-tap-jaw-1') as HTMLButtonElement;
    fireEvent.click(tapButton);
    // The runner is at the operator prompt: Continue is there, by testid, and the row's button is
    // disabled while the tap runs (a second press would orphan the console handle).
    await screen.findByTestId('engrave-mount-tap-continue');
    expect(screen.getByTestId('engrave-mount-tap-cancel')).toBeTruthy();
    expect((screen.getByTestId('engrave-setup-tap-jaw-1') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-mount-tap-continue'));
    });
    await waitFor(() => expect(screen.getByTestId('engrave-setups-tap-note').textContent).toContain('recorded'));
    expect((screen.getByTestId('engrave-setup-tap-jaw-1') as HTMLButtonElement).disabled).toBe(false);
    expect(operatorPrompts.length).toBeGreaterThan(0);
  });

  it('#611 with no probe accessory checked out the datum stands — there is nothing to compare against', () => {
    useMachineStore.setState({ machine: OBS });
    useLocationStore.setState({
      location: {
        ...DATUM_LOCATION,
        // The vise only: no probe accessory is checked out to the machine.
        accessories: [DATUM_LOCATION.accessories![1]!],
      },
    });
    act(() => useEngraveJobStore.setState({ job: savedJob() }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));

    expect(screen.queryByTestId('engrave-setup-reg-need-datum-1')).toBeNull();
    expect(screen.getByTestId('engrave-setup-reg-summary-1').textContent).toContain('Home, fit the wired probe');
  });

  it('#617 a datum written from the machine card re-plans from the current record', () => {
    useMachineStore.setState({ machine: OBS });
    const job = savedJob();
    jobVise(job).source = 'saved';
    act(() => useEngraveJobStore.setState({ job }));
    // No jaw-top datum yet: the location's profile has none.
    useLocationStore.setState({
      location: {
        ...DATUM_LOCATION,
        accessories: (DATUM_LOCATION.accessories ?? []).map((a) =>
          a.kind === 'probe' ? { ...a, constants: {}, provenance: {}, history: [] } : a,
        ),
        machines: [
          {
            ...DATUM_LOCATION.machines[0]!,
            bedProfiles: [
              {
                ...DATUM_LOCATION.machines[0]!.bedProfiles![0]!,
                datums: { ...DATUM_LOCATION.machines[0]!.bedProfiles![0]!.datums, viseJawTopZ: null },
              },
            ],
          },
        ],
      },
    });
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));
    expect(screen.getByTestId('engrave-setup-reg-need-datum-1')).toBeTruthy();

    // The card's tap writes the datum into the location; the section re-reads it and takes the datum path.
    act(() => useLocationStore.setState({ location: DATUM_LOCATION }));
    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));
    expect(screen.queryByTestId('engrave-setup-reg-need-datum-1')).toBeNull();
    expect(screen.getByTestId('engrave-setup-reg-summary-1').textContent).toContain('Home, fit the wired probe');
  });

  it('#603 the row names the checked-out probe and the machine', () => {
    useMachineStore.setState({ machine: OBS });
    useLocationStore.setState({
      location: {
        ...DATUM_LOCATION,
        machines: [{ ...DATUM_LOCATION.machines[0]!, nickname: 'Zoomba', name: 'Makera_Z1_000000', profileId: 'Z1' }],
        accessories: [
          { ...DATUM_LOCATION.accessories![0]!, product: 'Makera Wired Probe V2' },
          DATUM_LOCATION.accessories![1]!,
        ],
      },
    });
    act(() => useEngraveJobStore.setState({ job: savedJob() }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));

    expect(screen.getByTestId('engrave-setup-machine-1').textContent).toBe('Zoomba');
    expect(screen.getByTestId('engrave-setup-probe-1').textContent).toBe('Makera Wired Probe V2');
  });

  it('a bracket refuses without a measured seat, then plans once the setting exists', () => {
    useSettingsStore.setState({ machineCalibration: CAL });
    act(() => useEngraveJobStore.setState({ job: savedJob() }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    fireEvent.change(screen.getByTestId('engrave-setup-mount-1'), { target: { value: 'bracket' } });
    expect(useEngraveJobStore.getState().job.setups![0]!.mount.kind).toBe('bracket');

    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));
    // #607 — the bracket's tap cannot stand in for the FIRST seat measurement (its arm top is
    // measured-only too, and no point is known clear of the slots until then), so the unmeasured
    // seat keeps the sentence that says how to measure it.
    expect(screen.getByTestId('engrave-setup-reg-refusal-1').textContent).toContain('bracket.seatMachineZ');

    act(() =>
      useShopDefaultsStore.setState({
        status: 'present',
        defaults: ShopDefaultsSchema.parse({
          'bracket.seatMachineZ': { value: -70.2, source: 'measured', setAt: '2026-10-16T10:00:00.000Z', unit: 'mm', note: 'one touch' },
        }),
      }),
    );
    fireEvent.click(screen.getByTestId('engrave-setup-plan-reg-1'));
    expect(screen.getByTestId('engrave-setup-reg-summary-1').textContent.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('engrave-setup-approve-reg-1'));
    expect(useEngraveJobStore.getState().job.setups![0]!.registration!.method).toBe('bracket');
  });

  it('changing the mount clears the approved registration and remount', () => {
    const job = savedJob();
    job.setups![0]!.registration = {
      method: 'vise',
      plan: {
        mount: 'vise',
        surfacePoint: { x: 0, y: 0, z: -54 },
        scans: [],
        settings: { coarseStepMm: 1, fineStepMm: 0.1, capBelowSurfaceMm: 0.5 },
        mountObstacles: [],
      } as unknown as NonNullable<JobSetup['registration']>['plan'],
      expected: 'planned',
    };
    job.setups![0]!.remount = { instruction: ['turn it over'], confirm: null };
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);
    fireEvent.click(screen.getByTestId('engrave-setup-expand-1'));
    fireEvent.change(screen.getByTestId('engrave-setup-mount-1'), { target: { value: 'bracket' } });
    expect(useEngraveJobStore.getState().job.setups![0]!.registration).toBeUndefined();
    expect(useEngraveJobStore.getState().job.setups![0]!.remount).toBeUndefined();
  });
});

describe('#471 remount — derived on the line, approved on the page', () => {
  it('previews a remount for the second setup and stores it only after “It is mounted”', () => {
    act(() => useEngraveJobStore.setState({ job: twoSetupJob() }));
    render(<EngraveSetupsSection />);
    expect(screen.getByTestId('engrave-setup-2')).toBeTruthy();
    expect(screen.getByTestId('engrave-setup-mount-words-2').textContent).toContain('bracket');
    fireEvent.click(screen.getByTestId('engrave-setup-expand-2'));
    expect(screen.getByTestId('engrave-setup-remount-times-2').textContent).toContain('Remount ≈');
    fireEvent.click(screen.getByTestId('engrave-setup-remount-preview-2'));
    expect(screen.getByTestId('engrave-remount-page')).toBeTruthy();
    expect(useEngraveJobStore.getState().job.setups![1]!.remount).toBeUndefined();

    fireEvent.click(screen.getByTestId('engrave-remount-done'));
    expect(useEngraveJobStore.getState().job.setups![1]!.remount).toBeDefined();
    expect(useEngraveJobStore.getState().job.setups![1]!.remount!.instruction.length).toBeGreaterThan(0);
  });
});

describe('#589 the surface tolerance — shown with the recommendation, writable, invalidates the plan', () => {
  it('shows the current tolerance with the per-stock recommendation beside it', () => {
    const job = savedJob();
    job.stock.material = 'petg';
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);

    const input = screen.getByTestId('engrave-setups-tolerance-input') as HTMLInputElement;
    expect(input.value).toBe('0.4'); // the labelled fallback with no location read
    expect(screen.getByTestId('engrave-setups-tolerance').textContent).toContain('Plausibility width');
    expect(screen.getByTestId('engrave-setups-tolerance').textContent).toContain('±1 mm — printed stock');
  });

  it('saving a new tolerance writes the house default and strips the approved registration', async () => {
    const stored: Record<string, unknown> = {};
    setHouseClientLoader(async () => ({
      call: async (method: string, path: string, body?: unknown) => {
        if (method === 'GET' && path === '/defaults') {
          return { kind: 'ok', text: JSON.stringify(stored), etag: '"v1"' };
        }
        if (method === 'PUT' && path.startsWith('/defaults/')) {
          stored[path.slice('/defaults/'.length)] = body;
          return { kind: 'ok', text: '', etag: '"v2"' };
        }
        return { kind: 'ok', text: '' };
      },
    }) as unknown as HouseClient);

    const job = savedJob();
    job.stock.material = 'petg';
    // An approved registration, so the change has a plan to invalidate.
    job.setups![0]!.registration = {
      method: 'vise',
      plan: {} as NonNullable<JobSetup['registration']>['plan'],
      expected: 'planned',
    };
    act(() => useEngraveJobStore.setState({ job }));
    render(<EngraveSetupsSection />);

    fireEvent.change(screen.getByTestId('engrave-setups-tolerance-input'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('engrave-setups-tolerance-save'));

    await waitFor(() => {
      expect(useEngraveJobStore.getState().job.setups![0]!.registration).toBeUndefined();
    });
    expect(stored['registration.surfaceToleranceMm']).toMatchObject({ value: 1, source: 'chosen' });
  });
});
