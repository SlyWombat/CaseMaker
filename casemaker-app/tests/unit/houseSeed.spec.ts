// #654 scope 4 — the house's six V-bits seed with a NULL flute length because `build-house.ts`
// copied the label's empty field verbatim. The derivation already exists (`vFluteLength`, landed in
// `7e02f36d`); the house BUILD never applied it, so every rebuild reproduced the nulls. This test
// drives the builder with the six real label records and pins the cone heights the labels imply:
// LC = (DC − D1) / (2 · tan(halfAngle)), with the chamfer's unstated tip read as a point.
//
// The second case is the other half of the rule: a label that DOES state a flute length is the
// vendor's measurement, so the build keeps it — the derivation only fills an empty field. (Every
// non-cone in the corpus states one; the flat here is the real `C1-BIT-FLAT-3.175-12`.)

import { describe, expect, it } from 'vitest';

import { buildHouseInventory, type LabelRecord } from '@/engine/cnc/houseDocument';

/** The six V-bits' printed labels, exactly as `tool-labels/labels.json` records them. */
function record(code: string, label: string, reading: LabelRecord['reading']): LabelRecord {
  return {
    code,
    label,
    chinese: '',
    makeraSku: '',
    quantity: 1,
    codes: [{ symbology: 'qr', value: code }],
    caseColours: ['yellow base, clear tube'],
    reading,
  };
}

const SIX: LabelRecord[] = [
  record('C1-BIT-ENGRAVE-30-0.3', 'Single Flute Engraving Bit - 1/8" Shank 30° * 0.3mm', { shape: 'engraving', angleDeg: 30, tipDiameter: 0.3 }),
  record('C1-BIT-ENGRAVE-30-0.5', 'Single Flute Engraving Bit - 1/8" Shank 30° * 0.5mm', { shape: 'engraving', angleDeg: 30, tipDiameter: 0.5 }),
  record('C1-BIT-CHAMFER-90', 'Chamfering Bit - 1/8" Shank 90°', { shape: 'chamfer', angleDeg: 90 }),
  record('C1-BIT-ENGRAVE-M-30-0.2', 'Single Flute Engraving Bit for Metal - 1/8" Shank 30° * 0.2mm', { shape: 'engraving', angleDeg: 30, tipDiameter: 0.2 }),
  record('C1-BIT-ENGRAVE-M-30-0.3', 'Single Flute Engraving Bit for Metal - 1/8" Shank 30° * 0.3mm', { shape: 'engraving', angleDeg: 30, tipDiameter: 0.3 }),
  record('C1-BIT-ENGRAVE-M-60-0.1', 'Single Flute Engraving Bit for Metal - 1/8" Shank 60° * 0.1mm', { shape: 'engraving', angleDeg: 60, tipDiameter: 0.1 }),
];

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

describe('#654 the house build derives a V-bit flute length', () => {
  it('writes the cone height into every one of the six house V-bits', () => {
    const { inventory, problems } = buildHouseInventory({ records: SIX });
    expect(problems).toEqual([]);
    expect(inventory).toHaveLength(6);

    const byId = new Map(inventory.map((item) => [item.id, item.tool]));
    // The six derived values the issue states, from DC 3.175 mm (the 1/8" shank) and each angle.
    expect(round3(byId.get('kz-engrave-30-0-3')!.fluteLength!)).toBe(5.365);
    expect(round3(byId.get('kz-engrave-30-0-5')!.fluteLength!)).toBe(4.992);
    expect(round3(byId.get('kz-chamfer-90')!.fluteLength!)).toBe(1.588);
    expect(round3(byId.get('kz-engrave-m-30-0-2')!.fluteLength!)).toBe(5.551);
    expect(round3(byId.get('kz-engrave-m-30-0-3')!.fluteLength!)).toBe(5.365);
    expect(round3(byId.get('kz-engrave-m-60-0-1')!.fluteLength!)).toBe(2.663);
  });

  it('keeps a flute length the label states, and derives nothing for a shape that is not a cone', () => {
    const { inventory, problems } = buildHouseInventory({
      records: [record('C1-BIT-FLAT-3.175-12', 'Flat End Mill - 1/8" Shank 3.175mm * 12mm', { shape: 'flat', tipDiameter: 3.175, fluteLength: 12 })],
    });
    expect(problems).toEqual([]);
    expect(inventory[0]!.tool.fluteLength).toBe(12);
  });
});
