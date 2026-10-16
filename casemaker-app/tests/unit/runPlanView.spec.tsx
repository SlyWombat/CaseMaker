// @vitest-environment jsdom
// #421 — the plan view and the machine strip, drawn from the plan engine: every phase with its time
// and source, last run beside it; a switch per feature with its reason; the unproven light not drawn.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Z1 } from '@/engine/cnc/machine';
import { formatDuration, planRun } from '@/engine/cnc/plan';
import { MachineStrip } from '@/components/panels/MachineStrip';
import { RunPlanView } from '@/components/panels/RunPlanView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const plan = planRun({
  setups: [{ index: 1, mountStep: false, faced: false, registration: null }],
  programs: [{ id: 't1', setupIndex: 1, label: 'T1 ⌀2 flat', hash: 'abc', estimatedSeconds: 125 }],
  machine: Z1,
  mount: 'vise',
  stock: { flatness: 'domed' },
  shallowestCutMm: 0.2,
  finishedHashes: [],
  defaults: null,
  lastRun: { at: '2026-10-15T17:00:00Z', seconds: { 's1.p1.cut': 140 } },
});

describe('#421 the plan view', () => {
  it('lists every phase with its time, its source, and last run beside it', () => {
    render(<RunPlanView plan={plan} />);
    for (const p of plan.phases) expect(screen.getByTestId(`run-plan-phase-${p.id}`)).toBeTruthy();
    expect(screen.getByTestId('run-plan-phase-s1.p1.cut-time').textContent).toBe('2 min 15 s');
    expect(screen.getByTestId('run-plan-phase-s1.p1.cut-last').textContent).toContain('2 min 20 s');
    expect(screen.getByTestId('run-plan-phase-home').textContent).toContain('fallback');
    expect(screen.getByTestId('run-plan-total').textContent).toContain('Total');
    expect(screen.getByTestId('run-plan-findings').textContent).toContain('fallback');
    const table = screen.getByRole('table');
    expect(table.querySelector('caption')?.textContent).toContain('phase by phase');
    expect([...table.querySelectorAll('th')].every((th) => th.getAttribute('scope') === 'col')).toBe(true);
  });

  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(180)).toBe('3 min');
    expect(formatDuration(3900)).toBe('1 h 05 min');
    expect(formatDuration(59.6)).toBe('1 min');
    expect(formatDuration(3599.6)).toBe('1 h 00 min');
    // Rounding the minutes after the split read 7199 s as "1 h 60 min".
    expect(formatDuration(7199)).toBe('2 h 00 min');
    expect(formatDuration(7169)).toBe('1 h 59 min');
  });
});

describe('#421 the machine strip', () => {
  it('draws vacuum, air run and a locked auto-level, each with its reason; not the unproven light', () => {
    const toggle = vi.fn();
    render(<MachineStrip features={plan.features} onToggle={toggle} />);
    expect(screen.getByTestId('machine-strip-vacuum-reason').textContent).toContain('every cut');
    expect((screen.getByTestId('machine-strip-vacuum-switch') as HTMLInputElement).disabled).toBe(true);
    for (const k of ['vacuum', 'air-run', 'auto-level']) {
      const box = screen.getByTestId(`machine-strip-${k}-switch`);
      const id = box.getAttribute('aria-describedby')!;
      expect(document.getElementById(id)).toBe(screen.getByTestId(`machine-strip-${k}-reason`));
    }
    expect(screen.queryByTestId('machine-strip-light')).toBeNull();
    const auto = screen.getByTestId('machine-strip-auto-level-switch') as HTMLInputElement;
    expect(auto.disabled).toBe(true);
    expect(screen.getByTestId('machine-strip-auto-level').textContent).toContain('locked');
    fireEvent.click(screen.getByTestId('machine-strip-air-run-switch'));
    expect(toggle).toHaveBeenCalledWith('air-run', false);
  });
});
