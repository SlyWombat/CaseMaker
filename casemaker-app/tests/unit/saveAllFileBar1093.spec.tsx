// @vitest-environment jsdom
/**
 * #1093 R2 — A MULTI-PROGRAM RUN OFFERS SAVE ALL, AND NO SINGLE-PROGRAM SAVE.
 *
 * The file bar's File menu is where the run's files are reached (#792). With one program it says
 * *Save .nc…*, exactly as before; with more than one it says *Save all (N programs)…* and there is
 * no *Save .nc…* — the item that wrote program 1 alone and stranded the rest is gone, not merely
 * supplemented. The blocker sentence closes both.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { EngraveJobFileBar } from '@/components/panels/EngraveJobFileBar';

afterEach(cleanup);

function openMenu(): void {
  fireEvent.click(screen.getByTestId('engrave-file-menu-toggle'));
}

describe('#1093 R2 — the file bar’s save item', () => {
  it('one program keeps Save .nc… and offers no Save all', () => {
    render(<EngraveJobFileBar onSaveProgram={vi.fn()} onSaveAllPrograms={vi.fn()} programCount={1} />);
    openMenu();
    expect(screen.getByTestId('engrave-save').textContent).toContain('Save .nc');
    expect(screen.queryByTestId('engrave-save-all')).toBeNull();
  });

  it('five programs offer Save all (5 programs)… and NO single-program Save', () => {
    const onSaveAll = vi.fn();
    const onSave = vi.fn();
    render(<EngraveJobFileBar onSaveProgram={onSave} onSaveAllPrograms={onSaveAll} programCount={5} />);
    openMenu();
    const item = screen.getByTestId('engrave-save-all');
    expect(item.textContent).toContain('Save all (5 programs)');
    expect(screen.queryByTestId('engrave-save')).toBeNull();
    fireEvent.click(item);
    expect(onSaveAll).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('the blocker closes Save all, and its sentence is the item’s own hover', () => {
    render(
      <EngraveJobFileBar
        onSaveProgram={vi.fn()}
        onSaveAllPrograms={vi.fn()}
        programCount={5}
        saveProgramBlocker="program 3 failed verification"
      />,
    );
    openMenu();
    const item = screen.getByTestId('engrave-save-all') as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.title).toContain('Save all is disabled — program 3 failed verification.');
  });
});
