/**
 * The console panel (#302 item 4) — one typed line to the controller, drawn under the machine card.
 *
 * WHAT THIS IS FOR. The bridge can send a line and read what came back, and until now nothing in the
 * app could ask it to: a person with a machine on the bench had to reach for the harness. This is the
 * panel that closes that gap, and it is deliberately the smallest thing that does: one line, one
 * press, the reply beside it.
 *
 * THE THREE DECISIONS (maintainer, 2026-10-12, #302):
 *
 *   1. it sits COLLAPSED under the machine card in Manage → Machines, desktop build only;
 *   2. an "I am at the machine" checkbox, ticked once per session, and every line still needs its
 *      own Send press — no auto-repeat, no queued script, no history replay;
 *   3. the record is a copy-transcript button. Nothing is written to disk, so there is no trace file
 *      to leak a controller's output into a shared folder.
 *
 * THE PLACEMENT HAS NO FRAME IN THE MOCKUP. `docs/assets/cnc-mockup.html` draws no console, so this
 * follows decision 1 rather than a drawing, and the fact is noted on #311 (the machines surface).
 *
 * WHERE THE RULES LIVE. The guard clauses are `engine/cnc/consoleGate.ts`, asked by the seam
 * (`platform/machineConsole.ts`) before any socket opens and by the sink again. This panel asks the
 * same predicate for the sentence it shows, so the text beside the box and the text in a refusal are
 * one string, not two that agree today.
 *
 * WHAT IS NOT HERE. No `!` or `~` (the realtime bytes stay unwired — see #303). No jog, no DRO, no
 * "run file": a job arrives as a verified program through the upload path, and that is the only way
 * a `.nc` reaches the machine. **The physical stop is the stop** — this panel has no hold, and the
 * person at the machine is the safeguard (`/Fabrication.md` §8).
 */

import { useEffect, useMemo, useState } from 'react';
import { consoleProblem } from '@/engine/cnc/consoleGate';
import { canDriveMachine } from '@/platform/capabilities';
import { attachConsole, type ConsoleSendResult } from '@/platform/machineConsole';

/** One exchange: what was typed, what came back, and what to say about it. */
interface Entry {
  line: string;
  kind: ConsoleSendResult['kind'];
  /** The controller's reply, verbatim — empty when there was none. */
  text: string;
  /** The aside: the elapsed time and frame count, or why there is no reply. */
  note: string;
}

/** The panel, or nothing at all in a build that cannot open a socket. Read at render, not at import. */
export function MachineConsole({ host, port }: { host: string; port: number }) {
  return canDriveMachine ? <ConsolePanel host={host} port={port} /> : null;
}

