// @vitest-environment jsdom
// #1169 (part B) — THE MACHINE STOPPED. The card names the step, quotes the machine, states what
// is still good, and gates the choices behind Unlock and home. The recovery presses themselves are
// the strip's existing ones; the fake-machine e2e covers their flow.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { CutStoppedCard } from '@/components/panels/CutStoppedCard';
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

function stopped(): void {
  const nc = 'G0 X0 Y0\nM02\n';
  useEngraveReleaseStore.setState({
    records: {
      [KEY]: {
        phase: 'failed',
        active: 1,
        vacuum: 'unknown',
        walks: { airwalk: null, clean: null },
        files: Array.from({ length: 3 }, (_, i) => ({ index: i + 1, toolKey: 'flat-1.0', done: false, upload: 'uploaded', nc })),
      } as never,
    },
  });
  useMachineRunStore.setState({
    runs: { [KEY]: { running: false, progress: { state: 'Alarm', line: 298, percent: null, elapsedS: null }, lines: ['> ?', '<Alarm|MPos:0,0,0>'] } as never },
  });
}

describe('#1169 the machine stopped', () => {
  it('names the step and position, quotes the machine, states what is good, gates the choices', () => {
    stopped();
    render(<CutStoppedCard machine={MACHINE} target={TARGET} originWritten onRegisterAgain={() => {}} />);
    const card = screen.getByTestId('engrave-cut-recovery-stopped');
    expect(card.textContent).toContain('The machine stopped');
    expect(card.textContent).toContain('while cutting program 1 of 3');
    expect(card.textContent).toContain('line 298');
    expect(card.textContent).toContain('Its words:');
    expect(card.textContent).toContain('still knows where the blank is');
    expect(card.textContent).toContain('All 3 programs are still on the machine');
    // Recovery first; the choices wait for it (the unit card cannot press Unlock without a console).
    expect((screen.getByTestId('engrave-cut-recovery-unlock-home') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('engrave-cut-recovery-run-again') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('engrave-cut-recovery-register-again') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('engrave-cut-recovery-end') as HTMLButtonElement).disabled).toBe(true);
    // The bit-change choice is the one that is always out until #1168.
    expect((screen.getByTestId('engrave-cut-recovery-bit-broke') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('engrave-cut-recovery-bit-broke').textContent).toContain('after #1168');
    // Cleaning never starts by itself: it is a press, and no cleaning walk means none is offered.
    expect((screen.getByTestId('engrave-cut-recovery-clean') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is absent while the run is not stopped', () => {
    useEngraveReleaseStore.setState({ records: { [KEY]: { phase: 'running', files: [], walks: { airwalk: null, clean: null } } as never } });
    render(<CutStoppedCard machine={MACHINE} target={TARGET} originWritten={null} onRegisterAgain={() => {}} />);
    expect(screen.queryByTestId('engrave-cut-recovery-stopped')).toBeNull();
  });
});
