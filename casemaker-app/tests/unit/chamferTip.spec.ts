/**
 * #740 — A POINTED CUTTER'S UNKNOWN TIP IS NOT ITS SHANK.
 *
 * `cuttingDiameter` falls back to `diameter`, which is the right best effort for matching a FILE
 * against a cutter. For a chamfer Makera writes the 3.175 mm SHANK into `diameter` and leaves the
 * tip empty, and the findings used that fallback as if it were a cutter: "every stroke is thinner
 * than a 3.175 mm 90° V-bit", "A 4.5 mm hole cannot be cut with a 3.175 mm 90° V-bit". The cone the
 * CAM and the measurement actually use (`vCone`) reads the same record as a POINT, so the sentences
 * named a cutter that exists nowhere.
 *
 * The two bench jobs are the reproduction: j10's plaque (a 7 mm "Ruth" label, a 4.5 mm circle and
 * 53 traces) and j11's inlay female (a 22 mm "FF" label and a combined ring marked inlay). Both were
 * jobbed for `C1-BIT-CHAMFER-90`.
 *
 * What is pinned here:
 *  1. With no tip recorded, the worker ASKS for the tip — one plain-words finding naming the cutter
 *     and the field — and neither the wrong reach sentence nor the 0 µm groove refusal appears.
 *  2. With the Makera row's own geometry (tip 0.1 mm, flute 1.6 mm), the same jobs generate: the
 *     strokes and the 4.5 mm hole the 3.175 mm judgement refused are V-carved.
 *  3. The feeds row's step-over is a fraction of the diameter it was RESOLVED against (the chamfer
 *     row's shank/base, the engraver row's tip), which is what lets the tiny tip run at the row's
 *     requested fraction instead of dividing by a tip width the row never named.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';

const JOBS = join(__dirname, '..', '..', '..', 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');

/**
 * The house/owned row the two bench jobs were cut with, as the inventory materialises it: the tip
 * is either ABSENT (the state #740 is about) or the Makera row's own 0.1 mm. `diameter` is the
 * shank, the 3.175 mm the wrong sentences read as a cutter.
 */
function chamfer(tip: number | null): Tool {
  return flatEndMill(3.175, {
    id: null,
    name: 'C1-BIT-CHAMFER-90',
    typeText: 'Chamfer',
    shape: 'chamfer',
    tipDiameter: tip,
    diameter: 3.175,
    angle: 90,
    halfAngle: 45,
    fluteLength: 1.6,
  });
}

/** One bench job, with the cutter it names snapshotted on the job as the store would keep it. */
function benchJob(file: string, tip: number | null): EngraveJob {
  const raw = JSON.parse(readFileSync(join(JOBS, file), 'utf8')) as Record<string, unknown>;
  raw.tool = chamfer(tip);
  const parsed = parseEngraveJob(raw);
  if (!parsed.ok) throw new Error(`${file} should parse: ${parsed.errors.join('; ')}`);
  return parsed.job;
}

const codes = (gen: EngraveGenerated): string[] => gen.findings.map((f) => f.code);

/** The sentence #740 exists to delete: a shank read as the cutter that touches the design. */
const SHANK_READ_AS_CUTTER = /3\.175 mm 90° V-bit/;

describe('#740 — an unrecorded tip is asked for, not invented', () => {
  it('asks for j10’s tip instead of refusing its strokes and hole against the 3.175 mm shank', () => {
    const gen = generate(tl, benchJob('j10-plaque-90v.json', null));

    const ask = gen.findings.filter((f) => f.code === 'tool-tip-unrecorded');
    expect(ask).toHaveLength(1);
    expect(ask[0]!.severity).toBe('error');
    // Plain words, the cutter by name, and the field + its unit — the operator has to know what to
    // type and where. No finding code leaks into the sentence.
    expect(ask[0]!.message).toContain('C1-BIT-CHAMFER-90');
    expect(ask[0]!.message).toContain('tip ⌀');
    expect(ask[0]!.message).toContain('mm');
    expect(ask[0]!.message).toContain('Manage → Tools');
    expect(ask[0]!.message).not.toContain('tool-tip-unrecorded');
    expect(ask[0]!.labelId).toBeUndefined();

    // The wrong geometry refusals are GONE, not merely joined by the ask.
    expect(codes(gen)).not.toContain('item-empty');
    expect(codes(gen)).not.toContain('vcarve-groove-too-narrow');
    expect(gen.findings.some((f) => SHANK_READ_AS_CUTTER.test(f.message))).toBe(false);

    // It is a refusal: no program is written for a cutter whose width is unknown.
    expect(gen.ok).toBe(false);
    expect(gen.programs).toEqual([]);
  }, 180_000);

  it('asks for j11’s tip in place of the same wrong sentences', () => {
    const gen = generate(tl, benchJob('j11-inlay-female-90v.json', null));

    const ask = gen.findings.filter((f) => f.code === 'tool-tip-unrecorded');
    expect(ask).toHaveLength(1);
    expect(ask[0]!.message).toContain('C1-BIT-CHAMFER-90');
    expect(ask[0]!.message).toContain('tip ⌀');
    expect(codes(gen)).not.toContain('item-empty');
    expect(codes(gen)).not.toContain('vcarve-groove-too-narrow');
    expect(gen.findings.some((f) => SHANK_READ_AS_CUTTER.test(f.message))).toBe(false);
    expect(gen.ok).toBe(false);
    expect(gen.programs).toEqual([]);
  }, 180_000);

  it('does not ask where the plane model never judges the item (the variable carve’s own rule)', () => {
    // #665 — a variable-depth region's width is its own design at every level; the plane model's
    // reach finding is deliberately not computed for it, so an absent tip is not a blocker there.
    // Keeping the ask to the plane-model items is what stops it from refusing #665's established
    // point-tip carve (and #673's inlay, which the full suite pins separately).
    const job = benchJob('j10-plaque-90v.json', null);
    job.labels = job.labels.map((l) => ({ ...l, vCarveDepth: 'variable' as const }));
    job.shapes = job.shapes.map((s) => ({ ...s, vCarveDepth: 'variable' as const }));

    const gen = generate(tl, job);
    expect(codes(gen)).not.toContain('tool-tip-unrecorded');
  }, 180_000);
});
