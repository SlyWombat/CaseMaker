// @vitest-environment jsdom
// Issue #280 — the startup wizard: machine check, job type, then the engrave setup.
//
// Only the socket is faked (`setMachineProbeLoader`), so `probeMachine`'s real orchestration runs.
// `scheduleImmediate` is mocked because a jsdom test has no geometry worker, and the wizard's own
// hand-off does not depend on the rebuild finishing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { StartWizard } from '@/components/welcome/StartWizard';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { setMachineProbeLoader, type ConfigReadSummary, type MachineProbeClient } from '@/platform/machineProbe';
import { Z1_FRAME_REPLIES } from './fixtures/z1Frame';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The Engrave panel is rendered beside the wizard by `AppShell`; a jsdom test has no worker. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

function fakeClient(over: Partial<MachineProbeClient> = {}): MachineProbeClient {
  return {
    discover: over.discover ?? (async () => []),
    identify: over.identify ?? (async () => ({ ip: '192.168.10.43', mac: 'aa:bb:cc:dd:ee:ff' })),
    status: over.status ?? (async () => ({ ok: true, text: 'Idle' })),
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

beforeEach(() => {
  cleanup();
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  resetMachineStore();
  // The check writes the machine's own frame into settings (#279), so each test starts with no
  // saved frame rather than inheriting the previous one's.
  useSettingsStore.getState().resetSettings();
  resetStartWizard();
  useProjectStore.setState({ project: createDefaultProject('rpi-4b'), welcomeMode: true });
  useViewportStore.setState({ activeSidebarSection: null, selection: null });
  useEngraveJobStore.setState({ job: defaultEngraveJob() });
});

afterEach(() => {
  cleanup();
  setMachineProbeLoader(null);
  setEngravePreviewClientLoader(null);
  useEngravePreviewStore.getState().dispose();
});

/** Click through step 1 without checking for a machine. */
function skipToJobStep(): void {
  fireEvent.click(screen.getByTestId('start-wizard-next'));
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

describe('#280 — step 1, the machine check', () => {
  it('reports a found machine with what it said about itself, and its known limits', async () => {
    useClient(
      fakeClient({
        discover: async () => [
          { name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false },
        ],
      }),
    );
    render(<StartWizard />);
    fireEvent.click(screen.getByTestId('start-wizard-check'));

    const state = await screen.findByTestId('start-wizard-machine-state');
    expect(state.getAttribute('data-state')).toBe('found');
    expect(screen.getByTestId('start-wizard-machine-name').textContent).toContain('Makera_Z1_010290');
    expect(screen.getByTestId('start-wizard-machine-address').textContent).toContain('192.168.10.43:2222');
    expect(screen.getByTestId('start-wizard-machine-address').textContent).toContain('idle');
    expect(screen.getByTestId('start-wizard-machine-identity').textContent).toContain('aa:bb:cc:dd:ee:ff');
    expect(screen.getByTestId('start-wizard-machine-status').textContent).toContain('Idle');
    // The profile is the one the NAME resolved to, and its numbers come from there.
    expect(screen.getByTestId('start-wizard-machine-profile').textContent).toContain('Makera Z1');
    expect(screen.getByTestId('start-wizard-machine-profile').textContent).toContain('13000 rpm');
    expect(screen.queryByTestId('start-wizard-machine-unknown')).toBeNull();
  });

  it("saves the machine's own frame and says which frame is in force (#279)", async () => {
    useClient(
      fakeClient({
        discover: async () => [
          { name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false },
        ],
      }),
    );
    render(<StartWizard />);
    fireEvent.click(screen.getByTestId('start-wizard-check'));

    await screen.findByTestId('start-wizard-machine-state');
    const frame = screen.getByTestId('start-wizard-machine-frame');
    expect(frame.getAttribute('data-state')).toBe('machine-calibrated-frame');
    expect(frame.textContent).toContain('192.168.10.43');

    // Saved with its provenance, and with the MACHINE's numbers rather than the vendor's: the
    // bench Z1's anchor1 is 1.51 mm from `configZ1.default`, which is the whole of #279.
    const saved = useSettingsStore.getState().machineCalibration;
    expect(saved?.machineId).toBe('Z1');
    expect(saved?.frame.anchor1).toEqual([-190.89, -193.83]);
  });

  it('warns that the vendor’s defaults are in force when the frame could not be read (#279)', async () => {
    useClient(
      fakeClient({
        discover: async () => [
          { name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false },
        ],
        readConfig: async () => {
          throw new Error('connect timeout');
        },
      }),
    );
    render(<StartWizard />);
    fireEvent.click(screen.getByTestId('start-wizard-check'));

    await screen.findByTestId('start-wizard-machine-state');
    expect(screen.getByTestId('start-wizard-machine-frame').getAttribute('data-state')).toBe(
      'machine-vendor-frame',
    );
    expect(useSettingsStore.getState().machineCalibration).toBeUndefined();
  });

  it('reports an unknown machine as unknown, with no numbers', async () => {
    useClient(
      fakeClient({
        discover: async () => [{ name: 'SomeLaser_9000', host: '10.0.0.5', port: 2222, busy: false }],
      }),
    );
    render(<StartWizard />);
    fireEvent.click(screen.getByTestId('start-wizard-check'));

    await screen.findByTestId('start-wizard-machine-state');
    expect(screen.getByTestId('start-wizard-machine-unknown')).toBeDefined();
    expect(screen.queryByTestId('start-wizard-machine-profile')).toBeNull();
    // Said ONCE. The probe used to note the same thing in its own words as well, so the browser
    // rendered two near-identical paragraphs under each other.
    expect(screen.getAllByText(/not being given another machine/i)).toHaveLength(1);
    expect(screen.queryByTestId('start-wizard-machine-note-0')).toBeNull();
  });

  it('“nothing answered” is an answer, and it never blocks', async () => {
    useClient(fakeClient());
    render(<StartWizard />);
    fireEvent.click(screen.getByTestId('start-wizard-check'));

    const state = await screen.findByTestId('start-wizard-machine-state');
    expect(state.getAttribute('data-state')).toBe('not-found');
    expect(state.textContent).toMatch(/without a machine/i);
    // Next is enabled with no machine at all.
    expect((screen.getByTestId('start-wizard-next') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('start-wizard-next'));
    expect(screen.getByTestId('start-wizard-step-job')).toBeDefined();
  });

  it('a build with no socket says so, in the guard’s own words', async () => {
    setMachineProbeLoader(async () => {
      throw new Error('Driving the machine requires the desktop build (BUILD_TARGET=desktop).');
    });
    render(<StartWizard />);
    // vitest runs the web target, so the reason is on screen before anything is pressed.
    expect(screen.getByTestId('start-wizard-machine-note-build')).toBeDefined();
    fireEvent.click(screen.getByTestId('start-wizard-check'));

    const state = await screen.findByTestId('start-wizard-machine-state');
    expect(state.getAttribute('data-state')).toBe('unavailable');
    expect(state.textContent).toContain('desktop build');
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
    fireEvent.click(screen.getByTestId('start-wizard-check'));

    const state = await screen.findByTestId('start-wizard-machine-state');
    expect(state.getAttribute('data-state')).toBe('error');
    expect(state.textContent).toContain('udp: bind failed');
  });

  it('connects to a typed address, and admits it knows no model', async () => {
    useClient(fakeClient());
    render(<StartWizard />);
    fireEvent.change(screen.getByTestId('start-wizard-address'), { target: { value: '10.0.0.7' } });
    fireEvent.click(screen.getByTestId('start-wizard-connect-address'));

    await screen.findByTestId('start-wizard-machine-state');
    expect(screen.getByTestId('start-wizard-machine-address').textContent).toContain('10.0.0.7:2222');
    expect(screen.getByTestId('start-wizard-machine-unknown')).toBeDefined();
  });
});

describe('#280 — step 2, what are you making', () => {
  it('offers the five project types, each an existing template', () => {
    render(<StartWizard />);
    skipToJobStep();
    for (const id of ['protective-case', 'mini-rack-10in', 'tool-insert', 'badge-blank', 'blank']) {
      expect(screen.getByTestId(`start-wizard-job-${id}`), `${id} should be offered`).toBeDefined();
    }
  });

  it('choosing the blank creates the project, opens the Engrave panel and hands off to the setup', () => {
    render(<StartWizard />);
    skipToJobStep();
    fireEvent.click(screen.getByTestId('start-wizard-job-blank'));

    const s = useProjectStore.getState();
    expect(s.project.case.blank?.enabled).toBe(true);
    expect(s.welcomeMode).toBe(false);
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
    // Step 3 is the flow's own overlay, not a second dialog stacked on ours.
    expect(screen.getByTestId('engrave-setup-flow')).toBeDefined();
    expect(screen.queryByTestId('start-wizard')).toBeNull();
  });

  it('seeds the engrave job’s stock from the blank — dimensions only, tagged computed', () => {
    render(<StartWizard />);
    skipToJobStep();
    fireEvent.click(screen.getByTestId('start-wizard-job-blank'));

    const job = useEngraveJobStore.getState().job;
    expect(job.stock.length).toBe(100);
    expect(job.stock.width).toBe(60);
    expect(job.stock.thickness).toBe(12);
    expect(job.sources?.stock?.length).toBe('computed');
    // The material is left alone: a blank does not know what it is made of.
    expect(job.sources?.stock?.material).toBeUndefined();
  });

  // #344 — the V1 job is the two-colour badge, and it arrives at the setup flow from this route.
  // The panel is mounted beside the wizard here the way `AppShell` mounts it, so the spec drives
  // the real path: hand off, take the badge blank, come back into the flow, and look at the step
  // that holds the vise. Before the fix the shipped 4 mm `stockProud` met the 3.81 mm blank and
  // the blank step refused the job before the person could answer anything else.
  it('the badge job reaches the setup flow with no vise error (#344)', () => {
    useStartWizardStore.getState().openWizard();
    render(
      <>
        <EngravePanel />
        <WizardHost />
      </>,
    );
    skipToJobStep();
    fireEvent.click(screen.getByTestId('start-wizard-job-badge-blank'));
    expect(screen.getByTestId('engrave-setup-flow')).toBeTruthy();

    // Take the badge's own blank (the button the stale-stock nag points at), then re-enter the
    // flow: the answers are seeded when it opens, so it has to be reopened to see the new blank.
    fireEvent.click(screen.getByTestId('engrave-setup-close'));
    fireEvent.click(screen.getByTestId('engrave-stock-from-badge'));
    const job = useEngraveJobStore.getState().job;
    expect(job.stock.thickness).toBe(3.81);
    expect(job.workholding.vise.stockProud).toBeCloseTo(1.905, 9);

    fireEvent.click(screen.getByTestId('engrave-setup-open'));
    fireEvent.click(screen.getByTestId('engrave-setup-next')); // holding -> material
    fireEvent.click(screen.getByTestId('engrave-setup-next')); // material -> blank
    const blankStep = screen.getByTestId('engrave-setup-step-blank');
    expect(blankStep.textContent).not.toContain('vise-stock-proud-exceeds-thickness');
    // …and it is the badge's blank the flow is asking about, not the 12 mm default it would have
    // seeded before the panel's button ran.
    expect((screen.getByTestId('engrave-setup-stock-thickness') as HTMLInputElement).value).toBe('3.81');
  });

  it('never overwrites a stock the user typed or measured', () => {
    const job = defaultEngraveJob();
    useEngraveJobStore.setState({
      job: { ...job, stock: { ...job.stock, length: 999 }, sources: { stock: { length: 'measured' } } },
    });
    render(<StartWizard />);
    skipToJobStep();
    fireEvent.click(screen.getByTestId('start-wizard-job-blank'));

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

describe('#280 — the machine record survives the wizard', () => {
  it('a found check is kept in the store, not in the component', () => {
    useClient(
      fakeClient({
        discover: async () => [
          { name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false },
        ],
      }),
    );
    render(<StartWizard />);
    fireEvent.click(screen.getByTestId('start-wizard-check'));
    return screen.findByTestId('start-wizard-machine-state').then(() => {
      expect(useMachineStore.getState().machine?.profileId).toBe('Z1');
      expect(useMachineStore.getState().outcome).toBe('found');
    });
  });
});
