// @vitest-environment jsdom
// #345 — the house depth margins, and which edit counts as the user choosing them.
//
// The bug this pins (the #345 review's item 4): `commitMargin` stamped `source: 'user'` on ANY of
// the five rows. That source is what stops `effectiveMargins` reading the blank's own layer height,
// so typing a MINIMUM FLOOR — a seed for new jobs, which has nothing to do with the boundary margin
// — would silently freeze every later blank at the house 0.2, and a blank printed at 0.3 mm layers
// would lose the 0.3 it is entitled to without anyone being told. Only the two margins a job COPIES
// may flip it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { SettingsMenu } from '@/components/layout/SettingsMenu';
import { useSettingsStore } from '@/store/settingsStore';

/** Type a value into one margin box and commit it the way the row does: on blur. */
function commit(id: string, value: string): void {
  const box = screen.getByTestId(id) as HTMLInputElement;
  fireEvent.change(box, { target: { value } });
  fireEvent.blur(box);
}

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
});

afterEach(cleanup);

describe('the house depth margins (#345)', () => {
  it('commits a margin the user typed, and marks the number as theirs', () => {
    render(<SettingsMenu onClose={() => {}} />);
    commit('settings-margin-boundary', '0.4');
    expect(useSettingsStore.getState().margins).toMatchObject({
      boundaryMargin: 0.4,
      source: 'user',
    });
  });

  it('a box tabbed through UNCHANGED commits nothing (#345 review)', () => {
    render(<SettingsMenu onClose={() => {}} />);
    // The shipped 0.2 is already in the box. Focusing and blurring it — a tab-through — used to call
    // `commitMargin({ boundaryMargin: 0.2 })` because the draft was a valid number, changed or not,
    // which flipped `source` to `'user'` and stopped `effectiveMargins` reading each blank's own
    // layer height: the SAME failure as item 4's, reachable without typing a character.
    const box = screen.getByTestId('settings-margin-boundary') as HTMLInputElement;
    expect(box.value).toBe('0.2');
    fireEvent.focus(box);
    fireEvent.blur(box);
    expect(useSettingsStore.getState().margins.source).toBe('default');

    // A re-typed spelling of the same number is not a change either: the field is a number, so
    // 0.20 IS 0.2 and the source must not be claimed for it.
    fireEvent.change(box, { target: { value: '0.20' } });
    fireEvent.blur(box);
    expect(useSettingsStore.getState().margins.source).toBe('default');
  });

  it('a seed edited on its own does not claim the boundary margin as the user’s (#345 review)', () => {
    render(<SettingsMenu onClose={() => {}} />);
    commit('settings-margin-floor', '2');

    // The seed moved…
    expect(useSettingsStore.getState().margins.minFloor).toBe(2);
    // …and the boundary margin is still the SHIPPED default, so `effectiveMargins` keeps reading
    // each blank's own layer height off it.
    expect(useSettingsStore.getState().margins.source).toBe('default');
  });

  it('the other three seeds are the same: edge margin, breakthrough and jaw clearance leave the source alone', () => {
    render(<SettingsMenu onClose={() => {}} />);
    commit('settings-margin-edge', '3');
    commit('settings-margin-breakthrough', '0.5');
    // #362/#363 — the jaw clearance is the case most tempting to get wrong: it is a depth-related
    // number sitting between the two margins that DO flip the source, but a job copies it as its OWN
    // `jawClearance` and the check reads that off the document (#362), so it never enters
    // `effectiveMargins`. Setting it has said nothing about the boundary margin.
    commit('settings-margin-jaw', '1.5');
    const margins = useSettingsStore.getState().margins;
    expect(margins).toMatchObject({ edgeMargin: 3, breakthrough: 0.5, jawClearance: 1.5, source: 'default' });
  });

  it('a Z tolerance is one of the two copied margins, so it DOES flip the source', () => {
    render(<SettingsMenu onClose={() => {}} />);
    commit('settings-margin-z', '0.12');
    expect(useSettingsStore.getState().margins).toMatchObject({ zTolerance: 0.12, source: 'user' });
  });

  it('restoring the shipped margins puts the source back, with the numbers', () => {
    render(<SettingsMenu onClose={() => {}} />);
    commit('settings-margin-boundary', '0.4');
    fireEvent.click(screen.getByTestId('settings-margins-reset'));
    const margins = useSettingsStore.getState().margins;
    expect(margins).toMatchObject({ boundaryMargin: 0.2, source: 'default' });
  });
});
