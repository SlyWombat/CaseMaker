/**
 * #785 — the REACH check for a goal, decided before any CAM or measured search.
 *
 * A goal deeper than the cutter can reach cannot be cut from the top: the tip stops at the flute's
 * end and the holder enters the part. That is a safety refusal (#786's table C keeps reach
 * refusals), but it must come EARLY and say the numbers, and it must only fire on a reach that is
 * KNOWN:
 *
 *   - the cutter's own `fluteLength` when it states one;
 *   - otherwise the VENDOR CATALOGUE's value for the same cutter — an `inv:` copy or a clone that
 *     lost the flute takes Makera's number for the cutter it is, by Makera's own id, and the
 *     sentence says where the number came from ("Makera's catalogue");
 *   - with no source at all the reach is NOT recorded, and an unknown reach is not a refusal: it is
 *     a stated assumption (an info) that the depth is unchecked, and the sweep's holder gate is the
 *     real guard (`holder-unproven`).
 *
 * THE ONE-CLICK WAY TO CUT WHAT REACHES. A stated (or catalogued) reach shorter than the goal still
 * refuses BY DEFAULT, with the numbers and the fixes. But the operator can choose `cutWithinReach`
 * on the goal: the goal is then cut as the top band of the STOCK the cutter reaches safely (the
 * reach less a clearance, so the holder never enters the work), and the result states what is left
 * in the stock. That is #784's principle — "let me make the part I can have" — applied to depth.
 */

import type { Tool } from '@/engine/cnc/tool';
import { vendorId } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { JobFinding } from './jobSetup';
import { jobTargetObjects } from './jobSetup';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { placedSize } from './targetScale';

/**
 * The clearance a top-band cut keeps between the cutter's stated reach and the stock top, mm —
 * the holder must stay ABOVE the work. 1.0, the same provisional figure the shop's jaw rule uses
 * (`depthBounds.DEFAULT_JAW_CLEARANCE_MM`), and deliberately not a setting: this is the safety
 * margin of a cut the app itself proposes, and it must not be shrunk by a house number that was
 * never about the holder.
 */
export const GOAL_BAND_CLEARANCE_MM = 1.0;

/** Where a reach number came from — the cutter's own record, or Makera's catalogue row for it. */
export type ReachSource = 'stated' | 'catalogue';

export interface ToolReach {
  mm: number;
  source: ReachSource;
  /** The catalogue row's own name, when the number came from the catalogue (`Makera's catalogue`). */
  catalogueName: string | null;
}

