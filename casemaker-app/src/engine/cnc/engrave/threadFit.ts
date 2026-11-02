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
  /**
   * #848 — the job item that RAISES the boss, or null when the boss is the stock or a reference
   * circle nothing in the job cuts (it must already stand before the file runs).
   */
  raisedBy: BossRaiser | null;
}

/** #848 — the cut that leaves a boss standing: a cutaway around it, a frame on it, or its own prism. */
export interface BossRaiser {
  /** The item that cuts the material around the boss. */
  id: string;
  /** `the cutaway "ring"`, `the frame "rim"`, `its own prism`. */
  what: string;
  /** How tall the boss stands once that cut is made: the cut's own depth, mm. */
  heightMm: number;
  /**
   * true in ONE PROGRAM'S sub-job (`jobForSetup`) when an EARLIER program of the run cuts it: the
   * item then arrives as a construction copy listed in `job.cutEarlier`.
   */
  earlier: boolean;
}

const AXIS_EPS = 0.05;

/**
 * #841 — the boss an EXTERNAL thread at `position` is cut on, or null. The boss must already exist:
 *
 *   - round stock standing in the vise (`shape: 'cylinder'` or a `'disc'`, not on the rotary) whose
 *     axis is the thread's — the box's centre;
 *   - or a circle shape centred on the thread's axis that is a reference (`construction`) or a
 *     raised prism — the boss a prior program left. A plain circle POCKET is a hole, not a boss.
 *
 * #848 — A BOSS THE JOB CUTS. The reference circle may be the island of a cutaway or the outline a
 * frame follows: that cut leaves it standing, as tall as the cut is deep, and `raisedBy` names it.
 * A raised prism raises itself. A frame's gap widens the standing boss by the gap on each side.
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
    return { diameterMm: st.diameter, what: `the ⌀${st.diameter} mm round stock`, source: 'stock', raisedBy: null };
  }
  const earlier = new Set(job.cutEarlier ?? []);
  // A cut this job makes, or one an earlier program of the run made (a construction copy the
  // sub-job carries for exactly that reason). Any other construction item is a reference only.
  const cuts = (item: { id: string; construction?: boolean }): { cut: boolean; earlier: boolean } =>
    item.construction !== true ? { cut: true, earlier: false } : { cut: earlier.has(item.id), earlier: earlier.has(item.id) };
  for (const sh of job.shapes) {
    if (sh.kind !== 'circle' || !sh.enabled) continue;
    if (sh.construction !== true && sh.prism === undefined) continue;
    if (!near(sh.position.x, position.x) || !near(sh.position.y, position.y)) continue;
    const name = `circle${sh.name ? ` "${sh.name}"` : ''}`;
    let diameterMm = sh.diameter;
    let raisedBy: BossRaiser | null = null;
    if (sh.prism !== undefined) {
      const c = cuts(sh);
      if (c.cut) raisedBy = { id: sh.id, what: 'its own prism', heightMm: sh.depth, earlier: c.earlier };
    }
    if (raisedBy === null) {
      for (const cb of job.combined ?? []) {
        if (!cb.enabled) continue;
        const holds = (cb.kind === 'cutaway' && cb.islands.includes(sh.id)) || (cb.kind === 'frame' && cb.around === sh.id);
        if (!holds) continue;
        const c = cuts(cb);
        if (!c.cut) continue;
        const label = `the ${cb.kind}${cb.name ? ` "${cb.name}"` : ''}`;
        if (cb.kind === 'frame') diameterMm = sh.diameter + 2 * Math.max(0, cb.gap);
        raisedBy = { id: cb.id, what: label, heightMm: cb.depth, earlier: c.earlier };
        break;
      }
    }
    const d = diameterMm === sh.diameter ? sh.diameter : Number(diameterMm.toFixed(3));
    return { diameterMm: d, what: `${name} (⌀${d} mm)`, source: sh.id, raisedBy };
  }
  return null;
}

export interface ThreadPilot {
  diameterMm: number;
  /** The words a sentence names it by: `circle "pilot" (⌀2.5 mm)`. */
  what: string;
  /** The item that bores it, and whether it happens in an EARLIER program of the run. */
  boredBy: { id: string; earlier: boolean };
}

/**
 * #902 — the pilot hole an INTERNAL thread at `position` already has modelled, or null. The
 * counterpart of {@link threadBoss} for the hole a tapped thread needs rather than the boss an
 * external one stands on: a plain circle POCKET (no `prism`, not a `construction` reference — see
 * `threadBoss`'s own "a plain circle pocket is a hole, not a boss") centred on the thread's axis,
 * wide enough for the minor-diameter pilot and deep enough for the thread plus its run-out.
 *
 * `job.cutEarlier` is the same construction-copy list `threadBoss.raisedBy.earlier` reads: present
 * when THIS program's own sub-job already carries the pilot as an earlier program's cut.
 */
export function threadPilot(
  job: EngraveJob,
  position: { x: number; y: number },
  minorMm: number,
  neededDepthMm: number,
): ThreadPilot | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= AXIS_EPS;
  const earlier = new Set(job.cutEarlier ?? []);
  for (const sh of job.shapes) {
    if (sh.kind !== 'circle' || !sh.enabled) continue;
    if (sh.construction === true || sh.prism !== undefined) continue;
    if (!near(sh.position.x, position.x) || !near(sh.position.y, position.y)) continue;
    if (sh.diameter + 1e-6 < minorMm) continue;
    if (sh.depth + 1e-6 < neededDepthMm) continue;
    return {
      diameterMm: sh.diameter,
      what: `circle${sh.name ? ` "${sh.name}"` : ''} (⌀${sh.diameter} mm)`,
      boredBy: { id: sh.id, earlier: earlier.has(sh.id) },
    };
  }
  return null;
}

/**
 * #848 — THE BOSS IS CUT BEFORE ITS THREAD. Reorders a plan's cutters so that a thread mill whose
 * external threads stand on a boss ANOTHER cutter of the plan raises comes after that cutter. Every
 * other plan is returned as it was (the same array), so a job with no raised boss is unchanged.
 */
export function bossBeforeThread<C extends { key: string; items: readonly string[] }>(job: EngraveJob, cutters: readonly C[]): readonly C[] {
  const raiserOf = new Map<string, string>();
  for (const t of job.threads ?? []) {
    if (!t.enabled || t.side !== 'external') continue;
    const by = threadBoss(job, t.position)?.raisedBy;
    if (by != null && !by.earlier) raiserOf.set(t.id, by.id);
  }
  if (raiserOf.size === 0) return cutters;
  const order = [...cutters];
  for (let guard = 0; guard < cutters.length; guard++) {
    let moved = false;
    for (let i = 0; i < order.length; i++) {
      const raisers = order[i]!.items.flatMap((id) => {
        const r = raiserOf.get(id);
        return r === undefined ? [] : [r];
      });
      if (raisers.length === 0) continue;
      const last = order.reduce((at, c, j) => (c.items.some((id) => raisers.includes(id)) ? Math.max(at, j) : at), -1);
      if (last > i) {
        const [mill] = order.splice(i, 1);
        order.splice(last, 0, mill!);
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return order.every((c, i) => c === cutters[i]) ? cutters : order;
}
