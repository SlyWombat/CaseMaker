/**
 * #881 — THE LEVEL POOL ON THE RUN'S TECHNICAL LINE.
 *
 * The pool is a memory decision before it is a speed one: each planner holds one level's measuring
 * grid, so the number of planners is what the page's budget (#889's 640 MB on a computer, 256 MB
 * on a phone, `navigator.deviceMemory` where reported) leaves room for, bounded by the cores. The
 * panel shows the pool's own answer — the pool states it back when it sizes itself — rather than
 * re-deriving it, so the line cannot disagree with what ran.
 *
 * The sentence is `poolPlannerSentence`'s: "Planned on 2 workers: the memory allows 2 of 7." The
 * line is absent when no budgeted run has happened (a raster job, or nothing generated yet).
 */

import type { CSSProperties, ReactNode } from 'react';

import { poolPlannerSentence, type PoolSizing } from '@/engine/jobs/poolSizing';

const MUTED: CSSProperties = { fontSize: 11, color: '#9aa4b0', lineHeight: 1.5, margin: '4px 0' };

export function PoolTechnicalLine({ sizing }: { sizing: PoolSizing | null }): ReactNode {
  if (sizing === null) return null;
  return (
    <p style={MUTED} data-testid="engrave-pool-technical">
      {poolPlannerSentence(sizing)}
    </p>
  );
}
