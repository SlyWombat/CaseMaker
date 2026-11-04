/**
 * #964 — THE POSTED PROGRAM'S OWN FACTS, from the file the machine will run.
 *
 * The seven-line scorer's program lines (cycle, air, rapids, cutters) must be read from the POSTED
 * `.nc`, not from the CAM's plan and not from the vendor's marketing number: plan v2 §3 and #956's
 * note both say the estimate is #927's on the posted file. This module does that one job:
 *
 *   parseGcode(text) → move events → #927's `efficiencyOf` on one IR
 *   → cycle seconds, air fraction, rapids / 1,000 feed lines, the cutters that cut.
 *
 * It uses the app's own timing model (`Z1.rapidEstimate`, the same object every panel estimate
 * reads) and the app's own G-code interpreter; it re-derives neither. The vendor's NC goes through
 * the same door, so the two sides of a card are measured by one implementation.
 *
 * A file's moves are split into OPERATIONS at its tool changes: #927 prices the first move of an
 * operation as the entry from the previous operation's last move, so splitting there times the
 * tool-change travel exactly once instead of dropping it.
 */

import { parseGcode } from '@/engine/cnc/gcode/interpreter';
import type { MoveEvent, ParseResult } from '@/engine/cnc/gcode/types';
import {
  efficiencyOf,
  estimateCycleSeconds,
  type CamMove,
  type CamOperation,
  type ToolpathIR,
} from '@/engine/cnc/cam/ir';
import { Z1 } from '@/engine/cnc/machine';
import { cuttingDiameter, flatEndMill, toolFromMkrRecord, type Tool } from '@/engine/cnc/tool';

/** One cutting tool as the posted file uses it. */
export interface CutterUse {
  /** The `T` number the file commanded. */
  number: number;
  name: string;
  shape: string;
  /** The cutter's cutting diameter, mm; null when the record does not state one. */
  cuttingDiameterMm: number | null;
  /** Feed moves made with this tool. */
  feedMoves: number;
}

/** One posted program's measured facts, before any combination across programs. */
export interface PostedFacts {
  label: string;
  /** #927's cycle estimate on the posted file, s: moves + entries + spin-up. */
  cycleSeconds: number;
  rapidSeconds: number;
  feedSeconds: number;
  spinUpSeconds: number;
  /** rapidSeconds / cycleSeconds. */
  airFraction: number;
  rapidMoves: number;
  feedMoves: number;
  /** `rapidMoves / feedMoves × 1000`; 0 for a program that feeds nothing. */
  rapidsPer1000FeedLines: number;
  cutters: CutterUse[];
  /** The vendor's own `;@MKR|TIME|seconds=`, when the file carries one. */
  headerTimeSeconds: number | null;
  spindleRpm: number;
  parseErrors: number;
}

export interface MeasureOptions {
  /** The page's label for the program (defaults to the file name the caller passes). */
  label?: string;
}

/** The modal machine position as moves are replayed; unresolved axes carry the last known value. */
type Tracked = { x: number; y: number; z: number };

const moveOf = (ev: MoveEvent, at: Tracked): { move: CamMove; next: Tracked } => {
  const next: Tracked = {
    x: ev.to[0] ?? at.x,
    y: ev.to[1] ?? at.y,
    z: ev.to[2] ?? at.z,
  };
  const move: CamMove =
    ev.mode === 'rapid'
      ? { kind: 'rapid', x: next.x, y: next.y, z: next.z, ...(ev.a === null ? {} : { a: ev.a }) }
      : { kind: 'feed', x: next.x, y: next.y, z: next.z, f: ev.feed ?? 0, ...(ev.a === null ? {} : { a: ev.a }) };
  return { move, next };
};

/** The tool records a file's header states, keyed by their `number`. */
function headerTools(parse: ParseResult): Map<number, Tool> {
  const tools = new Map<number, Tool>();
  for (const rec of parse.header?.records ?? []) {
    if (rec.tag !== 'TOOL') continue;
    const tool = toolFromMkrRecord(rec);
    if (tool.number !== null) tools.set(tool.number, tool);
  }
  return tools;
}

