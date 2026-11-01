/**
 * #841 — WHETHER A THREAD MILL FITS A THREAD, and WHERE AN EXTERNAL THREAD'S BOSS IS.
 *
 * One answer for the findings (`validateJob`), the cutter pick (`cutterPlan`) and the panel's
 * one-press change, so the three never disagree about what "fits" means:
 *
 *   - INTERNAL: the cutter must enter the pilot (`d < D1`) and span the radial depth
 *     (`d ≥ (D − D1)/2`, #445 D2's tooth-reach proxy);
 *   - EXTERNAL: there is no pilot to enter, so only the radial depth `(D − d3)/2` applies;
 *   - REACH: the flute must cover the thread plus ONE pitch of run-out (the smallest the CAM may use,
 *     `validateJob`'s own rule);
 *   - PITCH: the cutter's tooth pitch, read from its name (`threadMillPitchOf`), should equal the
 *     thread's. A mismatch is INFORMED, never refused (the maintainer's inform-don't-refuse rule):
 *     the item states the thread and the CAM cuts it.
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { threadDims, threadMillPitchOf, threadSpec, type ThreadSize } from '@/engine/cnc/threadTable';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';

export interface ThreadFitInput {
  size: ThreadSize;
  side?: 'external';
  depth: number;
}

export interface ThreadMillFit {
  /** The first physical reason the cutter cannot cut this thread, or null when it can. */
  refusal: string | null;
  /** The cutter's named pitch, mm, or null when its name states none. */
  cutterPitch: number | null;
  /** true / false when the cutter's pitch is known; null when it is not. */
  pitchMatches: boolean | null;
}

const PITCH_EPS = 1e-3;

export function threadMillFit(tool: Tool, thread: ThreadFitInput): ThreadMillFit {
  const cutterPitch = tool.shape === 'thread' ? threadMillPitchOf(tool.name) : null;
  const { major, pitch, minor } = threadDims(thread.size, thread.side === 'external' ? 'external' : 'internal');
  const pitchMatches = cutterPitch === null ? null : Math.abs(cutterPitch - pitch) <= PITCH_EPS;
  const out = (refusal: string | null): ThreadMillFit => ({ refusal, cutterPitch, pitchMatches });
  if (tool.shape !== 'thread') return out('not a thread mill');
  const d = cuttingDiameter(tool);
  if (d === null || !(d > 0)) return out('states no cutting diameter');
  if (thread.side !== 'external' && d >= minor) return out(`too wide for the ⌀${minor} mm pilot of ${thread.size}`);
  if (d < (major - minor) / 2) return out(`too narrow for the ${Number(((major - minor) / 2).toFixed(3))} mm radial depth of ${thread.size}`);
  if (tool.fluteLength !== null && tool.fluteLength > 0 && thread.depth + pitch > tool.fluteLength) {
    return out(`its ${tool.fluteLength} mm flute does not reach ${Number((thread.depth + pitch).toFixed(3))} mm`);
  }
  return out(null);
}

export interface NearestThreadMill {
  key: string;
  name: string;
  diameterMm: number;
  /** The pitch its name states, mm, or null. */
  pitchMm: number | null;
}

/**
 * The nearest OWNED thread mill that fits `thread` — the one-press change a fit or pitch finding
 * offers. "Nearest" is: a cutter named for the thread's own pitch first, then one whose pitch is
 * unstated, then the closest stated pitch; among those, the cutting diameter nearest the current
 * cutter's (the least change to the job). `excludeKey` is the cutter already chosen. Null when no
 * owned thread mill fits.
 */
export function nearestThreadMill(
  thread: ThreadFitInput,
  entries: readonly ToolLibraryEntry[],
  current: Tool | null,
  excludeKey?: string,
): NearestThreadMill | null {
  const pitch = threadSpec(thread.size).pitch;
  const currentD = current === null ? null : cuttingDiameter(current);
  const ranked = entries
    .filter((e) => e.key !== excludeKey && e.tool.shape === 'thread')
    .map((e) => ({ e, fit: threadMillFit(e.tool, thread), d: cuttingDiameter(e.tool) ?? 0 }))
    .filter((c) => c.fit.refusal === null)
    // A cutter named for ANOTHER pitch is no fix for a pitch finding, and a worse one for the rest.
    .sort((a, b) => {
      const rank = (m: boolean | null) => (m === true ? 0 : m === null ? 1 : 2);
      const r = rank(a.fit.pitchMatches) - rank(b.fit.pitchMatches);
      if (r !== 0) return r;
      const pa = a.fit.cutterPitch === null ? 0 : Math.abs(a.fit.cutterPitch - pitch);
      const pb = b.fit.cutterPitch === null ? 0 : Math.abs(b.fit.cutterPitch - pitch);
      if (pa !== pb) return pa - pb;
      if (currentD !== null) return Math.abs(a.d - currentD) - Math.abs(b.d - currentD);
      return b.d - a.d;
    });
  const best = ranked[0];
  if (best === undefined) return null;
  // The one-press is worth offering only when it is better on the axis that failed: a cutter named
  // for another pitch is never offered as the cure for a pitch mismatch.
  if (best.fit.pitchMatches === false && current !== null && threadMillFit(current, thread).refusal === null) return null;
  return { key: best.e.key, name: best.e.tool.name, diameterMm: best.d, pitchMm: best.fit.cutterPitch };
}

export interface ThreadBoss {
  diameterMm: number;
  /** The words a sentence names it by: `the ⌀8 mm round stock`, `circle "boss"`. */
  what: string;
  /** `stock` when the boss is the blank itself; the circle's id otherwise. */
  source: 'stock' | string;
}

const AXIS_EPS = 0.05;

/**
 * #841 — the boss an EXTERNAL thread at `position` is cut on, or null. The boss must already exist:
 *
 *   - round stock standing in the vise (`shape: 'cylinder'` or a `'disc'`, not on the rotary) whose
 *     axis is the thread's — the box's centre;
 *   - or a circle shape centred on the thread's axis that is a reference (`construction`) or a
 *     raised prism — the boss a prior program left. A plain circle POCKET is a hole, not a boss.
 */
export function threadBoss(job: EngraveJob, position: { x: number; y: number }): ThreadBoss | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= AXIS_EPS;
  const st = job.stock;
  if (
    st.diameter !== undefined &&
    (st.shape === 'disc' || (st.shape === 'cylinder' && job.workholding.kind !== 'rotary-chuck')) &&
    near(position.x, st.length / 2) &&
    near(position.y, st.width / 2)
  ) {
    return { diameterMm: st.diameter, what: `the ⌀${st.diameter} mm round stock`, source: 'stock' };
  }
  for (const sh of job.shapes) {
    if (sh.kind !== 'circle' || !sh.enabled) continue;
    if (sh.construction !== true && sh.prism === undefined) continue;
    if (!near(sh.position.x, position.x) || !near(sh.position.y, position.y)) continue;
    return { diameterMm: sh.diameter, what: `circle${sh.name ? ` "${sh.name}"` : ''} (⌀${sh.diameter} mm)`, source: sh.id };
  }
  return null;
}
