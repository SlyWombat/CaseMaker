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

  it('a seed edited on its own does not claim the boundary margin as the user’s (#345 review)', () => {
    render(<SettingsMenu onClose={() => {}} />);
    commit('settings-margin-floor', '2');

    // The seed moved…
    expect(useSettingsStore.getState().margins.minFloor).toBe(2);
    // …and the boundary margin is still the SHIPPED default, so `effectiveMargins` keeps reading
    // each blank's own layer height off it.
    expect(useSettingsStore.getState().margins.source).toBe('default');
  });

  it('the other two seeds are the same: edge margin and breakthrough leave the source alone', () => {
    render(<SettingsMenu onClose={() => {}} />);
    commit('settings-margin-edge', '3');
    commit('settings-margin-breakthrough', '0.5');
    const margins = useSettingsStore.getState().margins;
    expect(margins).toMatchObject({ edgeMargin: 3, breakthrough: 0.5, source: 'default' });
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
