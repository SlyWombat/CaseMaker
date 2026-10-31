/**
 * #743 P-8 — A BOARD'S SETUPS, written as the document's own `setups[]`.
 *
 * One setup per face the board has copper on. Setup 1 is the identity (the stock as supplied),
 * and setup 2 is the plan's own second side: its orientation and mount came from `orient`, the
 * same turn the run's stock carry and the registration use, so nothing here can disagree about
 * which way the board was turned.
 *
 * Each setup carries its cutters the way every other job does (#472/#746): `tools` in cut order,
 * and `toolItems` naming which of the setup's items each cutter owns. §3.4's choice is the same
 * `pcbCutterPlan` for both sides — the engraver owns the isolation, a drill or borer the holes,
 * and a flat that reaches through the board the cut-out. A role no owned cutter fills stays
 * unassigned and is stated by the job's own check (`setup-items-unassigned` / `hole-no-cutter`).
 *
 * Pure apart from the id source: the caller hands in the library and the catalogue rows.
 */

import { newId } from '@/utils/id';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Orientation } from '@/engine/cnc/setups/types';
import type { JobSetup } from '@/types/engraveJob';
import { pcbCutterPlan, type PcbCutterItems, type PcbCutterPlan } from './pcbCutters';
import type { PcbImportOk } from './pcbImport';

/** The first setup's face record: the stock as supplied, top up. */
const IDENTITY_ORIENTATION: Orientation = {
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
  front: 'front',
  back: 'back',
};

/** One face's setup, with the plan that chose its cutters. */
export interface PcbSideSetup {
  /** Which face of the board this setup cuts. */
  side: 'top' | 'bottom';
  cutter: PcbCutterPlan;
  items: PcbCutterItems;
  setup: JobSetup;
}

export interface PcbSetups {
  /** Setup 1 first, then the second side when the board has one. */
  sides: PcbSideSetup[];
  /** The job's own cutter (the first program's), or null when nothing owned cuts a role. */
  toolKey: string | null;
  /** What the import states about the cutters it chose, one copy per fact. */
  notes: string[];
}

/** One setup record from its side's items and cutter plan. */
function setupOf(
  items: PcbCutterItems,
  cutter: PcbCutterPlan,
  orientation: Orientation,
  mount: JobSetup['mount'],
): JobSetup {
  const itemIds = [
    ...items.frames.map((item) => item.id),
    ...items.drills.map((item) => item.id),
    ...items.cutouts.map((item) => item.id),
  ];
  const toolItems: Record<string, string[]> = {};
  for (const key of cutter.tools) {
    toolItems[key] = [...cutter.assignment].filter(([, owns]) => owns === key).map(([id]) => id);
  }
  return {
    id: newId('setup'),
    orientation: { ...orientation },
    mount: { ...mount },
    itemIds,
    tools: [...cutter.tools],
    ...(cutter.tools.length === 0 ? {} : { toolItems }),
  };
}

/**
 * The board's setups, in cut order. A single-sided board yields one; a two-layer board yields the
 * top and the bottom. The through deep enough for the outline cutter is the blank's own thickness
 * plus the job's breakthrough (`throughMm`), the same number the single-sided import used.
 */
export function pcbSetupPlan(
  plan: PcbImportOk,
  tools: readonly ToolLibraryEntry[],
  throughMm: number,
  catalogue: readonly FeedCatalogueRow[] = [],
): PcbSetups {
  const topItems: PcbCutterItems = {
    frames: plan.items.frames,
    drills: plan.items.drills,
    cutouts: plan.items.cutouts,
  };
  const topCutter = pcbCutterPlan(topItems, tools, throughMm, catalogue);
  const sides: PcbSideSetup[] = [
    {
      side: 'top',
      cutter: topCutter,
      items: topItems,
      setup: setupOf(topItems, topCutter, IDENTITY_ORIENTATION, plan.mount),
    },
  ];
  if (plan.second !== null) {
    const bottomItems: PcbCutterItems = {
      frames: plan.second.items.frames,
      drills: [],
      cutouts: plan.second.items.cutouts,
    };
    const bottomCutter = pcbCutterPlan(bottomItems, tools, throughMm, catalogue);
    sides.push({
      side: 'bottom',
      cutter: bottomCutter,
      items: bottomItems,
      setup: setupOf(bottomItems, bottomCutter, plan.second.orientation, plan.second.mount),
    });
  }
  const notes: string[] = [];
  for (const note of sides.flatMap((side) => side.cutter.notes)) {
    if (!notes.includes(note)) notes.push(note);
  }
  const toolKey = sides.find((side) => side.cutter.tools.length > 0)?.cutter.tools[0] ?? null;
  return { sides, toolKey, notes };
}
