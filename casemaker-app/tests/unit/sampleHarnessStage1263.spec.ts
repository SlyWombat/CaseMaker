/**
 * #1263 — the sample bench states its own material and never stages a job the schema refuses.
 * (`tools/samples/stageStock.ts`; the wizard no longer proposes a material, and the harness used to
 * copy the proposal's null into every mesh sample's job.)
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '../../src/store/engraveJobSchema';
import { proposeStock } from '../../src/engine/cnc/stockProposal';
import { assertStaged, HARNESS_MATERIAL, stagedMaterial } from '../../tools/samples/stageStock';

describe('#1263 the sample bench stages a material', () => {
  it('the wizard proposes none for a mesh — the case the harness copied', () => {
    expect(proposeStock({ kind: 'mesh', size: { x: 40, y: 40, z: 12 } })!.material).toBeNull();
  });

  it('a sample with no stated material gets the harness choice, and says so', () => {
    expect(stagedMaterial({})).toEqual({ material: HARNESS_MATERIAL, chosen: true });
    expect(stagedMaterial({ material: null })).toEqual({ material: HARNESS_MATERIAL, chosen: true });
    expect(HARNESS_MATERIAL).toBe('hardwood');
  });

  it("a sample whose manifest states a material keeps its own, and the harness chose nothing", () => {
    expect(stagedMaterial({ material: 'mdf' })).toEqual({ material: 'mdf', chosen: false });
  });

  it('the staged job is one the job schema accepts', () => {
    const proposal = proposeStock({ kind: 'mesh', size: { x: 40, y: 40, z: 12 } })!;
    const job = defaultEngraveJob();
    job.stock = { ...job.stock, length: proposal.length, width: proposal.width, thickness: proposal.thickness, material: stagedMaterial({}).material };
    expect(() => assertStaged(job)).not.toThrow();
    expect(parseEngraveJob(JSON.parse(JSON.stringify(job))).ok).toBe(true);
  });

  it('a null or unusable field is the harness’s OWN failure, naming the field — not a schema refusal', () => {
    const base = defaultEngraveJob();
    const withStock = (patch: Record<string, unknown>) => ({ ...base, stock: { ...base.stock, ...patch } }) as never;
    expect(() => assertStaged(withStock({ material: null }))).toThrow(/stock\.material is null/);
    expect(() => assertStaged(withStock({ thickness: null }))).toThrow(/stock\.thickness is null/);
    expect(() => assertStaged(withStock({ length: Number.NaN }))).toThrow(/stock\.length is not usable/);
  });
});
