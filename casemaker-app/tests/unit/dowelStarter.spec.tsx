// @vitest-environment jsdom
// #1107 — THE DOWEL STARTER ASKS ITS QUESTION.
//
// The door's "Name on a dowel" used to land on Holding with no operation, and Create then wrote an
// EMPTY job. Now it opens the question with the dowel intent selected and the text field focused;
// Create waits for the text, and the job it makes is a rotary text job reading along the rod.
//
// The location is seeded with the house's rotary machine (the same fixture `rotaryHolding.spec`
// uses), because the Holding step only offers the mounts the machine actually has.

import { readFileSync } from 'node:fs';
import type { JSX } from 'react';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { StartWizard } from '@/components/welcome/StartWizard';
import { MachineRecordSchema, type FixtureRecord, type LocationView, type MachineRecord } from '@/platform/locationClient';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useLocationStore } from '@/store/locationStore';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';

vi.mock('@/engine/jobs/JobScheduler', () => ({ scheduleImmediate: vi.fn(async () => {}) }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return false;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  id: string;
  name: string;
  createdAt: string;
  machines: unknown[];
  accessories: FixtureRecord[];
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

/** The fixture's machine with the 4th axis on its pins and a bare bed. */
function rotaryMachine(): MachineRecord {
  const machine = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  const profile = machine.bedProfiles![0]!;
  profile.placements = [
    {
      id: 'pl-rotary',
      fixture: 'fx-rotary-1',
      where: { kind: 'pins', pins: 'rotary', anchor: null },
      count: null,
      seed: null,
      frame: null,
      provenance: {},
    },
  ];
  profile.surface = {
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
  profile.consumables = null;
  return machine;
}

function seedLocation(machine: MachineRecord): void {
  const location = {
    kind: 'casemaker-location',
    schemaVersion: 1,
    id: DOC.id,
    name: DOC.name,
    createdAt: DOC.createdAt,
    machines: [machine],
    accessories: [...DOC.accessories, ROTARY],
  } as unknown as LocationView;
  act(() => {
    useLocationStore.setState({ status: 'present', location, etag: '"e1"', reason: null });
  });
}

function WizardHost(): JSX.Element {
  const open = useStartWizardStore((s) => s.open);
  return open ? <StartWizard /> : <></>;
}

beforeEach(() => {
  cleanup();
  resetStartWizard();
  seedLocation(rotaryMachine());
});
afterEach(cleanup);

describe('#1107 — the dowel starter', () => {
  it('lands on the question with the dowel intent selected and the text field focused', async () => {
    act(() => {
      useStartWizardStore.getState().openWizard('machine', 'dowel');
    });
    render(<WizardHost />);
    await waitFor(() => expect(screen.getByTestId('start-wizard-progress').textContent).toContain('What are you cutting?'), {
      timeout: 15_000,
    });
    expect(screen.getByTestId('start-wizard-op-text')).toBeDefined();
    expect(document.activeElement).toBe(screen.getByTestId('start-wizard-op-text'));
    // The intent is picked; the empty text is what holds Create.
    const next = screen.getByTestId('start-wizard-operation-next') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(screen.getByTestId('start-wizard-create-unblock').textContent).toBe('Type the text to engrave — for example, a name.');
  });

  it('creates a rotary text job reading along the rod once the text is typed', async () => {
    act(() => {
      useStartWizardStore.getState().openWizard('machine', 'dowel');
    });
    render(<WizardHost />);
    await waitFor(() => expect(screen.getByTestId('start-wizard-progress').textContent).toContain('What are you cutting?'), {
      timeout: 15_000,
    });
    fireEvent.change(screen.getByTestId('start-wizard-op-text'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('start-wizard-operation-next'));
    expect(screen.getByTestId('start-wizard-progress').textContent).toContain('Stock');
    // The rod the starter seeded is the stock proposal.
    expect(screen.getByTestId('start-wizard-form-rod').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    expect(screen.getByTestId('start-wizard-progress').textContent).toContain('Holding');
    // #1107 — the chuck arrives selected: the frame chose the hold.
    expect((screen.getByTestId('engrave-setup-mount-rotary') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-setup-next'));

    const job = useEngraveJobStore.getState().job;
    expect(job.stock.shape).toBe('cylinder');
    expect(job.workholding.kind).toBe('rotary-chuck');
    const label = job.labels.find((l) => l.text === 'Hello');
    expect(label).toBeDefined();
    expect(label!.size).toBeGreaterThan(0);
  });
});
