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
import { feedRowDiameter, flatEndMill, tipNotRecorded, type Tool } from '@/engine/cnc/tool';
import {
  DEFAULT_V_CARVE_STEPOVER_RATIO,
  vCarveRowStepover,
} from '@/engine/cnc/vCarveGeometry';
import { vCone } from '@/engine/cnc/vProfile';
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

describe('#740 — the Makera row’s 0.1 mm tip V-carves what the shank refused', () => {
  it('generates j10 with the tip stated', () => {
    const gen = generate(tl, benchJob('j10-plaque-90v.json', 0.1));

    expect(codes(gen)).not.toContain('tool-tip-unrecorded');
    expect(codes(gen)).not.toContain('item-empty');
    expect(codes(gen)).not.toContain('vcarve-groove-too-narrow');
    expect(gen.findings.some((f) => SHANK_READ_AS_CUTTER.test(f.message))).toBe(false);
    // The old step-over arithmetic divided the chamfer's flat-row step-over by the 0.1 mm tip
    // width (ratio 14.2875) and the CAM refused it. The row's own diameter is the denominator.
    expect(gen.errors).toEqual([]);
    expect(gen.ok).toBe(true);
    expect(gen.programs.length).toBeGreaterThan(0);
  }, 180_000);

  it('generates j11 with the tip stated', () => {
    const gen = generate(tl, benchJob('j11-inlay-female-90v.json', 0.1));

    expect(codes(gen)).not.toContain('tool-tip-unrecorded');
    expect(codes(gen)).not.toContain('item-empty');
    expect(codes(gen)).not.toContain('vcarve-groove-too-narrow');
    expect(gen.findings.some((f) => SHANK_READ_AS_CUTTER.test(f.message))).toBe(false);
    expect(gen.errors).toEqual([]);
    expect(gen.ok).toBe(true);
    expect(gen.programs.length).toBeGreaterThan(0);
  }, 180_000);
});

describe('#740 — one owner for the tip, one diameter for the feeds row', () => {
  it('tipNotRecorded is true only for a pointed cutter whose tip the record leaves empty', () => {
    expect(tipNotRecorded(chamfer(null))).toBe(true);
    // A stated 0 is a POINT, not an unknown: `vCone` reads it as one, and the plane model's own
    // 0 µm groove refusal (#221) is the true sentence for that cutter. The Type door records a
    // blank as null and refuses a typed 0 as a claim, so only an absent field is asked for.
    expect(tipNotRecorded(chamfer(0))).toBe(false);
    expect(tipNotRecorded(chamfer(0.1))).toBe(false);
    // A flat end mill records its whole face as the tip; that is a stated size, not this case.
    expect(tipNotRecorded(flatEndMill(3.175))).toBe(false);
    // A pointed cutter with no resolvable cone is the cone's own refusal, not this one.
    expect(tipNotRecorded(flatEndMill(3.175, { shape: 'engraving', tipDiameter: null, angle: null, halfAngle: null }))).toBe(
      false,
    );
  });

  it('feedRowDiameter is the base a chamfer row is resolved on and the tip an engraver’s', () => {
    expect(feedRowDiameter(chamfer(null))).toBe(3.175); // the shank, never 0
    expect(feedRowDiameter(chamfer(0.1))).toBe(3.175);
    const engraver = flatEndMill(3.175, {
      shape: 'engraving',
      tipDiameter: 0.3,
      angle: 30,
      halfAngle: 15,
    });
    expect(feedRowDiameter(engraver)).toBe(0.3);
    expect(feedRowDiameter(flatEndMill(6))).toBe(6);
  });

  it('vCarveRowStepover reads a chamfer’s flat-row number against its base, not its tip', () => {
    const tool = chamfer(0.1);
    const cone = vCone(tool);
    expect(cone).not.toBeNull();
    // 0.45 × 3.175 mm is exactly what `feedsFor` resolves for the chamfer's flat row.
    const step = vCarveRowStepover(tool, 0.45 * 3.175, 0.2, cone!);
    expect(step).not.toBeNull();
    expect(step!.requested).toBeCloseTo(2 * 0.2 * 0.45, 12);
    // The 0.1 mm tip still bounds the FLOOR, so the effective pitch is its 0.05 mm radius.
    expect(step!.effective).toBeCloseTo(0.05, 12);
    expect(step!.clamped).toBe(true);
    // The old reader measured the same row number against the tip width: ratio 14.2875, outside
    // (0, 1], which the CAM threw on. Nothing about that number is fed back in as a fraction.
    expect((0.45 * 3.175) / (2 * cone!.tipRadius)).toBeCloseTo(14.2875, 10);
    expect(vCarveRowStepover(tool, feedRowDiameter(tool)! + 0.1, 0.2, cone!)).toBeNull();
  });

  it('vCarveRowStepover leaves an engraver’s established numbers where they were', () => {
    const engraver = flatEndMill(3.175, {
      shape: 'engraving',
      tipDiameter: 0.3,
      angle: 30,
      halfAngle: 15,
    });
    const cone = vCone(engraver)!;
    const step = vCarveRowStepover(engraver, DEFAULT_V_CARVE_STEPOVER_RATIO * 0.3, 0.2, cone)!;
    expect(step.requested).toBeCloseTo(2 * 0.2 * DEFAULT_V_CARVE_STEPOVER_RATIO, 12);
    expect(step.clamped).toBe(true); // 0.24 mm request vs the 0.15 mm tip radius
  });

  it('vCarveRowStepover answers null, not a throw, for a tip that is not stated', () => {
    const tool = chamfer(null);
    const cone = vCone(tool)!;
    expect(cone.tipRadius).toBe(0);
    expect(vCarveRowStepover(tool, 0.45 * 3.175, 0.2, cone)).toBeNull();
  });
});

