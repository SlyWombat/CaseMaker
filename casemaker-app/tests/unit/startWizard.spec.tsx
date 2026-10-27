// @vitest-environment jsdom
// Issue #280 — the startup wizard: machine check, job type, then the engrave setup.
//
// Only the socket is faked (`setMachineProbeLoader`), so `probeMachine`'s real orchestration runs.
// `scheduleImmediate` is mocked because a jsdom test has no geometry worker, and the wizard's own
// hand-off does not depend on the rebuild finishing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { jobVise } from '@/engine/cnc/fixture';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { StartWizard } from '@/components/welcome/StartWizard';
import { EngravePanel } from '@/components/panels/EngravePanel';
import {
  setMachineProbeLoader,
  type ConfigReadSummary,
  type DiscoveredMachineSummary,
  type MachineProbeClient,
} from '@/platform/machineProbe';
import { Z1_FRAME_REPLIES } from './fixtures/z1Frame';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { BADGE_POCKET_KEEP_OUT_ID } from '@/engine/cnc/engrave/fromBadge';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { createDefaultProject, useProjectStore } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { useViewportStore } from '@/store/viewportStore';

vi.mock('@/engine/jobs/JobScheduler', () => ({ scheduleImmediate: vi.fn(async () => {}) }));

// #346 — vitest runs the WEB target, where the wizard shows no check at all. The step-1 tests below
// exercise the desktop build's check through the probe seam, so they run with the capability on;
// the "no socket" tests turn it off. A getter, so each test reads the value at render.
/**
 * #365 review — the hand-off awaits the labels' FACES before it seeds the job, so this seam can hold
 * them in flight (`fonts.gate`) and watch the store stay untouched until they land. Pass-through for
 * every other test, so the mock is invisible to them.
 */
const fonts = vi.hoisted(() => ({ gate: false, release: null as null | (() => void) }));
vi.mock('@/engine/fonts/registry', async (orig) => {
  const real = await orig<typeof import('@/engine/fonts/registry')>();
  // Both names: the seed paths call the best-effort one, and the mock has to intercept THOSE calls
  // (a mock of its sibling would not — the real `ensureSeedFontsLoaded` calls the real loader).
  const waiting = async (
    ...args: Parameters<typeof real.ensureLabelFontsLoaded>
  ): Promise<void> => {
    if (fonts.gate) await new Promise<void>((resolve) => (fonts.release = resolve));
    await real.ensureLabelFontsLoaded(...args);
  };
  return { ...real, ensureLabelFontsLoaded: waiting, ensureSeedFontsLoaded: waiting };
});

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

/** The Engrave panel is rendered beside the wizard by `AppShell`; a jsdom test has no worker. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

/** The bench controller's whole `?` line; a bare `Idle` is not a frame and parses to no state. */
const IDLE_LINE = '<Idle|MPos:-1.000,-1.000,-1.000|F:0,0,100|S:0,0,100|T:0>';

function fakeClient(over: Partial<MachineProbeClient> = {}): MachineProbeClient {
  return {
    discover: over.discover ?? (async () => []),
    identify: over.identify ?? (async () => ({ ip: '192.168.10.43', mac: 'aa:bb:cc:dd:ee:ff' })),
    status: over.status ?? (async () => ({ ok: true, text: IDLE_LINE })),
    // A machine that also answers its own frame (#279), as the bench Z1 does: the wizard's check
    // reads it, and these tests assert what the panel then says about which frame is in force.
    readConfig: over.readConfig ?? (async (_target, keys) => answersFor(keys)),
  };
}

/** The bench machine's answers for `keys`; anything the transcript does not carry is a refusal. */
function answersFor(keys: readonly string[]): ConfigReadSummary {
  const values = new Map<string, string>();
  const failures: ConfigReadSummary['failures'] = [];
  for (const key of keys) {
    const value = Z1_FRAME_REPLIES[key];
    if (value !== undefined) values.set(key, value);
    else failures.push({ key, reason: 'not-in-config', detail: 'no answer for this key' });
  }
  return { values, failures };
}

function useClient(client: MachineProbeClient): void {
  setMachineProbeLoader(async () => client);
}

/**
 * #682 — step 1 now checks when it opens. A test that is not about the check leaves that search
 * unanswered, so its pending microtasks cannot land an update after the test has moved on.
 */
