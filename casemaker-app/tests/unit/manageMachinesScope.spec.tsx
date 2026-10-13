// @vitest-environment jsdom
// #302 item 4 — the console panel under the machine card in Manage → Machines.
//
// THE SEAM IS THE CLIENT. `setMachineConsoleLoader` swaps the socket half for a fake, so the panel's
// real guard → lazy open → send path runs in every test. What this pins is the part the browser QA
// cannot see: the panel is absent where it could not work, Send is off until the person says they are
// at the machine, and a line the guards refuse costs no connection.
//
// THE CAPABILITY IS A GETTER (#354's seam in `manageMode.spec.tsx`), so the desktop half can be
// turned on for one test without rebuilding for the other target.

import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MachinesScope } from '@/components/manage/MachinesScope';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setMachineConsoleLoader,
  type ConsoleSend,
  type MachineConsoleClient,
  type MachineConsoleSession,
} from '@/platform/machineConsole';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const caps = vi.hoisted(() => ({ drive: false }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canDriveMachine() {
      return caps.drive;
    },
  };
});

/** A controller that answered once — what the card draws its console under. */
const Z1_RECORD = {
  name: 'Z1',
  host: '192.168.10.43',
  port: 2222,
  busy: false,
  ip: '192.168.10.43',
  mac: 'AA:BB:CC:DD:EE:FF',
  status: '<Idle|MPos:0.000,0.000,0.000|Bf:14,128>',
  profileId: 'Z1',
  observedAt: '2026-10-09T06:00:00.000Z',
  notes: [],
};

/** The session the panel holds, with what it was asked. */
interface FakeConsole {
  session: MachineConsoleSession;
  sent: string[];
  readonly closes: number;
  readonly opens: number;
}

/** How the fake console answers a line. The recorder is the fake's own, so `sent` is the truth. */
type Answer = (line: string) => ConsoleSend;

/** Install a console client and count the loads, so "no connection" is an assertion. */
function fakeConsole(
  answer: Answer = (line) => ({ ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 }),
): FakeConsole & { loads: () => number } {
  let loads = 0;
  const sent: string[] = [];
  const counters = { closes: 0, opens: 0 };
  const session: MachineConsoleSession = {
    async send(line) {
      sent.push(line);
      return answer(line);
    },
    async close() {
      counters.closes += 1;
    },
  };
  const client: MachineConsoleClient = {
    async open() {
      counters.opens += 1;
      return session;
    },
  };
  setMachineConsoleLoader(async () => {
    loads += 1;
    return client;
  });
  // The counters are read after the fact, so they have to be live reads rather than copied numbers.
  return {
    session,
    sent,
    get closes() {
      return counters.closes;
    },
    get opens() {
      return counters.opens;
    },
    loads: () => loads,
  };
}

/** The card, with a machine that answered. */
function withMachine(): void {
  useMachineStore.setState({
    machine: Z1_RECORD,
    outcome: 'found',
    reason: null,
    checkedAt: '2026-10-09T06:00:00.000Z',
  });
}

beforeEach(() => {
  cleanup();
  caps.drive = false;
  resetMachineStore();
  useSettingsStore.setState({ machineCalibration: undefined });
});

afterEach(() => setMachineConsoleLoader(null));

const q = (id: string) => screen.queryByTestId(id);
const line = () => screen.getByTestId('manage-console-line') as HTMLInputElement;
const send = () => screen.getByTestId('manage-console-send') as HTMLButtonElement;
const armed = () => screen.getByTestId('manage-console-armed') as HTMLInputElement;

describe('#302 the console panel — where it is', () => {
  it('a build that cannot open a socket draws no console at all', () => {
    caps.drive = false;
    withMachine();
    render(<MachinesScope />);
    // The card is still the record it was (#354), and the console is simply not part of it.
    expect(q('manage-machine-card')).not.toBeNull();
    expect(q('manage-console')).toBeNull();
  });

  it('the desktop build draws it collapsed under the machine card', () => {
    caps.drive = true;
    withMachine();
    render(<MachinesScope />);
    const panel = screen.getByTestId('manage-console');
    expect(panel.tagName).toBe('DETAILS');
    // Collapsed by default: the card is still the thing you read first.
    expect((panel as HTMLDetailsElement).open).toBe(false);
    // Inside the card, at its foot — the machine it talks to is the one above it.
    expect(screen.getByTestId('manage-machine-card').contains(panel)).toBe(true);
    expect(q('manage-console-hint')).not.toBeNull();
  });

  it('draws nothing where there is no machine to talk to', () => {
    caps.drive = true;
    render(<MachinesScope />);
    expect(q('manage-machine-none')).not.toBeNull();
    expect(q('manage-console')).toBeNull();
  });
});

