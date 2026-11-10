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
import { partialRegenPlan, partialRegenSentence } from '@/engine/cnc/engrave/partialRegen';
import { freezePackage, type PackageProgramInput } from '@/engine/cnc/engrave/package';
import { engraveGenerate } from '@/workers/sim/engraveGenerate';
import { flatEndMill } from '@/engine/cnc/tool';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { tl } from './helpers/manifoldExec';
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

describe('#1136 stage 2a — which programs a replacement touches, and whether it may be partial', () => {
  const programsFor = (job: EngraveJob): PackageProgramInput[] => job.setups!.flatMap((setup, i) =>
    setup.tools.map((toolKey, j) => ({
      setupIndex: i + 1,
      setupId: setup.id,
      toolKey,
      nc: `G0 X0 Y0\n; setup ${i + 1} ${toolKey} ${j}\nM02\n`,
      frameNc: null,
      programHash: `h-${setup.id}-${toolKey}-${j}`,
    })),
  );
  const frozen = (job: EngraveJob) => {
    const made = freezePackage(job, programsFor(job), '2026-11-10T00:00:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    return made.package;
  };

  it('names the affected setup and carries the unaffected programs verbatim', () => {
    const base = job();
    const pkg = frozen(base);
    const replaced = withCutterReplacement(base, 'inv:b', 'inv:e');
    const plan = partialRegenPlan(replaced, pkg);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.affectedSetups).toEqual([1]);
    expect(plan.affectedSetupIds).toEqual(['s1']);
    // S2's frozen program rides over with the SAME bytes and hash.
    expect(plan.carry).toHaveLength(1);
    expect(plan.carry[0]).toMatchObject({ setupId: 's2', toolKey: 'inv:a', programHash: 'h-s2-inv:a-0' });
    expect(plan.carry[0]!.nc).toBe(pkg.programs.find((p) => p.setupId === 's2')!.nc);
  });

  it('the other setup affected when the substitution lands there', () => {
    const base = job();
    const pkg = frozen(base);
    const plan = partialRegenPlan(withCutterReplacement(base, 'inv:a', 'inv:e'), pkg);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.affectedSetups).toEqual([1, 2]);
    expect(plan.carry).toEqual([]);
  });

  it('refuses when the job changed beyond the replacement (the whole run must re-post)', () => {
    const base = job();
    const pkg = frozen(base);
    const changed: EngraveJob = { ...withCutterReplacement(base, 'inv:b', 'inv:e'), labels: [...base.labels.slice(1)] };
    const plan = partialRegenPlan(changed, pkg);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('beyond the cutter replacement');
  });

  it('refuses a replacement that would post the same cutter twice in one setup (a merge)', () => {
    const base = job();
    const pkg = frozen(base);
    const dup: EngraveJob = { ...base, cutterSubstitutions: { s1: { 'inv:b': 'inv:a' } } };
    const plan = partialRegenPlan(dup, pkg);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('merge two programs');
  });

  it('a map that changes nothing is not a partial post at all', () => {
    const base = job();
    const pkg = frozen(base);
    expect(partialRegenPlan(base, pkg)).toMatchObject({ ok: false });
  });
});

