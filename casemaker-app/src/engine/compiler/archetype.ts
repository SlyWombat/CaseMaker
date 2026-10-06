import type { Project } from '@/types';

/**
 * Which top-level shape this project compiles to (issue #167).
 *
 * Before this existed the precedence was written out at nine call sites as
 * nine separate reads of `case.rack?.enabled` / `case.stand?.enabled`. Three
 * archetypes each meant "and now here too", and a missed site is a silent
 * behaviour difference rather than a type error — exactly the kind of drift
 * that put the badge in the wrong branch of the viewport. The precedence is
 * now stated once, here.
 *
 * `shell` is the default: the board-in-a-box path the other three bypass.
 */
export type Archetype = 'rack' | 'stand' | 'badge' | 'shell';

/**
 * The archetype a project compiles to. Precedence is rack > stand > badge >
 * shell — each archetype is mutually exclusive by construction (only one
 * `enabled` flag is ever set by the UI), so the order only matters for a
 * hand-edited project that sets two.
 *
 * Callers that need the stand's own fall-through — `buildStandNodes` returns
 * `null` when the board is not a finished enclosure module, and the compiler
 * then builds the normal shell rather than an empty viewport — keep doing so:
 * this function reports the *requested* archetype, not whether the geometry
 * can be built. Same for the badge, which falls through when its parameters
 * are unbuildable (`badgeParamsProblem`).
 *
 * A null project (the welcome screen, a store that has not loaded yet) is
 * `shell` — there is no archetype to report, and every caller's shell branch
 * is the one that already handles "nothing to draw".
 */
export function derivedKind(project: Project | null | undefined): Archetype {
  const c = project?.case;
  if (c?.rack?.enabled) return 'rack';
  if (c?.stand?.enabled) return 'stand';
  if (c?.badge?.enabled) return 'badge';
  return 'shell';
}
