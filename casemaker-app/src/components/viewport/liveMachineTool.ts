/**
 * #527 §6 — the viewport's machine layer: WHICH body is drawn and WHERE. Pure selectors, so the
 * two scenes that draw it (the simulation's `SimMeshes` and the engrave preview) and their tests
 * share one rule and cannot disagree about what the machine is holding or where it is.
 *
 * ONE POSITION SOURCE AT A TIME (design §6): the live `WPos` while the machine is answering, else
 * the scrubbed simulation step. They are the same frame — the controller reports `WPos` in work
 * coordinates (`WPos = MPos − G54 − TLO`, `/Z1-Firmware-Dialect.md` §11.12) and every scene here is
 * drawn in the work frame with no transform (`SimMeshes`: "do not transform the meshes into
 * machine coordinates") — so a live position is used AS IS. With no machine answering there is no
 * live position and no honest substitute: the body sits at the scrub step, or is not drawn.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { Tool } from '@/engine/cnc/tool';

/**
 * The part of a release record this selector reads (#527), kept structural so the viewport does
 * not depend on the release store's whole type: the job it belongs to, the program the machine is
 * on, and each program's cutter key.
 */
export interface ReleaseToolSource {
  jobId: string;
  active: number | null;
  files: readonly { index: number; toolKey: string }[];
}

/** The work position a status line carries: each axis is null when the line did not state it. */
export interface LiveWorkPosition {
  x: number | null;
  y: number | null;
  z: number | null;
}

/** Where the tool body is drawn, and which source said so (the second is for tests and `data-` seams). */
export interface ToolPlacement {
  /** The tool tip (the contact point), in the scene's work frame. */
  at: [number, number, number];
  source: 'live' | 'scrub';
}

/**
 * The body's one position (#527 §6). LIVE wins only when the heartbeat has actually answered AND
 * the line carried a whole position: a status line left over from before a drop is a stale claim,
 * not an answer, and half a position would put the body on an invented axis.
 */
export function toolPlacement(
  live: { reachable: boolean | null; wpos: LiveWorkPosition | null },
  scrub: [number, number, number] | null,
): ToolPlacement | null {
  const { reachable, wpos } = live;
  if (reachable === true && wpos !== null && wpos.x !== null && wpos.y !== null && wpos.z !== null) {
    return { at: [wpos.x, wpos.y, wpos.z], source: 'live' };
  }
  return scrub === null ? null : { at: scrub, source: 'scrub' };
}

/**
 * The cutter the machine should have in it NOW (#527 §6: "the cutter swap changes it").
 *
 * A release runs one program per cutter, and the bit change between them is confirmed in the
 * viewport's rail. Once confirmed the release's `active` program moves to the next file, whose
 * `toolKey` names the cutter the operator just fitted — so the drawn body follows the confirmation,
 * not a selection: before it, `active` is still the program whose cutter is in the machine.
 *
 * Falls back to the job's own cutter when there is no release for this job, nothing is running, or
 * the key does not resolve in the tool list (a job can be viewed without its registry).
 */
export function fittedTool(
  job: EngraveJob,
  jobCutter: Tool | null,
  release: ReleaseToolSource | null,
  resolve: (key: string) => Tool | null,
): Tool | null {
  if (release === null || release.jobId !== job.id || release.active === null) return jobCutter;
  const file = release.files.find((f) => f.index === release.active);
  if (file === undefined) return jobCutter;
  return resolve(file.toolKey) ?? jobCutter;
}
