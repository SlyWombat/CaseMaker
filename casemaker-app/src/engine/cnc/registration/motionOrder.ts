// #1199 — THE SAFE-Z INVARIANT, one guard every probing session shares.
//
// The bench's 2026-11-10 seat press (build c8fa03a6) sent, at home, `G53 G0 Z-81.25` and then a
// 177 mm `G53 G0 X-175 Y-35`: the traverse ran 7 mm above the board, below the blank's top and the
// clamp, and bent fx-probe-1's shaft. The height was right for the DESCENT — the band's approach —
// but a traverse must never be taken there.
//
// THE RULE IS STRUCTURAL, so a future routine cannot skip it: an XY move is allowed ONLY when the
// last commanded machine Z is the machine's clearance or above. A descent at the point to be probed
// is the only way the head may go lower, and any probe that leaves it lower makes the Z unknown
// (or the trigger height) — so the next XY move must lift first. The guard is fed every line a
// probing session sends (`execute.ts` → `session()`), and returns a sentence instead of sending.
//
// It reads the app's own line grammar: only `G53 G0 Z…` states a machine Z. A work-coordinate
// `G0 Z…` says nothing about the machine (the work zero may sit tens of millimetres down), so it
// makes the Z UNKNOWN — conservative on purpose.

import { lastPrb } from './readings';

export interface MotionOrderGuard {
  /**
   * Feed one line, in the order the session sends it, with the controller's reply when there is
   * one. Returns null for a line that may go out, or the refusal sentence for an XY move the
   * invariant forbids. The caller must not send the refused line.
   */
  observe(line: string, reply?: string): string | null;
  /** The check ALONE, before the line is sent: what {@link observe} refuses, with no state change. */
  check(line: string): string | null;
  /** The state change alone, after the line went out and its reply is known. */
  commit(line: string, reply?: string): void;
  /** The last commanded machine Z (Infinity after a home), or null when unknown. */
  lastMachineZ(): number | null;
}

const f = (n: number): string => (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';

/** A `G53 G0 Z…` line's machine Z, or null. G53 is machine-coordinate and absolute whatever G91. */
function machineZOf(line: string): number | null {
  const m = /^G53\s+G0\s+Z(-?\d+(?:\.\d+)?)$/.exec(line.trim());
  return m === null ? null : Number(m[1]);
}

/** Whether a line commands XY motion (a rapid in either coordinate system). Probes are not moves. */
function isXYMove(line: string): boolean {
  const l = line.trim();
  if (!/^(?:G53\s+)?G[01]\b/.test(l)) return false;
  if (/\bZ-?\d/.test(l)) return false;
  return /\b[XY]-?\d/.test(l);
}

/** The trigger Z of a Z probe's reply (`[PRB:x,y,z:1]`), or null when the reply carries none. */
function triggerZOf(reply: string | undefined): number | null {
  return reply ? (lastPrb(reply)?.z ?? null) : null;
}

/**
 * @param clearanceZ the machine's own travel height, MACHINE Z (`toolChange.clearanceZ`): the
 *                   lowest Z at which an XY traverse may be taken.
 */
export function motionOrderGuard(clearanceZ: number): MotionOrderGuard {
  let lastZ: number | null = null;

  const check = (line: string): string | null => {
    const l = line.trim();
    if (!isXYMove(l)) return null;
    if (lastZ === null) {
      return (
        'refusing to move X/Y: the head is at an unknown Z — lift to the machine\'s clearance ' +
        `${f(clearanceZ)} with G53 G0 Z, then traverse, and descend only at the point to be probed`
      );
    }
    if (!(lastZ >= clearanceZ - 1e-9)) {
      return (
        `refusing to move X/Y from machine Z ${f(lastZ)}: a traverse on a probing run is taken at the machine's ` +
        `clearance ${f(clearanceZ)} or higher — lift first, then move, and descend only at the point to be probed`
      );
    }
    return null;
  };

  const commit = (line: string, reply?: string): void => {
    const l = line.trim();
    if (l === '$H') {
      // Homing puts the head at the top of its travel; whatever came before is history.
      lastZ = Number.POSITIVE_INFINITY;
      return;
    }
    if (isXYMove(l)) return; // XY never changes Z.
    if (/^G53\s+G0\s+Z-?\d/.test(l)) {
      lastZ = machineZOf(l);
      return;
    }
    if (l === 'G91' || l === 'G90') return;
    const probe = /^G38\.3\s+([XYZ])/.exec(l);
    if (probe !== null) {
      if (probe[1] === 'Z') lastZ = triggerZOf(reply);
      return;
    }
    // Any other line that moves Z (a work-coordinate G0 Z, a G28/G30) hides the machine Z.
    if (/^(?:G53\s+)?G[01]\b/.test(l) && /\bZ-?\d/.test(l)) lastZ = null;
  };

  return {
    lastMachineZ: () => lastZ,
    check,
    commit,
    observe(line: string, reply?: string): string | null {
      const problem = check(line);
      if (problem !== null) return problem;
      commit(line, reply);
      return null;
    },
  };
}
