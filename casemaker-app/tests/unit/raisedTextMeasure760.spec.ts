// #760 — the raised-text gap, measured at the fixtures the brief names: j02's "Software" at
// 14 mm and the coin's "Software" at 3.6 mm on the disc. The rows are the same ones
// `raised-text-fused` quotes and the pick reads, and a cone is judged where the raised letters
// stand — its TOP-FACE opening, not its plane width, which a sharply-tipped V would let pass a
// gap it visibly welds over.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tl } from './helpers/manifoldExec';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { raisedTextMeasure } from '@/workers/sim/engraveGenerate';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const JOBS = join(HERE, '..', '..', '..', 'docs', 'bench', '2026-10-28-z1-real-jobs', 'jobs');

function jobOf(name: string): EngraveJob {
  const parsed = parseEngraveJob(JSON.parse(readFileSync(join(JOBS, name), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.job;
}

const flat = (diameter: number): Tool => flatEndMill(diameter, { name: `flat ${diameter}` });

/** The 90° chamfer bit the bench owns: a 0.1 mm tip on a 3.175 mm shank. */
const CHAMFER_90 = flatEndMill(3.175, {
  name: '90° chamfer',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: 0.1,
  angle: 90,
});

describe('#760 raised-text gaps, measured', () => {
  it('j02 "Software" at 14 mm: gaps 1.08 mm — a 1.5 mm flat joins, a 1 mm keeps', () => {
    const job = jobOf('j02-raised-cnx.json');
    const measure = raisedTextMeasure(tl, job, toPartPlan(job));
    const wide = measure(flat(1.5));
    expect(wide).toHaveLength(1);
    expect(wide[0]!.text).toBe('Software');
    expect(wide[0]!.gap).toBeCloseTo(1.08, 2);
    // "CNX" at 24 mm survives the same width — the measurement is structural, not a size table.
    expect(measure(flat(3.175)).map((r) => r.labelId)).toEqual(['software']);
    expect(measure(flat(1))).toEqual([]);
  });

  it('the coin’s "Software" at 3.6 mm: gaps 0.278 mm — every flat from 0.3 up joins it', () => {
    const job = jobOf('j04-coin-disc-pla.json');
    const measure = raisedTextMeasure(tl, job, toPartPlan(job));
    const one = measure(flat(1));
    expect(one).toHaveLength(1);
    expect(one[0]!.text).toBe('Software');
    expect(one[0]!.gap).toBeCloseTo(0.278, 3);
    expect(measure(flat(3.175)).map((r) => r.labelId).sort()).toEqual(['cnx', 'software']);
    expect(measure(flat(0.2))).toEqual([]);
  });

  it('judges a V at its TOP-FACE opening: the 90° 0.1 mm chamfer opens 0.9 mm there', () => {
    const job = jobOf('j04-coin-disc-pla.json');
    const measure = raisedTextMeasure(tl, job, toPartPlan(job));
    const rows = measure(CHAMFER_90);
    expect(rows.map((r) => r.labelId)).toEqual(['software']);
    // 0.05 mm tip radius + 0.4 mm of flank at tan 45° = 0.45 mm half-width → 0.9 mm opening.
    expect(rows[0]!.cutterRadius).toBeCloseTo(0.45, 3);
  });
});
