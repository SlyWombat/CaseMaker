/**
 * #700 — the line the wizard's Engrave text makes is placed and sized for the blank it is cut on,
 * and it FILLS the blank route's placeholder rather than printing over it.
 *
 * THE K3 WALK, AS A UNIT. A badge blank has its long side along Y in the vise and a 38.1 mm span
 * across the jaws. The badge starter seeds one placeholder line ("Name"); step 4's "Zoomba" is
 * what that line was for, so the operation replaces its text in place — one line, read along Y,
 * inside the stock minus the edge margin, with no jaw finding. A line the operator has already
 * edited is not a placeholder: the operation's text is ADDED, and the seed's avoid rule sends it
 * to the next free band instead of over the edited line. The k3 job then generates with the cutter
 * the recommendation picks.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultBadgeParams } from '@/types/badge';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { inkBoxOf } from '@/engine/cnc/engrave/inkBox';
import { labelGlyphMeasure } from '@/engine/cnc/engrave/partPlan';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import { defaultBlankParams } from '@/types/blank';
import type { EngraveJob, EngraveLabel } from '@/types/engraveJob';

/** The badge route's job, as the starter builds it: stock, pocket and its one seeded line. */
function badgeStarter(): void {
  const store = useEngraveJobStore.getState();
  store.reset();
  store.takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));
  // The operator's material, as the walk states it (the badge seed is PLA by decision, #13).
  store.setStock({ material: 'pla' });
}

/** The label's ink box as an axis-aligned box in the job's frame (rotation folded into the AABB). */
function labelBox(job: EngraveJob, label: EngraveLabel): { x0: number; y0: number; x1: number; y1: number } {
  const ink = inkBoxOf(label.text, label.font, label.weight, label.size, labelGlyphMeasure(job.customFonts ?? []));
  const halfWidth = ink.width / 2;
  const halfHeight = ink.height / 2;
  const radians = (label.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(radians));
  const s = Math.abs(Math.sin(radians));
  const halfX = halfWidth * c + halfHeight * s;
  const halfY = halfWidth * s + halfHeight * c;
  return { x0: label.position.x - halfX, y0: label.position.y - halfY, x1: label.position.x + halfX, y1: label.position.y + halfY };
}

function insideMargin(job: EngraveJob, label: EngraveLabel): void {
  const box = labelBox(job, label);
  const edge = job.edgeMargin;
  expect(box.x0).toBeGreaterThanOrEqual(edge - 1e-9);
  expect(box.x1).toBeLessThanOrEqual(job.stock.length - edge + 1e-9);
  expect(box.y0).toBeGreaterThanOrEqual(edge - 1e-9);
  expect(box.y1).toBeLessThanOrEqual(job.stock.width - edge + 1e-9);
}

beforeEach(() => {
  useEngraveJobStore.getState().reset();
});

describe('#700 the wizard’s engrave text', () => {
  it('fills the badge starter’s seeded line in place: one label, read along the blank’s long side', () => {
    badgeStarter();
    const seeded = useEngraveJobStore.getState().job;
    expect(seeded.labels).toHaveLength(1);
    const seedId = seeded.labels[0]!.id;
    // The badge route's seed carries the placeholder stamp, and it survives a document round-trip
    // (the schema must name the key or Zod strips it and a reload loses the fill).
    expect(useEngraveJobStore.getState().job.sources?.labels?.[seedId]?.seed).toBe(true);
    const roundTrip = parseEngraveJob(JSON.parse(JSON.stringify(seeded)) as unknown);
    expect(roundTrip.ok).toBe(true);
    if (roundTrip.ok) expect(roundTrip.job.sources?.labels?.[seedId]?.seed).toBe(true);

    const id = useEngraveJobStore.getState().addEngraveText('Zoomba', { depth: 0.5, font: DEFAULT_FONT_ID });
    const job = useEngraveJobStore.getState().job;
    expect(job.labels).toHaveLength(1);
    expect(job.labels[0]!.id).toBe(seedId);
    expect(id).toBe(seedId);
    expect(job.labels[0]!.text).toBe('Zoomba');
    expect(job.labels[0]!.rotation).toBe(90);
    expect(job.labels[0]!.depth).toBe(0.5);
    // The line is the person's operation now, not a placeholder to fill again.
    expect(job.sources?.labels?.[seedId]?.seed).toBeUndefined();
    expect(job.sources?.labels?.[seedId]?.layout).toBe('user');
    insideMargin(job, job.labels[0]!);
  });

  it('leaves the k3 job with no blocking finding, and generating with the recommended cutter', () => {
    badgeStarter();
    useEngraveJobStore.getState().addEngraveText('Zoomba', { depth: 0.5, font: DEFAULT_FONT_ID });
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

  it('adds a second line clear of a seeded line the operator has already edited', () => {
    badgeStarter();
    const store = useEngraveJobStore.getState();
    const seed = store.job.labels[0]!;
    // The operator edits the placeholder: from here it is their line, and the operation must not
    // overwrite it.
    store.updateLabel(seed.id, { text: 'Hello', size: 6 });
    expect(useEngraveJobStore.getState().job.sources?.labels?.[seed.id]?.seed).toBeUndefined();

    useEngraveJobStore.getState().addEngraveText('Zoomba', { depth: 0.5, font: DEFAULT_FONT_ID });
    const job = useEngraveJobStore.getState().job;
    expect(job.labels).toHaveLength(2);
    const hello = job.labels.find((l) => l.id === seed.id)!;
    const zoomba = job.labels.find((l) => l.id !== seed.id)!;
    expect(hello.text).toBe('Hello');
    expect(zoomba.text).toBe('Zoomba');
    // The second went to the next free band: the two ink boxes do not touch.
    const a = labelBox(job, hello);
    const b = labelBox(job, zoomba);
    const disjoint = a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0;
    expect(disjoint).toBe(true);
    insideMargin(job, hello);
    insideMargin(job, zoomba);
  });

  it('fills a bare blank’s seeded line too, and reads along X', () => {
    const store = useEngraveJobStore.getState();
    store.reset();
    // A blank of its own footprint, so the demo plank's three words are not what this route keeps.
    store.takeBlankStock(defaultBlankParams({ width: 120, height: 70, thickness: 10 }));
    store.setStock({ material: 'pla' });
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(1);
    const seedId = useEngraveJobStore.getState().job.labels[0]!.id;

    const id = useEngraveJobStore.getState().addEngraveText('Hello', { depth: 0.5, font: DEFAULT_FONT_ID });
    const job = useEngraveJobStore.getState().job;
    expect(id).toBe(seedId);
    expect(job.labels).toHaveLength(1);
    expect(job.labels[0]!.text).toBe('Hello');
    expect(job.labels[0]!.rotation).toBe(0);
    insideMargin(job, job.labels[0]!);
  });
});
