// #1102 — separate what HOLDS the blank from what LOCATES it. The bracket can be a FENCE (the
// blank taped to the bed and pushed into the bracket's corner): `tape` + `fence`. A bracket with
// no clamps is exactly that setup said from the wrong side, so the schema refuses it and the one
// stored shape that used to be allowed — the vendor tray's side 2 — migrates on load.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultBracketHold, defaultTapeHold } from '@/engine/cnc/engrave/jobSetup';
import { engraveJobDocumentSchema, parseEngraveJob } from '@/store/engraveJobSchema';
import type { BedFence, EngraveJob, JobWorkholding } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAY_SIDE_2 = join(HERE, '..', 'e2e', 'fixtures', 'm1trayB', 'm1trayB-bottom.cutjob.json');

const FENCE: BedFence = { kind: 'bracket', anchor: 1, variant: 'thin', edges: 'corner' };
const REFUSAL = "a bracket with no clamps is a fence — say 'taped, located against the bracket'";

function jobWith(workholding: JobWorkholding): EngraveJob {
  return { ...defaultEngraveJob(), workholding };
}
const parse = (job: unknown) => parseEngraveJob(JSON.parse(JSON.stringify(job)));

describe('#1102 the fence: tape holds, the bracket locates', () => {
  it('tape + fence (anchor 1, corner) is accepted, with where null and squareTo fence', () => {
    const tape = { ...defaultTapeHold(), where: null, squareTo: 'fence' as const, fence: FENCE };
    const parsed = parse(jobWith({ kind: 'tape', tape }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.workholding).toEqual({ kind: 'tape', tape });
  });

  it('tape without a fence is still the stored shape it was (fence absent, squareTo front)', () => {
    const parsed = parse(jobWith({ kind: 'tape', tape: defaultTapeHold() }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.workholding).toEqual({ kind: 'tape', tape: defaultTapeHold() });
    expect('fence' in (parsed.job.workholding as { tape: object }).tape).toBe(false);
  });

  it('a fence that names more than the corner is refused (a one-arm fence is not proven)', () => {
    const tape = { ...defaultTapeHold(), squareTo: 'fence' as const, fence: { ...FENCE, edges: 'left-arm' } };
    expect(parse(jobWith({ kind: 'tape', tape: tape as never })).ok).toBe(false);
  });

  it('a bracket with clamps: [] is refused with the sentence, by the document schema and by a parse', () => {
    const noClamps: JobWorkholding = { kind: 'bracket', bracket: { ...defaultBracketHold({ x: 100, y: 60, z: 6 }, null), clamps: [] } };
    const parsed = parse(jobWith(noClamps));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join('\n')).toContain(REFUSAL);
    const direct = engraveJobDocumentSchema.safeParse(JSON.parse(JSON.stringify(jobWith(noClamps))));
    expect(direct.success).toBe(false);
    if (!direct.success) expect(direct.error.issues.map((i) => i.message)).toContain(REFUSAL);
  });

  it('a bracket with clamps still parses', () => {
    expect(parse(jobWith({ kind: 'bracket', bracket: defaultBracketHold({ x: 100, y: 60, z: 6 }, null) })).ok).toBe(true);
  });
});

describe('#1102 the migration: the vendor tray’s side 2 is tape + fence', () => {
  it('rewrites the zero-clamp bracket under a taped board, and nothing else in the job changes', () => {
    const raw = JSON.parse(readFileSync(TRAY_SIDE_2, 'utf8')) as {
      workholding: { kind: string; bracket: { anchor: 1 | 2; variant: string; placement?: 'anchored' | 'placed'; obstacles?: unknown[] } };
    };
    expect(raw.workholding.kind).toBe('bracket');
    const migrated = parseEngraveJob(raw);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;

    const b = raw.workholding.bracket;
    const fence: BedFence = {
      kind: 'bracket',
      anchor: b.anchor,
      placement: b.placement,
      variant: b.variant,
      edges: 'corner',
      obstacles: b.obstacles as BedFence['obstacles'],
    };
    const explicit = { ...raw, workholding: { kind: 'tape', tape: { ...defaultTapeHold(), where: null, squareTo: 'fence', fence } } };
    const expected = parseEngraveJob(JSON.parse(JSON.stringify(explicit)));
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const strip = (j: EngraveJob) => ({ ...j, id: undefined, setups: undefined });
    expect(migrated.job.workholding).toEqual(expected.job.workholding);
    expect(strip(migrated.job)).toEqual(strip(expected.job));
  });
});