describe('#740 — an unrecorded tip on a cone carve is a warning, not a silent point', () => {
  const assumedPoint = (gen: EngraveGenerated) =>
    gen.findings.filter((f) => f.code === 'tool-tip-assumed-point');

  /** j10 with every design item on the variable-depth carve (#665), the cone's own geometry. */
  function variableJ10(tip: number | null): EngraveJob {
    const job = benchJob('j10-plaque-90v.json', tip);
    job.labels = job.labels.map((l) => ({ ...l, vCarveDepth: 'variable' as const }));
    job.shapes = job.shapes.map((s) => ({ ...s, vCarveDepth: 'variable' as const }));
    return job;
  }

  it('warns that j10’s variable-depth carve is planned as a sharp point, without the plane error', () => {
    const gen = generate(tl, variableJ10(null));
    const warning = assumedPoint(gen);
    expect(warning).toHaveLength(1);
    expect(warning[0]!.severity).toBe('warning');
    // The cutter by name, the field with its unit, and the assumption in plain words. A finding
    // code never leaks into the sentence.
    expect(warning[0]!.message).toContain('C1-BIT-CHAMFER-90');
    expect(warning[0]!.message).toContain('tip ⌀');
    expect(warning[0]!.message).toContain('mm');
    expect(warning[0]!.message).toContain('SHARP POINT');
    expect(warning[0]!.message).not.toContain('tool-tip-assumed-point');
    // The plane-model ERROR is not duplicated: no item here is judged at a colour plane.
    expect(codes(gen)).not.toContain('tool-tip-unrecorded');
  }, 180_000);

  it('drops the warning when j10’s tip is stated', () => {
    const gen = generate(tl, variableJ10(0.1));
    expect(codes(gen)).not.toContain('tool-tip-assumed-point');
  }, 180_000);

  it('warns for j11’s inlay while its plane-model label keeps the error', () => {
    const gen = generate(tl, benchJob('j11-inlay-female-90v.json', null));
    expect(assumedPoint(gen)).toHaveLength(1);
    expect(assumedPoint(gen)[0]!.message).toContain('C1-BIT-CHAMFER-90');
    // Distinct items, distinct findings: the FF label is judged at the plane (error), the inlay
    // ring follows the cone (warning). Neither sentence is written twice.
    const error = gen.findings.filter((f) => f.code === 'tool-tip-unrecorded');
    expect(error).toHaveLength(1);
    expect(error[0]!.severity).toBe('error');

    const stated = generate(tl, benchJob('j11-inlay-female-90v.json', 0.1));
    expect(codes(stated)).not.toContain('tool-tip-assumed-point');
  }, 180_000);

  it('warns for a prism with an unrecorded tip, and not once the tip is stated', () => {
    // j10 has no prism fixture; its one shape is marked as one (#674). Labels are removed so no
    // item is judged at a colour plane and the warning is the prism's own.
    const prismJob = (tip: number | null): EngraveJob => {
      const job = benchJob('j10-plaque-90v.json', tip);
      job.labels = [];
      job.shapes = [{ ...job.shapes[0]!, prism: {} }];
      return job;
    };
    const gen = generate(tl, prismJob(null));
    expect(assumedPoint(gen)).toHaveLength(1);
    expect(codes(gen)).not.toContain('tool-tip-unrecorded');
    const stated = generate(tl, prismJob(0.1));
    expect(codes(stated)).not.toContain('tool-tip-assumed-point');
  }, 180_000);
});

