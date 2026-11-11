// @vitest-environment jsdom
// firstJob.acceptance "every disabled control carries its reason sentence": "Surface a mesh" is
// DISABLED on a job that already has work (correctly: it starts a new, empty job), and #1109 (60f1ce411)
// moved the chip's blurb from its `title` to visible text, which left the disabled chip with no
// reason of its own — the sentence sat in a sibling hint the audit does not read. The disabled chip
// now carries the reason as its title, the same words as the visible hint.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { OperationPicker } from '@/components/panels/OperationPicker';

afterEach(() => cleanup());

function draw(surfaceAllowed: boolean): void {
  render(
    <OperationPicker mode="add" testidFor={(id) => `chip-${id}`} onPick={() => undefined} surfaceAllowed={surfaceAllowed} />,
  );
}

describe('the operation picker’s disabled chip', () => {
  it('Surface a mesh, disabled on a job with work, carries its reason as its title and says it on the screen', () => {
    draw(false);
    const chip = screen.getByTestId('chip-surface') as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    const hint = screen.getByTestId('operation-picker-surface-hint').textContent ?? '';
    expect(hint).toContain('Surface a mesh starts a new, empty job');
    expect(chip.getAttribute('title')).toBe(hint);
  });

  it('enabled, it has no reason title (nothing is wrong)', () => {
    draw(true);
    const chip = screen.getByTestId('chip-surface') as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
    expect(chip.getAttribute('title')).toBeNull();
    expect(screen.queryByTestId('operation-picker-surface-hint')).toBeNull();
  });
});
