/**
 * §3.4 — WHAT CUTS A BOARD (#743 P-4b, extended 2026-10-31).
 *
 * The Gerber set says where the holes are and how wide; it cannot say what is in the tool box. The
 * design's rules, in order:
 *
 *   - the ISOLATION is cut by an engraving bit: the owned cone with the smallest tip, preferring the
 *     one Makera's catalogue answers for PCB (design §3.4);
 *   - each HOLE SIZE is drilled by an owned drill or end mill whose ⌀ is the hole's, up to +0.1 mm
 *     and never under (Q7); otherwise it is BORED by a flat end mill narrower than the hole; and
 *     when nothing owned can make it the mode stays `'drill'` and the job's own checks name the
 *     missing cutter at the item (`hole-no-cutter`);
 *   - the CUT-OUT is cut by an owned flat (a corn bit on a PCB) whose flute reaches through the
 *     board, preferring one the catalogue answers for PCB.
 *
 * The plan is written into the setup as `tools` + `toolItems` (#472/#746), so a board arrives with
 * its three cutter programs already assigned and the operator only confirms them. When a role has
 * no cutter the import still succeeds: the rest of the board is worth importing, and the missing
 * role is stated.
 *
 * Pure: the caller hands in the owned entries (`getTools()` in the app and the CLI) and, when it
 * has one, the catalogue rows.
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { catalogueCoverageFor, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { vCone, vFluteLength } from '@/engine/cnc/vProfile';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { JobSetup } from '@/types/engraveJob';

/** The most a drill or end mill may be OVER its hole and still make it (design Q7), mm. */
export const PCB_DRILL_SLACK_MM = 0.1;

export interface PcbHoleAssignment {
  /** Drill item id → the mode its own hole's cutter asks for. */
  modes: ReadonlyMap<string, 'drill' | 'bore'>;
  /** Drill item id → the owned cutter that makes it, when one does. */
  keys: ReadonlyMap<string, string>;
  /** One sentence per size that is BORED rather than drilled. */
  notes: string[];
}

/** `0.8` — a hole's size without a trailing zero run. */
function mm(v: number): string {
  return `${Number(v.toFixed(3))}`;
}

/** The cutter's reach below the top face: the shoulder when stated, else the flute, mm. */
function reachOf(tool: Tool): number | null {
  return tool.shoulderLength ?? tool.fluteLength;
}

/** Whether Makera's catalogue answers this cutter for a copper-clad board. */
function onPcbRow(tool: Tool, catalogue: readonly FeedCatalogueRow[]): boolean {
  return catalogueCoverageFor(catalogue, 'pcb', tool).kind === 'covered';
}

/** Whether a cutter presents the cone an isolation needs. */
function isEngraver(entry: ToolLibraryEntry): boolean {
  return vCone(entry.tool) !== null && vFluteLength(entry.tool) !== null;
}

/**
 * Assign each imported drill item its mode and its cutter. Sizes are compared to the micron, so a
 * parser's 0.7999 and a catalogue's 0.8 are one size.
 */
export function pcbHoleAssignment(
  drills: readonly { id: string; diameter?: number }[],
  tools: readonly ToolLibraryEntry[],
): PcbHoleAssignment {
  const cutters = tools.flatMap((entry) => {
    const d = cuttingDiameter(entry.tool);
    return d === null || d <= 0 ? [] : [{ key: entry.key, tool: entry.tool, shape: entry.tool.shape, diameter: d }];
  });
  const modes = new Map<string, 'drill' | 'bore'>();
  const keys = new Map<string, string>();
  const notes: string[] = [];

  /** The decision for one size, computed once for every item of that size. */
  const decide = (hole: number): { mode: 'drill' | 'bore'; key: string | null } => {
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
    if (exact !== undefined) return { mode: 'drill', key: exact.key };
    // 2 · a flat end mill narrower than the hole bores it to size.
    const borer = cutters
      .filter((c) => c.shape === 'flat' && c.diameter < hole - 1e-9)
      .sort((a, b) => b.diameter - a.diameter)[0];
    return borer === undefined ? { mode: 'drill', key: null } : { mode: 'bore', key: borer.key };
  };

  const bySize = new Map<string, { mode: 'drill' | 'bore'; key: string | null }>();
  for (const drill of drills) {
    const hole = drill.diameter;
    if (hole === undefined || !(hole > 0)) {
      modes.set(drill.id, 'drill');
      continue;
    }
    const key = hole.toFixed(3);
    let decided = bySize.get(key);
    if (decided === undefined) {
      decided = decide(hole);
      bySize.set(key, decided);
      if (decided.mode === 'bore') {
        const count = drills.filter((d) => d.diameter !== undefined && d.diameter.toFixed(3) === key).length;
        notes.push(
          `No owned ⌀${mm(hole)} mm drill or end mill within +${PCB_DRILL_SLACK_MM} mm; ` +
            `the ${count} ⌀${mm(hole)} hole${count === 1 ? ' is' : 's are'} bored to size with a flat end mill.`,
        );
      }
    }
    modes.set(drill.id, decided.mode);
    if (decided.key !== null) keys.set(drill.id, decided.key);
  }
  return { modes, keys, notes };
}