function headerTime(parse: ParseResult): number | null {
  for (const rec of parse.header?.records ?? []) {
    if (rec.tag !== 'TIME') continue;
    const value = Number.parseFloat(rec.fields['seconds'] ?? '');
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/** The cutter a `T` number names: the header's record when it states one, else the number alone. */
function cutterFor(number: number, tools: Map<number, Tool>): Tool {
  return tools.get(number) ?? { ...flatEndMill(3.175), number };
}

const cutterKey = (c: CutterUse): string => `${c.number}|${c.name}|${c.shape}|${c.cuttingDiameterMm ?? ''}`;

/**
 * Measure one posted program from its TEXT.
 *
 * Every number the seven-line scorer's program lines need, from the app's own parser and timing
 * model. The caller supplies the text (a spec reads the fixture; the page reads the `.nc` it
 * posted), so this function does no I/O and cannot disagree with itself about a path.
 */
export function measurePostedProgram(text: string, opts: MeasureOptions = {}): PostedFacts {
  const parse = parseGcode(text);
  const tools = headerTools(parse);
  const spindleRpm = (() => {
    for (const ev of parse.events) {
      if (ev.kind === 'spindle' && ev.state !== 'off' && ev.rpm !== null && ev.rpm > 0) return ev.rpm;
    }
    return 0;
  })();

  // Walk the event stream into operations, one per tool change, with the position carried across
  // every move exactly as the machine would (an axis a line does not name keeps its last value).
  interface RawOp {
    tool: number;
    moves: CamMove[];
    feedMoves: number;
  }
  const ops: RawOp[] = [];
  let current: RawOp = { tool: 0, moves: [], feedMoves: 0 };
  let at: Tracked = { x: 0, y: 0, z: 0 };
  for (const ev of parse.events) {
    if (ev.kind === 'tool-change') {
      if (current.moves.length > 0) ops.push(current);
      current = { tool: ev.tool, moves: [], feedMoves: 0 };
      continue;
    }
    if (ev.kind !== 'move') continue;
    const { move, next } = moveOf(ev, at);
    at = next;
    current.moves.push(move);
    if (ev.mode === 'cut') current.feedMoves++;
  }
  if (current.moves.length > 0) ops.push(current);

  const rapid = Z1.rapidEstimate;
  const firstTool = cutterFor(ops.find((o) => o.feedMoves > 0)?.tool ?? 0, tools);
  const ir: ToolpathIR = {
    frame: 'flat',
    tool: firstTool,
    toolNumber: firstTool.number ?? 1,
    spindleRpm,
    air: false,
    safeZ: 5,
    hopZ: 1,
    operations: ops.map(
      (o, i): CamOperation => ({
        number: i + 1,
        name: `T${o.tool}`,
        labelId: '',
        depth: 0,
        moves: o.moves,
        estimatedSeconds: estimateCycleSeconds(o.moves, rapid),
      }),
    ),
  };
  const efficiency = efficiencyOf(ir, rapid);

  const cutters = new Map<string, CutterUse>();
  for (const op of ops) {
    if (op.feedMoves === 0) continue;
    const tool = cutterFor(op.tool, tools);
    const use: CutterUse = {
      number: op.tool,
      name: tool.name,
      shape: tool.shape,
      cuttingDiameterMm: cuttingDiameter(tool),
      feedMoves: op.feedMoves,
    };
    const key = cutterKey(use);
    const existing = cutters.get(key);
    if (existing === undefined) cutters.set(key, use);
    else existing.feedMoves += use.feedMoves;
  }

  // The counts are the parser's own summary, the same facts it reports beside every program.
  const feedMoves = parse.summary.cuts;
  const rapidCount = parse.summary.rapids;
  const cycleSeconds = efficiency.cycleSeconds;
  return {
    label: opts.label ?? '',
    cycleSeconds,
    rapidSeconds: efficiency.rapidSeconds,
    feedSeconds: efficiency.feedSeconds,
    spinUpSeconds: efficiency.spinUpSeconds,
    airFraction: efficiency.airFraction,
    rapidMoves: rapidCount,
    feedMoves,
    rapidsPer1000FeedLines: feedMoves > 0 ? (rapidCount / feedMoves) * 1000 : rapidCount > 0 ? Number.POSITIVE_INFINITY : 0,
    cutters: [...cutters.values()].sort((a, b) => b.feedMoves - a.feedMoves),
    headerTimeSeconds: headerTime(parse),
    spindleRpm,
    parseErrors: parse.diagnostics.filter((d) => d.severity === 'error').length,
  };
}

/**
 * Several posted programs as ONE side of a card (a rough and a finish, or a vendor's programs per
 * side): seconds and move counts sum; the air fraction is recomputed over the sums, never averaged;
 * a cutter seen in two programs is one cutter.
 */
export function combinePostedFacts(parts: readonly PostedFacts[]): PostedFacts {
  const cutters = new Map<string, CutterUse>();
  let cycleSeconds = 0;
  let rapidSeconds = 0;
  let feedSeconds = 0;
  let spinUpSeconds = 0;
  let rapidMoves = 0;
  let feedMoves = 0;
  let headerTimeSeconds: number | null = null;
  let spindleRpm = 0;
  let parseErrors = 0;
  for (const p of parts) {
    cycleSeconds += p.cycleSeconds;
    rapidSeconds += p.rapidSeconds;
    feedSeconds += p.feedSeconds;
    spinUpSeconds += p.spinUpSeconds;
    rapidMoves += p.rapidMoves;
    feedMoves += p.feedMoves;
    if (p.headerTimeSeconds !== null) headerTimeSeconds = (headerTimeSeconds ?? 0) + p.headerTimeSeconds;
    spindleRpm = Math.max(spindleRpm, p.spindleRpm);
    parseErrors += p.parseErrors;
    for (const c of p.cutters) {
      const existing = cutters.get(cutterKey(c));
      if (existing === undefined) cutters.set(cutterKey(c), { ...c });
      else existing.feedMoves += c.feedMoves;
    }
  }
  return {
    label: parts.map((p) => p.label).filter((l) => l.length > 0).join(' + '),
    cycleSeconds,
    rapidSeconds,
    feedSeconds,
    spinUpSeconds,
    airFraction: cycleSeconds > 0 ? rapidSeconds / cycleSeconds : 0,
    rapidMoves,
    feedMoves,
    rapidsPer1000FeedLines: feedMoves > 0 ? (rapidMoves / feedMoves) * 1000 : rapidMoves > 0 ? Number.POSITIVE_INFINITY : 0,
    cutters: [...cutters.values()].sort((a, b) => b.feedMoves - a.feedMoves),
    headerTimeSeconds,
    spindleRpm,
    parseErrors,
  };
}
