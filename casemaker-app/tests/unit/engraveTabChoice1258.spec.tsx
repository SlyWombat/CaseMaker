// @vitest-environment jsdom
// #1258 — the tab question at the point Generate stopped: reads the run's result, writes the job's
// answer, and generates again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { EngraveTabChoice } from '@/components/panels/EngraveTabChoice';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { useTabChoiceStore } from '@/store/tabChoiceStore';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import { FIXTURE_NEEDED } from '../tools/tabChoiceFixture';

const asking = (stale = false): EngraveGenerated =>
  ({ ok: false, stage: 'cam', tabChoiceNeeded: FIXTURE_NEEDED, ...(stale ? { tabChoiceStale: true } : {}) }) as unknown as EngraveGenerated;
const done = (): EngraveGenerated => ({ ok: true, stage: 'done' }) as unknown as EngraveGenerated;

beforeEach(() => {
  useEngraveJobStore.setState({ job: defaultEngraveJob() });
  useEngraveRunStore.setState({ generated: null });
  useTabChoiceStore.getState().reset();
});
afterEach(cleanup);

describe('#1258 — the question where Generate stopped', () => {
  it('nothing is drawn while nothing is asked', () => {
    render(<EngraveTabChoice onGenerate={vi.fn()} />);
    expect(screen.queryByTestId('tab-choice-card')).toBeNull();
    expect(screen.queryByTestId('tab-choice-bar')).toBeNull();
  });

  it('a result that asks draws the card; using a choice writes the job’s answer with the fingerprint and generates again', () => {
    const onGenerate = vi.fn();
    useEngraveRunStore.setState({ generated: asking() });
    render(<EngraveTabChoice onGenerate={onGenerate} />);
    fireEvent.click(screen.getByLabelText(/Leave the longer stretches/));
    fireEvent.click(screen.getByTestId('tab-choice-use'));
    expect(useEngraveJobStore.getState().job.tabChoice).toEqual({ choice: 'longerStretch', answeredFor: 'fixture-1258' });
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it('Cancel collapses it to the bar and Choose… brings it back; the question is never dropped', () => {
    useEngraveRunStore.setState({ generated: asking() });
    render(<EngraveTabChoice onGenerate={vi.fn()} />);
    fireEvent.click(screen.getByTestId('tab-choice-cancel'));
    expect(screen.getByTestId('tab-choice-bar')).toBeTruthy();
    expect(useEngraveJobStore.getState().job.tabChoice).toBeUndefined();
    fireEvent.click(screen.getByTestId('tab-choice-choose'));
    expect(screen.getByTestId('tab-choice-card')).toBeTruthy();
  });

  it('once answered and generated, the same place carries the summary; Change… reopens the question', () => {
    useEngraveRunStore.setState({ generated: asking() });
    render(<EngraveTabChoice onGenerate={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/Put a tab inside the corner margin/));
    fireEvent.click(screen.getByTestId('tab-choice-use'));
    // The next generate succeeds: no question comes back, the answer stands on the job.
    act(() => useEngraveRunStore.setState({ generated: done() }));
    expect(screen.getByTestId('tab-choice-answered').textContent).toContain('Holding: 3 tabs inside the corner margin.');
    fireEvent.click(screen.getByTestId('tab-choice-change'));
    expect(screen.getByTestId('tab-choice-card')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Leave the longer stretches/));
    fireEvent.click(screen.getByTestId('tab-choice-use'));
    expect(useEngraveJobStore.getState().job.tabChoice?.choice).toBe('longerStretch');
  });

  it('a stale answer asks again with the one-line reason', () => {
    useEngraveJobStore.getState().setTabChoice({ choice: 'longerStretch', answeredFor: 'old' });
    useEngraveRunStore.setState({ generated: asking(true) });
    render(<EngraveTabChoice onGenerate={vi.fn()} />);
    expect(screen.getByTestId('tab-choice-count').textContent).toContain('The outline changed since you chose; choose again.');
  });

  it('the job’s answer round-trips: set, then cleared, leaves the job as it was', () => {
    const before = useEngraveJobStore.getState().job;
    useEngraveJobStore.getState().setTabChoice({ choice: 'insideMargin', answeredFor: 'x' });
    expect(useEngraveJobStore.getState().job.tabChoice).toEqual({ choice: 'insideMargin', answeredFor: 'x' });
    useEngraveJobStore.getState().setTabChoice(null);
    expect(useEngraveJobStore.getState().job).toEqual(before);
  });
});