/** A stated length, when the record has one. */
function positive(v: number | null): number | null {
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The body that must clear the stock, by the engine's one existing rule (`cutterPlan.reachOf`,
 * `recommendTool.reachOf`, `smartPick` and the sweep's holder gate all read the same fields):
 * the SHOULDER when the record states one, else the FLUTE. A cutter that states only its flute
 * reaches that far; one that states its shoulder reaches to the shoulder.
 */
function statedReach(tool: Tool): number | null {
  return positive(tool.shoulderLength) ?? positive(tool.fluteLength);
}

/**
 * One cutter's known reach: its own stated shoulder/flute, else Makera's catalogue row for the
 * same cutter (an `inv:` copy or a clone registered from a catalogue row carries Makera's `g_ID`),
 * else null.
 *
 * `entries` is the registry snapshot the run was started from (`shop.tools` in the worker). A
 * catalogue match needs a stated vendor id on BOTH sides: `id: null`/`'0'` is the post's way of
 * saying "this cutter has no Makera id", and two no-id cutters must never be taken for each other.
 */
export function knownReach(tool: Tool, entries: readonly ToolLibraryEntry[]): ToolReach | null {
  const stated = statedReach(tool);
  if (stated !== null) return { mm: stated, source: 'stated', catalogueName: null };
  const id = vendorId(tool);
  if (id === null) return null;
  for (const entry of entries) {
    if (!entry.key.startsWith('cat:')) continue;
    if (vendorId(entry.tool) !== id) continue;
    const reach = statedReach(entry.tool);
    if (reach !== null) return { mm: reach, source: 'catalogue', catalogueName: entry.tool.name };
  }
  return null;
}

/** The longest KNOWN reach among these cutters, with the cutter that has it; null when none is known. */
export function longestKnownReach(
  tools: readonly Tool[],
  entries: readonly ToolLibraryEntry[],
): { tool: Tool; reach: ToolReach } | null {
  let best: { tool: Tool; reach: ToolReach } | null = null;
  for (const tool of tools) {
    const reach = knownReach(tool, entries);
    if (reach === null) continue;
    if (best === null || reach.mm > best.reach.mm) best = { tool, reach };
  }
  return best;
}

/**
 * How deep below the STOCK TOP the cutter must go to reach the goal's lowest surface, mm — the
 * number the holder must clear. It equals the goal's own height only when the goal's top sits at
 * the stock top (the default placement): a goal sunk into the blank needs that much more, and one
 * whose underside is still above the blank needs nothing.
 */
export function goalNeedMm(goal: EngraveTargetObject): number {
  const base = goal.position.z - placedSize(goal).z; // the goal's lowest point in work Z
  return base < 0 ? -base : 0;
}

const mm3 = (v: number): string => String(Number(v.toFixed(3)));

/** How the reach is named in a sentence — the cutter's own record or the catalogue's number. */
function reachWords(reach: ToolReach): string {
  return `${mm3(reach.mm)} mm${reach.source === 'catalogue' ? " (Makera's catalogue)" : ''}`;
}

/**
 * The reach findings for ONE goal, in the order they matter:
 *
 *   - `goal-reach-short` (ERROR) — the cutter's known reach is shorter than the goal is deep and
 *     the operator has not chosen the top-band cut. The sentence carries the depth and the reach,
 *     the four fixes, and (when the chosen cutter is not the house's longest) what the longest is.
 *   - `goal-cut-top-band` (WARNING) — the same shortfall with `cutWithinReach` chosen: the goal is
 *     cut as the stock's top band, and the sentence states how much of the goal is left in it.
 *   - `goal-reach-unrecorded` (INFO) — no stated or catalogued reach: the assumption is stated and
 *     nothing blocks; the sweep's holder gate is the guard.
 *
 * `goal-reach-short` carries the `targetId` and the band depth (`goalBandMm`) so the panel can put
 * the one-click option beside the sentence; it is absent when the band would be zero (a reach at
 * or under the clearance has nothing safe to cut, and the other three fixes stand alone).
 */
export function goalReachFindings(
  goal: EngraveTargetObject,
  chosen: Tool | null,
  owned: readonly Tool[],
  entries: readonly ToolLibraryEntry[],
): JobFinding[] {
  if (goal.format === 'png' || (goal.role ?? 'reference') !== 'goal' || !goal.enabled) return [];
  if (chosen === null) return []; // no cutter at all is the feeds gate's refusal, not this one
  const depth = placedSize(goal).z;
  const need = goalNeedMm(goal);
  if (!(depth > 0) || !(need > 0)) return [];
  // The sentence names the goal's own depth (what the row shows). When the goal is not top-flush
  // the reach decision is made on its lowest surface's depth below the stock top, and the sentence
  // states that too rather than letting the two numbers disagree silently.
  const depthWords =
    Math.abs(need - depth) < 5e-4
      ? `${mm3(depth)} mm deep`
      : `${mm3(depth)} mm deep, its lowest surface ${mm3(need)} mm below the stock top`;

  const mine = knownReach(chosen, entries);
  if (mine === null) {
    return [
      {
        severity: 'info',
        code: 'goal-reach-unrecorded',
        message:
          `The goal is ${depthWords}. This cutter's reach is not recorded; the depth it can reach is ` +
          `unchecked; record its flute in Manage › Tools.`,
      },
    ];
  }
  if (need <= mine.mm + 1e-9) return [];

  const band = Number((mine.mm - GOAL_BAND_CLEARANCE_MM).toFixed(3));
  const longest = longestKnownReach(owned, entries);
  const isLongest = longest === null || mine.mm >= longest.reach.mm - 1e-9;
  const reachPhrase = isLongest
    ? `your longest reach is ${reachWords(mine)}`
    : `this cutter reaches ${reachWords(mine)} (your longest reach is ${reachWords(longest.reach)})`;

  // The part of the GOAL the band actually removes: the stock covers z in [-band, 0] and the goal
  // spans [position.z - depth, position.z], so the cut portion is their overlap.
  const goalTop = Math.min(goal.position.z, 0);
  const goalBase = goal.position.z - depth;
  const cutGoal = band > 0 ? Math.max(0, Math.min(depth, goalTop - Math.max(goalBase, -band))) : 0;
  const left = Math.max(0, depth - cutGoal);
  const bandWords =
    Math.abs(cutGoal - band) < 1e-9
      ? `only the stock's top ${mm3(band)} mm is cut; the remaining ${mm3(left)} mm of the goal is left in the stock`
      : `only the stock's top ${mm3(band)} mm is cut — ${mm3(cutGoal)} mm of the goal — so the remaining ${mm3(left)} mm of it is left in the stock`;

  if (goal.cutWithinReach === true && band > 0) {
    return [
      {
        severity: 'warning',
        code: 'goal-cut-top-band',
        targetId: goal.id,
        message:
          `The goal is ${depthWords} and ${reachPhrase}, so ${bandWords}. Cut the other side as a second setup, ` +
          `scale the goal, or use a longer cutter to remove it.`,
      },
    ];
  }

  return [
    {
      severity: 'error',
      code: 'goal-reach-short',
      targetId: goal.id,
      ...(band > 0 ? { goalBandMm: band } : {}),
      message:
        `The goal is ${depthWords} and ${reachPhrase}, so the holder would enter the part before the tip reaches ` +
        `the bottom. Scale the goal to ${mm3(mine.mm)} mm or less, cut it from both sides (a flip, one setup per side), ` +
        `choose a longer cutter` +
        (band > 0 ? `, or cut just the top ${mm3(band)} mm (the depth this cutter reaches safely).` : '.'),
    },
  ];
}

/** Every reach finding over the job's goals, in goal order. */
export function jobReachFindings(
  job: EngraveJob,
  chosen: Tool | null,
  owned: readonly Tool[],
  entries: readonly ToolLibraryEntry[],
): JobFinding[] {
  // A ROTARY RELIEF IS NOT JUDGED BY THE FLAT FRAME'S REACH. On a rod the goal's local Z is
  // RADIAL, not "below the stock top" toward the bed, so this check's premise does not hold; the
  // relief's own checks (the axis crossing, the free span, the rod's radius and the sweep) judge
  // it. Without this, a 12 mm-flute cutter on an 18 mm-deep relief was refused before the rotary
  // path — the #723 R-4 e2e caught it.
  if (rotaryMapOf(job) !== null) return [];
  const out: JobFinding[] = [];
  for (const goal of jobTargetObjects(job)) out.push(...goalReachFindings(goal, chosen, owned, entries));
  return out;
}

/** The first blocking reach finding over the job's goals, or null. */
export function jobReachRefusal(
  job: EngraveJob,
  chosen: Tool | null,
  owned: readonly Tool[],
  entries: readonly ToolLibraryEntry[],
): JobFinding | null {
  return jobReachFindings(job, chosen, owned, entries).find((f) => f.severity === 'error') ?? null;
}
