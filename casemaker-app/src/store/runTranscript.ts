/**
 * #1208 (bounded) — A RUN'S CONVERSATION, FOR ITS STOP REPORT.
 *
 * The report's transcript is `{line, reply}` pairs: which line went out, and what came back. A
 * run sends a handful of COMMANDS (the vacuum words, `play`, Stop's `abort`/`M490.2`, `$H`) and a
 * status poll `?` every 2 s — thousands of exchanges over a long run. Keeping every one of them,
 * and copying the whole array on every poll, is the #1147 memory-retention class the manager
 * caught: ~5,400 raw status replies in the store and in a shipped report after 3 h, with
 * quadratic copying behind them.
 *
 * So the rule is split:
 *  - every COMMAND is kept whole and in order — they are few and each one is the diagnosis;
 *  - only the last N status exchanges are held, in a FIXED RING (`report.statusPollsKept`, a #1207
 *    shop key): the tail is what a dead-link report needs, and a ring never copies on append.
 * {@link RunTranscript.droppedPolls} says how many status exchanges the report no longer carries.
 *
 * The view is chronological: commands keep their send positions among the kept polls, and a
 * command sent after an early poll is still there when that poll has rolled out of the ring.
 */
import type { StopTranscriptEntry } from '@/platform/machineStopReport';

export interface RunTranscriptView {
  /** The conversation to report: commands whole, plus the kept status exchanges, in send order. */
  entries: StopTranscriptEntry[];
  /** Status exchanges the ring dropped; 0 when the report carries the whole run. */
  droppedPolls: number;
}

interface SeqEntry {
  /** The exchange's place in the run, so the kept polls merge back into it in order. */
  seq: number;
  entry: StopTranscriptEntry;
}

export class RunTranscript {
  /** The ring's fixed size — `report.statusPollsKept`, never a literal at the call site. */
  readonly keepPolls: number;
  private readonly commands: SeqEntry[] = [];
  /** Fixed length; a push overwrites the oldest slot. Never grows, never copies. */
  private readonly ring: (SeqEntry | undefined)[];
  private cursor = 0;
  private held = 0;
  private seq = 0;
  private dropped = 0;

  constructor(keepPolls: number) {
    const size = Number.isFinite(keepPolls) ? Math.floor(keepPolls) : 1;
    this.keepPolls = Math.max(1, size);
    this.ring = new Array<SeqEntry | undefined>(this.keepPolls);
  }

  /** Status exchanges currently held (at most {@link keepPolls}). */
  get pollsHeld(): number {
    return this.held;
  }

  /** Append one exchange. `poll` is true only for the status line `?`. */
  push(line: string, reply: string, poll: boolean): void {
    const at = this.seq;
    this.seq += 1;
    if (!poll) {
      this.commands.push({ seq: at, entry: { line, reply } });
      return;
    }
    if (this.held === this.ring.length) this.dropped += 1;
    else this.held += 1;
    this.ring[this.cursor] = { seq: at, entry: { line, reply } };
    this.cursor = (this.cursor + 1) % this.ring.length;
  }

  /**
   * The report's conversation. Built only when a report is asked for — never on the poll path —
   * so the run itself pays one fixed-size slot per status read, not a copy of everything.
   */
  view(): RunTranscriptView {
    const kept: SeqEntry[] = [];
    for (const entry of this.ring) if (entry !== undefined) kept.push(entry);
    kept.sort((a, b) => a.seq - b.seq);
    const merged = [...this.commands, ...kept].sort((a, b) => a.seq - b.seq);
    return { entries: merged.map((item) => item.entry), droppedPolls: this.dropped };
  }
}