describe('#302 the console panel — the checkbox and the press', () => {
  beforeEach(() => {
    caps.drive = true;
    withMachine();
  });

  it('Send is off until the box is ticked, and until there is a line to send', () => {
    const wire = fakeConsole();
    render(<MachinesScope />);

    expect(send().disabled).toBe(true);
    expect(send().title).toContain('I am at the machine');

    fireEvent.change(line(), { target: { value: '?' } });
    expect(send().disabled).toBe(true); // armed only, still not ticked

    fireEvent.click(armed());
    expect(send().disabled).toBe(false);
    expect(send().title).toContain('Send this line');

    // Unticking turns it off again without losing the line or the transcript.
    fireEvent.click(armed());
    expect(send().disabled).toBe(true);
    expect(line().value).toBe('?');
    expect(wire.loads()).toBe(0);
  });

  it('a blank line is not sendable, even with the box ticked', () => {
    fakeConsole();
    render(<MachinesScope />);
    fireEvent.click(armed());
    expect(send().disabled).toBe(true);
    fireEvent.change(line(), { target: { value: '   ' } });
    expect(send().disabled).toBe(true);
  });

  it('shows the guard’s refusal as it is typed, and Send stays off: no socket is opened', () => {
    const wire = fakeConsole();
    render(<MachinesScope />);
    fireEvent.click(armed());
    fireEvent.change(line(), { target: { value: 'config-set sd x 1' } });

    const refusal = screen.getByTestId('manage-console-refusal');
    expect(refusal.textContent).toContain('changes a configuration value');
    expect(send().disabled).toBe(true);
    expect(send().title).toContain('refusing');
    // The refusal is decided before the bridge is reached, which is the whole ordering rule.
    expect(wire.loads()).toBe(0);
  });

  it('sends on an explicit press, once, and puts the reply and its timing in the transcript', async () => {
    const wire = fakeConsole((l) => ({ ok: true, line: l, text: '<Idle|MPos:0,0,0>', frames: 2, elapsedMs: 41 }));
    render(<MachinesScope />);
    fireEvent.click(armed());
    fireEvent.change(line(), { target: { value: '?' } });
    fireEvent.click(send());

    await waitFor(() => expect(q('manage-console-transcript')).not.toBeNull());
    expect(wire.sent).toEqual(['?']);
    expect(wire.opens).toBe(1);
    const entry = screen.getByTestId('manage-console-entry-0');
    expect(entry.getAttribute('data-kind')).toBe('sent');
    expect(entry.textContent).toContain('?');
    expect(entry.textContent).toContain('<Idle|MPos:0,0,0>');
    expect(screen.getByTestId('manage-console-note-0').textContent).toBe('2 frames · 41 ms');
    // The box is cleared only because the line went out.
    expect(line().value).toBe('');
  });

  it('Enter is the same press as the button, and never sends twice', async () => {
    const wire = fakeConsole();
    render(<MachinesScope />);
    fireEvent.click(armed());
    fireEvent.change(line(), { target: { value: 'M491' } });
    fireEvent.keyDown(line(), { key: 'Enter' });

    await waitFor(() => expect(screen.getByTestId('manage-console-entry-0')).not.toBeNull());
    expect(wire.sent).toEqual(['M491']);
    // And with the box unticked, Enter does nothing at all.
    fireEvent.change(line(), { target: { value: '?' } });
    fireEvent.click(armed());
    fireEvent.keyDown(line(), { key: 'Enter' });
    expect(wire.sent).toEqual(['M491']);
  });

  it('a line that timed out stays in the box, and says what arrived instead of a reply', async () => {
    fakeConsole((l) => ({ ok: false, reason: 'timeout', line: l, detail: 'no reply within 60000 ms', text: '' }));
    render(<MachinesScope />);
    fireEvent.click(armed());
    fireEvent.change(line(), { target: { value: 'M491' } });
    fireEvent.click(send());

    await waitFor(() => expect(q('manage-console-entry-0')).not.toBeNull());
    expect(screen.getByTestId('manage-console-entry-0').getAttribute('data-kind')).toBe('timeout');
    expect(screen.getByTestId('manage-console-note-0').textContent).toContain('no reply within');
    // Not cleared: the line is the only copy of what was typed, and it is worth looking at again.
    expect(line().value).toBe('M491');
  });

  it('survives React’s StrictMode remount, which runs the close effect once on mount', async () => {
    // Found by browser QA on 2026-10-12, not here: `npm run dev:desktop` runs StrictMode, whose
    // mount-then-cleanup closed the console before the first press and answered "this console is
    // closed". This is the same panel under the same condition, so it cannot come back.
    const wire = fakeConsole();
    render(
      <StrictMode>
        <MachinesScope />
      </StrictMode>,
    );
    fireEvent.click(armed());
    fireEvent.change(line(), { target: { value: '?' } });
    fireEvent.click(send());

    await waitFor(() => expect(q('manage-console-entry-0')).not.toBeNull());
    expect(wire.sent).toEqual(['?']);
    expect(screen.getByTestId('manage-console-entry-0').getAttribute('data-kind')).toBe('sent');
  });

  it('closes the console when the card goes away', async () => {
    const wire = fakeConsole();
    const view = render(<MachinesScope />);
    fireEvent.click(armed());
    fireEvent.change(line(), { target: { value: '?' } });
    fireEvent.click(send());
    await waitFor(() => expect(wire.sent).toEqual(['?']));
    expect(wire.closes).toBe(0);

    view.unmount();
    await waitFor(() => expect(wire.closes).toBe(1));
  });

  it('copies the transcript to the clipboard, which is the only record there is', async () => {
    const writes: string[] = [];
    const clipboard = { writeText: (t: string) => (writes.push(t), Promise.resolve()) };
    const had = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    try {
      fakeConsole();
      render(<MachinesScope />);
      // Nothing has been sent, so there is nothing to copy and no button offering it.
      expect(q('manage-console-copy')).toBeNull();

      fireEvent.click(armed());
      fireEvent.change(line(), { target: { value: '?' } });
      fireEvent.click(send());
      await waitFor(() => expect(q('manage-console-transcript')).not.toBeNull());

      fireEvent.click(screen.getByTestId('manage-console-copy'));
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]).toContain('console transcript — 192.168.10.43:2222');
      expect(writes[0]).toContain('> ?');
      expect(writes[0]).toContain('ok');
      await waitFor(() =>
        expect(screen.getByTestId('manage-console-status').textContent).toBe('Transcript copied.'),
      );
    } finally {
      if (had) Object.defineProperty(navigator, 'clipboard', had);
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });

  it('Clear empties the panel’s transcript and nothing else', async () => {
    const wire = fakeConsole();
    render(<MachinesScope />);
    fireEvent.click(armed());
    fireEvent.change(line(), { target: { value: '?' } });
    fireEvent.click(send());
    await waitFor(() => expect(q('manage-console-entry-0')).not.toBeNull());

    fireEvent.click(screen.getByTestId('manage-console-clear'));
    expect(q('manage-console-transcript')).toBeNull();
    // The connection is the session's, and clearing a transcript is not a reason to drop it.
    expect(wire.closes).toBe(0);
  });
});