function unansweredClient(): MachineProbeClient {
  return {
    ...fakeClient(),
    discover: () => new Promise<DiscoveredMachineSummary[]>(() => {}),
  };
}

beforeEach(() => {
  cleanup();
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  resetMachineStore();
  // The check writes the machine's own frame into settings (#279), so each test starts with no
  // saved frame rather than inheriting the previous one's.
  useSettingsStore.getState().resetSettings();
  resetStartWizard();
  useClient(unansweredClient());
  useProjectStore.setState({ project: createDefaultProject('rpi-4b'), welcomeMode: true });
  useViewportStore.setState({ activeSidebarSection: null, selection: null });
  useEngraveJobStore.setState({ job: defaultEngraveJob() });
});

afterEach(() => {
  cleanup();
  fonts.gate = false;
  fonts.release = null;
  setMachineProbeLoader(null);
  setEngravePreviewClientLoader(null);
  useEngravePreviewStore.getState().dispose();
});

/** Click through step 1 without checking for a machine. */
function skipToStockStep(): void {
  fireEvent.click(screen.getByTestId('start-wizard-next'));
}

/**
 * Open a STARTER — the welcome door's only template path since #683 took the cards out of step 2.
 * The door calls `openWizard('machine', id)` and the wizard's mount effect hands the id to
 * `chooseJob`, whose hand-off is async: it awaits the labels' faces before it seeds the job (#365
 * review), so a bare store write returns while the project write and the step change are still a
 * microtask away, and a spec that read either one straight after would be asserting on the state
 * from BEFORE the hand-off. `vitest`'s fake fonts are already parsed, but the await is
 * unconditional, so this is the shape the component really runs in.
 */
async function openStarter(id: string): Promise<void> {
  await act(async () => {
    useStartWizardStore.getState().openWizard('machine', id);
  });
}

/**
 * The wizard mounted the way `AppShell` mounts it (`{wizardOpen && <StartWizard />}`), beside the
 * panel. Closing the wizard must UNMOUNT it, or its setup overlay stays on screen at `step`;
 * `step === 'setup'` and the panel would then both render a flow.
 */
function WizardHost() {
  const open = useStartWizardStore((s) => s.open);
  return open ? <StartWizard /> : <></>;
}