describe('#1136 stage 2b — the partial post carries the untouched programs byte for byte', () => {
  const TOOL_B_KEY = 'user:flat-1-b';
  const TOOL_C_KEY = 'user:flat-0.8-c';
  const tools: ToolLibraryEntry[] = [
    { key: TOOL_B_KEY, tool: flatEndMill(1.0, { name: '1 mm flat (setup B)' }), provenance: 'test' },
    { key: TOOL_C_KEY, tool: flatEndMill(0.8, { name: '0.8 mm flat (setup C)' }), provenance: 'test' },
    ...TOOL_LIBRARY,
  ];

  /** Two setups, one label each: setup 1's program then setup 2's, in cut order. */
  function twoSetupJob(): EngraveJob {
    const j = defaultEngraveJob();
    j.toolKey = 'flat-1.0';
    const [a, b] = j.labels.map((l) => l.id);
    j.setups = [setup('s1', [a!], ['flat-1.0']), setup('s2', [b!], [TOOL_B_KEY])];
    return j;
  }

  it('re-posts only the affected setup, and the estimate names only its programs', async () => {
    const job = twoSetupJob();
    const generate = (j: EngraveJob, previous?: Parameters<typeof engraveGenerate>[9]) =>
      engraveGenerate(tl, j, jobTool(j), [], null, undefined, { tools }, undefined, undefined, previous);

    const full = await generate(job);
    expect(
      full.ok,
      JSON.stringify({ stage: full.stage, errors: full.errors, findings: full.findings.filter((f) => f.severity === 'error') }),
    ).toBe(true);
    expect(full.programs.map((p) => p.setupId)).toEqual(['s1', 's2']);

    const made = freezePackage(job, full.programs, '2026-11-10T00:00:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    const pkg = made.package;
    const frozenJob: EngraveJob = { ...job, package: pkg };
    const replaced = withCutterReplacement(frozenJob, TOOL_B_KEY, TOOL_C_KEY);

    const plan = partialRegenPlan(replaced, pkg);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.affectedSetups).toEqual([2]);
    expect(partialRegenSentence(plan, pkg)).toContain('1 of 2 program');
    expect(partialRegenSentence(plan, pkg)).toContain('setup 2');
    expect(partialRegenSentence(plan, pkg)).toContain('the other 1 rides over unchanged');

    const partial = await generate(replaced, full);
    expect(
      partial.ok,
      JSON.stringify({ stage: partial.stage, errors: partial.errors, findings: partial.findings.filter((f) => f.severity === 'error') }),
    ).toBe(true);
    // THE PROMISE: the unaffected program's text and key are the frozen ones, byte for byte.
    expect(partial.programs.map((p) => p.setupId)).toEqual(['s1', 's2']);
    expect(partial.programs[0]!.nc).toBe(full.programs[0]!.nc);
    expect(partial.programs[0]!.programHash).toBe(full.programs[0]!.programHash);
    // The replaced setup really re-posts, with the replacement named.
    expect(partial.programs[1]!.toolKey).toBe(TOOL_C_KEY);
    expect(partial.programs[1]!.nc).not.toBe(full.programs[1]!.nc);
    // The operator is told what the press will do, and only that.
    const statement = partial.findings.find((f) => f.code === 'partial-regen');
    expect(statement?.severity).toBe('info');
    expect(statement?.message).toContain('1 of 2 program');
    expect(statement?.message).toContain('setup 2');
    // The freeze still covers the whole run, in the same order.
    const frozenAgain = freezePackage(replaced, partial.programs, '2026-11-10T00:01:00.000Z');
    if (!frozenAgain.ok) throw new Error(frozenAgain.reason);
    expect(frozenAgain.package.programs).toHaveLength(pkg.programs.length);
    expect(frozenAgain.package.programs.map((p) => p.setupId)).toEqual(pkg.programs.map((p) => p.setupId));
    expect(frozenAgain.package.programs[0]!.hash).toBe(pkg.programs[0]!.hash);
    expect(frozenAgain.package.programs[1]!.hash).not.toBe(pkg.programs[1]!.hash);
    expect(frozenAgain.package.hash).not.toBe(pkg.hash);
  });

  it('a design change beside the replacement re-posts the whole run, stated', async () => {
    const job = twoSetupJob();
    const generate = (j: EngraveJob, previous?: Parameters<typeof engraveGenerate>[9]) =>
      engraveGenerate(tl, j, jobTool(j), [], null, undefined, { tools }, undefined, undefined, previous);
    const full = await generate(job);
    expect(full.ok).toBe(true);
    const made = freezePackage(job, full.programs, '2026-11-10T00:00:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    const replaced = withCutterReplacement({ ...job, package: made.package }, TOOL_B_KEY, TOOL_C_KEY);
    // A design edit, not a cutter one: the substitution is no longer the only change.
    const changed: EngraveJob = { ...replaced, labels: replaced.labels.map((l, i) => (i === 0 ? { ...l, text: 'CASED' } : l)) };

    const fallback = await generate(changed, full);
    expect(fallback.ok).toBe(true);
    const statement = fallback.findings.find((f) => f.code === 'partial-regen');
    expect(statement?.message).toContain('whole run');
    // A full re-post is byte-for-byte the run a generate with no carry produces.
    const fresh = await generate({ ...changed, package: undefined });
    expect(fallback.programs.map((p) => p.programHash)).toEqual(fresh.programs.map((p) => p.programHash));
  });
});

