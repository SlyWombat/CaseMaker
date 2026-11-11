// @vitest-environment jsdom
// #1106 items 1–2 (analyst's comment 6785498732, land18 walk) — THE JOB CARRIES A PROFILE ID.
//
// Item 1: step 1's rows are LOCATION RECORDS, but `job.machineId` is a PROFILE id everywhere else
// (`bedProfiles.machineForJob` matches `m.profileId`). The row click wrote the record id into the
// job, so no machine resolved and Generate could not plan; and the row was compared by record id
// against the job's profile id, so the picked row never read as selected. The wizard now holds the
// selected RECORD in its own state and writes the record's PROFILE id to the job; a record with no
// profile is selectable, leaves the job's machine alone, and says so on its row.
//
// Item 2: on the web build no check ever runs, so the selected row read "Checking…" for ever. A
// row is "checking" only where a check can run; on the web every row uses the profile words, and
// the positive sentence heads the step above the list.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { StartWizard } from '@/components/welcome/StartWizard';
import { CARVERA, Z1 } from '@/engine/cnc/machine';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetMachineStore } from '@/store/machineStore';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetStartWizard } from '@/store/startWizardStore';
import { NO_MACHINE_RELAY_SENTENCE } from '@/platform/capabilities';

const caps = vi.hoisted(() => ({ drive: true }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return caps.drive;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Location = NonNullable<ReturnType<typeof useLocationStore.getState>['location']>;
type Rec = Location['machines'][number];

const rec = (id: string, profileId: string | null, host: string | null): Rec =>
  ({ id, profileId, name: id, nickname: null, address: host === null ? null : { host, port: 2222 } }) as unknown as Rec;

const Z1_REC = rec('rec-z1', Z1.id, '192.168.10.43');
const CARVERA_REC = rec('rec-carvera', CARVERA.id, null);
const BARE_REC = rec('rec-bare', null, null);

function withMachines(...machines: Rec[]): void {
  useLocationStore.setState({
    status: 'present',
    location: { machines } as unknown as Location,
    etag: '"e1"',
    reason: null,
  });
}

const row = (id: string): HTMLElement => screen.getByTestId(`start-wizard-machine-row-${id}`);

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
  resetMachineStore();
  resetLocationStore();
  resetStartWizard();
  useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), machineId: Z1.id } });
  caps.drive = false; // the web build: no check runs, the rows are the whole step
});

afterEach(() => {
  cleanup();
  caps.drive = true;
});

describe('#1106 item 1 — selecting a row leaves job.machineId a profile id', () => {
  it('writes the clicked record’s PROFILE id, never the record id', () => {
    withMachines(Z1_REC, CARVERA_REC);
    render(<StartWizard />);
    fireEvent.click(row(CARVERA_REC.id));
    expect(useEngraveJobStore.getState().job.machineId).toBe(CARVERA.id);
    expect(useEngraveJobStore.getState().job.machineId).not.toBe(CARVERA_REC.id);
  });

  it('the selected row is the one clicked', () => {
    withMachines(Z1_REC, CARVERA_REC);
    render(<StartWizard />);
    fireEvent.click(row(CARVERA_REC.id));
    expect(row(CARVERA_REC.id).getAttribute('aria-pressed')).toBe('true');
    expect(row(Z1_REC.id).getAttribute('aria-pressed')).toBe('false');
  });

  it('a record with no profile is selectable, leaves the job’s machine alone, and says so', () => {
    withMachines(Z1_REC, BARE_REC);
    render(<StartWizard />);
    fireEvent.click(row(BARE_REC.id));
    expect(row(BARE_REC.id).getAttribute('aria-pressed')).toBe('true');
    expect(useEngraveJobStore.getState().job.machineId).toBe(Z1.id);
    expect(row(BARE_REC.id).textContent).toContain('no profile — set it in Manage › Machines');
  });

  it('a job whose profile is a record’s starts with that record selected', () => {
    withMachines(CARVERA_REC, Z1_REC);
    render(<StartWizard />);
    expect(row(Z1_REC.id).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('#1106 item 2 — the web build never says Checking…', () => {
  it('every row uses the profile words and nothing on the step reads Checking…', () => {
    withMachines(Z1_REC, CARVERA_REC);
    render(<StartWizard />);
    const step = screen.getByTestId('start-wizard-step-machine');
    expect(step.textContent).not.toContain('Checking');
    expect(row(Z1_REC.id).textContent).toContain('profile only — vendor defaults; connect it at Cut');
    expect(row(CARVERA_REC.id).textContent).toContain('profile only — vendor defaults; connect it at Cut');
  });

  it('the positive sentence heads the step, above the list', () => {
    withMachines(Z1_REC);
    render(<StartWizard />);
    const note = screen.getByTestId('start-wizard-machine-note-build');
    expect(note.textContent).toBe(NO_MACHINE_RELAY_SENTENCE);
    const list = screen.getByTestId('start-wizard-machine-list');
    expect(note.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
