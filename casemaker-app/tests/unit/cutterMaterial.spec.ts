// #573/#954 — the shared cutter/material metal-line predicate, and the LABELLED FALLBACK that
// replaced the refusal. The wizard's step-2 gate and the worker's `metalLineFindings` read the
// predicate; the pick and the feeds read the fallback.

import { describe, it, expect } from 'vitest';

import { cutterOnMetalLine } from '@/engine/cnc/engrave/cutterMaterial';
import { planCutters } from '@/engine/cnc/engrave/cutterPlan';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { feedsFor, feedsToolForSurface, metalLineFallbackNote } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';

/** The 30° engraving bit, named for metal but a V-profile cone — dual-use (#575). */
const engravingMetal = flatEndMill(0.5, {
  shape: 'engraving',
  name: 'Engraving V-bit 30 x 0.5 (Metal)',
  tipDiameter: 0.5,
  diameter: 3.175,
  angle: 30,
  halfAngle: 15,
});
/** Makera's metal FLAT end mill, on the "(Metal)" line (#405). */
const flatMetal = flatEndMill(3.175, { id: '112111313812', name: '3.175*12mm Flat End(Metal)' });
/** The owned "for Metal" ball #954's finding names.</summary> */
const ballMetal = flatEndMill(2, {
  id: '161031002006',
  name: '2*6mm Ball Nose(Metal)',
  shape: 'ball',
  tipDiameter: 2,
  diameter: 3.175,
  fluteLength: 6,
});

/** A pure goal job: a ball's work, on the hardwood stick. */
function goalBallJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [];
  job.shapes = [];
  job.combined = [];
  job.traces = [];
  job.toolKey = '';
  job.stock = { ...job.stock, material: 'hardwood' };
  job.targetObject = {
    id: 'goal-954',
    name: 'part',
    role: 'goal',
    enabled: true,
    format: 'stl',
    sha256: 'a'.repeat(64),
    position: { x: 20, y: 20, z: 0 },
    rotation: 0,
    size: { x: 20, y: 20, z: 5 },
  } as EngraveJob['targetObject'];
  return job;
}

describe('cutterMaterial (#573 shared metal-line predicate)', () => {
  it('does not put a V-profile engraving bit on the line, even with a metal name (#575)', () => {
    expect(cutterOnMetalLine(engravingMetal, 'pla')).toBe(false);
  });

  it('puts a flat metal cutter on PLA on the line — the PAIR carries it (#405)', () => {
    expect(cutterOnMetalLine(flatMetal, 'pla')).toBe(true);
  });

  it('does not put a flat metal cutter on a metal blank on the line (#405)', () => {
    expect(cutterOnMetalLine(flatMetal, 'aluminium-6061')).toBe(false);
  });
});

describe('#954 the metal-line fallback is labelled, not refused', () => {
  it('feeds a metal flat on PLA from the starting band, and says it is a fallback', () => {
    const note = metalLineFallbackNote(flatMetal, 'pla', []);
    expect(note).toContain('Makera publishes no feed row');
    expect(note).toContain('labelled fallback');
    const feeds = feedsFor([], 'pla', flatMetal, Z1);
    expect(feeds.ok).toBe(true);
    if (!feeds.ok) return;
    expect(feeds.entry.provenance).toContain('Makera publishes no feed row');
  });

  it('says nothing when the catalogue rates the pair (#732 — the premise is false)', () => {
    const rows = [{ cutterId: '112111313812', material: 'ABS', rpm: 12000, feed: 900, plungeFeed: 400, stepDown: 1 }];
    expect(metalLineFallbackNote(flatMetal, 'pla', rows)).toBeNull();
  });

  it('red-first: an owned metal ball on hardwood is a candidate with the labelled feeds, not a refusal', () => {
    const job = goalBallJob();
    const entries: ToolLibraryEntry[] = [{ key: 'inv:m-ball-2', tool: ballMetal, provenance: 'test' }];
    const plan = planCutters(job, null, entries, []);
    expect(plan.cutters.map((c) => c.key)).toContain('inv:m-ball-2');
    expect(plan.unassigned).toEqual([]);
    // The pair's labelled fallback is stated for the ball itself; a goal's ball is FED through the
    // generator's flat proxy (#910), which resolves the material's starting row.
    expect(metalLineFallbackNote(ballMetal, 'hardwood', [])).toContain('Makera publishes no feed row');
    const feeds = feedsFor([], 'hardwood', feedsToolForSurface(ballMetal), Z1);
    expect(feeds.ok).toBe(true);
  });
});
