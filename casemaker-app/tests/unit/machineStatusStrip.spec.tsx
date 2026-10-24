// @vitest-environment jsdom
// #519 item 3 — "what the machine is doing now": while a registration owns the machine the state
// reads Probing and the runner's current step takes the program's slot (the design's §5 strip). The
// raw line is fed through `machineStore` exactly as the heartbeat and the uploads leave it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MachineStatusStrip } from '@/components/viewport/MachineStatusStrip';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { resetMachineRunStore, useMachineRunStore, type RunEntry } from '@/store/machineRunStore';
import { resetRegistrationTouchesStore, useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import { resetEngraveReleaseStore, useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import type { ReleaseRecord } from '@/store/engraveReleaseStore';
import type { MachineObservation } from '@/platform/machineProbe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function remember(line: string): void {
  const observation: MachineObservation = {
    name: 'QA Z1',
    host: '192.0.2.10',
    port: 2222,
    busy: false,
    ip: null,
    mac: null,
    status: line,
    profileId: 'Z1',
    observedAt: '2026-10-24T12:00:00.000Z',
    notes: [],
  };
  useMachineStore.getState().setProbeResult({ kind: 'found', observation, calibration: null });
  useMachineStore.getState().noteLiveStatusLine(line);
}

beforeEach(() => {
  cleanup();
  resetMachineStore();
  resetRegistrationTouchesStore();
  resetEngraveReleaseStore();
  resetMachineRunStore();
});

afterEach(cleanup);

describe('#519 item 3 — the strip while a registration runs', () => {
  it('reads Probing for a Run state, and prints the runner’s step in the program slot', () => {
    remember('<Run|MPos:-10,-10,-3|WPos:0,0,0|F:400,400,100>');
    useMachineStore.getState().setRegistrationActive(true);
    useRegistrationTouchesStore.getState().setStep('as low as machine Z -57.2 (the surface seek)');
    render(<MachineStatusStrip />);

    expect(screen.getByTestId('machine-status-state').textContent).toBe('Probing');
    expect(screen.getByTestId('machine-status-step').textContent).toContain('the surface seek');
    expect(screen.queryByTestId('machine-status-program')).toBeNull();
  });

  it('outside a registration the same Run state reads Running and shows the program', () => {
    remember('<Run|MPos:-10,-10,-3|WPos:0,0,0|P:12,40,75>');
    render(<MachineStatusStrip />);

    expect(screen.getByTestId('machine-status-state').textContent).toBe('Running');
    expect(screen.getByTestId('machine-status-program').textContent).toContain('line 12');
    expect(screen.queryByTestId('machine-status-step')).toBeNull();
  });

  it('while a registration owns the machine the fitted instrument is the probe, not a T number', () => {
    remember('<Run|MPos:-10,-10,-3|WPos:0,0,0|T:6>');
    useMachineStore.getState().setRegistrationActive(true);
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-tool').textContent).toBe('probe');
  });

  it('prints the vacuum as what the app last SENT, with its qualifier', () => {
    remember('<Run|MPos:-10,-10,-3|WPos:0,0,0>');
    // The strip reads only the record's vacuum; the rest of a release record is irrelevant here.
    useEngraveReleaseStore.setState({
      records: { '192.0.2.10:2222': { vacuum: 'on' } as unknown as ReleaseRecord },
    });
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-vacuum').textContent).toBe('vacuum on (as sent)');
  });

  // #618 — the controller may say Idle once a suspend drains its queue; the app's own knowledge
  // that it suspended this job is what the operator needs to see.
  it('reads Paused while the app holds a suspended run, even if the line says Idle', () => {
    remember('<Idle|MPos:-10,-10,-3|WPos:0,0,0>');
    useMachineRunStore.setState({
      runs: { '192.0.2.10:2222': { paused: true } as unknown as RunEntry },
    });
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-state').textContent).toBe('Paused');
  });
});
