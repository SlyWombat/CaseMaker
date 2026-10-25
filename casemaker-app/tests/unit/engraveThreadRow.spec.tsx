// @vitest-environment jsdom
// The milled-thread row (#445 phase B): the collapsed line's glyph and depth, and the editor that
// states the thread — the ISO 261 size (pitch on screen), the assumed pilot, the axis, the depth.
//
// Rendered DIRECTLY, not through `EngravePanel`: the row is a controlled component, and what is
// worth pinning here is the patch each control sends. The reachability claim — a person CAN add a
// thread from the panel — is `engravePanel.spec.tsx`'s (#445 B3), where the menu entry and the
// list wiring live.
//
// The row is a controlled component: the parent owns the item and hands back the patched version.
// So what is checkable here is the PATCH each control sends, which is the contract the panel's
// `updateThread(id, patch)` relies on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngraveThreadRow } from '@/components/panels/EngraveThreadRow';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { resetEngraveRows } from '@/store/engraveRowStore';
import type { ThreadPatch } from '@/store/engraveJobStore';
import type { EngraveThreadItem } from '@/types/engraveJob';

beforeEach(() => {
  resetEngraveRows();
});

afterEach(() => {
  cleanup();
});

const THREAD: EngraveThreadItem = {
  kind: 'thread',
  id: 'thr-1',
  position: { x: 50, y: 30 },
  enabled: true,
  size: 'M5',
  standard: 'metric',
  classFit: '6H',
  depth: 5,
  through: false,
};

interface RowOptions {
  thread?: Partial<EngraveThreadItem>;
  maxDepth?: number;
  findings?: JobFinding[];
}

/** Render one row; returns the two callbacks so each test can read what the control sent. */
function row({ thread = {}, maxDepth = 20, findings = [] }: RowOptions = {}): {
  onChange: ReturnType<typeof vi.fn>;
  onRemove: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn<(patch: ThreadPatch) => void>();
  const onRemove = vi.fn();
  render(
    <EngraveThreadRow
      thread={{ ...THREAD, ...thread }}
      index={0}
      maxDepth={maxDepth}
      onChange={onChange}
      onRemove={onRemove}
      findings={findings}
    />,
  );
  return { onChange, onRemove };
}

/** Open the row the way a person does: press the chevron on the line. */
function open(): void {
  fireEvent.click(screen.getByTestId('engrave-thread-expand-0'));
}

const finding = (severity: JobFinding['severity'], code: string, message: string): JobFinding => ({
  severity,
  code: code as JobFinding['code'],
  message,
});

describe('EngraveThreadRow — the collapsed line', () => {
  it('shows the kind glyph, the fallback name and the threaded length', () => {
    row();
    expect(screen.getByText('⌗')).toBeTruthy();
    // #662 — the row is NAMED by the engine's operation name, and the type chip says which kind
    // of operation it is — two different statements, each asserted by its own words.
    expect(screen.getByText('Thread M5×0.8')).toBeTruthy();
    expect(screen.getByTestId('engrave-thread-type-0').textContent).toBe('Thread');
    // Three places, trailing zeros dropped — the same `rowSummary` every kind uses.
    expect(screen.getByText('5 mm')).toBeTruthy();
    expect(screen.getByTestId('engrave-thread-row-0')).toBeTruthy();
  });

  it('draws no editor while the row is folded', () => {
    row();
    expect(screen.queryByTestId('engrave-thread-depth-0')).toBeNull();
    expect(screen.queryByTestId('engrave-thread-size-0')).toBeNull();
  });

  it('a named thread reads by its name', () => {
    row({ thread: { name: 'port' } });
    expect(screen.getByText('Thread "port" M5×0.8')).toBeTruthy();
  });
});

