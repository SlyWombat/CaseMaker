// @vitest-environment jsdom
// #573 — the wizard is a shell over existing components. This spec stubs the three mounted
// components and tests the wizard's OWN mechanics: the stepper order, the per-step gates and the
// reset-forward-on-edit (a stock/cutter change → step 2, a stale run → step 4).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngraveCutWizard } from '@/components/panels/EngraveCutWizard';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useMachineStore } from '@/store/machineStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill } from '@/engine/cnc/tool';
import type { MachineObservation } from '@/platform/machineProbe';
import type { EngraveJob } from '@/types/engraveJob';

vi.mock('@/components/manage/MachinesScope', () => ({ MachinesScope: () => <div data-testid="mock-machines" /> }));
vi.mock('@/components/panels/EngraveSetupsSection', () => ({ EngraveSetupsSection: () => <div data-testid="mock-setups" /> }));
vi.mock('@/components/panels/EngraveRegistrationStep', () => ({
  EngraveRegistrationStep: () => <div data-testid="mock-registration" />,
}));

const ONLINE: MachineObservation = {
  name: null,
  host: '192.168.10.43',
  port: 2222,
  busy: false,
  ip: null,
  mac: null,
  status: '<Idle|MPos:-1,-1,-1>',
  statusLine: null,
  profileId: null,
  observedAt: '2026-10-22T00:00:00.000Z',
  notes: [],
};

/** A job with an approved setup-1 registration plan, so the step-3 gate (plan) passes. */
function plannedJob(): EngraveJob {
  const job = { ...defaultEngraveJob(), toolKey: 'flat-1.0' };
  job.setups = [
    {
      registration: { method: 'registration', plan: { mount: 'vise', scans: [] }, expected: null },
    } as unknown as NonNullable<EngraveJob['setups']>[number],
  ];
  return job;
}

function seedMachine(): void {
  act(() => {
    useMachineStore.setState({ machine: ONLINE });
  });
}

