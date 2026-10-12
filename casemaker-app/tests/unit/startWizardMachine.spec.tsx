// @vitest-environment jsdom
// Issue #347 — step 1's machine pick, and the notice when the machine that answers is not it.
//
// The picker's own claim is narrow and worth testing exactly: the list IS `MACHINES` and picking one
// writes the job's `machineId` and nothing else. To show the list is read from the module rather
// than hardcoded to the Z1, `MACHINES` is mocked here with a second profile — for this FILE only, so
// the rest of the suite keeps testing the machine the app actually ships.
//
// The second half of the issue — "a mismatch notice when a found machine reports a different
// profile" — has no reachable state while one profile ships, so the same mock is what makes it
// testable at all: a job on the second profile, with a Z1 answering the check.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/engine/cnc/machine', async (orig) => {
  const real = await orig<typeof import('@/engine/cnc/machine')>();
  return {
    ...real,
    MACHINES: {
      ...real.MACHINES,
      TESTMILL: { ...real.Z1, id: 'TESTMILL', name: 'Test Mill' },
    },
  };
});

import { StartWizard } from '@/components/welcome/StartWizard';
import { setMachineProbeLoader, type MachineProbeClient } from '@/platform/machineProbe';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { resetStartWizard } from '@/store/startWizardStore';

// #346/#347 — vitest runs the WEB target, where the wizard has no socket at all. The picker must
// exist on both builds, so the "no check, but still a picker" test renders with the capability off.
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

/** A bench Z1 that answers, but whose frame does not read completely (no saved calibration). */
function z1Client(): MachineProbeClient {
  return {
    discover: async () => [
      { name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false },
    ],
    identify: async () => ({ ip: '192.168.10.43', mac: 'aa:bb:cc:dd:ee:ff' }),
    status: async () => ({ ok: true, text: 'Idle' }),
    readConfig: async () => ({ values: new Map<string, string>(), failures: [] }),
  };
}

beforeEach(() => {
  cleanup();
  resetMachineStore();
  resetStartWizard();
  useEngraveJobStore.setState({ job: defaultEngraveJob() });
});

afterEach(() => {
  cleanup();
  setMachineProbeLoader(null);
});

describe('#347 — step 1 picks the machine', () => {
  it('offers every profile, and picking one writes the machine and nothing else', () => {
    render(<StartWizard />);
    const select = screen.getByTestId('start-wizard-machine-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['Z1', 'TESTMILL']);
    expect([...select.options].map((o) => o.textContent)).toEqual(['Makera Z1', 'Test Mill']);
    // The job's own answer, so the control opens on what the document says.
    expect(select.value).toBe('Z1');

    const before = useEngraveJobStore.getState().job;
    fireEvent.change(select, { target: { value: 'TESTMILL' } });

    const after = useEngraveJobStore.getState().job;
    expect(after.machineId).toBe('TESTMILL');
    // NOTHING else moved: the pick is a one-field write, so a half-answered job cannot be re-based
    // on another machine's work area by a stray click.
    expect({ ...after, machineId: before.machineId }).toEqual(before);
  });

  it('asks the question on a build with no socket too — where it is the only way to answer', () => {
    caps.drive = false;
    try {
      render(<StartWizard />);
      expect(screen.getByTestId('start-wizard-machine-select')).toBeDefined();
      expect(screen.getByTestId('start-wizard-machine-pick-note')).toBeDefined();
      // The check is still absent: the picker is the question, the socket is the evidence.
      expect(screen.queryByTestId('start-wizard-check')).toBeNull();
      fireEvent.change(screen.getByTestId('start-wizard-machine-select'), {
        target: { value: 'TESTMILL' },
      });
      expect(useEngraveJobStore.getState().job.machineId).toBe('TESTMILL');
    } finally {
      caps.drive = true;
    }
  });

  it('names a found machine that is not the job’s, and repoints nothing', async () => {
    useEngraveJobStore.getState().setMachine('TESTMILL');
    setMachineProbeLoader(async () => z1Client());
    render(<StartWizard />);
    fireEvent.click(screen.getByTestId('start-wizard-check'));

    const found = await screen.findByTestId('start-wizard-machine-state');
    expect(found.getAttribute('data-state')).toBe('found');
    const notice = screen.getByTestId('start-wizard-machine-mismatch');
    expect(notice.textContent).toContain('Makera Z1');
    expect(notice.textContent).toContain('Test Mill');
    // The job is still the job's: the check observes, it does not decide.
    expect(useEngraveJobStore.getState().job.machineId).toBe('TESTMILL');
    expect(useMachineStore.getState().machine?.profileId).toBe('Z1');
  });
});
