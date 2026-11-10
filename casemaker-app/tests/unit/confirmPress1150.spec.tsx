// @vitest-environment jsdom
// #1150 — A DESTRUCTIVE PRESS TAKES TWO, and the second one names what goes. The file delete's
// pattern (MachineFiles) made the app's own precedent; this is its one implementation, so Remove
// from inventory, Remove this definition, a feed row, Forget this machine and Remove the switch
// all read and behave the same.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfirmPress } from '@/components/manage/ConfirmPress';

describe('#1150 — the two-press confirm', () => {
  it('does nothing on the first press: it names what goes and waits', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmPress
        label="Remove from inventory"
        sentence="Remove “2 mm flat end” from the inventory? Any definition it was registered from stays."
        confirmLabel="Remove it"
        onConfirm={onConfirm}
        testId="manage-item-remove"
      />,
    );
    fireEvent.click(screen.getByTestId('manage-item-remove'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('manage-item-remove-sentence').textContent).toBe(
      'Remove “2 mm flat end” from the inventory? Any definition it was registered from stays.',
    );
    // The first button is gone; the danger press is the confirm and nothing else is.
    expect(screen.queryByTestId('manage-item-remove')).toBeNull();
    expect(screen.getByTestId('manage-item-remove-confirm').textContent).toBe('Remove it');
  });

  it('cancel puts the original control back and still does nothing', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmPress label="Remove the switch" sentence="Remove the switch?" confirmLabel="Remove it" onConfirm={onConfirm} testId="x" />,
    );
    fireEvent.click(screen.getByTestId('x'));
    fireEvent.click(screen.getByTestId('x-cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId('x').textContent).toBe('Remove the switch');
    expect(screen.queryByTestId('x-confirming')).toBeNull();
  });

  it('the confirm fires the action exactly once and closes', () => {
    const onConfirm = vi.fn();
    render(<ConfirmPress label="Remove" sentence="Remove the row?" confirmLabel="Delete the row" onConfirm={onConfirm} testId="y" />);
    fireEvent.click(screen.getByTestId('y'));
    fireEvent.click(screen.getByTestId('y-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('y')).not.toBeNull();
  });

  it('a disabled control cannot open the confirm', () => {
    const onConfirm = vi.fn();
    render(<ConfirmPress label="Remove" sentence="Remove?" confirmLabel="Remove it" onConfirm={onConfirm} testId="z" disabled />);
    expect((screen.getByTestId('z') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('z'));
    expect(screen.queryByTestId('z-confirming')).toBeNull();
  });
});
