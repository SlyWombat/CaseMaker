/**
 * CLOSING AND RE-OPENING THE VACUUM SPAN AROUND A MULTI-PROGRAM RUN (#419 decision 4, #469).
 *
 * The programs carry the span themselves: `M331` on the first file, `M332` on the last, neither in
 * between. The release step therefore sends NO vacuum words on a normal change — the vacuum stays on
 * across the bit change, which is the maintainer's rule. It sends one only when the file it is about
 * to play cannot:
 *
 *   - a RESUMED run starts at a middle or last program, which carries no `M331`. The vacuum was
 *     switched off when the previous run stopped, so the release step must switch it on again;
 *   - a file that carries no words at all (`air: false`, or a hand-made pre-#419 program) must not
 *     leave the vacuum in the state the last program left it.
 *
 * And it CLOSES the span when the run stops BETWEEN programs — an operator's Stop at the bit-change
 * pause, or a failure that leaves no program running. `M332` then `$H`, in that order (the bench
 * rule: home after every activity).
 *
 * NEVER BLIND. Every call asks `?` first and sends nothing unless the answer is `Idle` with no alarm.
 * An unreachable or alarmed machine is not a machine to switch a vacuum on or off from here; the
 * outcome says so, and the physical stop/plug is the stop. This is the same rule `machineStop.ts`
 * follows, and the reason this module exists rather than the release store calling `send` itself.
 */

import { attachConsole } from './machineConsole';
import { readProgress } from './machineRun';
import { alarmLine } from './machineUpload';
import { VACUUM_OFF, VACUUM_ON } from './machineVacuum';

export type SpanOutcome =
  /** The line(s) went out, with the status line that let them. */
  | { kind: 'done'; status: string; sent: readonly string[] }
  /** The machine answered, but not Idle (or in an alarm): nothing was sent. */
  | { kind: 'not-idle'; status: string | null; detail: string; sent?: readonly string[] }
  /** The poll or a command failed or went unanswered: nothing more was sent. */
  | { kind: 'failed'; detail: string; sent: readonly string[] };

type Target = { host: string; port: number };

function sentence(r: { kind: string; text?: string; detail?: string }): string {
  if (r.kind === 'sent' && typeof r.text === 'string') return r.text.trim();
  if (r.kind === 'timeout') return 'the line was sent but the controller did not answer';
  return typeof r.detail === 'string' ? r.detail : r.kind;
}

/**
 * Ask `?`, require Idle with no alarm and no program paused mid-job, then send `lines` in order.
 * The one place both calls below make that decision, so "is it safe to send?" cannot differ.
 */
async function sendWhenIdle(target: Target, lines: readonly string[]): Promise<SpanOutcome> {
  const session = attachConsole(target);
  const sent: string[] = [];
  try {
    const q = await session.send('?');
    if (q.kind !== 'sent') {
      return { kind: 'failed', detail: `the machine did not answer a status poll (${sentence(q)})`, sent };
    }
    const alarm = alarmLine(q.text);
    if (alarm !== null) {
      return { kind: 'not-idle', status: q.text, detail: `the controller is in an alarm (\`${alarm}\`)` };
    }
    const p = readProgress(q.text);
    if (p.state !== 'Idle') {
      return { kind: 'not-idle', status: q.text, detail: `the controller reports ${p.state ?? 'no state'}, not Idle` };
    }
    // Idle with a program below 100 % is the 3–4 s pause at `M05`, not a free machine — the same
    // reading `runProgram` refuses to start on.
    if (p.percent !== null && p.percent < 100) {
      return { kind: 'not-idle', status: q.text, detail: `the controller reads Idle with a program at ${p.percent} %` };
    }
    for (const line of lines) {
      const r = await session.send(line);
      sent.push(line);
      if (r.kind !== 'sent') {
        return { kind: 'failed', detail: `${line} could not be confirmed (${sentence(r)})`, sent };
      }
      const a = alarmLine(r.text);
      if (a !== null) {
        return { kind: 'not-idle', status: r.text, detail: `the controller said \`${a}\` after ${line}`, sent };
      }
    }
    return { kind: 'done', status: q.text, sent };
  } finally {
    await session.close();
  }
}

/** `M331`: switch the vacuum on, only on a machine that is Idle with no alarm. */
export async function switchVacuumOn(target: Target): Promise<SpanOutcome> {
  return sendWhenIdle(target, [VACUUM_ON]);
}

/**
 * `M332` then `$H`: close the span after a Stop or a failure between programs. Only on an Idle
 * machine — after an abort the run panel offers Home instead and this is not called.
 */
export async function closeVacuumSpan(target: Target): Promise<SpanOutcome> {
  return sendWhenIdle(target, [VACUUM_OFF, '$H']);
}
