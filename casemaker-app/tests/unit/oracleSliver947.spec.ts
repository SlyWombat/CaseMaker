// #947 — the recommended ⌀3.175 flat (19 mm cap) under-cuts the default text job on the real
// shop inventory: the oracle's boundary comparison reads a hairline sliver at a reflex corner of
// the design (where two strokes join) as material left, because the CAM posts the cut as
// independent ring contours while the prediction is the design's own morphological opening — the
// two constructions can disagree by a sliver even though every stroke is fully reached. The fix
// (`ORACLE_SLIVER_WIDTH_MM` in oracle.ts) opens the raw disagreement region at a small, fixed
// width before counting its area, so a sliver thinner than that width collapses to nothing while
// a genuinely wide defect still fails.
import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { createSimSession, type SimSession } from '@/workers/sim/session';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { Z1 } from '@/engine/cnc/machine';
import type { EngraveJob } from '@/types/engraveJob';

function load(job: EngraveJob, nc: string, tool: Tool): SimSession {
  const session = createSimSession(tl);
  const r = session.load(nc, toSetup(job, Z1), tool, Z1.id);
  if (!r.ok) throw new Error(`load refused: ${JSON.stringify(r.diagnostics)}`);
  return session;
}

/** C's reproduction setup on #947: a single-line text job on the hardwood stick, cap 19 mm. */
function zoombaJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.stock = { length: 100, width: 36, thickness: 36, material: 'hardwood' };
  job.labels = [
    {
      id: 'zoomba',
      text: 'Zoomba',
      font: job.labels[0]!.font,
      weight: 'bold',
      size: 19,
      position: { x: 18, y: 50 },
      rotation: 90,
      depth: 0.5,
      enabled: true,
    },
  ];
  job.shapes = [];
  return job;
}

describe('#947 — the oracle absorbs a boundary sliver but still catches a real under-cut', () => {
  it.each([1.0, 2.0, 3.0, 3.175])('the default text job reaches four ticks with a ⌀%s mm flat', async (dia) => {
    const job = zoombaJob();
    const tool = flatEndMill(dia);
    const g = await engraveGenerate(tl, job, tool, []);
    expect(g.nc).not.toBeNull();
    const session = load(job, g.nc!, tool);
    try {
      const report = session.oracle(g.predicted);
      // Every diameter in #947's own measurement reaches every stroke; only the boundary hairline
      // differed before the fix, and it must no longer block the file.
      expect(report.ok).toBe(true);
      expect(report.worst.underCut).toBeLessThanOrEqual(report.areaFloor ?? 0.001);
      expect(report.worst.overCut).toBeLessThanOrEqual(report.areaFloor ?? 0.001);
    } finally {
      session.dispose();
    }
  });

  it('still refuses the same job if the posted program is deliberately shrunk away from the design', async () => {
    const job = zoombaJob();
    const tool = flatEndMill(3.175);
    const g = await engraveGenerate(tl, job, tool, []);
    expect(g.nc).not.toBeNull();
    // A program shifted well past any boundary tolerance leaves the design's own strokes behind —
    // the #741 class of defect (a real, substantial disagreement), which must still fail loudly
    // regardless of the sliver fix.
    const shifted = g.nc!.replace(/X([\d.]+)/g, (_m, x: string) => `X${(parseFloat(x) + 0.5).toFixed(4)}`);
    const session = load(job, shifted, tool);
    try {
      const report = session.oracle(g.predicted);
      expect(report.ok).toBe(false);
      expect(report.worst.underCut + report.worst.overCut).toBeGreaterThan(1);
    } finally {
      session.dispose();
    }
  });
});
