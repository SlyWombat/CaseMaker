// @vitest-environment jsdom
// #637 — the shared mount tap's OWN guarantees, below the two hosts that render it:
//
//   • one tap at a time across hosts (a second press is refused, not queued);
//   • unmount CANCELS the pending operator prompt and CLOSES the console attachment;
//   • the release is token-owned, so a cancelled tap's unwinding cannot clear a newer tap's gate;
//   • a note still reaches the host after a React StrictMode mount (the dev-mode cleanup runs once
//     on mount — `alive` must re-arm, or every note is swallowed in a dev build).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { resetLocationStore } from '@/store/locationStore';
import { useMountTap, useMountTapBusyFlag } from '@/hooks/useMountTap';
import type { RegistrationSettings } from '@/engine/cnc/registration/settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS = {} as unknown as RegistrationSettings;
const TARGET = { host: '192.0.2.10', port: 2222 };

// `vi.mock` is hoisted above these declarations, so the spies and the runner's observations live in
// a `vi.hoisted` block.
const h = vi.hoisted(() => {
  const close = vi.fn(async (): Promise<void> => {});
  const attach = vi.fn(() => ({ send: vi.fn(async () => ({ kind: 'ok' as const, reply: '' })), close }));
  return { close, attach, state: { operatorSaid: null as boolean | null, operatorStarted: false } };
});
const closeSpy = h.close;
const attachConsoleSpy = h.attach;

vi.mock('@/platform/machineConsole', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/machineConsole')>();
  return { ...actual, attachConsole: h.attach };
});

vi.mock('@/engine/cnc/registration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/cnc/registration')>();
  return {
    ...actual,
    runMountTap: vi.fn(
      async (
        _tap: unknown,
        _fromZ: unknown,
        _settings: unknown,
        deps: { operator: (step: { kind: string; text: string }) => Promise<boolean> },
      ) => {
        h.state.operatorStarted = true;
        const ok = await deps.operator({ kind: 'fit-probe', text: 'Fit the wired probe in the spindle, then continue.' });
        h.state.operatorSaid = ok;
        if (!ok) return { ok: false as const, reason: 'stopped: the probe was not fitted', transcript: [] };
        return {
          ok: true as const,
          z: -56.82,
          at: { x: -186.2, y: -180 },
          probe: { lengthZ: -76.063, rest: 'Probe: 0' },
          transcript: [{ line: '?', reply: '<Idle|MPos:-1,-1,-1>' }],
        };
      },
    ),
  };
});

function Host({ label }: { label: string }) {
  const api = useMountTap({
    target: TARGET,
    settings: SETTINGS,
    floor: -80,
    probeId: 'probe-1',
    successNote: 'the jaw top was recorded',
  });
  const busy = useMountTapBusyFlag();
  return (
    <div>
      <button
        type="button"
        data-testid={`tap-${label}`}
        disabled={busy}
        onClick={() => void api.tapJaw({ x: -186.2, y: -180, fromMachineZ: -50, reference: 'vise-jaw-top' })}
      >
        Tap
      </button>
      <span data-testid={`busy-${label}`}>{busy ? 'busy' : 'idle'}</span>
      <span data-testid={`note-${label}`}>{api.note ?? ''}</span>
      {api.prompt !== null && (
        <button type="button" data-testid={`continue-${label}`} onClick={() => api.resolve(true)}>
          Continue
        </button>
      )}
    </div>
  );
}

beforeEach(() => {
  cleanup();
  resetLocationStore();
  attachConsoleSpy.mockClear();
  closeSpy.mockClear();
  h.state.operatorSaid = null;
  h.state.operatorStarted = false;
});

afterEach(() => cleanup());

describe('#637 the shared mount tap', () => {
  it('refuses a second host’s press while one tap holds the gate', async () => {
    render(
      <>
        <Host label="setups" />
        <Host label="bed" />
      </>,
    );
    fireEvent.click(screen.getByTestId('tap-setups'));
    await screen.findByTestId('continue-setups');

    // Both hosts read the one flag, so the other host's button is disabled…
    expect((screen.getByTestId('tap-bed') as HTMLButtonElement).disabled).toBe(true);
    // …and a press that slips through anyway is refused without opening a second console.
    fireEvent.click(screen.getByTestId('tap-bed'));
    expect(attachConsoleSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels the pending prompt and closes the console when the host unmounts', async () => {
    const { unmount } = render(<Host label="setups" />);
    fireEvent.click(screen.getByTestId('tap-setups'));
    await screen.findByTestId('continue-setups');
    expect(h.state.operatorStarted).toBe(true);

    unmount();

    // The cancelled prompt is answered NO, so the runner unwinds instead of waiting forever.
    await waitFor(() => expect(h.state.operatorSaid).toBe(false));
    expect(closeSpy).toHaveBeenCalled();
  });

  it('lets a newer tap run after the cancelled one unwinds — the stale release does not clear it', async () => {
    const first = render(<Host label="setups" />);
    fireEvent.click(screen.getByTestId('tap-setups'));
    await screen.findByTestId('continue-setups');
    first.unmount();

    // The gate is free again once the unmount released its token…
    render(<Host label="bed" />);
    await waitFor(() => expect((screen.getByTestId('tap-bed') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('tap-bed'));
    await screen.findByTestId('continue-bed');

    // …and the FIRST tap's detached promise reaching its `finally` must not re-enable the button.
    await waitFor(() => expect(h.state.operatorSaid).toBe(false));
    expect((screen.getByTestId('tap-bed') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('busy-bed') as HTMLElement).textContent).toBe('busy');
  });

  it('delivers the note after a StrictMode mount (the dev cleanup must re-arm, not swallow)', async () => {
    render(
      <StrictMode>
        <Host label="setups" />
      </StrictMode>,
    );
    fireEvent.click(screen.getByTestId('tap-setups'));
    await screen.findByTestId('continue-setups');
    fireEvent.click(screen.getByTestId('continue-setups'));

    await waitFor(() => expect(screen.getByTestId('note-setups').textContent).toBe('the jaw top was recorded'));
    await waitFor(() => expect((screen.getByTestId('busy-setups') as HTMLElement).textContent).toBe('idle'));
  });
});