function ConsolePanel({ host, port }: { host: string; port: number }) {
  // One console for as long as the card is on screen. Creating it opens NOTHING: the socket appears
  // with the first line that is actually sent, and is closed when the card goes away.
  const session = useMemo(() => attachConsole({ host, port }), [host, port]);
  useEffect(() => () => void session.close(), [session]);

  // Session state, in the component and nowhere else (#302 decision 2): closing the panel or
  // reloading asks again, which is the point of asking.
  const [armed, setArmed] = useState(false);
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [note, setNote] = useState<string | null>(null);

  // Live, before anything is pressed and before any socket exists. The same predicate the seam asks.
  const problem = consoleProblem(line);
  const blank = line.trim().length === 0;
  const canSend = armed && !blank && problem === null && !busy;

  async function send(): Promise<void> {
    if (!canSend) return;
    const text = line;
    setBusy(true);
    try {
      const result = await session.send(text);
      setEntries((prev) => [...prev, entryFor(result)]);
      // The box keeps a line that did not get through — a refusal and a timeout are both things to
      // look at again, and clearing them would throw away the only copy of what was typed.
      if (result.kind === 'sent') setLine('');
      setNote(null);
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    const why = await copyText(transcriptText(host, port, entries));
    setNote(why ?? 'Transcript copied.');
  }

  return (
    <details className="mconsole" data-testid="manage-console">
      <summary data-testid="manage-console-summary">
        Console
        {entries.length > 0 && <span className="dim"> · {entries.length} line{entries.length === 1 ? '' : 's'}</span>}
      </summary>

      <p className="hint" data-testid="manage-console-hint">
        One line at a time, sent when you press Send. The machine's own command line — for a status
        or a probe, not for a job: a program arrives through the verified upload above. Nothing here
        can hold or stop a move; <b>the physical stop is the stop</b>, and anything that moves needs
        you standing at the machine.
      </p>

      <label className="console-armed" title="A console line can move the machine, so this is asked once per session rather than remembered.">
        <input
          type="checkbox"
          checked={armed}
          onChange={(e) => setArmed(e.target.checked)}
          data-testid="manage-console-armed"
        />
        I am at the machine
      </label>

      <div className="console-row">
        <input
          className="fld fld--text mono"
          type="text"
          value={line}
          placeholder="? or M491"
          aria-label="A console line to send to the machine"
          data-testid="manage-console-line"
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            // Enter is an explicit press of Send and nothing more: it never repeats, and it never
            // fires on a line the button itself would refuse.
            if (e.key === 'Enter') {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className="btn btn--primary"
          data-testid="manage-console-send"
          disabled={!canSend}
          // The reason sits on the button as well as in the panel: a disabled control with no
          // explanation is the failure this app refuses to ship (the tool editor's own pattern).
          title={sendTitle(armed, blank, problem, busy)}
          onClick={() => void send()}
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>

      {problem !== null && !blank && (
        <p className="hint console-refusal" data-testid="manage-console-refusal">
          {problem}
        </p>
      )}

      {entries.length > 0 && (
        <>
          <div className="console-transcript" data-testid="manage-console-transcript" aria-live="polite">
            {entries.map((e, i) => (
              <div key={i} className="console-entry" data-testid={`manage-console-entry-${i}`} data-kind={e.kind}>
                <div className="console-line">
                  <span className="dim">&gt;</span> {e.line}
                </div>
                {e.text.length > 0 && <pre className="console-reply">{e.text}</pre>}
                <div className="console-note" data-testid={`manage-console-note-${i}`}>
                  {e.note}
                </div>
              </div>
            ))}
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn--sm"
              data-testid="manage-console-copy"
              title="Copy what was typed and what came back, as text"
              onClick={() => void copy()}
            >
              Copy transcript
            </button>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="manage-console-clear"
              title="Clear the panel's own transcript. Nothing on the machine changes."
              onClick={() => {
                setEntries([]);
                setNote(null);
              }}
            >
              Clear
            </button>
          </div>
        </>
      )}

      {note !== null && (
        <p className="hint" data-testid="manage-console-status">
          {note}
        </p>
      )}
    </details>
  );
}

/** The one press's answer, as a transcript entry. */
function entryFor(result: ConsoleSendResult): Entry {
  switch (result.kind) {
    case 'sent':
      return {
        line: result.line,
        kind: 'sent',
        text: result.text,
        note: `${result.frames} frame${result.frames === 1 ? '' : 's'} · ${result.elapsedMs} ms`,
      };
    case 'timeout':
      return {
        line: result.line,
        kind: 'timeout',
        text: result.text,
        // A half-reply and an empty box are different things to read, so they are said differently.
        note:
          result.text.length === 0
            ? result.detail
            : `${result.detail} — the partial reply above is what did arrive`,
      };
    case 'refused':
    case 'error':
    case 'unavailable':
      return { line: result.line, kind: result.kind, text: '', note: result.detail };
  }
}

/** Why Send is off, in the words of whichever thing turned it off. */
function sendTitle(armed: boolean, blank: boolean, problem: string | null, busy: boolean): string {
  if (busy) return 'Waiting for the controller to answer';
  if (!armed) return 'Tick “I am at the machine” first — a console line can move it';
  if (blank) return 'Type a line to send';
  if (problem !== null) return problem;
  return 'Send this line to the controller, now';
}

/** The transcript as plain text: what was typed, what came back, and the aside. */
function transcriptText(host: string, port: number, entries: readonly Entry[]): string {
  // The machine and port are named because that is what the panel knows; no time is claimed, because
  // the transcript holds none (the elapsed figure is per line, and a wall clock the panel never read
  // would be an invention).
  const head = `console transcript — ${host}:${port}`;
  const body = entries.map((e) =>
    [`> ${e.line}`, e.text.length > 0 ? e.text : '', `· ${e.note}`].filter((s) => s.length > 0).join('\n'),
  );
  return [head, ...body].join('\n\n');
}

/**
 * Put `text` on the clipboard. Returns null when it landed, or the reason it did not — the same
 * contract `MachinesScope`'s `saveText` uses, and for the same reason: a copy that silently did
 * nothing is the one failure the user has no way to notice.
 */
async function copyText(text: string): Promise<string | null> {
  try {
    if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return null;
    }
  } catch {
    // A refused clipboard (an insecure origin, a denied permission) falls through to the fallback
    // rather than ending the attempt: the selection copy below still works in most of those cases.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok ? null : 'this browser would not copy — select the transcript and copy it by hand';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
