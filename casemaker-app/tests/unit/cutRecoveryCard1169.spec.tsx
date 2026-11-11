// @vitest-environment jsdom
// #1169 (part A) — THE MACHINE IS WAITING FOR YOU. The firmware's `Tool` state, on the Cut step,
// with the machine's own words, the bit and the two actions. The run actions are the strip's.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CutRecoveryCard } from '@/components/panels/CutRecoveryCard';
import { machineKey, useMachineRunStore } from '@/store/machineRunStore';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import type { MachineObservation } from '@/platform/machineProbe';

const TARGET = { host: '192.0.2.10', port: 2222 };
const KEY = machineKey(TARGET);
const MACHINE = { host: TARGET.host, port: TARGET.port } as unknown as MachineObservation;

afterEach(() => {
  cleanup();
  useMachineRunStore.setState({ runs: {} });
  useEngraveReleaseStore.setState({ records: {} });
});

function waiting(over: Record<string, unknown> = {}): void {
  useMachineRunStore.setState({
    runs: {
      [KEY]: {
        running: true,
        toolWaiting: { awaited: 3 },
        stopAsked: false,
        paused: false,
        lines: [],
        ...over,
      } as never,
    },
  });
  useEngraveReleaseStore.setState({ records: { [KEY]: { active: 3, phase: 'running' } as never } });
}

describe('#1169 the machine is waiting', () => {
  it('says what the machine is doing, which bit, and offers Continue and Stop', () => {
    waiting();
    render(<CutRecoveryCard machine={MACHINE} target={TARGET} />);
    const card = screen.getByTestId('engrave-cut-recovery-waiting');
    expect(card.textContent).toContain('The machine is waiting for you');
    expect(card.textContent).toContain('Program 3 asked for tool 3');
    expect(card.textContent).toContain('waiting for a tool change to be confirmed');
    expect(screen.getByTestId('engrave-cut-recovery-continue')).toBeTruthy();
    expect(screen.getByTestId('engrave-cut-recovery-stop')).toBeTruthy();
  });

  it('Continue is the run watcher’s M490.2 path, and Stop is the release stop', () => {
    waiting();
    const state = useMachineRunStore.getState();
    const ask = vi.spyOn(state, 'requestToolContinue');
    const stop = vi.spyOn(useEngraveReleaseStore.getState(), 'stop').mockImplementation(() => {});
    render(<CutRecoveryCard machine={MACHINE} target={TARGET} />);
    fireEvent.click(screen.getByTestId('engrave-cut-recovery-continue'));
    expect(ask).toHaveBeenCalledWith(KEY);
    fireEvent.click(screen.getByTestId('engrave-cut-recovery-stop'));
    expect(stop).toHaveBeenCalledWith(TARGET);
  });

  it('is absent when the machine is not waiting, and while a stop is already asked', () => {
    useMachineRunStore.setState({ runs: { [KEY]: { running: true, toolWaiting: null, lines: [] } as never } });
    render(<CutRecoveryCard machine={MACHINE} target={TARGET} />);
    expect(screen.queryByTestId('engrave-cut-recovery-waiting')).toBeNull();
    cleanup();
    waiting({ stopAsked: true });
    render(<CutRecoveryCard machine={MACHINE} target={TARGET} />);
    expect((screen.getByTestId('engrave-cut-recovery-continue') as HTMLButtonElement).disabled).toBe(true);
  });
});
