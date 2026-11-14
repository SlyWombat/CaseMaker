// @vitest-environment jsdom
// #1258 — the tab question's card, in each of its states, against the stated fixture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TabChoiceCard, type TabChoiceCardProps } from '@/components/panels/TabChoiceCard';
import {
  answeredSummary,
  holdingChoiceSuffix,
  insideMarginRow,
  longerStretchRow,
  TAB_QUESTION,
} from '@/components/panels/tabChoiceWords';
import { FIXTURE_NEEDED, TAB_WIDTH_MM } from '../tools/tabChoiceFixture';

afterEach(cleanup);

function props(over: Partial<TabChoiceCardProps> = {}): TabChoiceCardProps {
  return {
    needed: FIXTURE_NEEDED,
    tabWidthMm: TAB_WIDTH_MM,
    mode: 'ask',
    onUse: vi.fn(),
    onCancel: vi.fn(),
    onChoose: vi.fn(),
    onChange: vi.fn(),
    onChangeTabs: vi.fn(),
    ...over,
  };
}

/** The operator's text may carry no code token and no long float (the default-job walk's rule). */
function expectCleanText(text: string): void {
  const CODE = /#\d+|\b(?:cat|inv|bp):|\blbl-|\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:default|refused)\b|\b(?:flat|ball|bull|chamfer|engraver|drill|thread)-\d[\w.]*|\bvise-[a-z-]+/g;
  const FLOAT = /\d+\.\d{4,}/g;
  expect([...text.matchAll(CODE), ...text.matchAll(FLOAT)].map((m) => m[0])).toEqual([]);
}

