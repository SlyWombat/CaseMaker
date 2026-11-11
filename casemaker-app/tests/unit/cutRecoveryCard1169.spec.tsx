// @vitest-environment jsdom
// #1169 (part A) — THE MACHINE IS WAITING FOR YOU. The firmware's `Tool` state, on the Cut step,
// with the machine's own words, the bit and the two actions. The run actions are the strip's.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CutRecoveryCard } from '@/components/panels/CutRecoveryCard';
import { machineKey, useMachineRunStore } from '@/store/machineRunStore';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { useLocationStore } from '@/store/locationStore';
import { MachineRecordSchema, type LocationView } from '@/platform/locationClient';
import { toolChangeIdentity } from '@/platform/toolChangeDry';
import type { MachineObservation } from '@/platform/machineProbe';

const TARGET = { host: '192.0.2.10', port: 2222 };
const KEY = machineKey(TARGET);
const MACHINE = { host: TARGET.host, port: TARGET.port } as unknown as MachineObservation;

afterEach(() => {
  cleanup();
  useMachineRunStore.setState({ runs: {} });
  useEngraveReleaseStore.setState({ records: {} });
  useLocationStore.setState({ status: 'absent', location: null, etag: null, reason: null });
  Object.defineProperty(navigator, 'webdriver', { configurable: true, value: false });
  delete (globalThis as { __caseMaker?: unknown }).__caseMaker;
});

/**
 * A machine record for TARGET at the house. A stated GRBL profile carries no controller frame, so
 * its clearance is UNKNOWN; 'Z1' carries a read frame, so the preview can review the line.
 */
function seedMachine(completedShape?: string, profileId = 'grbl:shapeoko-4'): void {
  const record = MachineRecordSchema.parse({
    id: 'm-1',
    profileId,
    address: { host: TARGET.host, port: TARGET.port },
    updatedAt: '2026-11-11T09:00:00.000Z',
    completedRoutines:
      completedShape === undefined
        ? []
        : [{ routine: 'tool-change', shape: completedShape, at: '2026-11-11T09:00:00.000Z', build: { version: '1.0.0', commit: null } }],
  });
  const location = {
    kind: 'casemaker-location',
    schemaVersion: 1,
    id: 'loc-1',
    name: 'QA',
    createdAt: '2026-11-11T00:00:00.000Z',
    machines: [record],
    accessories: [],
  } as unknown as LocationView;
  act(() => {
    useLocationStore.setState({ status: 'present', location, etag: '"e1"', reason: null });
  });
}

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
    seedMachine(toolChangeIdentity().shape, 'Z1'); // a proved shape on a read frame: the press is free
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

// #1202 carried onto the card (#1123 item 9, manager ruling 2026-11-11): the waiting card owns the
// recovery, so it carries A's tool-change preview and gate unchanged — the same dry line, mark,
// statement, headless refusal, hold rule and sender the run panel's own prompt carries.
describe('#1202 the tool-change preview on the waiting card', () => {
  it('shows the line Continue sends, marks a first run, and the statement releases the press', () => {
    seedMachine(undefined, 'Z1'); // a read frame: the preview's clearance is known
    waiting();
    const ask = vi.spyOn(useMachineRunStore.getState(), 'requestToolContinue');
    render(<CutRecoveryCard machine={MACHINE} target={TARGET} />);

    const routine = screen.getByTestId('engrave-registration-routine');
    expect(routine.getAttribute('data-routine')).toBe('tool-change');
    const shown = [...routine.querySelectorAll('[data-testid^="engrave-registration-dry-line-"] code')].map((c) =>
      (c.textContent ?? '').trim(),
    );
    expect(shown).toEqual(['M490.2']);
    expect(screen.getByTestId('engrave-registration-dry-note').textContent).toContain('M490.2 macro');
    // This machine has never continued a tool change: marked, with its own statement gate.
    expect(screen.getByTestId('engrave-registration-first-run').textContent).toContain('has not run on this machine before');
    const cont = (): HTMLButtonElement => screen.getByTestId('engrave-cut-recovery-continue') as HTMLButtonElement;
    expect(cont().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-registration-first-run-tick'));
    expect(cont().disabled).toBe(false);
    fireEvent.click(cont());
    expect(ask).toHaveBeenCalledWith(KEY);
  });

  it('holds a first-run Continue on an unknown clearance, even when its statement is ticked', () => {
    // No location record for this host:port — there is no frame to read, so the line is refused.
    waiting();
    render(<CutRecoveryCard machine={MACHINE} target={TARGET} />);
    expect(screen.getByTestId('engrave-registration-first-run')).toBeTruthy();
    expect(screen.getByTestId('engrave-registration-dry-error').textContent).toContain('clearance unknown');
    const cont = (): HTMLButtonElement => screen.getByTestId('engrave-cut-recovery-continue') as HTMLButtonElement;
    expect(cont().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engrave-registration-first-run-tick'));
    expect(cont().disabled).toBe(true); // no reading is not a statement: the press stays held
  });

  it('keeps a proved shape’s Continue on an unknown clearance, and still shows the refusal', () => {
    seedMachine(toolChangeIdentity().shape); // recorded before; the stated GRBL profile has no frame
    waiting();
    const ask = vi.spyOn(useMachineRunStore.getState(), 'requestToolContinue');
    render(<CutRecoveryCard machine={MACHINE} target={TARGET} />);
    // Not a first run — the refusal stays on screen, the way on is not taken away.
    expect(screen.queryByTestId('engrave-registration-first-run')).toBeNull();
    expect(screen.getByTestId('engrave-registration-dry-error').textContent).toContain('clearance unknown');
    const cont = screen.getByTestId('engrave-cut-recovery-continue') as HTMLButtonElement;
    expect(cont.disabled).toBe(false);
    fireEvent.click(cont);
    expect(ask).toHaveBeenCalledWith(KEY);
  });

  it('holds a first-run press from an automated instance and says why', () => {
    seedMachine(undefined, 'Z1');
    waiting();
    Object.defineProperty(navigator, 'webdriver', { configurable: true, value: true });
    render(<CutRecoveryCard machine={MACHINE} target={TARGET} />);
    expect(screen.getByTestId('engrave-registration-first-run-headless').textContent).toContain('driven automatically');
    fireEvent.click(screen.getByTestId('engrave-registration-first-run-tick'));
    expect((screen.getByTestId('engrave-cut-recovery-continue') as HTMLButtonElement).disabled).toBe(true);
  });
});
