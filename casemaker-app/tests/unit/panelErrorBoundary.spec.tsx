// @vitest-environment jsdom
/**
 * #490 — a throw in the Engrave panel used to unmount the whole rail. The boundary must say what
 * threw, keep the chrome around it up, offer a reload that restores the child, and write the crash
 * into the run's diagnostics so the run sheet can carry it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { PanelErrorBoundary } from '@/components/ui/PanelErrorBoundary';
import { useEngraveRunStore } from '@/store/engraveRunStore';

// The validator stand-in the issue names: a render-time throw, flipped off to prove the reset
// restores the child rather than rendering the sentence forever.
let shouldThrow = true;

function ThrowingValidator(): JSX.Element {
  if (shouldThrow) throw new Error('bundled font Barlow-Bold is not loaded');
  return <p data-testid="healthy-child">the panel body</p>;
}

beforeEach(() => {
  shouldThrow = true;
  useEngraveRunStore.getState().reset();
  // React prints the caught error itself; keep the run's output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PanelErrorBoundary (#490)', () => {
  it('names what threw and leaves the chrome around the panel up', () => {
    render(
      <div>
        <b data-testid="rail-header">Engrave text</b>
        <PanelErrorBoundary name="Engrave panel">
          <ThrowingValidator />
        </PanelErrorBoundary>
      </div>,
    );
    expect(screen.getByTestId('rail-header').textContent).toBe('Engrave text');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Engrave panel could not be drawn');
    expect(screen.getByTestId('panel-error-message').textContent).toBe(
      'bundled font Barlow-Bold is not loaded',
    );
    // The "where" — React's component stack — is on screen in dev.
    expect(screen.getByTestId('panel-error-stack').textContent).toContain('ThrowingValidator');
  });

  it('records the crash as a diagnostic on the run, under its own code', () => {
    render(
      <PanelErrorBoundary name="Engrave panel">
        <ThrowingValidator />
      </PanelErrorBoundary>,
    );
    const [diagnostic] = useEngraveRunStore.getState().simDiagnostics;
    expect(diagnostic).toMatchObject({
      severity: 'error',
      code: 'panel-render-error',
      message: 'bundled font Barlow-Bold is not loaded (Engrave panel)',
    });
  });

  it('logs the code and the component stack to the console, and reports through the seam', () => {
    const onError = vi.fn();
    render(
      <PanelErrorBoundary name="Engrave setup flow" onError={onError}>
        <ThrowingValidator />
      </PanelErrorBoundary>,
    );
    const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('[panel-render-error]') && line.includes('Engrave setup flow'))).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(String((onError.mock.calls[0]![1] as { componentStack?: string }).componentStack)).toContain(
      'ThrowingValidator',
    );
  });

  it('reloads the panel into a child that no longer throws', () => {
    render(
      <PanelErrorBoundary name="Engrave panel">
        <ThrowingValidator />
      </PanelErrorBoundary>,
    );
    expect(screen.queryByTestId('healthy-child')).toBeNull();

    shouldThrow = false;
    fireEvent.click(screen.getByTestId('panel-error-reload'));

    expect(screen.getByTestId('healthy-child').textContent).toBe('the panel body');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders its children untouched when nothing throws', () => {
    shouldThrow = false;
    render(
      <PanelErrorBoundary name="Engrave panel">
        <ThrowingValidator />
      </PanelErrorBoundary>,
    );
    expect(screen.getByTestId('healthy-child')).not.toBeNull();
    expect(useEngraveRunStore.getState().simDiagnostics).toEqual([]);
  });
});