describe('#280/#682 — step 1, the machine check', () => {
  /** The bench Z1 answering the search on the address it announces. */
  function foundClient(over: Partial<MachineProbeClient> = {}): MachineProbeClient {
    return fakeClient({
      discover: async () => [
        { name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false },
      ],
      ...over,
    });
  }

  /** The check runs on open (#682); wait for the report rather than for the element, which exists
   *  from the first paint as "Checking…". */
  function waitForState(value: string): Promise<void> {
    return waitFor(() =>
      expect(screen.getByTestId('start-wizard-machine-state').getAttribute('data-state')).toBe(value),
    );
  }

  it('checks on open, names the machine, and saves its own frame (#279, #682)', async () => {
    useClient(foundClient());
    render(<StartWizard />);

    await waitForState('found');
    expect(screen.getByTestId('start-wizard-machine-name').textContent).toBe('Makera Z1');
    expect(screen.getByTestId('start-wizard-machine-address').textContent).toBe('192.168.10.43');
    expect(screen.getByTestId('start-wizard-machine-state').textContent).toContain('Online · Idle');
    // The removed essay (A3): the frame is still saved, it is no longer printed on step 1.
    expect(screen.queryByTestId('start-wizard-machine-frame')).toBeNull();

    // Saved with its provenance, and with the MACHINE's numbers rather than the vendor's: the
    // bench Z1's anchor1 is 1.51 mm from `configZ1.default`, which is the whole of #279.
    const saved = useSettingsStore.getState().machineCalibration;
    expect(saved?.machineId).toBe('Z1');
    expect(saved?.frame.anchor1).toEqual([-190.89, -193.83]);
  });

  it('a frame that cannot be read is not saved, and the machine is still Online (#279)', async () => {
    useClient(
      foundClient({
        readConfig: async () => {
          throw new Error('connect timeout');
        },
      }),
    );
    render(<StartWizard />);

    await waitForState('found');
    expect(screen.getByTestId('start-wizard-machine-state').textContent).toContain('Online · Idle');
    expect(useSettingsStore.getState().machineCalibration).toBeUndefined();
  });

  it('an unknown machine is named honestly and given no profile numbers', async () => {
    useClient(
      fakeClient({
        discover: async () => [{ name: 'SomeLaser_9000', host: '10.0.0.5', port: 2222, busy: false }],
      }),
    );
    render(<StartWizard />);

    await waitForState('found');
    // The broadcast name is the only identity this machine gave; the profile table did not match,
    // so MACHINES supplied no name and no number.
    expect(screen.getByTestId('start-wizard-machine-name').textContent).toBe('SomeLaser_9000');
    expect(screen.getByTestId('start-wizard-machine-address').textContent).toBe('10.0.0.5');
    expect(screen.queryByTestId('start-wizard-machine-profile')).toBeNull();
    expect(screen.queryByText(/13000 rpm/)).toBeNull();
  });

  it('“nothing answered” is an answer, and it never blocks', async () => {
    useClient(fakeClient());
    render(<StartWizard />);

    await waitForState('not-found');
    const state = screen.getByTestId('start-wizard-machine-state');
    expect(state.textContent).toContain('Offline');
    expect(screen.getByTestId('start-wizard-machine-offline-note').textContent).toContain(
      'the machine is needed at Cut',
    );
    // Next is enabled with no machine at all.
    expect((screen.getByTestId('start-wizard-next') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('start-wizard-next'));
    expect(screen.getByTestId('start-wizard-step-stock')).toBeDefined();
  });

  it('a build with no socket does not ask to connect one: the note, Cancel, Continue (#346)', () => {
    caps.drive = false;
    try {
      render(<StartWizard />);
      const note = screen.getByTestId('start-wizard-machine-note-build');
      expect(note.textContent).toContain('This instance cannot control a machine');
      expect(note.textContent).toContain('local (desktop) instance');
      // No check, no address box, no Connect, no fold, no Back: nothing that pretends a socket exists.
      expect(screen.queryByTestId('start-wizard-check')).toBeNull();
      expect(screen.queryByTestId('start-wizard-address')).toBeNull();
      expect(screen.queryByTestId('start-wizard-connect-address')).toBeNull();
      expect(screen.queryByTestId('start-wizard-machine-another')).toBeNull();
      expect(screen.queryByTestId('start-wizard-back')).toBeNull();
      // …and nothing was checked: the step did not pretend to open a socket.
      expect(useMachineStore.getState().outcome).toBeNull();
      // Continue is the advancing button, and it says what it does.
      expect(screen.getByTestId('start-wizard-next').textContent).toBe('Continue without a machine');
      fireEvent.click(screen.getByTestId('start-wizard-next'));
      expect(screen.getByTestId('start-wizard-step-stock')).toBeDefined();
    } finally {
      caps.drive = true;
    }
  });

  it('Cancel on the no-socket step puts the wizard away (#346)', () => {
    caps.drive = false;
    try {
      render(<StartWizard />);
      fireEvent.click(screen.getByTestId('start-wizard-cancel'));
      expect(useStartWizardStore.getState().open).toBe(false);
    } finally {
      caps.drive = true;
    }
  });

  it('a search that fails is an error, not a silent “nothing there”', async () => {
    useClient(
      fakeClient({
        discover: async () => {
          throw new Error('udp: bind failed');
        },
      }),
    );
    render(<StartWizard />);

    await waitForState('error');
    expect(screen.getByTestId('start-wizard-machine-state').textContent).toContain('Not answering');
    expect(screen.getByTestId('start-wizard-machine-reason').textContent).toContain('udp: bind failed');
  });

  it('connects to a typed address under the fold, and admits it knows no model', async () => {
    useClient(fakeClient());
    render(<StartWizard />);
    await waitForState('not-found'); // the automatic check heard nothing

    fireEvent.click(screen.getByTestId('start-wizard-machine-another'));
    fireEvent.change(screen.getByTestId('start-wizard-address'), { target: { value: '10.0.0.7' } });
    fireEvent.click(screen.getByTestId('start-wizard-connect-address'));

    await waitForState('found');
    expect(screen.getByTestId('start-wizard-machine-address').textContent).toBe('10.0.0.7');
    // A typed address announced no name, so no model is claimed for it.
    expect(screen.queryByTestId('start-wizard-machine-name')).toBeNull();
    expect(screen.getByTestId('start-wizard-machine-state').textContent).toContain('Online · Idle');
  });
});

describe('#280 — step 2, the stock', () => {
  it('choosing the blank creates the project, opens Engrave, and moves the same wizard to holding', async () => {
    render(<StartWizard />);
    await openStarter('blank');

    const s = useProjectStore.getState();
    expect(s.project.case.blank?.enabled).toBe(true);
    expect(s.welcomeMode).toBe(false);
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
    // The SAME modal, now on step 3: one wizard, one counter — no second dialog (#681).
    expect(screen.getByTestId('start-wizard')).toBeDefined();
    expect(screen.getByTestId('engrave-setup-step-holding')).toBeDefined();
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Holding');
    expect(screen.queryByTestId('engrave-setup-flow')).toBeNull();
  });

  it('seeds the engrave job’s stock from the blank — dimensions only, tagged computed', async () => {
    render(<StartWizard />);
    await openStarter('blank');

    const job = useEngraveJobStore.getState().job;
    expect(job.stock.length).toBe(100);
    expect(job.stock.width).toBe(60);
    expect(job.stock.thickness).toBe(12);
    expect(job.sources?.stock?.length).toBe('computed');
    // The material is left alone: a blank does not know what it is made of.
    expect(job.sources?.stock?.material).toBeUndefined();
  });

  // #344/#352 — the V1 job is the two-colour badge, and it arrives at the setup flow from this
  // route. The panel is mounted beside the wizard here the way `AppShell` mounts it, so the spec
  // drives the real path. Before #344's fix the shipped 4 mm `stockProud` met the 3.81 mm blank and
  // the blank step refused the job before the person could answer anything else; before #352 the
  // hand-off seeded `case.blank` only, so this spec passed trivially on the 12 mm default and only
  // the panel's button brought the badge across. The numbers are now the hand-off's own.
  it('the badge job reaches the setup flow with no vise error (#344, #352)', async () => {
    render(
      <>
        <EngravePanel />
        <WizardHost />
      </>,
    );
    await openStarter('badge-blank');
    expect(screen.getByTestId('engrave-setup-step-holding')).toBeTruthy();
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Holding');
    // The blank the hand-off seeded raises no #231 refusal (the vise followed the badge).
    expect(screen.queryByTestId('engrave-setup-step-finding-vise-stock-proud-exceeds-thickness')).toBeNull();

    // The hand-off itself is the seed (#352): the badge's blank is the stock, no button pressed —
    // and since #383 it is the blank TURNED a quarter turn, because that is how the vise holds it:
    // the 38.1 mm span across the jaws (X), the 76.2 mm span along them (Y).
    const job = useEngraveJobStore.getState().job;
    expect([job.stock.length, job.stock.width, job.stock.thickness]).toEqual([38.1, 76.2, 3.81]);
    // Seated on the jaws' 3.1 mm ledges: 3.81 − 3.1 (#208's calipers, #391 review item 1).
    expect(jobVise(job).stockProud).toBeCloseTo(0.71, 9);
    // …and the void the badge's model already has came with it (#271 route 1), so nothing floats.
    expect((job.keepOuts ?? []).map((k) => k.id)).toContain(BADGE_POCKET_KEEP_OUT_ID);
    // …and so did the LINES (#363 review): the three demo words were laid out for the 100 × 60 mm
    // plank, so the hand-off replaces them with the one placeholder the badge route seeds. The
    // stock assertions above would all still pass if the labels had been left running off the
    // badge, which is exactly what the issue was about.
    expect(job.labels).toHaveLength(1);
    expect(job.labels[0]!.text).toBe('Name');

    // Back to step 2: the step is seeded from the job the job now has, and it says where those
    // numbers came from rather than letting 3.81 look typed (#352).
    fireEvent.click(screen.getByTestId('start-wizard-back'));
    expect(screen.getByTestId('start-wizard-step-stock')).toBeDefined();
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 2 of 4 · Stock');
    // …and it is the badge's blank the step is asking about, not the 12 mm default it seeded before.
    expect((screen.getByTestId('start-wizard-make-thickness') as HTMLInputElement).value).toBe('3.81');
    expect(screen.getByTestId('engrave-setup-stock-provenance').textContent).toContain('the template');
  });

  it('does not seed the job until the labels’ faces are up (#365 review)', async () => {
    // The hand-off MEASURES the line it lays out, and a measure with no face parsed is the fallback
    // estimate — a badge seeded that way lands on 5 mm of cap where the panel's own rows (faces up)
    // say 8. So the seed waits, and this holds the faces in flight to show it: the project half is
    // up at once (it never waited), while the job is byte-for-byte the one that was there before.
    fonts.gate = true;
    render(<StartWizard />);
    await act(async () => {
      useStartWizardStore.getState().openWizard('machine', 'badge-blank');
    });

    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(useEngraveJobStore.getState().job.stock.length).toBe(defaultEngraveJob().stock.length);
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(3); // the demo set, untouched
    expect(screen.queryByTestId('engrave-setup-step-holding')).toBeNull();

    fonts.release?.();
    // …and once they land, the whole of the hand-off runs: the badge's stock, its ONE seeded line,
    // and step 3 of the same modal.
    expect(await screen.findByTestId('engrave-setup-step-holding')).toBeTruthy();
    const job = useEngraveJobStore.getState().job;
    // …the turned blank (#383), so its 38.1 mm span is the stock's LENGTH.
    expect(job.stock.length).toBeCloseTo(38.1, 6);
    expect(job.labels).toHaveLength(1);
    expect(job.labels[0]!.size).toBe(8); // measured, not the estimate's 5 (see the seed spec)
  });

  it('never overwrites a stock the user typed or measured', async () => {
    const job = defaultEngraveJob();
    useEngraveJobStore.setState({
      job: { ...job, stock: { ...job.stock, length: 999 }, sources: { stock: { length: 'measured' } } },
    });
    render(<StartWizard />);
    await openStarter('blank');

    const after = useEngraveJobStore.getState().job;
    expect(after.stock.length).toBe(999);
    expect(after.sources?.stock?.length).toBe('measured');
  });

  it('close puts the wizard away', () => {
    render(<StartWizard />);
    fireEvent.click(screen.getByTestId('start-wizard-close'));
    expect(useStartWizardStore.getState().open).toBe(false);
  });
});

// #432 slice 4 — the facing choice is SEEDED onto a job made from a piece of stock, not interpreted
// at Generate: a job with no `facing` key must keep planning exactly as it did before #432.
describe('#432 slice 4 — a new job starts with the finish’s facing choice', () => {
  /**
   * A typed 60 × 40 × 8 mm piece of the given finish. Softwood on purpose: facing is a wood and
   * metal question, and the house's PLA opening would refuse it (#683).
   */
  function typePiece(finish: 'rough' | 'finished' | 'printed' | 'unknown'): void {
    fireEvent.change(screen.getByTestId('start-wizard-stock-material'), { target: { value: 'softwood' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '60' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-width'), { target: { value: '40' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-thickness'), { target: { value: '8' } });
    fireEvent.change(screen.getByTestId('start-wizard-stock-finish'), { target: { value: finish } });
  }

  async function start(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    // A job with items on it asks before it is replaced.
    const yes = screen.queryByTestId('start-wizard-replace-yes');
    if (yes !== null) {
      await act(async () => {
        fireEvent.click(yes);
      });
    }
  }

  it('a rough piece is seeded facing on, with the shop’s rough skim', async () => {
    render(<StartWizard />);
    skipToStockStep();
    typePiece('rough');
    await start();

    const job = useEngraveJobStore.getState().job;
    expect(job.stockEntry?.finish).toBe('rough');
    expect(job.facing).toEqual({ enabled: true, depth: 0.5 });
  });

  it('a finished piece is seeded facing off — the face is cut as it is', async () => {
    render(<StartWizard />);
    skipToStockStep();
    typePiece('finished');
    await start();

    expect(useEngraveJobStore.getState().job.facing).toEqual({ enabled: false, depth: 0.2 });
  });

  it('the finish line states the rule once, with no consequence paragraph (#683, A8)', () => {
    render(<StartWizard />);
    skipToStockStep();
    typePiece('rough');

    expect(screen.getByTestId('start-wizard-stock-finish-hint').textContent).toContain(
      'plastic is cut as it is; wood and metal are faced first',
    );
    // The old sentence about facing and the skim is the job's business, not the step's prose.
    expect(screen.queryByTestId('start-wizard-stock-facing')).toBeNull();
  });
});

// #681 — the wizard must carry a job to its item on the paths where something is missing. A job
// needs no machine and no cutter: both are answered later, and neither gates a step.
describe('#681 — the wizard with nothing to lean on', () => {
  /** A typed 60 × 40 × 8 mm piece, with the house's opening material. */
  function typePiece(): void {
    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '60' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-width'), { target: { value: '40' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-thickness'), { target: { value: '8' } });
  }

  /** Stock → holding → operation, the middle of the one wizard. */
  async function toOperationStep(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    expect(screen.getByTestId('engrave-setup-step-holding')).toBeDefined();
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Holding');
    fireEvent.click(screen.getByTestId('engrave-setup-next'));
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe(
      'Step 4 of 4 · What are you cutting?',
    );
  }

  it('no machine on the network: the check says so, Next is never gated, and the item is still made', async () => {
    useClient(fakeClient()); // discover → [] = nothing answered
    act(() => {
      useStartWizardStore.getState().openWizard();
    });
    render(<WizardHost />);

    await waitFor(() =>
      expect(screen.getByTestId('start-wizard-machine-state').getAttribute('data-state')).toBe('not-found'),
    );
    expect((screen.getByTestId('start-wizard-next') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('start-wizard-next'));
    typePiece();
    await toOperationStep();
    // A run that began here CREATES the job; only a re-entry adds an operation (#681/#685).
    expect(screen.getByTestId('start-wizard-create').textContent).toBe('Create the job');
    fireEvent.change(screen.getByTestId('start-wizard-op-text'), { target: { value: 'Bench free' } });
    fireEvent.click(screen.getByTestId('start-wizard-create'));
    expect(screen.queryByTestId('start-wizard')).toBeNull();

    const job = useEngraveJobStore.getState().job;
    expect(job.labels).toHaveLength(1);
    expect(job.labels[0]!.text).toBe('Bench free');
  });

  it('no cutter: the job still gets its item, with no bit named on it', async () => {
    act(() => {
      useStartWizardStore.getState().openWizard();
    });
    render(<WizardHost />);
    skipToStockStep();
    typePiece();
    await toOperationStep();
    // The default job names no cutter (#516), and this path added none.
    expect(useEngraveJobStore.getState().job.toolKey ?? '').toBe('');

    fireEvent.change(screen.getByTestId('start-wizard-op-text'), { target: { value: 'No bit yet' } });
    fireEvent.click(screen.getByTestId('start-wizard-create'));

    const job = useEngraveJobStore.getState().job;
    expect(job.toolKey ?? '').toBe('');
    expect(job.labels).toHaveLength(1);
    expect(job.labels[0]!.text).toBe('No bit yet');
  });

  it('nothing chosen on the stock step: Next waits, says what step it leads to, and how to unblock it', () => {
    act(() => {
      useStartWizardStore.getState().openWizard();
    });
    render(<WizardHost />);
    skipToStockStep();

    const next = screen.getByTestId('start-wizard-stock-next') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    // The button that leaves step 2 says what step 3 is.
    expect(next.textContent).toBe('Next: holding');
    // …and ONE sentence, in the step, says what to do — with the controls to do it right above.
    expect(screen.getByTestId('start-wizard-stock-unblock').textContent).toBe(
      'Choose the stock above — a piece on the shelf, a size you type, or a file.',
    );

    typePiece();
    expect((screen.getByTestId('start-wizard-stock-next') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('start-wizard-stock-unblock')).toBeNull();
  });
});

describe('#280/#682 — the machine record survives the wizard', () => {
  it('the check on open is kept in the store, not in the component', async () => {
    useClient(
      fakeClient({
        discover: async () => [
          { name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false },
        ],
      }),
    );
    render(<StartWizard />);

    await waitFor(() => expect(useMachineStore.getState().outcome).toBe('found'));
    expect(useMachineStore.getState().machine?.profileId).toBe('Z1');
  });
});
