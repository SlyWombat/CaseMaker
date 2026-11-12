/**
 * #1233 follow-up — A VENDOR PROGRAM ON OUR CLOCK.
 *
 * Makera Studio's own posted NC carries a `;@MKR|TIME` header: its estimate, on its clock. Ours is the
 * estimator's (`estimateCycleSeconds`: the Z1 rapid model, the trapezoid, the corner rule). The two are not
 * the same clock, and on the one job timed on the machine ours matched the stopwatch. So the comparison
 * parses the vendor's program move by move, times it with OUR estimator, prices its tool changes with the
 * #1114 curve (the recommended rule, each change priced from the program time before it), and takes every
 * ratio on that figure. The header is printed beside it and never divided by.
 *
 * Pure over the program's text. The vendor program is fixed, so the figure is the same in every run.
 */
import { estimateCycleSeconds, moveSeconds, rapidRate, type CamMove } from '../../src/engine/cnc/cam/ir';
import { Z1 } from '../../src/engine/cnc/machine';
import { BIT_CHANGE_RECOMMENDED, bitChangePriceSeconds } from '../../src/engine/cnc/cam/model/bitChange';

export interface VendorClock {
  /** The program's moves on our clock, s (entries between toolpaths of one cutter included). */
  moveSeconds: number;
  /** Tool changes after the first cutter. */
  changes: number;
  /** Those changes priced on the #1114 curve, s. */
  changeSeconds: number;
  /** moveSeconds + changeSeconds: the figure every ratio uses. */
  totalSeconds: number;
  /** The program's own `;@MKR|TIME` header, s, or null when it states none. */
  header: number | null;
}

interface Toolpath {
  tool: number;
  moves: CamMove[];
  entryFrom: CamMove | null;
}

function toolpathsOf(text: string): { toolpaths: Toolpath[]; header: number | null } {
  const toolpaths: Toolpath[] = [];
  let header: number | null = null;
  let x = 0;
  let y = 0;
  let z = 0;
  let f = 0;
  let mode: 0 | 1 = 0;
  let cur = 0;
  let tp: Toolpath | null = null;
  let last: CamMove | null = null;
  const open = (): Toolpath => {
    tp = { tool: cur, moves: [], entryFrom: null };
    toolpaths.push(tp);
    return tp;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith(';')) {
      if (line.startsWith(';@MKR|TIME|')) header = Number(line.split('seconds=')[1]);
      else if (line.startsWith(';@MKR|TOOLPATH_START') && (tp === null || (tp as Toolpath).moves.length > 0)) open();
      continue;
    }
    const code = line.split(';')[0]!;
    if (/\bG(28|53|92)\b/.test(code)) continue;
    const words = [...code.matchAll(/([GMTXYZFS])\s*(-?\d*\.?\d+)/g)].map((m) => [m[1]!, Number(m[2])] as const);
    const has = (c: string, v: number): boolean => words.some(([k, n]) => k === c && n === v);
    const t = words.find(([k]) => k === 'T');
    if (t !== undefined && has('M', 6)) {
      cur = t[1];
      if (tp !== null && (tp as Toolpath).moves.length === 0) (tp as Toolpath).tool = cur;
      else if (tp !== null) open();
      continue;
    }
    if (has('G', 0)) mode = 0;
    else if (has('G', 1)) mode = 1;
    let moved = false;
    for (const [k, n] of words) {
      if (k === 'X') { x = n; moved = true; }
      else if (k === 'Y') { y = n; moved = true; }
      else if (k === 'Z') { z = n; moved = true; }
      else if (k === 'F') f = n;
    }
    if (!moved) continue;
    const path = tp ?? open();
    const mv: CamMove = mode === 0 ? { kind: 'rapid', x, y, z } : { kind: 'feed', x, y, z, f };
    if (path.moves.length === 0) path.entryFrom = last;
    path.moves.push(mv);
    last = mv;
  }
  return { toolpaths: toolpaths.filter((p) => p.moves.length > 0), header };
}

export function vendorClock(text: string): VendorClock {
  const { toolpaths, header } = toolpathsOf(text);
  const rapid = Z1.rapidEstimate!;
  let moves = 0;
  let changes = 0;
  let changeSeconds = 0;
  let preceding = 0;
  let lastTool: number | null = null;
  for (const tp of toolpaths) {
    let s = estimateCycleSeconds(tp.moves, rapid);
    if (lastTool === tp.tool && tp.entryFrom !== null) {
      // the entry rapid between two toolpaths of one cutter, from where the machine was left (#927)
      const a = tp.entryFrom;
      const b = tp.moves[0]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      s += moveSeconds(Math.hypot(dx, dy, dz), rapidRate(rapid, dx, dy, dz), rapid.accelMmPerS2);
    }
    if (lastTool !== null && lastTool !== tp.tool) {
      changes += 1;
      changeSeconds += bitChangePriceSeconds(BIT_CHANGE_RECOMMENDED, preceding);
      preceding = 0;
    }
    lastTool = tp.tool;
    preceding += s;
    moves += s;
  }
  return { moveSeconds: moves, changes, changeSeconds, totalSeconds: moves + changeSeconds, header };
}
