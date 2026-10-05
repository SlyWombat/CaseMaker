// @vitest-environment jsdom
// #245 — the read-only G-code pane. It is presentational over `simStore`'s path + step; the tests
// drive the store directly and assert the pane follows it, that a diagnostic jump is honoured, and
// that nothing in the pane can edit the program.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { GcodePane } from '@/components/panels/GcodePane';
import { useSimStore } from '@/store/simStore';
import type { SimPath } from '@/workers/sim/session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROGRAM = 'G0 X0 Y0\nG1 Z-1 F100\nG1 X10\n';

/** Three vertices at steps 0, 1, 2, on source lines 2, 3 and 4. */
const PATH: SimPath = {
  xyz: new Float32Array([0, 0, 0, 1, 1, -1, 2, 2, -2]),
  step: new Uint32Array([0, 1, 2]),
  kind: new Uint8Array([1, 1, 1]),
  t: new Float32Array([0, 1, 2]),
  line: new Uint32Array([2, 3, 4]),
};

beforeEach(() => {
  useSimStore.setState({ path: PATH, step: 0 });
});
afterEach(() => {
  cleanup();
  useSimStore.setState({ path: null, step: -1 });
});

describe('GcodePane', () => {
  it('renders the program text with line numbers and no editable control', () => {
    render(<GcodePane text={PROGRAM} />);
    const pane = screen.getByTestId('sim-gcode-pane');
    expect(screen.getByTestId('sim-gcode-text').textContent).toContain('2 | G1 Z-1 F100');
    // Read-only by construction: no field, no textarea, nothing contenteditable.
    expect(pane.querySelector('input, textarea, select, [contenteditable="true"]')).toBeNull();
    expect(pane.getAttribute('data-readonly')).toBe('true');
  });

  it('highlights the line the transport is on, and follows it as the step moves', () => {
    render(<GcodePane text={PROGRAM} />);
    expect(screen.getByTestId('sim-gcode-current').getAttribute('data-line')).toBe('2');

    act(() => useSimStore.setState({ step: 2 }));
    expect(screen.getByTestId('sim-gcode-current').getAttribute('data-line')).toBe('4');
  });

  it('has no current-line highlight before a program is loaded', () => {
    act(() => useSimStore.setState({ path: null, step: -1 }));
    render(<GcodePane text={PROGRAM} />);
    expect(screen.queryByTestId('sim-gcode-current')).toBeNull();
  });

  it('reveals and marks a diagnostic’s line', () => {
    render(<GcodePane text={PROGRAM} jumpLine={3} jumpSeq={1} />);
    expect(screen.getByTestId('sim-gcode-jump').getAttribute('data-line')).toBe('3');
  });

  it('ignores a line outside the program', () => {
    render(<GcodePane text={PROGRAM} jumpLine={99} jumpSeq={1} />);
    expect(screen.queryByTestId('sim-gcode-jump')).toBeNull();
  });
});