// #386 item 3 — output that arrived with no line in flight. `protocol.ts` keeps it out of `text`; this
// pins the half the person sees: it is drawn ABOVE the reply, labelled as answering nothing, and a
// line whose only company was an old frame is still a line nothing answered.
describe('#386 item 3 — a frame that arrived with no line in flight', () => {
  beforeEach(() => {
    caps.drive = true;
    withMachine();
  });

  /** The bench's real case: `M491`'s macro tail, still on the wire when the next line went out. */
  const M491_TAIL = 'M492.3\r\nERROR: Probe dead or not set, please charge or set first!\r\nok\r\n';

  it('is drawn beside the reply, never merged into it, and not counted as the line’s own', async () => {
    fakeConsole((l) => ({
      ok: true,
      line: l,
      text: '<Idle|MPos:0,0,0>',
      frames: 1,
      elapsedMs: 40,
      carried: { text: M491_TAIL, frames: 3 },
    }));
    render(<MachinesScope />);
    fireEvent.click(armed());
    fireEvent.change(line(), { target: { value: '?' } });
    fireEvent.click(send());

    await waitFor(() => expect(q('manage-console-carried-0')).not.toBeNull());
    const carried = screen.getByTestId('manage-console-carried-0');
    expect(carried.textContent).toContain('no line was in flight');
    expect(carried.textContent).toContain('not a reply to anything above');
    expect(carried.textContent).toContain('ERROR: Probe dead or not set');
    expect(carried.querySelector('pre')?.textContent).toBe(M491_TAIL);
    // The reply is the line's own and NOTHING else: the carried text is nowhere in it. That is the
    // property the whole change exists for — a late `ERROR:`/`ALARM:` read as the answer to `?`.
    const entry = screen.getByTestId('manage-console-entry-0');
    const own = [...entry.querySelectorAll('pre')].filter((p) => p.closest('.console-carried') === null);
    expect(own.map((p) => p.textContent)).toEqual(['<Idle|MPos:0,0,0>']);
    // Its timing is its own too: three frames that answered nothing are not folded into "1 frame".
    expect(screen.getByTestId('manage-console-note-0').textContent).toBe('1 frame · 40 ms');
  });

  it('a line nothing answered is still a timeout when an old alarm was waiting', async () => {
    fakeConsole((l) => ({
      ok: false,
      reason: 'timeout',
      line: l,
      detail: 'no reply within 60000 ms',
      text: '',
      carried: { text: '[PRB:-9.890,-12.830,-76.700:0]\r\nALARM: Probe fail\r\nok\r\n', frames: 3 },
    }));
    render(<MachinesScope />);
    fireEvent.click(armed());
    fireEvent.change(line(), { target: { value: '?' } });
    fireEvent.click(send());

    await waitFor(() => expect(q('manage-console-entry-0')).not.toBeNull());
    expect(screen.getByTestId('manage-console-entry-0').getAttribute('data-kind')).toBe('timeout');
    // The alarm IS shown — it happened, and hiding it would be its own lie — but above a plain
    // "nothing answered this", which is the plain note, not the partial-reply one.
    expect(screen.getByTestId('manage-console-carried-0').textContent).toContain('ALARM: Probe fail');
    expect(screen.getByTestId('manage-console-note-0').textContent).toBe('no reply within 60000 ms');
  });

  it('the copied transcript marks it as unasked-for, so a paste cannot read as a reply', async () => {
    // Found by reading a bench trace: a transcript pasted into an issue is where a late alarm is
    // read out of context, and the marker is the only thing in the text that says it answered nothing.
    const writes: string[] = [];
    const had = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => (writes.push(t), Promise.resolve()) },
    });
    try {
      fakeConsole((l) => ({
        ok: false,
        reason: 'timeout',
        line: l,
        detail: 'no reply within 60000 ms',
        text: '',
        carried: { text: 'ALARM: Probe fail\r\n', frames: 1 },
      }));
      render(<MachinesScope />);
      fireEvent.click(armed());
      fireEvent.change(line(), { target: { value: '?' } });
      fireEvent.click(send());
      await waitFor(() => expect(q('manage-console-copy')).not.toBeNull());

      fireEvent.click(screen.getByTestId('manage-console-copy'));
      await waitFor(() => expect(writes).toHaveLength(1));
      // Bound once: `writes` is `string[]`, and `noUncheckedIndexedAccess` gives an element the type
      // `string | undefined`, so every `writes[0]` in a call is a tsc error in the tests project.
      const copied = writes[0] ?? '';
      expect(copied).toContain('(no line in flight) ALARM: Probe fail');
      expect(copied.indexOf('> ?')).toBeLessThan(copied.indexOf('(no line in flight)'));
    } finally {
      if (had) Object.defineProperty(navigator, 'clipboard', had);
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
    }
  });
});
