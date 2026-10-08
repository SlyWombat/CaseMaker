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
import {
  defaultToolboxParams,
  TOOLBOX_HEIGHT_LADDER,
  TOOLBOX_PEG_THICKNESS,
  type ToolboxParams,
} from '@/types';
import { toolboxPegHeadroom } from '@/engine/compiler/toolbox';

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
    // The count and shape are stated, not just the fact that there is a grid —
    // 23 × 15 on the default floor is the centred lattice's answer for a
    // 300 mm width, and a drift in either the anchor or the pitch shows here.
    expect(screen.getByTestId('toolbox-summary').textContent).toMatch(/23 × 15 sockets \(345\)/);

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

  // Dividers (#150). The panel is the only place these are created, so this is
  // where the id minting, the fit defaults and the write-through are pinned.
  describe('dividers', () => {
    it('offers no divider to add until the floor grid is on', () => {
      seed({ ...defaultToolboxParams(), grid: false });
      render(<ToolboxPanel />);

      const add = screen.getByTestId('toolbox-add-peg') as HTMLButtonElement;
      expect(add.disabled).toBe(true);
      expect(screen.getByText(/Turn the floor grid on/)).toBeTruthy();

      fireEvent.click(add);
      expect(current()?.pegs ?? []).toHaveLength(0);
    });

    it('adds a divider sized to the bin, and a change writes the whole object', () => {
      const params = defaultToolboxParams();
      seed(params);
      render(<ToolboxPanel />);

      fireEvent.click(screen.getByTestId('toolbox-add-peg'));
      const added = current()!.pegs!;
      expect(added).toHaveLength(1);
      expect(added[0]!.id).toBe('1');
      expect(added[0]!.enabled).toBe(true);
      // The defaults are the bin's, not the component's: the height is what the
      // cavity actually holds under the seating ledge, and the wall is the
      // divider default rather than a number typed into the panel.
      expect(added[0]!.height).toBeGreaterThan(0);
      expect(added[0]!.height).toBeLessThanOrEqual(toolboxPegHeadroom(params));
      expect(added[0]!.thickness).toBe(TOOLBOX_PEG_THICKNESS);
      expect(screen.getByTestId('toolbox-summary').textContent).toMatch(/Dividers: 1 of 1 on/);

      // Editing one field must not drop its siblings: `patchCase` validates a
      // TOP-LEVEL partial only, so a nested fragment would be silently
      // discarded rather than fail. Ask the store for everything else.
      fireEvent.change(screen.getByTestId('toolbox-peg-spans-1'), { target: { value: '5' } });
      fireEvent.change(screen.getByTestId('toolbox-peg-axis-1'), { target: { value: 'y' } });
      const edited = current()!;
      expect(edited.pegs![0]!.spans).toBe(5);
      expect(edited.pegs![0]!.axis).toBe('y');
      expect(edited.pegs![0]!.height).toBe(added[0]!.height);
      expect(edited.width).toBe(300);
      expect(edited.grid).toBe(true);
    });

    it('takes a divider back out, and reuses the freed id', () => {
      seed(defaultToolboxParams());
      render(<ToolboxPanel />);

      fireEvent.click(screen.getByTestId('toolbox-add-peg'));
      fireEvent.click(screen.getByTestId('toolbox-add-peg'));
      expect(current()!.pegs!.map((p) => p.id)).toEqual(['1', '2']);

      fireEvent.click(screen.getByTestId('toolbox-peg-remove-1'));
      expect(current()!.pegs!.map((p) => p.id)).toEqual(['2']);

      // The lowest free number, so a removed divider's id comes back rather
      // than a counter climbing forever.
      fireEvent.click(screen.getByTestId('toolbox-add-peg'));
      expect(current()!.pegs!.map((p) => p.id)).toEqual(['2', '1']);
    });

    it('says why a divider will not build, in the same words the compiler uses', () => {
      const params = defaultToolboxParams();
      seed({ ...params, pegs: [{ id: '1', spans: 3, height: 400, thickness: 2.4, axis: 'x', enabled: true }] });
      render(<ToolboxPanel />);

      const problem = screen.getByTestId('toolbox-peg-problem');
      expect(problem.textContent).toMatch(/Divider 1/);
      expect(problem.textContent).toMatch(/seating ledge/);
      expect(problem.textContent).toContain(String(Math.round(toolboxPegHeadroom(params))));
    });

    it('collapses the bin-wide reason to one line, however many dividers there are', () => {
      seed({
        ...defaultToolboxParams(),
        grid: false,
        pegs: [
          { id: '1', spans: 3, height: 90, thickness: 2.4, axis: 'x', enabled: true },
          { id: '2', spans: 3, height: 90, thickness: 2.4, axis: 'y', enabled: true },
        ],
      });
      render(<ToolboxPanel />);

      // "the grid is off" is one fact about the bin, not one per divider.
      const problems = screen.getAllByTestId('toolbox-peg-problem');
      expect(problems).toHaveLength(1);
      expect(problems[0]!.textContent).toMatch(/floor grid is off/);
    });
  });
});
