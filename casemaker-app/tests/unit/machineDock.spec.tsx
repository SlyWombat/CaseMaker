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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = { host: '192.0.2.10', port: 2222 };

beforeEach(() => {
  cleanup();
  resetMachineTranscriptStore();
  resetMachineRunStore();
  resetEngraveReleaseStore();
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
