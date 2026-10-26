/**
 * #700 — the line the wizard's Engrave text makes is placed and sized for the blank it is cut on.
 *
 * THE K3 WALK, AS A UNIT. A badge blank has its long side along Y in the vise and a 38.1 mm span
 * across the jaws; the old `addLabel` put a 10 mm line at the stock's centre reading along X, so
 * six characters ran through the fixed jaw and Generate refused the job the wizard had just built.
 * These fixtures build the badge route's job, add the operator's text, and hold the three claims:
 * the line reads the blank's way, its measured ink box is inside the stock minus the edge margin
 * (which is what the jaw rule charges), and the job generates with no error finding — with the
 * cutter the recommendation picks.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultBadgeParams } from '@/types/badge';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { inkBoxOf } from '@/engine/cnc/engrave/inkBox';
import { labelGlyphMeasure } from '@/engine/cnc/engrave/partPlan';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';

/** The badge route's job with no seeded line: exactly the issue's "badge blank + Zoomba". */
function badgeWithOperatorText(text: string): { id: string } {
  const store = useEngraveJobStore.getState();
  store.reset();
  store.takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));
  // The operator's material, as the walk states it (the badge seed is PLA by decision, #13).
  store.setStock({ material: 'pla' });
  store.replace({ ...useEngraveJobStore.getState().job, labels: [] });
  const id = useEngraveJobStore.getState().addEngraveText(text, { depth: 0.5, font: DEFAULT_FONT_ID });
  return { id };
}

beforeEach(() => {
  useEngraveJobStore.getState().reset();
});

describe('#700 the wizard’s engrave text', () => {
  it('reads a badge along its long side and sits inside the blank and its edge margin', () => {
    const { id } = badgeWithOperatorText('Zoomba');
    const job = useEngraveJobStore.getState().job;
    const label = job.labels.find((l) => l.id === id);
    expect(label).toBeDefined();
    expect(label!.rotation).toBe(90);
    expect(label!.text).toBe('Zoomba');

    // The line's own measured ink, put in the JOB's frame the way a rotation of 90 turns it: the
    // ink's width runs along Y, its height across X.
    const ink = inkBoxOf(label!.text, label!.font, label!.weight, label!.size, labelGlyphMeasure(job.customFonts ?? []));
    const halfAcross = ink.height / 2;
    const halfAlong = ink.width / 2;
    const edge = job.edgeMargin;
    expect(label!.position.x - halfAcross).toBeGreaterThanOrEqual(edge - 1e-9);
    expect(label!.position.x + halfAcross).toBeLessThanOrEqual(job.stock.length - edge + 1e-9);
    expect(label!.position.y - halfAlong).toBeGreaterThanOrEqual(edge - 1e-9);
    expect(label!.position.y + halfAlong).toBeLessThanOrEqual(job.stock.width - edge + 1e-9);
  });

  it('leaves the k3 job with no blocking finding, and generating with the recommended cutter', () => {
    badgeWithOperatorText('Zoomba');
    // The recommendation lands on the 1 mm flat end (#699's fixture); the engine needs the job to
    // name it before it can post a program.
    useEngraveJobStore.getState().setTool('flat-1.0', 'computed');
    const job = useEngraveJobStore.getState().job;

    // The blocker #688 surfaced: a cut within the jaw keep-out. It must be gone by the layout.
    const findings = validateJob(job);
    expect(findings.filter((f) => f.code === 'vise-jaw-collision')).toEqual([]);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);

    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.nc).not.toBeNull();
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('keeps a bare blank’s line reading along X and inside its own margin', () => {
    const store = useEngraveJobStore.getState();
    store.reset();
    store.setStock({ length: 100, width: 60, thickness: 12, material: 'pla' });
    store.replace({ ...useEngraveJobStore.getState().job, labels: [] });
    const id = useEngraveJobStore.getState().addEngraveText('Hello', { depth: 0.5, font: DEFAULT_FONT_ID });
    const job = useEngraveJobStore.getState().job;
    const label = job.labels.find((l) => l.id === id)!;
    expect(label.rotation).toBe(0);
    const ink = inkBoxOf(label.text, label.font, label.weight, label.size, labelGlyphMeasure(job.customFonts ?? []));
    expect(label.position.x - ink.width / 2).toBeGreaterThanOrEqual(job.edgeMargin - 1e-9);
    expect(label.position.x + ink.width / 2).toBeLessThanOrEqual(job.stock.length - job.edgeMargin + 1e-9);
    expect(label.position.y - ink.height / 2).toBeGreaterThanOrEqual(job.edgeMargin - 1e-9);
    expect(label.position.y + ink.height / 2).toBeLessThanOrEqual(job.stock.width - job.edgeMargin + 1e-9);
  });
});
