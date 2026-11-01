/**
 * #879 — HARDWOOD IS THE FLAGSHIP, AND PRINTED PLASTIC SAYS IT MELTS — ONCE.
 *
 * The maintainer retired "the default is a job for a printed PLA blank": cutting PLA is not
 * recommended, because it softens from cutting heat. Hardwood replaces it as the default material
 * and the flagship example (a hardwood name plate). PLA and PETG stay offered — a badge import is
 * printed PLA by definition — and a job whose blank is one carries a SINGLE info line naming the
 * heat problem and the ways to keep the cut cool. A fact, never a refusal, and never per program.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import type { StockMaterial } from '@/types/engraveJob';

function jobOn(material: StockMaterial) {
  const base = defaultEngraveJob();
  return { ...base, stock: { ...base.stock, material } };
}

describe('#879 the default material is hardwood', () => {
  it('a fresh job is a hardwood blank, with the name plate’s geometry unchanged', () => {
    const job = defaultEngraveJob();
    expect(job.stock.material).toBe('hardwood');
    // The geometry that suits wood is the plate the job has always been: three engraved words.
    expect(job.labels.map((l) => l.text)).toEqual(['CASE', 'MAKER', 'first chips']);
    expect(job.shapes).toEqual([]);
  });

  it('the same job still validates on the hardwood rows', () => {
    const findings = validateJob(defaultEngraveJob());
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});

describe('#879 printed plastic is one stated fact', () => {
  for (const material of ['pla', 'petg'] as const) {
    it(`a ${material.toUpperCase()} job carries exactly one info line about cutting heat`, () => {
      const findings = validateJob(jobOn(material));
      const melt = findings.filter((f) => f.code === 'printed-plastic-melts');
      expect(melt).toHaveLength(1);
      expect(melt[0]!.severity).toBe('info');
      expect(melt[0]!.message).toContain('softens from cutting heat');
      // The ways out are named on the same line.
      expect(melt[0]!.message).toMatch(/step-down/i);
      expect(melt[0]!.message).toMatch(/single-flute/i);
      expect(melt[0]!.message).toMatch(/air blast/i);
      // Never a refusal: the material alone raises no error.
      expect(findings.some((f) => f.severity === 'error')).toBe(false);
    });
  }

  it('hardwood carries no such line', () => {
    const findings = validateJob(defaultEngraveJob());
    expect(findings.some((f) => f.code === 'printed-plastic-melts')).toBe(false);
  });

  it('it is one line for the job, not one per item: a three-word job still carries one', () => {
    const job = jobOn('pla');
    expect(job.labels.length).toBe(3);
    expect(validateJob(job).filter((f) => f.code === 'printed-plastic-melts')).toHaveLength(1);
  });
});
