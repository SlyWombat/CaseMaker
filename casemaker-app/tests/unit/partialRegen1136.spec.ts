// #1136 — A CUTTER REPLACEMENT AS A JOB-LEVEL MAP, not a rewrite. Stage 1 of the design note's
// approved shape: the map is consumed at `jobSetups` (the ONE place a program's cutter is
// resolved), the document keeps its own `toolKey`/`setups[].tools`, and the fingerprint moves
// when — and only when — a program's cutter really changes. Red first against the old in-place
// `replaceCutter` (which rewrote the document and left no map).

import { describe, expect, it } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { jobFingerprint } from '@/engine/cnc/engrave/package';
import { replacementProblem, withCutterReplacement } from '@/engine/cnc/engrave/cutterChecklist';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;
const setup = (id: string, itemIds: string[], tools: string[]): JobSetup => ({
  id,
  orientation: { ...IDENTITY },
  mount: { kind: 'vise' },
  itemIds,
  tools,
});

/** A two-setup, two-cutter job: S1 posts A then B; S2 posts A. */
function job(): EngraveJob {
  const j = defaultEngraveJob();
  j.toolKey = 'inv:a';
  j.setups = [setup('s1', ['txt'], ['inv:a', 'inv:b']), setup('s2', ['txt'], ['inv:a'])];
  return j;
}

describe('#1136 a replacement is a map at the one seam', () => {
  it('jobSetups applies the map, and the document keeps its own cutters', () => {
    const j: EngraveJob = { ...job(), cutterSubstitutions: { s1: { 'inv:b': 'inv:c' }, s2: { 'inv:a': 'inv:d' } } };
    const resolved = jobSetups(j);
    expect(resolved.find((s) => s.id === 's1')!.tools).toEqual(['inv:a', 'inv:c']);
    expect(resolved.find((s) => s.id === 's2')!.tools).toEqual(['inv:d']);
    // The document is untouched: the operator's bits, the checklist's original keys.
    expect(j.setups![0]!.tools).toEqual(['inv:a', 'inv:b']);
    expect(j.setups![1]!.tools).toEqual(['inv:a']);
    expect(j.toolKey).toBe('inv:a');
  });

  it('a face tool listed with the setup is substituted too (#836)', () => {
    const withFace: EngraveJob = { ...job(), cutterSubstitutions: { s1: { 'inv:b': 'inv:c' } } };
    withFace.setups![0] = { ...withFace.setups![0]!, faceToolKey: 'inv:b' };
    expect(jobSetups(withFace).find((s) => s.id === 's1')!.faceToolKey).toBe('inv:c');
  });

  it('the map is a BYTE input: the fingerprint moves only when a cutter really changed', () => {
    const base = job();
    expect(jobFingerprint({ ...base, cutterSubstitutions: { s1: { 'inv:b': 'inv:c' } } })).not.toBe(jobFingerprint(base));
    // A map that replaces a cutter with itself changes no program: same fingerprint.
    expect(jobFingerprint({ ...base, cutterSubstitutions: { s1: { 'inv:b': 'inv:b' } } })).toBe(jobFingerprint(base));
    // The checklist stays outside it (#1127's hard rule).
    const ticked: EngraveJob = { ...base, cutterChecklist: { pkg: { 'inv:b': { state: 'located', at: '2026-11-10T00:00:00.000Z' } } } };
    expect(jobFingerprint(ticked)).toBe(jobFingerprint(base));
  });

  it('the replacement rule writes the map for every setup that lists the cutter', () => {
    const next = withCutterReplacement(job(), 'inv:a', 'inv:e');
    expect(next.cutterSubstitutions).toEqual({ s1: { 'inv:a': 'inv:e' }, s2: { 'inv:a': 'inv:e' } });
    // Nothing in the document moved.
    expect(next.setups![0]!.tools).toEqual(['inv:a', 'inv:b']);
    expect(next.setups![1]!.tools).toEqual(['inv:a']);
    expect(next.toolKey).toBe('inv:a');
    // The measured search's substitution sentence goes, as the in-place write did.
    expect(next.substitution).toBeUndefined();
    // Replacing again updates the entry rather than adding a second one.
    expect(withCutterReplacement(next, 'inv:a', 'inv:f').cutterSubstitutions).toEqual({ s1: { 'inv:a': 'inv:f' }, s2: { 'inv:a': 'inv:f' } });
    // A no-op replacement is no write at all.
    const unchanged = job();
    expect(withCutterReplacement(unchanged, 'inv:a', 'inv:a')).toBe(unchanged);
  });

  it('the implicit setup (no stored setups) substitutes too', () => {
    const j = defaultEngraveJob();
    j.setups = undefined;
    j.toolKey = 'inv:a';
    const next = withCutterReplacement(j, 'inv:a', 'inv:e');
    expect(Object.values(next.cutterSubstitutions ?? {})).toHaveLength(1);
    expect(jobSetups(next)[0]!.tools).toEqual(['inv:e']);
    expect(jobSetups(next)[0]!.id).toBe(jobSetups(j)[0]!.id);
  });

  it('refuses a replacement another cutter in the SAME setup already posts (it would merge refs)', () => {
    expect(replacementProblem(job(), 'inv:b', 'inv:c')).toBeNull();
    expect(replacementProblem(job(), 'inv:a', 'inv:b')).toContain('would merge the two programs');
    expect(replacementProblem(job(), 'inv:b', 'inv:a')).toContain('would merge the two programs');
    // An already-mapped key still finds its setups: S1 posts B, so B -> A would merge there.
    const mapped = withCutterReplacement(job(), 'inv:a', 'inv:e');
    expect(replacementProblem(mapped, 'inv:a', 'inv:b')).not.toBeNull();
    // A replacement already in ANOTHER setup only is fine.
    expect(replacementProblem(job(), 'inv:b', 'inv:e')).toBeNull();
  });
});
