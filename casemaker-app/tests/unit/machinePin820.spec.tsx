// @vitest-environment jsdom
// #820 — THE RAIL'S MACHINE ROW IS AN ACTION. On k3's web build the maintainer pressed
// "Machine · No machine yet" wanting to connect the Z1 and nothing happened; the only way in was
// the small Manage › Machines link at the foot of the viewport. The row now opens Manage ›
// Machines, and with no machine it says what pressing it does.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { MachinePin } from '@/components/layout/MachinePin';
import { useManageModeStore } from '@/store/manageModeStore';
import { resetMachineStore } from '@/store/machineStore';

describe('#820 the rail machine row opens Manage › Machines', () => {
  beforeEach(() => {
    useManageModeStore.getState().closeManage();
    resetMachineStore();
  });
  afterEach(cleanup);

  it('states the action with no machine, and opens the machines scope', () => {
    render(<MachinePin />);
    expect(screen.getByTestId('machine-pin-status').textContent).toContain('No machine yet · Add');
    fireEvent.click(screen.getByTestId('machine-pin-open'));
    expect(useManageModeStore.getState().open).toBe(true);
    expect(useManageModeStore.getState().scope).toBe('machines');
  });

  it('names the machine it opens when one is known', () => {
    useManageModeStore.setState({ open: false });
    render(<MachinePin />);
    const button = screen.getByTestId('machine-pin-open');
    expect(button.getAttribute('aria-label')).toContain('Manage › Machines');
  });
});