describe('EngraveThreadRow — the editor', () => {
  it('states the assumed pilot, derived from the same ISO table the CAM reads', () => {
    row();
    open();
    // M5 × 0.8 → D1 = 5 − 1.0825 × 0.8 = 4.134. The row must not carry its own copy of the number.
    expect(screen.getByText(/⌀4\.134 mm/)).toBeTruthy();
    // "M5 × 0.8" alone also matches the size <option>; the pilot sentence is the unique claim.
    expect(screen.getByText(/ISO 261 basic minor for M5 × 0\.8/)).toBeTruthy();
  });

  it('labels every size with its coarse pitch, so the pitch is on screen', () => {
    row();
    open();
    const select = screen.getByTestId('engrave-thread-size-0') as HTMLSelectElement;
    const options = [...select.options].map((o) => o.textContent);
    expect(options).toEqual(['M2 × 0.4 mm', 'M2.5 × 0.45 mm', 'M3 × 0.5 mm', 'M4 × 0.7 mm', 'M5 × 0.8 mm', 'M6 × 1 mm']);
  });

  it('a size change patches only the size', () => {
    const { onChange } = row();
    open();
    fireEvent.change(screen.getByTestId('engrave-thread-size-0'), { target: { value: 'M6' } });
    expect(onChange).toHaveBeenCalledWith({ size: 'M6' });
  });

  it('a depth change patches only the depth', () => {
    const { onChange } = row();
    open();
    fireEvent.change(screen.getByTestId('engrave-thread-depth-0'), { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith({ depth: 3 });
  });

  it('the depth slider patches the same field', () => {
    const { onChange } = row();
    open();
    fireEvent.change(screen.getByLabelText('Thread 1 depth slider'), { target: { value: '2.5' } });
    expect(onChange).toHaveBeenCalledWith({ depth: 2.5 });
  });

  it('a position change sends the whole axis pair, moved on one axis', () => {
    const { onChange } = row();
    open();
    fireEvent.change(screen.getByTestId('engrave-thread-x-0'), { target: { value: '12' } });
    expect(onChange).toHaveBeenCalledWith({ position: { x: 12, y: 30 } });
    fireEvent.change(screen.getByTestId('engrave-thread-y-0'), { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith({ position: { x: 50, y: 7 } });
  });

  it('through is offered, not hidden — its finding is what refuses it', () => {
    const { onChange } = row();
    open();
    const box = screen.getByTestId('engrave-thread-through-0') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith({ through: true });
  });

  it('the name is optional: typing sends the text, clearing sends undefined', () => {
    const typed = row();
    open();
    fireEvent.change(screen.getByTestId('engrave-thread-name-0'), { target: { value: 'port' } });
    expect(typed.onChange).toHaveBeenCalledWith({ name: 'port' });
    cleanup();

    // The parent is what makes the field show 'port' — this row is controlled — so clearing is a
    // claim about a row that HAS a name, which is the only state in which a person can clear one.
    resetEngraveRows();
    const cleared = row({ thread: { name: 'port' } });
    open();
    fireEvent.change(screen.getByTestId('engrave-thread-name-0'), { target: { value: '' } });
    expect(cleared.onChange).toHaveBeenCalledWith({ name: undefined });
  });

  it('a depth past the stock says so in the max-depth line', () => {
    row({ thread: { depth: 30 }, maxDepth: 20 });
    open();
    const line = screen.getByTestId('engrave-thread-maxdepth-0');
    expect(line.textContent).toContain('Max depth 20 mm');
  });
});

describe('EngraveThreadRow — the shell controls', () => {
  it('a finding puts a ⚠ on the line and its sentence in the body', () => {
    row({ findings: [finding('error', 'thread-pilot-unproven', 'The pilot was not measured.')] });
    expect(screen.getByTestId('engrave-thread-warn-0').getAttribute('aria-label')).toBe('1 error');
    open();
    expect(screen.getByText('The pilot was not measured.')).toBeTruthy();
  });

  it('remove and show/hide work from the folded line', () => {
    const { onChange, onRemove } = row();
    fireEvent.click(screen.getByTestId('engrave-thread-remove-0'));
    expect(onRemove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('engrave-thread-enabled-0'));
    expect(onChange).toHaveBeenCalledWith({ enabled: false });
  });
});