describe('EngraveCutWizard (#573)', () => {
  beforeEach(() => {
    act(() => {
      useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), toolKey: 'flat-1.0' } });
      useMachineStore.setState({ machine: null, outcome: null, reason: null, checkedAt: null });
      useEngraveRunStore.setState({ staleSince: null, generated: null, oracle: null });
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('starts on the machine step, with Next disabled until the machine is reached', () => {
    render(<EngraveCutWizard />);
    expect(screen.getByTestId('mock-machines')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-step-0').dataset.active).toBe('true');
    expect((screen.getByTestId('engrave-cut-next') as HTMLButtonElement).disabled).toBe(true);

    seedMachine();
    expect((screen.getByTestId('engrave-cut-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('walks forward in order and Back returns', () => {
    render(<EngraveCutWizard />);
    seedMachine();

    fireEvent.click(screen.getByTestId('engrave-cut-next'));
    expect(screen.getByTestId('engrave-cut-step-1').dataset.active).toBe('true');
    expect(screen.getByTestId('engrave-cut-wizard-cutter').textContent).toContain('flat');

    fireEvent.click(screen.getByTestId('engrave-cut-back'));
    expect(screen.getByTestId('engrave-cut-step-0').dataset.active).toBe('true');
  });

  it('enforces the order — the plan step needs an approved plan', () => {
    render(<EngraveCutWizard />);
    seedMachine();
    fireEvent.click(screen.getByTestId('engrave-cut-next')); // step 1 (cutter ok)
    fireEvent.click(screen.getByTestId('engrave-cut-next')); // step 2 (plan)

    // Step 2 gate is an approved plan; the default job has none, so Next stays disabled.
    expect((screen.getByTestId('engrave-cut-next') as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      useEngraveJobStore.setState({ job: plannedJob() });
    });
    expect((screen.getByTestId('engrave-cut-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('resets forward to the blank step when the stock changes', () => {
    render(<EngraveCutWizard />);
    act(() => {
      useEngraveJobStore.setState({ job: plannedJob() });
    });
    seedMachine();

    fireEvent.click(screen.getByTestId('engrave-cut-next')); // 1 blank
    fireEvent.click(screen.getByTestId('engrave-cut-next')); // 2 plan
    expect(screen.getByTestId('engrave-cut-step-2').dataset.active).toBe('true');

    act(() => {
      const job = useEngraveJobStore.getState().job;
      useEngraveJobStore.setState({ job: { ...job, stock: { ...job.stock, length: 50 } } });
    });
    expect(screen.getByTestId('engrave-cut-step-1').dataset.active).toBe('true');
  });

  it('step 2 passes for a V-profile engraving bit on PLA, even with a metal name (#575)', () => {
    const engravingMetal = flatEndMill(0.5, {
      shape: 'engraving',
      name: 'Engraving V-bit 30 x 0.5 (Metal)',
      tipDiameter: 0.5,
      diameter: 3.175,
      angle: 30,
      halfAngle: 15,
    });
    act(() => {
      useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), toolKey: 'v30', tool: engravingMetal } });
    });
    render(<EngraveCutWizard />);
    seedMachine();
    fireEvent.click(screen.getByTestId('engrave-cut-next')); // step 1 (blank + cutter)
    expect((screen.getByTestId('engrave-cut-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('step 2 blocks a flat metal cutter on PLA, and the override lets it through (#572)', () => {
    const flatMetal = flatEndMill(3.175, { id: '112111313812', name: '3.175*12mm Flat End(Metal)' });
    act(() => {
      useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), toolKey: 'flat-metal', tool: flatMetal } });
    });
    render(<EngraveCutWizard />);
    seedMachine();
    fireEvent.click(screen.getByTestId('engrave-cut-next')); // step 1
    expect((screen.getByTestId('engrave-cut-next') as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      useEngraveJobStore.setState({ job: { ...useEngraveJobStore.getState().job, metalLineOverride: true } });
    });
    expect((screen.getByTestId('engrave-cut-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('resets forward to the generate step when the run goes stale', () => {
    render(<EngraveCutWizard />);
    act(() => {
      const job = plannedJob();
      job.package = { hash: 'frozen' } as unknown as EngraveJob['package'];
      useEngraveJobStore.setState({ job });
      useEngraveRunStore.setState({
        generated: { programs: [] } as unknown as ReturnType<typeof useEngraveRunStore.getState>['generated'],
        oracle: { ok: true, band: 0, levels: [], worst: { underCut: 0, overCut: 0 } },
      });
    });
    seedMachine();

    fireEvent.click(screen.getByTestId('engrave-cut-next')); // 1 blank
    fireEvent.click(screen.getByTestId('engrave-cut-next')); // 2 plan
    fireEvent.click(screen.getByTestId('engrave-cut-next')); // 3 generate
    fireEvent.click(screen.getByTestId('engrave-cut-next')); // 4 freeze
    expect(screen.getByTestId('engrave-cut-step-4').dataset.active).toBe('true');

    act(() => {
      useEngraveRunStore.setState({ staleSince: Date.now() });
    });
    expect(screen.getByTestId('engrave-cut-step-3').dataset.active).toBe('true');
  });

  it('step 4 shows "checking…" and stays gated while the oracle is pending (#578)', () => {
    act(() => {
      useEngraveJobStore.setState({ job: plannedJob() });
      useEngraveRunStore.setState({
        generated: { programs: [] } as unknown as ReturnType<typeof useEngraveRunStore.getState>['generated'],
        oracle: null,
      });
    });
    render(<EngraveCutWizard />);
    seedMachine();

    fireEvent.click(screen.getByTestId('engrave-cut-next')); // 1 blank
    fireEvent.click(screen.getByTestId('engrave-cut-next')); // 2 plan
    fireEvent.click(screen.getByTestId('engrave-cut-next')); // 3 generate
    expect(screen.getByTestId('engrave-cut-step-3').dataset.active).toBe('true');

    // The oracle is async: null means PENDING, so the step says "checking…", never the blocked
    // sentence, and Next stays disabled until the oracle for this seq lands.
    expect(screen.getByTestId('engrave-cut-generate-checking')).toBeTruthy();
    expect(screen.queryByTestId('engrave-cut-generate-blocked')).toBeNull();
    expect((screen.getByTestId('engrave-cut-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('step 3 materialises the setups for a job that has none (#579)', () => {
    render(<EngraveCutWizard />);
    seedMachine();

    fireEvent.click(screen.getByTestId('engrave-cut-next')); // 1 blank
    fireEvent.click(screen.getByTestId('engrave-cut-next')); // 2 plan
    expect(screen.getByTestId('engrave-cut-step-2').dataset.active).toBe('true');

    // The step materialises the setups, so the mounted section is editable (the Plan/Approve
    // controls) rather than the read-only "compatibility reading".
    expect(useEngraveJobStore.getState().job.setups).toBeDefined();
    expect(useEngraveJobStore.getState().job.setups!.length).toBeGreaterThan(0);
  });
});
