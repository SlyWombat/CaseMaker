// @vitest-environment jsdom
// #528 — the dock band under the viewport. The rail components write the three transcripts into
// `machineTranscriptStore`; the dock reads them and renders the Transcript tab with the testids the
// transcripts used to carry in the rail. This spec drives the STORE directly — the move of the
// content is the subject, not the machine.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MachineDock } from '@/components/viewport/MachineDock';
import { resetMachineTranscriptStore, useMachineTranscriptStore } from '@/store/machineTranscriptStore';
import { resetMachineRunStore, useMachineRunStore } from '@/store/machineRunStore';
import { resetEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { resetRegistrationTouchesStore, useRegistrationTouchesStore } from '@/store/registrationTouchesStore';
import type { LiveTouch } from '@/engine/cnc/registration/liveTouch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = { host: '192.0.2.10', port: 2222 };

const touch = (over: Partial<LiveTouch> & Pick<LiveTouch, 'seq'>): LiveTouch => ({
  source: 'edge',
  label: 'the left edge',
  x: 1,
  y: 2,
  z: -56.17,
  touched: true,
  kind: 'stock',
  ...over,
});

beforeEach(() => {
  cleanup();
  resetMachineTranscriptStore();
  resetMachineRunStore();
  resetEngraveReleaseStore();
  resetMachineStore();
  resetRegistrationTouchesStore();
});

afterEach(cleanup);

describe('#528 the machine dock — Transcript tab', () => {
  it('renders nothing while there is no transcript content (a bare viewport stays bare)', () => {
    render(<MachineDock />);
    expect(screen.queryByTestId('machine-dock')).toBeNull();
  });

  it('moves the three transcripts out of the rail and into the dock, content unchanged', () => {
    useMachineTranscriptStore.setState({
      registration: '> G38.2 Z-2\nok\n> M491\nok',
      runLines: '> play file.nc\nok\n(no status reply 1)',
      releaseNotes: 'Playing program 1 of 2: job.nc (inv:engraver).',
    });
    render(<MachineDock />);

    expect(screen.getByTestId('machine-dock')).toBeDefined();
    // Not live, so the dock starts collapsed; the operator opens the Transcript tab.
    fireEvent.click(screen.getByTestId('machine-dock-transcript'));

    const registration = screen.getByTestId('engrave-registration-transcript');
    const runLines = screen.getByTestId('engrave-run-lines');
    const releaseNotes = screen.getByTestId('engrave-release-notes');

    // The dock's <pre> is fed the joined text verbatim, so the rendered textContent is the same
    // string the rail's <pre> held.
    expect(registration.textContent).toBe('> G38.2 Z-2\nok\n> M491\nok');
    expect(runLines.textContent).toBe('> play file.nc\nok\n(no status reply 1)');
    expect(releaseNotes.textContent).toBe('Playing program 1 of 2: job.nc (inv:engraver).');

    // Monospace, newest last: the joined text is already in append order, so the last line is the
    // newest — the release note's final sentence lands last.
    expect(getComputedStyle(registration).whiteSpace).toBe('pre');
  });

  it('renders only the transcripts that have content', () => {
    useMachineTranscriptStore.setState({ runLines: '> play file.nc\nok' });
    render(<MachineDock />);
    fireEvent.click(screen.getByTestId('machine-dock-transcript'));

    expect(screen.getByTestId('machine-dock')).toBeDefined();
    expect(screen.getByTestId('engrave-run-lines')).toBeDefined();
    expect(screen.queryByTestId('engrave-registration-transcript')).toBeNull();
    expect(screen.queryByTestId('engrave-release-notes')).toBeNull();
  });

  it('collapses to its tab bar when nothing is live, and a click pins the Transcript open', () => {
    useMachineTranscriptStore.setState({ runLines: '> play file.nc\nok' });
    render(<MachineDock />);

    // Not live: collapsed, so the transcript is behind the tab.
    expect(screen.getByTestId('machine-dock-transcript')).toBeDefined();
    expect(screen.queryByTestId('engrave-run-lines')).toBeNull();

    fireEvent.click(screen.getByTestId('machine-dock-transcript'));
    expect(screen.getByTestId('engrave-run-lines')).toBeDefined();
  });

  it('opens itself while a run is going, even without a click', () => {
    useMachineTranscriptStore.setState({ runLines: '> play file.nc\nok' });
    const machine = `${TARGET.host}:${TARGET.port}`;
    useMachineRunStore.getState().prepare(TARGET, 'file.nc', 'hash-1');
    useMachineRunStore.setState((s) => ({
      runs: { ...s.runs, [machine]: { ...s.runs[machine]!, running: true } },
    }));
    render(<MachineDock />);

    expect(screen.getByTestId('machine-dock')).toBeDefined();
    expect(screen.getByTestId('engrave-run-lines')).toBeDefined();
  });
});

describe('#519 item 1 — the dock’s Touches tab', () => {
  it('renders one row per reading as it landed, with the surface row keeping the rail’s testid', () => {
    useRegistrationTouchesStore.getState().add(touch({ seq: 1, source: 'surface', label: null, z: -56.171 }));
    useRegistrationTouchesStore.getState().add(touch({ seq: 2 }));
    useRegistrationTouchesStore.getState().add(touch({ seq: 3, kind: 'miss', touched: false, z: -59 }));

    render(<MachineDock />);
    fireEvent.click(screen.getByTestId('machine-dock-touches'));

    expect(screen.getByTestId('engrave-registration-touches')).toBeDefined();
    expect(screen.getByTestId('engrave-registration-surface').textContent).toContain('the surface');
    expect(screen.getByTestId('engrave-registration-touch-2').getAttribute('data-verdict')).toBe('stock');
    const miss = screen.getByTestId('engrave-registration-touch-3');
    expect(miss.getAttribute('data-verdict')).toBe('miss');
    expect(miss.textContent).toContain('no touch');
  });

  it('closes the table with the spread sentence when the run assessed one', () => {
    useRegistrationTouchesStore.getState().add(touch({ seq: 1 }));
    useRegistrationTouchesStore.getState().setSpreadSentence('Surface spread 0.12 mm against the 0.2 mm band — within it.');
    render(<MachineDock />);
    fireEvent.click(screen.getByTestId('machine-dock-touches'));
    expect(screen.getByTestId('engrave-registration-spread-sentence').textContent).toContain('0.12 mm');
  });

  it('opens itself and defaults to Touches while a registration owns the machine', () => {
    useRegistrationTouchesStore.getState().add(touch({ seq: 1 }));
    useMachineStore.setState({ registrationActive: true });
    render(<MachineDock />);

    // Expanded without a click, and the Touches tab is the active one.
    expect(screen.getByTestId('engrave-registration-touches')).toBeDefined();
    expect(screen.getByTestId('machine-dock-touches').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('machine-dock-transcript').getAttribute('aria-selected')).toBe('false');
  });
});
