// @vitest-environment jsdom
// #648 — the strip's accessory indicators: three icons at the far left, each with a tooltip and a
// popover that says what it is and offers the guarded toggle. The vacuum text leaves the strip.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MachineStatusStrip } from '@/components/viewport/MachineStatusStrip';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { resetRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import { resetEngraveReleaseStore, useEngraveReleaseStore, type ReleaseRecord } from '@/store/engraveReleaseStore';
import { resetMachineRunStore } from '@/store/machineRunStore';
import { resetStripAccessoryStore } from '@/store/stripAccessoryStore';
import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleSession } from '@/platform/machineConsole';
import type { MachineObservation } from '@/platform/machineProbe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IDLE = '<Idle|MPos:-1,-1,-1|WPos:0,0,0>';
const RUNNING = '<Run|MPos:-10,-10,-3|WPos:0,0,0|P:12,40,75>';

function remember(line: string): void {
  const observation: MachineObservation = {
    name: 'QA Z1', host: '192.0.2.10', port: 2222, busy: false, ip: null, mac: null,
    status: line, profileId: 'Z1', observedAt: '2026-10-24T12:00:00.000Z', notes: [],
  };
  useMachineStore.getState().setProbeResult({ kind: 'found', observation, calibration: null });
  useMachineStore.getState().noteLiveStatusLine(line);
}

/** A fake console that answers `?` with `status` and every command with `ok`. */
function fakeConsole(status: string) {
  const sent: string[] = [];
  const session: MachineConsoleSession = {
    async send(line) {
      sent.push(line);
      const reply = (text: string): ConsoleSend => ({ ok: true, line, text, frames: 1, elapsedMs: 10 });
      return reply(line === '?' ? status : 'ok');
    },
    async close() {},
  };
  setMachineConsoleLoader(async () => ({ async open() { return session; } }));
  return sent;
}

beforeEach(() => {
  cleanup();
  resetMachineStore();
  resetRegistrationTouchesStore();
  resetEngraveReleaseStore();
  resetMachineRunStore();
  resetStripAccessoryStore();
  setMachineConsoleLoader(null);
});
afterEach(() => {
  cleanup();
  setMachineConsoleLoader(null);
});

describe('#648 the accessory indicators', () => {
  it('draws vacuum, antistatic and work light at the far left, unknown until something is sent', () => {
    remember(IDLE);
    render(<MachineStatusStrip />);
    for (const kind of ['vacuum', 'antistatic', 'light'] as const) {
      expect(screen.getByTestId(`machine-status-accessory-${kind}`).getAttribute('data-mode')).toBe('unknown');
    }
    // The tooltip and the accessible name say the name and the state.
    expect(screen.getByTestId('machine-status-accessory-light').getAttribute('title')).toBe('Work light unknown');
    expect(screen.getByTestId('machine-status-accessory-light').getAttribute('aria-label')).toBe('Work light unknown');
  });

  it('takes the vacuum mode from the release record the program left', () => {
    remember(IDLE);
    useEngraveReleaseStore.setState({ records: { '192.0.2.10:2222': { vacuum: 'off' } as unknown as ReleaseRecord } });
    render(<MachineStatusStrip />);
    expect(screen.getByTestId('machine-status-accessory-vacuum').getAttribute('data-mode')).toBe('off');
  });

  it('no longer renders the vacuum as text', () => {
    remember(IDLE);
    useEngraveReleaseStore.setState({ records: { '192.0.2.10:2222': { vacuum: 'on' } as unknown as ReleaseRecord } });
    render(<MachineStatusStrip />);
    expect(screen.queryByTestId('machine-status-vacuum')).toBeNull();
    expect(screen.getByTestId('machine-status').textContent).not.toContain('vacuum off');
  });

  it('opens a popover with the one-line meaning and the toggle, and Escape closes it', () => {
    remember(IDLE);
    render(<MachineStatusStrip />);
    const button = screen.getByTestId('machine-status-accessory-light');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('machine-status-accessory-popover-light').textContent).toContain('The machine’s own light');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('machine-status-accessory-popover-light')).toBeNull();
  });

  it('a press calls the guarded module and the indicator follows its answer', async () => {
    remember(IDLE);
    const sent = fakeConsole(IDLE);
    render(<MachineStatusStrip />);
    fireEvent.click(screen.getByTestId('machine-status-accessory-light'));
    fireEvent.click(screen.getByTestId('machine-status-accessory-on-light'));
    await waitFor(() => expect(screen.getByTestId('machine-status-accessory-light').getAttribute('data-mode')).toBe('on'));
    // One connection, asked first, then the machine's own code.
    expect(sent).toEqual(['?', 'M821']);
  });

  it('the vacuum press sends the vacuum code on the same guard', async () => {
    remember(IDLE);
    const sent = fakeConsole(IDLE);
    render(<MachineStatusStrip />);
    fireEvent.click(screen.getByTestId('machine-status-accessory-vacuum'));
    fireEvent.click(screen.getByTestId('machine-status-accessory-on-vacuum'));
    await waitFor(() => expect(screen.getByTestId('machine-status-accessory-vacuum').getAttribute('data-mode')).toBe('on'));
    expect(sent).toEqual(['?', 'M331']);
  });

  it('disables the toggle with the reason while a program is running', () => {
    remember(RUNNING);
    render(<MachineStatusStrip />);
    fireEvent.click(screen.getByTestId('machine-status-accessory-vacuum'));
    expect(screen.getByTestId('machine-status-accessory-disabled-vacuum').textContent).toBe('A program is running — stop it first.');
    expect((screen.getByTestId('machine-status-accessory-on-vacuum') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a refusal from the module is shown in the popover, and the indicator keeps its state', async () => {
    remember(IDLE);
    // The machine says Idle to the strip, but answers the guard with a running line: the module refuses.
    fakeConsole(RUNNING);
    render(<MachineStatusStrip />);
    fireEvent.click(screen.getByTestId('machine-status-accessory-light'));
    fireEvent.click(screen.getByTestId('machine-status-accessory-on-light'));
    await waitFor(() =>
      expect(screen.getByTestId('machine-status-accessory-note-light').textContent).toContain('rather than Idle'),
    );
    expect(screen.getByTestId('machine-status-accessory-light').getAttribute('data-mode')).toBe('unknown');
  });
});
