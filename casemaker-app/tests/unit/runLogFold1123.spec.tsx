// @vitest-environment jsdom
/**
 * #1123 item 4 — THE LOG FOLD beside the progress line: closed by default, every tick inside with
 * its time and duration.
 *
 * The maintainer's bench note: "there should be a log file, or a window with what is being done
 * for long running jobs". The fold is that window; this spec renders it alone (the panel's own
 * run store has its own tests) and pins what the operator sees.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { RunLogFold } from '@/components/panels/RunLogFold';

afterEach(cleanup);

const LOG = [
  { at: 1_000_000, ms: 0, label: 'starting the worker' },
  { at: 1_004_500, ms: 4_500, label: 'planning: rest — setup 1, 10 %' },
];

describe('#1123 item 4 — the log fold', () => {
  it('draws nothing before a run has a log', () => {
    const { container } = render(<RunLogFold log={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('is a closed fold whose summary counts the ticks; opening it shows clock, duration and words', () => {
    render(<RunLogFold log={LOG} />);
    const fold = screen.getByTestId('engrave-run-log');
    expect(fold.hasAttribute('open')).toBe(false);
    const summary = fold.querySelector('summary')!;
    expect(summary.textContent).toContain('Log');
    expect(summary.textContent).toContain('2');
    fireEvent.click(summary);
    expect(fold.hasAttribute('open')).toBe(true);
    const lines = screen.getAllByTestId('engrave-run-log-line');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain('starting the worker');
    expect(lines[1]!.textContent).toContain('+4.5 s');
    expect(lines[1]!.textContent).toContain('planning: rest — setup 1');
  });
});