describe('#1258 — the question', () => {
  it('opens with nothing selected and the primary disabled; the sentence is the ruled one', () => {
    render(<TabChoiceCard {...props()} />);
    expect(screen.getByTestId('tab-choice-heading').textContent).toBe(TAB_QUESTION);
    expect(screen.getByTestId('tab-choice-count').textContent).toBe(
      '3 stretches of this outline need a choice — one answer applies to all of them.',
    );
    expect((screen.getByTestId('tab-choice-use') as HTMLButtonElement).disabled).toBe(true);
    for (const r of screen.getAllByRole('radio')) expect((r as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('Generate is paused until you choose.')).toBeTruthy();
  });

  it('each option states its numbers per stretch as sentences, and its cost', () => {
    render(<TabChoiceCard {...props()} />);
    const one = screen.getByTestId('tab-choice-option-insideMargin').textContent!;
    for (const s of FIXTURE_NEEDED.stretches) expect(one).toContain(insideMarginRow(s));
    expect(one).toContain('Stretch 1: a tab 5 mm from the corner (margin 8 mm) leaves');
    expect(one).toContain('(margin 12.6 mm)'); // each edge's own margin
    expect(one).toContain('A tab inside the margin is cut where the cutter changes direction and its load is highest.');
    const two = screen.getByTestId('tab-choice-option-longerStretch').textContent!;
    for (const s of FIXTURE_NEEDED.stretches) expect(two).toContain(longerStretchRow(s, 80));
    expect(two).toContain('Stretch 1: 92 mm with no tab; the shop’s limit'.replace('’', "'"));
    expect(two).toContain('The stretch has no tab; the part may flex or lift along it.');
    expect(two).not.toMatch(/flute/i);
  });

  it('a picked option looks picked: a filled accent centre, and the others an empty ring', () => {
    render(<TabChoiceCard {...props()} />);
    expect(screen.getByTestId('tab-choice-radio-insideMargin').getAttribute('data-picked')).toBe('false');
    fireEvent.click(screen.getByLabelText(/Put a tab inside the corner margin/));
    const one = screen.getByTestId('tab-choice-radio-insideMargin') as HTMLElement;
    const two = screen.getByTestId('tab-choice-radio-longerStretch') as HTMLElement;
    expect(one.getAttribute('data-picked')).toBe('true');
    expect(two.getAttribute('data-picked')).toBe('false');
    expect(one.style.background).toContain('radial-gradient');
    expect(two.style.background === 'transparent' || two.style.background === '').toBe(true);
    expect(one.style.border).not.toBe(two.style.border);
  });

  it('option 3 tells the truth about where it goes, and each row names its cut-out when there are several', () => {
    const named = {
      ...FIXTURE_NEEDED,
      stretches: FIXTURE_NEEDED.stretches.map((s, i) => ({ ...s, cut: i === 0 ? { id: 'a', name: 'Lid outline' } : { id: 'b', name: 'Base outline' } })),
    };
    render(<TabChoiceCard {...props({ needed: named as never })} />);
    expect(screen.getByTestId('tab-choice-change-tabs').textContent).toContain(
      "Takes you to this cut-out's tab count and width. Generate asks again if the new tabs still leave a stretch too long.",
    );
    expect(screen.getByTestId('tab-choice-option-insideMargin').textContent).toContain('Lid outline — Stretch 1: a tab 5 mm');
    expect(screen.getByTestId('tab-choice-option-longerStretch').textContent).toContain('Base outline — Stretch 2: 86 mm with no tab');
  });

  it('choosing enables the primary and hands the answer back; the drawing follows the option', () => {
    const onUse = vi.fn();
    render(<TabChoiceCard {...props({ onUse })} />);
    expect(screen.getByTestId('tab-choice-drawing').getAttribute('data-focus')).toBe('none');
    fireEvent.click(screen.getByLabelText(/Put a tab inside the corner margin/));
    expect(screen.getByTestId('tab-choice-drawing').getAttribute('data-focus')).toBe('insideMargin');
    expect((screen.getByTestId('tab-choice-use') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText(/Leave the longer stretches/));
    expect(screen.getByTestId('tab-choice-drawing').getAttribute('data-focus')).toBe('longerStretch');
    fireEvent.click(screen.getByTestId('tab-choice-use'));
    expect(onUse).toHaveBeenCalledWith('longerStretch');
  });

  it('"Change the tabs myself" is set apart and is not an answer', () => {
    const onChangeTabs = vi.fn();
    const onUse = vi.fn();
    render(<TabChoiceCard {...props({ onChangeTabs, onUse })} />);
    fireEvent.click(screen.getByTestId('tab-choice-change-tabs'));
    expect(onChangeTabs).toHaveBeenCalledTimes(1);
    expect(onUse).not.toHaveBeenCalled();
    expect((screen.getByTestId('tab-choice-use') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a stale answer says so in one line', () => {
    render(<TabChoiceCard {...props({ stale: true })} />);
    expect(screen.getByTestId('tab-choice-count').textContent).toContain('The outline changed since you chose; choose again.');
  });

  it('option 1 is not offered when no stretch has a place for a tab, and says why', () => {
    const none = { ...FIXTURE_NEEDED, stretches: FIXTURE_NEEDED.stretches.map((s) => ({ ...s, candidates: [], leavesSpansMm: [s.spanMm], stillOverLimit: false })) };
    render(<TabChoiceCard {...props({ needed: none })} />);
    expect(screen.queryByTestId('tab-choice-option-insideMargin')).toBeNull();
    expect(screen.getByTestId('tab-choice-no-place').textContent).toContain('Option 1 is not offered.');
  });

  it('a mixed case: the stretch with no place reads "no place for a tab — stays N mm"', () => {
    const mixed = {
      ...FIXTURE_NEEDED,
      stretches: FIXTURE_NEEDED.stretches.map((s, i) => (i === 1 ? { ...s, candidates: [], leavesSpansMm: [s.spanMm], stillOverLimit: false } : s)),
    };
    render(<TabChoiceCard {...props({ needed: mixed })} />);
    const one = screen.getByTestId('tab-choice-option-insideMargin').textContent!;
    expect(one).toContain('Stretch 2: no place for a tab — stays 86 mm.');
    expect(one).toContain('Stretch 1: a tab 5 mm from the corner');
  });

  it('several tabs in one stretch read as one sentence with the lengths the engine leaves', () => {
    const s0 = FIXTURE_NEEDED.stretches[0]!;
    const many = {
      ...FIXTURE_NEEDED,
      stretches: [{ ...s0, candidates: [s0.candidates[0]!, { ...s0.candidates[0]!, fromCornerMm: 30, marginMm: 12 }], leavesSpansMm: [30, 20, 25], stillOverLimit: false }],
    };
    expect(insideMarginRow(many.stretches[0]!)).toBe(
      'Stretch 1: 2 tabs, 5 and 30 mm from their corners (margins 8 and 12 mm), leave 30 mm, 20 mm and 25 mm.',
    );
    expect(holdingChoiceSuffix('insideMargin', many)).toBe('2 by your choice');
    const over = { ...s0, stillOverLimit: true, leavesSpansMm: [90, 2] };
    expect(insideMarginRow(over)).toContain('A stretch of 90 mm is still past the limit.');
  });

  it('one stretch says "1 stretch", with no "applies to all"', () => {
    const one = { ...FIXTURE_NEEDED, stretches: [FIXTURE_NEEDED.stretches[0]!] };
    render(<TabChoiceCard {...props({ needed: one })} />);
    expect(screen.getByTestId('tab-choice-count').textContent).toBe('1 stretch of this outline needs a choice.');
  });

  it('the phone puts Use this choice above Cancel; the desktop puts Cancel first', () => {
    const order = (): string[] =>
      [...screen.getByTestId('tab-choice-card').querySelectorAll('footer button')].map((b) => b.textContent!);
    render(<TabChoiceCard {...props({ phone: true })} />);
    expect(order()).toEqual(['Use this choice', 'Cancel']);
    cleanup();
    render(<TabChoiceCard {...props()} />);
    expect(order()).toEqual(['Cancel', 'Use this choice']);
  });

  it('Cancel is the caller’s: the card does not hide itself', () => {
    const onCancel = vi.fn();
    render(<TabChoiceCard {...props({ onCancel })} />);
    fireEvent.click(screen.getByTestId('tab-choice-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('tab-choice-card')).toBeTruthy();
  });

  it('the options are a radio group a keyboard reaches, and the card announces itself', () => {
    render(<TabChoiceCard {...props()} />);
    expect(screen.getByRole('radiogroup', { name: 'How to hold the part' })).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByTestId('tab-choice-card').getAttribute('aria-live')).toBe('assertive');
    expect(document.activeElement).toBe(screen.getByTestId('tab-choice-heading'));
  });

  it('no operator sentence carries a code token or a long float', () => {
    render(<TabChoiceCard {...props()} />);
    expectCleanText(screen.getByTestId('tab-choice-card').textContent!);
  });
});

describe('#1258 — the bar, the summary, the sheet', () => {
  it('after Cancel the card is a one-line amber bar with Choose…', () => {
    const onChoose = vi.fn();
    render(<TabChoiceCard {...props({ mode: 'collapsed', onChoose })} />);
    expect(screen.getByTestId('tab-choice-bar').textContent).toContain('Action needed: choose how this part is held');
    fireEvent.click(screen.getByTestId('tab-choice-choose'));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it('the answered summary names the choice and its numbers, with Change…', () => {
    const onChange = vi.fn();
    render(<TabChoiceCard {...props({ mode: 'answered', answer: 'longerStretch', onChange })} />);
    const t = screen.getByTestId('tab-choice-answered').textContent!;
    expect(t).toContain('Holding: 3 stretches left longer than the shop’s 80 mm.'.replace('’', "'"));
    expect(t).toContain('92 mm, 86 mm and 84 mm have no tab');
    fireEvent.click(screen.getByTestId('tab-choice-change'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('the summaries and the Holding row carry the engine’s numbers', () => {
    const inside = answeredSummary('insideMargin', FIXTURE_NEEDED);
    expect(inside.headline).toBe('Holding: 3 tabs inside the corner margin.');
    expect(inside.detail).toContain('5, 6, 4 mm from a corner');
    expect(holdingChoiceSuffix('insideMargin', FIXTURE_NEEDED)).toBe('3 by your choice');
    expect(holdingChoiceSuffix('longerStretch', FIXTURE_NEEDED)).toBe('3 stretches by your choice');
    const one = { ...FIXTURE_NEEDED, stretches: [FIXTURE_NEEDED.stretches[0]!] };
    expect(holdingChoiceSuffix('longerStretch', one)).toBe('92 mm stretch by your choice');
    for (const t of [inside.headline, inside.detail]) expectCleanText(t);
  });
});
