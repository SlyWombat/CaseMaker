// The app's material vocabulary (#456): the shelf and the job must speak PrusaSlicer's own
// `filament_type` classes for printed stock.
//
// The shelf (#413) and the feeds editor render `STOCK_MATERIALS`/`MATERIAL_LABELS`, and a job's
// `stock.material` is parsed against the schema's `z.enum(STOCK_MATERIALS)`. So a class the 3MF
// reader can name but the vocabulary lacks would be a material the reader states and the job then
// refuses. These are specs of that existing behaviour, not a widening of it.

import { describe, expect, it } from 'vitest';

import {
  MATERIAL_LABELS,
  PRINTED_BLANK_MATERIALS,
  STOCK_MATERIALS,
  isPlasticMaterial,
} from '@/engine/cnc/materials';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';

describe('the shelf vocabulary carries PrusaSlicer’s filament classes (#456)', () => {
  it('covers exactly the printed-blank classes #456 lists that this app knows', () => {
    expect([...PRINTED_BLANK_MATERIALS]).toEqual([
      'pla',
      'petg',
      'pet',
      'abs',
      'asa',
      'hips',
      'pa',
      'pa-cf',
      'pa-gf',
      'pc',
      'pp',
      'tpu',
      'pva',
    ]);
  });

  it('offers every printed-blank class on the shelf, with an app word for it', () => {
    for (const material of PRINTED_BLANK_MATERIALS) {
      expect(STOCK_MATERIALS).toContain(material);
      expect(Object.prototype.hasOwnProperty.call(MATERIAL_LABELS, material)).toBe(true);
      expect(MATERIAL_LABELS[material]).toBeTruthy();
    }
  });

  it('parses every printed-blank class through the job schema’s material enum', () => {
    for (const material of PRINTED_BLANK_MATERIALS) {
      const job = defaultEngraveJob();
      job.stock = { ...job.stock, material };
      const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
      expect(parsed.ok, `${material} must parse as stock.material`).toBe(true);
      if (parsed.ok) expect(parsed.job.stock.material).toBe(material);
    }
  });

  it('keeps both fibre nylons distinct from plain PA, so the abrasive class has its own name', () => {
    expect(PRINTED_BLANK_MATERIALS).toContain('pa');
    expect(PRINTED_BLANK_MATERIALS).toContain('pa-cf');
    expect(PRINTED_BLANK_MATERIALS).toContain('pa-gf');
    expect(new Set(['pa', 'pa-cf', 'pa-gf']).size).toBe(3);
    expect(MATERIAL_LABELS['pa-cf']).not.toBe(MATERIAL_LABELS.pa);
    expect(MATERIAL_LABELS['pa-gf']).not.toBe(MATERIAL_LABELS.pa);
  });
});

describe('the plastic class (#564)', () => {
  it('reads every named plastic — printed blanks, acrylic and unspecified plastic — as plastic', () => {
    for (const material of [...PRINTED_BLANK_MATERIALS, 'acrylic', 'plastic'] as const) {
      expect(isPlasticMaterial(material), material).toBe(true);
    }
  });

  it('reads no wood and no metal as plastic', () => {
    for (const material of ['softwood', 'hardwood', 'mdf', 'aluminium-6061', 'aluminium-7075', 'brass', 'copper'] as const) {
      expect(isPlasticMaterial(material), material).toBe(false);
    }
  });

  it('partitions the whole vocabulary: every stock material is exactly one of wood, metal or plastic', () => {
    for (const material of STOCK_MATERIALS) {
      const plastic = isPlasticMaterial(material);
      const wood = material === 'softwood' || material === 'hardwood' || material === 'mdf';
      const metal = ['aluminium-6061', 'aluminium-7075', 'brass', 'copper'].includes(material);
      expect(Number(plastic) + Number(wood) + Number(metal), material).toBe(1);
    }
  });
});