/** The board's work items, as the import builds them. */
export interface PcbCutterItems {
  /** The isolation frames (`around` the copper). */
  frames: readonly { id: string }[];
  drills: readonly { id: string; diameter?: number }[];
  cutouts: readonly { id: string }[];
}

export interface PcbCutterPlan {
  /** The setup's cutters, in cut order: the engraver, each drill, then the outline cutter. */
  tools: string[];
  /** Item id → the key of the cutter that owns it. An item absent here has no cutter. */
  assignment: ReadonlyMap<string, string>;
  /** What the import states about the cutters it chose. */
  notes: string[];
}

/**
 * The whole setup's cutter plan (§3.4): the engraver for the isolation, a drill or borer per hole
 * size, and a flat for the cut-out. Tools are ordered as they cut; drill sizes keep the order they
 * first appear in the file.
 */
export function pcbCutterPlan(
  items: PcbCutterItems,
  tools: readonly ToolLibraryEntry[],
  /**
   * The through depth the outline cutter must reach, mm — the blank's thickness plus the job's
   * breakthrough. A cutter whose stated reach is shorter cannot free the board.
   */
  throughMm: number,
  catalogue: readonly FeedCatalogueRow[] = [],
): PcbCutterPlan {
  const assignment = new Map<string, string>();
  const order: string[] = [];
  const notes: string[] = [];
  const own = (itemId: string, key: string): void => {
    assignment.set(itemId, key);
    if (!order.includes(key)) order.push(key);
  };

  // The engraver: the smallest tip whose cone states a flute, and Makera's PCB row first.
  const engravers = tools
    .filter(isEngraver)
    .sort((a, b) => {
      const covered = Number(onPcbRow(b.tool, catalogue)) - Number(onPcbRow(a.tool, catalogue));
      if (covered !== 0) return covered;
      const ta = cuttingDiameter(a.tool) ?? Number.POSITIVE_INFINITY;
      const tb = cuttingDiameter(b.tool) ?? Number.POSITIVE_INFINITY;
      if (ta !== tb) return ta - tb;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  const engraver = engravers[0] ?? null;
  if (engraver === null && items.frames.length > 0) {
    notes.push('No engraving bit (a cone with a stated flute) is in the tool library, so the isolation has no cutter yet.');
  } else if (engraver !== null) {
    for (const frame of items.frames) own(frame.id, engraver.key);
  }

  // The holes: their own drill where one is the size, a bore where a flat can helix them.
  const holes = pcbHoleAssignment(items.drills, tools);
  for (const [id, key] of holes.keys) own(id, key);
  notes.push(...holes.notes);

  // The outline: a flat that reaches through the board, Makera's PCB row first, the finest first.
  const flats = tools
    .filter((entry) => entry.tool.shape === 'flat')
    .filter((entry) => {
      const reach = reachOf(entry.tool);
      return reach === null || reach + 1e-9 >= throughMm;
    })
    .sort((a, b) => {
      const covered = Number(onPcbRow(b.tool, catalogue)) - Number(onPcbRow(a.tool, catalogue));
      if (covered !== 0) return covered;
      const da = cuttingDiameter(a.tool) ?? Number.POSITIVE_INFINITY;
      const db = cuttingDiameter(b.tool) ?? Number.POSITIVE_INFINITY;
      if (da !== db) return da - db;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  const outline = flats[0] ?? null;
  if (outline === null && items.cutouts.length > 0) {
    notes.push(
      `No flat end mill whose stated reach covers ${mm(throughMm)} mm is in the tool library, so the board has no cut-out cutter yet.`,
    );
  } else if (outline !== null) {
    for (const cutout of items.cutouts) own(cutout.id, outline.key);
  }

  return { tools: order, assignment, notes };
}

/**
 * The setup with a PCB cutter plan written into it (#472/#746). The plan's cutters are APPENDED to
 * the setup's own — never reordered — and each new item is owned by its cutter. A setup with no
 * `toolItems` map gains one that gives its first cutter everything it already cut, so adding a map
 * to a job that predates it never unassigns an item.
 */
export function withPcbCutters(setup: JobSetup, plan: PcbCutterPlan, newItemIds: readonly string[]): JobSetup {
  const added = new Set(newItemIds);
  const tools = [...setup.tools];
  for (const key of plan.tools) if (!tools.includes(key)) tools.push(key);
  const first = tools[0];
  const toolItems: Record<string, string[]> =
    setup.toolItems !== undefined
      ? Object.fromEntries(Object.entries(setup.toolItems).map(([key, ids]) => [key, [...ids]]))
      : first === undefined
        ? {}
        : // The board's own items are NOT in the first cutter's list: each is assigned to the
          // cutter the plan chose for it, below. Every other item keeps today's reading.
          { [first]: setup.itemIds.filter((id) => !added.has(id)) };
  for (const id of newItemIds) {
    const key = plan.assignment.get(id);
    if (key === undefined) continue;
    (toolItems[key] ??= []).push(id);
  }
  return {
    ...setup,
    tools,
    itemIds: [...new Set([...setup.itemIds, ...newItemIds])],
    toolItems,
  };
}
