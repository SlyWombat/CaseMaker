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
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetShopDefaultsStore, useShopDefaultsStore } from '@/store/shopDefaultsStore';
import type { MachineRecord } from '@/platform/locationClient';
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
  return {
    close,
    attach,
    state: {
      operatorSaid: null as boolean | null,
      operatorStarted: false,
      /** #653 — a promise the mocked runner awaits after the operator says Yes (mid-motion). */
      hold: null as Promise<void> | null,
    },
  };
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
        // #653 — the host may unmount while the machine is still touching; the test holds the run
        // here until it releases it.
        if (h.state.hold !== null) await h.state.hold;
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

function Host({
  label,
  reference = 'vise-jaw-top',
  datumOffsetMm,
  successNote = 'the jaw top was recorded',
}: {
  label: string;
  reference?: 'vise-jaw-top' | 'bracket-seat';
  datumOffsetMm?: number;
  successNote?: string;
}) {
  const api = useMountTap({
    target: TARGET,
    settings: SETTINGS,
    floor: -80,
    probeId: 'probe-1',
    successNote,
  });
  const busy = useMountTapBusyFlag();
  return (
    <div>
      <button
        type="button"
        data-testid={`tap-${label}`}
        disabled={busy}
        onClick={() => void api.tapJaw({ x: -186.2, y: -180, fromMachineZ: -50, reference, datumOffsetMm })}
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

// #642 — the bracket-seat write-back had no spec: the hook wrote the seat (the reading minus the
// bracket's own height) into the bed profile AND moved the `bracket.seatMachineZ` shop default the
// compiler reads, with a partial-failure note for either write. These drive `tapJaw` through the
// mocked runner and read what the two writes would have put on each record.
describe('#642 the bracket-seat write-back', () => {
  /** One bed, active, with nothing measured — where the seat datum lands. */
  function machine(): MachineRecord {
    return {
      id: 'm1',
      profileId: 'Z1',
      address: { host: TARGET.host, port: TARGET.port },
      bedProfiles: [
        {
          id: 'bp1',
          datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null },
          placements: [],
          surface: null,
          history: [],
        },
      ],
      activeBedProfileId: 'bp1',
      history: [],
      notes: [],
      observedAt: '2026-10-25T00:00:00.000Z',
    } as unknown as MachineRecord;
  }

  interface Written {
    key: string;
    value: { value: number; source: string; note: string | null };
  }

  /** The location with this machine; `saveMachine` records and answers `answer()`. */
  function located(saves: MachineRecord[], answer: () => 'ok' | 'failed', writeNote: string | null = null): void {
    useLocationStore.setState({
      status: 'present',
      etag: '"e1"',
      reason: null,
      location: { machines: [machine()], accessories: [] } as unknown as NonNullable<
        ReturnType<typeof useLocationStore.getState>['location']
      >,
      saveMachine: async (record: MachineRecord) => {
        saves.push(record);
        useLocationStore.setState({ writeNote });
        return answer();
      },
    });
  }

  function shopStub(written: Written[], answer: () => boolean, reason: string | null = null): void {
    useShopDefaultsStore.setState({
      set: async (key, value) => {
        written.push({ key, value: value as Written['value'] });
        useShopDefaultsStore.setState({ reason });
        return answer();
      },
    });
  }

  async function tapBracket(): Promise<void> {
    fireEvent.click(screen.getByTestId('tap-setups'));
    await screen.findByTestId('continue-setups');
    await act(async () => {
      fireEvent.click(screen.getByTestId('continue-setups'));
    });
  }

  beforeEach(() => {
    resetLocationStore();
    resetShopDefaultsStore();
  });

  afterEach(() => {
    resetShopDefaultsStore();
  });

  it('writes seat = reading − the bracket height, then the shop default the compiler reads', async () => {
    const saves: MachineRecord[] = [];
    const shop: Written[] = [];
    located(saves, () => 'ok');
    shopStub(shop, () => true);
    render(<Host label="setups" reference="bracket-seat" datumOffsetMm={8.5} successNote="the seat was recorded" />);

    await tapBracket();

    // The runner's mocked reading is −56.82; the seat is one bracket height (8.5 mm) below it.
    const bed = saves.at(-1)!.bedProfiles!.find((p) => p.id === 'bp1')!;
    expect(bed.datums.bracketSeatZ?.value).toBeCloseTo(-65.32, 3);
    expect(bed.datums.bracketSeatZ?.by).toBe('probe-1');
    expect(shop).toHaveLength(1);
    expect(shop[0]!.key).toBe('bracket.seatMachineZ');
    expect(shop[0]!.value.value).toBeCloseTo(-65.32, 3);
    expect(shop[0]!.value.source).toBe('measured');
    expect(shop[0]!.value.note).toContain('tapped on the bracket');
    await waitFor(() => expect(screen.getByTestId('note-setups').textContent).toBe('the seat was recorded'));
  });

  it('a refused machine save is stated on the note, and the shop default is not written', async () => {
    const saves: MachineRecord[] = [];
    const shop: Written[] = [];
    located(saves, () => 'failed', 'the location is read-only');
    shopStub(shop, () => true);
    render(<Host label="setups" reference="bracket-seat" datumOffsetMm={8.5} />);

    await tapBracket();

    await waitFor(() =>
      expect(screen.getByTestId('note-setups').textContent).toContain(
        'the seat was tapped, but the machine record was not saved: the location is read-only',
      ),
    );
    expect(shop).toEqual([]);
  });

  it('a refused shop-default save is stated too, with the machine write standing', async () => {
    const saves: MachineRecord[] = [];
    const shop: Written[] = [];
    located(saves, () => 'ok');
    shopStub(shop, () => false, 'the defaults are locked by another window');
    render(<Host label="setups" reference="bracket-seat" datumOffsetMm={8.5} />);

    await tapBracket();

    await waitFor(() =>
      expect(screen.getByTestId('note-setups').textContent).toContain(
        'the bracket seat was tapped, but the shop default was not saved: the defaults are locked by another window',
      ),
    );
    // The machine write still landed: the seat is on the bed profile.
    expect(saves.at(-1)!.bedProfiles!.find((p) => p.id === 'bp1')!.datums.bracketSeatZ?.value).toBeCloseTo(-65.32, 3);
  });
});

// #653 — the unmount policy, from the other side. Mid-motion there is nothing to cancel: closing
// the console would not stop the move (the next line reopens the session) and it left the probe at
// the touch with no closing `$H`. The run keeps the console and the gate until its own `finally`.
describe('#653 unmount mid-motion', () => {
  function BusyProbe() {
    const busy = useMountTapBusyFlag();
    return <span data-testid="probe-busy">{busy ? 'busy' : 'idle'}</span>;
  }

  it('lets the run finish instead of closing the console under a move', async () => {
    let release: () => void = () => {};
    h.state.hold = new Promise<void>((resolve) => {
      release = () => {
        h.state.hold = null;
        resolve();
      };
    });
    render(<BusyProbe />);
    const view = render(<Host label="setups" />);
    fireEvent.click(screen.getByTestId('tap-setups'));
    await screen.findByTestId('continue-setups');
    await act(async () => {
      fireEvent.click(screen.getByTestId('continue-setups'));
    });
    await waitFor(() => expect(h.state.operatorSaid).toBe(true));

    view.unmount();

    // Mid-motion: the console stays open and the gate stays held by the running tap.
    expect(closeSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('probe-busy').textContent).toBe('busy');

    await act(async () => {
      release();
    });

    // The run's own finally closes the handle and releases the gate.
    await waitFor(() => expect(closeSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('probe-busy').textContent).toBe('idle'));
  });

  afterEach(() => {
    h.state.hold = null;
  });
});
