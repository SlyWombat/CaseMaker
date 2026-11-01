// @vitest-environment jsdom
// #261 slice 2 — THE RACK PANEL'S FAMILY SWITCH.
//
// The printed-shelf rack and the 10″ U-mount rack are different products sharing one archetype,
// so the panel makes the family explicit: each mode shows ONLY its own controls, and switching
// keeps the other mode's values in the document. The geometry is covered by the engine specs; this
// proves the controls write what they say.
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { RackPanel } from '@/components/panels/RackPanel';
import { createDefaultProject, useProjectStore } from '@/store/projectStore';
import type { Project } from '@/types';

function rackProject(): Project {
  const project = createDefaultProject('rpi-4b');
  return {
    ...project,
    case: {
      ...project.case,
      rack: { enabled: true, width: 252, depth: 250, slots: 16, wallMount: 'none', accessories: [] },
    },
  };
}

function seed(project: Project): void {
  useProjectStore.setState({ project });
}

afterEach(() => cleanup());

describe('#261 slice 2 the panel’s family switch', () => {
  it('offers both families, and the printed-shelf controls stay under the printed mode', () => {
    seed(rackProject());
    render(<RackPanel />);
    expect(screen.getByTestId('rack-mode-printed')).toBeTruthy();
    expect(screen.getByTestId('rack-mode-umount')).toBeTruthy();
    // Printed-shelf mode shows its own width/slot controls, not the U ones.
    expect(screen.getByTestId('rack-panel')).toBeTruthy();
    expect(screen.queryByTestId('rack-u')).toBeNull();
  });

  it('choosing the U-mount family writes the mode and shows only the standard’s controls', () => {
    seed(rackProject());
    render(<RackPanel />);
    fireEvent.click(screen.getByTestId('rack-mode-umount'));
    expect(useProjectStore.getState().project?.case.rack?.mode).toBe('u-mount');
    // The panel re-renders in u-mount mode: units and depth, and no accessory editor.
    expect(screen.getByTestId('rack-panel-umount')).toBeTruthy();
    expect(screen.getByTestId('rack-u')).toBeTruthy();
    expect(screen.getByTestId('rack-depth-umount')).toBeTruthy();
    expect(screen.queryByTestId('rack-panel')).toBeNull();
  });

  it('the unit control writes 1–12 and clamps', () => {
    seed({ ...rackProject(), case: { ...rackProject().case, rack: { ...rackProject().case.rack!, mode: 'u-mount' } } });
    render(<RackPanel />);
    const input = screen.getByTestId('rack-u') as HTMLInputElement;
    expect(input.value).toBe('6');
    fireEvent.change(input, { target: { value: '9' } });
    expect(useProjectStore.getState().project?.case.rack?.u).toBe(9);
    fireEvent.change(input, { target: { value: '20' } });
    expect(useProjectStore.getState().project?.case.rack?.u).toBe(12);
  });
});
