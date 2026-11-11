// @vitest-environment jsdom
// #1106 — step 1 is a PICKER: every CNC machine record, the last used first, profile-only rows a
// full citizen, each row drawing its bed, and the bed changed from here. One list, one sentence,
// and the last row is the one action that adds a machine.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { MachineStep } from '@/components/welcome/MachineStep';
import { MachineRecordSchema, type MachineRecord } from '@/platform/locationClient';
import { resetManageMode, useManageModeStore } from '@/store/manageModeStore';

// #346 — vitest runs the WEB target; the step's two builds are selected here per test.
const caps = vi.hoisted(() => ({ drive: false }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return caps.drive;
    },
  };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { machines: unknown[] };

function record(id: string, host: string | null): MachineRecord {
  const parsed = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  return { ...parsed, id, address: host === null ? null : { host, port: 2222 } };
}

const ONLINE = record('m-online', '192.168.10.43');
const OFFLINE = record('m-offline', '192.168.10.44');
const PROFILE = record('m-profile', null);

function draw(over: Partial<Parameters<typeof MachineStep>[0]> = {}): {
  onSelect: ReturnType<typeof vi.fn>;
  onChangeBed: ReturnType<typeof vi.fn>;
} {
  const onSelect = vi.fn();
  const onChangeBed = vi.fn();
  render(
    <MachineStep
      machines={[ONLINE, OFFLINE, PROFILE]}
      busy={false}
      outcome="not-found"
      route={null}
      machine={null}
      reason={null}
      onCheck={() => undefined}
      selectedMachineId={ONLINE.id}
      lastMachineId={OFFLINE.id}
      onSelectMachine={onSelect}
      onChangeBed={onChangeBed}
      {...over}
    />,
  );
  return { onSelect, onChangeBed };
}

beforeEach(() => {
  cleanup();
  caps.drive = false;
  resetManageMode();
});
afterEach(() => cleanup());

describe('#1106 the machine step is a picker', () => {
  it('lists every record, last used first, and the selected one is pressed', () => {
    draw();
    const list = screen.getByTestId('start-wizard-machine-list');
    const rows = [...list.querySelectorAll('button[data-testid^="start-wizard-machine-row-"]')];
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      `start-wizard-machine-row-${OFFLINE.id}`,
      `start-wizard-machine-row-${ONLINE.id}`,
      `start-wizard-machine-row-${PROFILE.id}`,
    ]);
    expect(screen.getByTestId(`start-wizard-machine-row-${ONLINE.id}`).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId(`start-wizard-machine-row-${OFFLINE.id}`).getAttribute('aria-pressed')).toBe('false');
  });

  it('a profile-only machine is a full row, with its own sentence', () => {
    draw();
    expect(screen.getByTestId(`start-wizard-machine-row-${PROFILE.id}`).textContent).toContain('profile only');
    // Its bed's mount is on the row (the picture's data), not only its name.
    expect(screen.getByTestId(`start-wizard-machine-row-${PROFILE.id}`).getAttribute('data-mount')).toBeTruthy();
  });

  it('choosing a row selects it, and the bed is changed from here', () => {
    const { onSelect, onChangeBed } = draw();
    fireEvent.click(screen.getByTestId(`start-wizard-machine-row-${OFFLINE.id}`));
    expect(onSelect).toHaveBeenCalledWith(OFFLINE.id);
    fireEvent.click(screen.getByTestId('start-wizard-change-bed'));
    expect(onChangeBed).toHaveBeenCalledTimes(1);
  });

  it('web build: rows say the profile words, never Checking…', () => {
    draw();
    for (const id of [ONLINE.id, OFFLINE.id, PROFILE.id]) {
      const text = screen.getByTestId(`start-wizard-machine-row-${id}`).textContent ?? '';
      expect(text).toContain('profile only — vendor defaults; connect it at Cut');
      expect(text).not.toContain('Checking');
    }
  });

  it('an offline row says so, with the job line under it', () => {
    caps.drive = true;
    draw();
    const text = screen.getByTestId(`start-wizard-machine-row-${OFFLINE.id}`).textContent ?? '';
    expect(text).toContain('Offline — no answer on the network');
    expect(text).toContain('The job can be written, checked and simulated now; the machine is needed at Cut.');
  });

  it('each row draws its bed', () => {
    draw();
    expect(screen.getByTestId(`start-wizard-machine-bed-${ONLINE.id}`).getAttribute('data-mount')).toBe(
      screen.getByTestId(`start-wizard-machine-row-${ONLINE.id}`).getAttribute('data-mount'),
    );
    expect(screen.getByTestId(`start-wizard-machine-bed-${PROFILE.id}`).querySelector('svg')).not.toBeNull();
  });

  it('Add a machine… is the list’s last row and opens Manage › Machines', () => {
    draw();
    const list = screen.getByTestId('start-wizard-machine-list');
    const buttons = [...list.querySelectorAll('button')];
    expect(buttons[buttons.length - 1]!.getAttribute('data-testid')).toBe('start-wizard-add-machine');
    fireEvent.click(screen.getByTestId('start-wizard-add-machine'));
    expect(useManageModeStore.getState().open).toBe(true);
    expect(useManageModeStore.getState().scope).toBe('machines');
  });

  it('the old single-machine header and the another-machine fold are gone', () => {
    draw();
    expect(screen.queryByTestId('start-wizard-machine-name')).toBeNull();
    expect(screen.queryByTestId('start-wizard-machine-address')).toBeNull();
    expect(screen.queryByTestId('start-wizard-machine-another')).toBeNull();
    expect(screen.queryByTestId('start-wizard-address')).toBeNull();
  });
});
