/**
 * §3.4 — HOW A BOARD'S HOLES ARE CUT (#743 P-4b).
 *
 * The Gerber set says where the holes are and how wide; it cannot say what is in the tool box. The
 * design's rule, in order, for each hole size:
 *
 *   1. an owned drill or end mill whose ⌀ is the hole's, up to +0.1 mm and never under (Q7) — the
 *      item plunges (`mode: 'drill'`);
 *   2. otherwise a flat end mill narrower than the hole — the item is BORED to size
 *      (`mode: 'bore'`, helixed down);
 *   3. otherwise nothing owned can make it: the mode stays `'drill'` and the job's own checks name
 *      the missing cutter at the item. The import never refuses the board for a cutter it lacks —
 *      the copper, outline and cut-out are still worth importing.
 *
 * Pure: the caller hands in the owned entries (`getTools()` in the app and the CLI).
 */

import { cuttingDiameter } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';

/** The most a drill or end mill may be OVER its hole and still make it (design Q7), mm. */
export const PCB_DRILL_SLACK_MM = 0.1;

export interface PcbHoleAssignment {
  /** Drill item id → the mode its own hole's cutter asks for. */
  modes: ReadonlyMap<string, 'drill' | 'bore'>;
  /** One sentence per size that is BORED rather than drilled. */
  notes: string[];
}

/** `0.8` — a hole's size without a trailing zero run. */
function mm(v: number): string {
  return `${Number(v.toFixed(3))}`;
}

/**
 * Assign each imported drill item its mode. Sizes are compared to the micron, so a parser's 0.7999
 * and a catalogue's 0.8 are one size.
 */
export function pcbHoleAssignment(
  drills: readonly { id: string; diameter?: number }[],
  tools: readonly ToolLibraryEntry[],
): PcbHoleAssignment {
  const cutters = tools.flatMap((entry) => {
    const d = cuttingDiameter(entry.tool);
    return d === null || d <= 0 ? [] : [{ key: entry.key, shape: entry.tool.shape, diameter: d }];
  });
  const modes = new Map<string, 'drill' | 'bore'>();
  const notes: string[] = [];

  /** The decision for one size, computed once for every item of that size. */
  const decide = (hole: number): 'drill' | 'bore' => {
    // 1 · an owned drill or end mill of the hole's size (never under, at most +0.1 mm over).
    const exact = cutters
      .filter(
        (c) =>
          (c.shape === 'drill' || c.shape === 'flat') &&
          c.diameter >= hole - 1e-9 &&
          c.diameter <= hole + PCB_DRILL_SLACK_MM + 1e-9,
      )
      .sort((a, b) =>
        a.shape === b.shape ? a.diameter - b.diameter : a.shape === 'drill' ? -1 : 1,
      )[0];
    if (exact !== undefined) return 'drill';
    // 2 · a flat end mill narrower than the hole bores it to size.
    const borer = cutters
      .filter((c) => c.shape === 'flat' && c.diameter < hole - 1e-9)
      .sort((a, b) => b.diameter - a.diameter)[0];
    return borer === undefined ? 'drill' : 'bore';
  };

  const bySize = new Map<string, 'drill' | 'bore'>();
  for (const drill of drills) {
    const hole = drill.diameter;
    if (hole === undefined || !(hole > 0)) {
      modes.set(drill.id, 'drill');
      continue;
    }
    const key = hole.toFixed(3);
    let mode = bySize.get(key);
    if (mode === undefined) {
      mode = decide(hole);
      bySize.set(key, mode);
      if (mode === 'bore') {
        const count = drills.filter((d) => d.diameter !== undefined && d.diameter.toFixed(3) === key).length;
        notes.push(
          `No owned ⌀${mm(hole)} mm drill or end mill within +${PCB_DRILL_SLACK_MM} mm; ` +
            `the ${count} ⌀${mm(hole)} hole${count === 1 ? ' is' : 's are'} bored to size with a flat end mill.`,
        );
      }
    }
    modes.set(drill.id, mode);
  }
  return { modes, notes };
}
