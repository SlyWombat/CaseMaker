// @vitest-environment jsdom
// The stacking-toolbox panel (#155). Geometry and numbers live in
// `toolbox.spec.ts`; this proves the panel renders for both states, that the
// height ladder is a convenience over a free number rather than a cage, and
// that every control reaches the project through `patchCase` — the store
// action that validates a TOP-LEVEL partial, so an update that sent a nested
// fragment would be silently dropped rather than fail.

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToolboxPanel } from '@/components/panels/ToolboxPanel';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { defaultToolboxParams, TOOLBOX_HEIGHT_LADDER, type ToolboxParams } from '@/types';

function seed(toolbox: ToolboxParams | undefined): void {
  const project = createDefaultProject('rpi-4b');
  useProjectStore.setState({ project: { ...project, case: { ...project.case, toolbox } } });
}

const current = (): ToolboxParams | undefined => useProjectStore.getState().project?.case.toolbox;

afterEach(cleanup);

describe('ToolboxPanel (#155)', () => {
  it('offers to enable the archetype when it is not running', () => {
    seed(undefined);
    render(<ToolboxPanel />);
    expect(screen.getByTestId('toolbox-panel-disabled')).toBeTruthy();
    expect(screen.queryByTestId('toolbox-panel')).toBeNull();

    fireEvent.click(screen.getByTestId('toolbox-enable'));
    expect(current()?.enabled).toBe(true);
    expect(current()?.width).toBe(300);
  });

  it('renders the whole editor once enabled, with no problem reported', () => {
    seed(defaultToolboxParams());
    render(<ToolboxPanel />);
    expect(screen.getByTestId('toolbox-panel')).toBeTruthy();
    expect(screen.getByTestId('toolbox-width')).toBeTruthy();
    expect(screen.getByTestId('toolbox-depth')).toBeTruthy();
    expect(screen.getByTestId('toolbox-grid')).toBeTruthy();
    expect(screen.getByTestId('toolbox-summary')).toBeTruthy();
    expect(screen.queryByTestId('toolbox-problem')).toBeNull();
  });

  it('writes the footprint through to the project', () => {
    seed(defaultToolboxParams());
    render(<ToolboxPanel />);
    fireEvent.change(screen.getByTestId('toolbox-width'), { target: { value: '260' } });
    expect(current()?.width).toBe(260);
    // ...and leaves every sibling field alone: the update is a complete object.
    expect(current()?.depth).toBe(200);
    expect(current()?.height).toBe(110);
    expect(current()?.grid).toBe(true);
  });

  it('treats the height ladder as presets over a free number, not a cage', () => {
    seed(defaultToolboxParams());
    render(<ToolboxPanel />);

    for (const h of TOOLBOX_HEIGHT_LADDER) {
      expect(screen.getByTestId(`toolbox-height-${h}`)).toBeTruthy();
    }

    // A ladder rung sets the height...
    const rung = TOOLBOX_HEIGHT_LADDER[2]!;
    fireEvent.click(screen.getByTestId(`toolbox-height-${rung}`));
    expect(current()?.height).toBe(rung);

    // ...and a height BETWEEN rungs is just as valid, which is the point.
    const offLadder = rung + 17;
    fireEvent.change(screen.getByTestId('toolbox-height'), { target: { value: String(offLadder) } });
    expect(current()?.height).toBe(offLadder);
    expect(screen.getByTestId(`toolbox-height-${rung}`).getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('toolbox-problem')).toBeNull();
  });

  it('toggles the floor grid and says what it did', () => {
    seed(defaultToolboxParams());
    render(<ToolboxPanel />);
    expect(screen.getByTestId('toolbox-summary').textContent).toMatch(/holes/);

    fireEvent.click(screen.getByTestId('toolbox-grid'));
    expect(current()?.grid).toBe(false);
    expect(screen.getByTestId('toolbox-summary').textContent).toMatch(/No floor grid/);
  });

  it('reports a reason, not a blank viewport, when a dimension cannot work', () => {
    seed({ ...defaultToolboxParams(), height: 4 });
    render(<ToolboxPanel />);
    const problem = screen.getByTestId('toolbox-problem');
    expect(problem.textContent).toMatch(/too short/);
    // The summary would be a lie here — there is no module to describe.
    expect(screen.queryByTestId('toolbox-summary')).toBeNull();
  });
});
