/**
 * #1202 field 5 — THE CLEANING PASS AND THE AIR WALK, AS MOTION ROUTINES.
 *
 * The walks are FILES (#1146), not console sequences: generated, posted, verified, uploaded and
 * played by the release card's single Start. Their identity must survive the fact that every job's
 * file differs in its geometry — a raster over a 160 × 126 blank and one over a 60 × 40 blank are
 * the SAME routine, and a mark that reappeared per job would mean nothing.
 *
 * THE SHAPE IS THE GENERATOR'S SEQUENCE, NOT THE BYTES. `cleanWalkFile` states its structural
 * steps (`CleanWalkStep`: the direct-air pair and the raster for the cleaning pass, the one closed
 * outline for the air walk), and this module hashes that order — coordinates, row counts, the
 * footprint, the sweep Z and the comment header never enter it. A build that moves a step (the
 * M812 before the raster, a lift inserted between rows) is a different routine and is marked again.
 */
import { programHash } from '@/engine/cnc/programHash';
import type { CleanWalkStep } from '@/engine/cnc/engrave/cleanWalk';
import type { MotionRoutineId, RoutineIdentity, RoutineLineShape } from '@/engine/cnc/registration/routineIdentity';

/** The two walk routines, by their record ids. */
export type WalkRoutineId = Extract<MotionRoutineId, 'clean-walk' | 'air-walk'>;

/**
 * The walk's identity: its generator's step sequence, in order. The step is the whole shape — no
 * axes or heights to name, because the walk's moves are the generator's own and not a plan's.
 */
export function walkRoutineIdentity(routine: WalkRoutineId, steps: readonly CleanWalkStep[]): RoutineIdentity {
  const lines: RoutineLineShape[] = steps.map((step) => ({ op: step, axis: '', height: null }));
  const text = lines.map((s) => `${s.op}|${s.axis}|${s.height ?? ''}`).join('\n');
  return { routine, shape: programHash(text), lines };
}
