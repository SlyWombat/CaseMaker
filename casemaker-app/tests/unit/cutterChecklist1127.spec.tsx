// @vitest-environment jsdom
// #1127 — THE CUTTER CHECKLIST: one interactive row per bit (located / replaced), the Cut gate,
// and the hard rule that the state is NEVER a byte input (outside jobFingerprint and staleness).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  CutterChecklist,
  cutterChecklistComplete,
  cutterChecklistRows,
  missingCuttersWords,
} from '@/components/panels/CutterChecklist';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { buildRunRecord, parseRunRecordText } from '@/engine/cnc/engrave/runRecord';
import { bitsLaidOutWords } from '@/engine/cnc/engrave/runSheet';
import { freezePackage, jobFingerprint, packageStaleness } from '@/engine/cnc/engrave/package';
import { flatEndMill } from '@/engine/cnc/tool';
import { resetRegistry, setInventoryEntries, setRegistry } from '@/engine/cnc/toolRegistry';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import type { EngraveJob } from '@/types/engraveJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FLAT = flatEndMill(3.175, { number: 1, name: '⌀3.175 mm flat end', handleDiameter: 3.175, fluteLength: 25 });
const BIG = flatEndMill(6, { number: 2, name: '⌀6 mm flat end', handleDiameter: 6, fluteLength: 30 });
const ALT = flatEndMill(3.175, { number: 3, name: '⌀3.175 mm flat end (spare)', handleDiameter: 3.175, fluteLength: 20 });

function seedRegistry(): void {
  setInventoryEntries([
    { key: 'inv:flat-25', tool: FLAT, provenance: 'test' },
    { key: 'inv:big-6', tool: BIG, provenance: 'test' },
    { key: 'inv:flat-20', tool: ALT, provenance: 'test' },
  ]);
  setRegistry([{ key: 'user:not-owned', tool: FLAT, provenance: 'test' }]);
}

const PROGRAMS = [{ toolKey: 'inv:flat-25' }, { toolKey: 'inv:big-6' }, { toolKey: 'inv:flat-25' }];

function jobWithClean(): EngraveJob {
  const job = defaultEngraveJob();
  return job;
}

afterEach(() => {
  cleanup();
  resetRegistry();
});

describe('#1127 the cutter checklist', () => {
  it('rows come in program order, each naming the programs it serves', () => {
    seedRegistry();
    const rows = cutterChecklistRows(PROGRAMS);
    expect(rows.map((row) => row.key)).toEqual(['inv:flat-25', 'inv:big-6']);
    expect(rows[0]!.programs).toEqual([1, 3]);
    expect(rows[1]!.programs).toEqual([2]);
  });

  it('the gate stays closed until EVERY row is located or replaced, and names what is missing', () => {
    seedRegistry();
    const rows = cutterChecklistRows(PROGRAMS);
    const missingWords = missingCuttersWords(rows, undefined) ?? '';
    expect(missingWords).toContain('0 of 2 cutters located — fit: ⌀ 3.175 mm flat end');
    expect(missingWords).toContain('⌀ 6 mm flat end');
    const partial = { 'inv:flat-25': { state: 'located' as const, at: new Date(2026, 10, 9, 11, 58, 0).toISOString() } };
    expect(cutterChecklistComplete(rows, partial)).toBe(false);
    expect(missingCuttersWords(rows, partial)).toContain('1 of 2');
    const complete = { ...partial, 'inv:big-6': { state: 'replaced' as const, replacedWith: 'inv:flat-20', at: new Date(2026, 10, 9, 11, 59, 0).toISOString() } };
    expect(cutterChecklistComplete(rows, complete)).toBe(true);
    expect(missingCuttersWords(rows, complete)).toBeNull();
  });

  it('renders a tick per row and writes the state through onSet; a 6 mm shank is stated, not an invented collet', () => {
    seedRegistry();
    const rows = cutterChecklistRows(PROGRAMS);
    const onSet = vi.fn();
    render(<CutterChecklist rows={rows} entries={undefined} onSet={onSet} />);
    expect(screen.getByTestId('engrave-cutter-missing').textContent).toContain('0 of 2');
    fireEvent.click(screen.getByTestId('engrave-cutter-locate-inv:flat-25'));
    expect(onSet).toHaveBeenCalledWith('inv:flat-25', expect.objectContaining({ state: 'located' }));
    // The 6 mm shank is printed as the shank; no record states a collet, so no collet is named.
    expect(screen.getByTestId('engrave-cutter-shank-inv:big-6').textContent).toContain('6 mm shank');
    expect(screen.queryByTestId('engrave-cutter-shank-inv:flat-25')).toBeNull();
    // A replacement offers an OWNED cutter of the same class (never the user's library).
    const picker = screen.getByTestId('engrave-cutter-replace-inv:flat-25') as HTMLSelectElement;
    const values = [...picker.options].map((o) => o.value);
    expect(values).toContain('inv:flat-20');
    expect(values).not.toContain('user:not-owned');
  });

  it('#803 — a disabled control SAYS WHY: the reason rides the title and aria-description', () => {
    seedRegistry();
    const rows = cutterChecklistRows(PROGRAMS);
    const reason = 'tick each bit at the Cut step, once the program is generated';
    render(<CutterChecklist rows={rows} entries={undefined} onSet={() => {}} disabled disabledReason={reason} />);
    const locate = screen.getByTestId('engrave-cutter-locate-inv:flat-25') as HTMLInputElement;
    expect(locate.disabled).toBe(true);
    expect(locate.getAttribute('title')).toBe(reason);
    expect(locate.getAttribute('aria-description')).toBe(reason);
    const replace = screen.getByTestId('engrave-cutter-replace-inv:flat-25') as HTMLSelectElement;
    expect(replace.disabled).toBe(true);
    expect(replace.getAttribute('title')).toBe(reason);
    expect(replace.getAttribute('aria-description')).toBe(reason);
  });

  it('TICKING IS NOT A BYTE INPUT: the fingerprint and the package’s staleness do not move', () => {
    seedRegistry();
    const job = jobWithClean();
    job.toolKey = 'inv:flat-25';
    const made = freezePackage(job, [{ setupIndex: 1, setupId: 'setup-1', toolKey: 'inv:flat-25', nc: 'G0 X0 Y0\nM02\n', programHash: 'h1', frameNc: null }], '2026-11-09T11:00:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    const pkg = made.package;
    const before = jobFingerprint(job);
    const ticked: EngraveJob = {
      ...job,
      cutterChecklist: {
        [pkg.hash]: {
          'inv:flat-25': { state: 'located', at: new Date(2026, 10, 9, 11, 58, 0).toISOString() },
          'inv:big-6': { state: 'replaced', replacedWith: 'inv:flat-20', at: new Date(2026, 10, 9, 11, 59, 0).toISOString() },
        },
      },
    };
    expect(jobFingerprint(ticked)).toBe(before);
    expect(packageStaleness(pkg, ticked).stale).toBe(false);
  });

  it('REPLACING a cutter writes it into the job (a byte input) — the package goes stale for an honest regenerate', () => {
    seedRegistry();
    const job = jobWithClean();
    job.toolKey = 'inv:flat-25';
    job.setups = [{ ...(job.setups ?? [])[0]!, tools: ['inv:flat-25'] } as never];
    const made = freezePackage(job, [{ setupIndex: 1, setupId: 'setup-1', toolKey: 'inv:flat-25', nc: 'G0 X0 Y0\nM02\n', programHash: 'h1', frameNc: null }], '2026-11-09T11:00:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    useEngraveJobStore.setState({ job });
    useEngraveJobStore.getState().replaceCutter('inv:flat-25', 'inv:flat-20');
    const replaced = useEngraveJobStore.getState().job;
    expect(replaced.toolKey).toBe('inv:flat-20');
    expect(replaced.setups?.[0]?.tools).toEqual(['inv:flat-20']);
    // A replacement IS a byte input: the frozen program no longer describes the job.
    expect(packageStaleness(made.package, replaced).stale).toBe(true);
  });

  it('a replacement follows the run across the regenerate the checklist asks for', () => {
    seedRegistry();
    const at = new Date(2026, 10, 9, 11, 59, 0).toISOString();
    // The operator's statement names the ORIGINAL cutter and its substitute. The whole run is then
    // re-generated, so the programs post the substitute — the row the gate asks about is now the
    // substitute's, and it is already answered by that entry.
    const entries = { 'inv:flat-25': { state: 'replaced' as const, replacedWith: 'inv:flat-20', at } };
    const rows = cutterChecklistRows([{ toolKey: 'inv:flat-20' }]);
    expect(rows.map((row) => row.key)).toEqual(['inv:flat-20']);
    expect(cutterChecklistComplete(rows, entries)).toBe(true);
    expect(missingCuttersWords(rows, entries)).toBeNull();
    // The sheet and the record name the bit that is in the spindle, not the one that is not.
    const job = jobWithClean();
    const made = freezePackage(
      job,
      [{ setupIndex: 1, setupId: 'setup-1', toolKey: 'inv:flat-20', nc: 'G0 X0 Y0\nM02\n', programHash: 'h2', frameNc: null }],
      '2026-11-09T12:00:00.000Z',
    );
    if (!made.ok) throw new Error(made.reason);
    const pkg = made.package;
    const checklisted: EngraveJob = { ...job, package: pkg, cutterChecklist: { [pkg.hash]: entries } };
    expect(bitsLaidOutWords(checklisted, [{ toolKey: 'inv:flat-20' }])).toBe('bits laid out: 1 of 1 at 11:59.');
    const record = buildRunRecord(
      checklisted,
      { nc: 'G0 X0 Y0\nM02\n', programs: [{ setupIndex: 1, setupId: 'setup-1', toolKey: 'inv:flat-20', nc: 'G0 X0 Y0\nM02\n' }] } as never,
      new Date('2026-11-09T12:00:00.000Z'),
    );
    expect(record.cutterChecklist).toEqual([
      expect.objectContaining({ key: 'inv:flat-20', state: 'replaced', programs: [1] }),
    ]);
    // The substitute does not name itself as its own replacement.
    expect(record.cutterChecklist?.[0]?.replacedWith).toBeUndefined();
  });

  it('the run record and the run sheet carry the laid-out line', () => {
    seedRegistry();
    const job = jobWithClean();
    const made = freezePackage(job, [{ setupIndex: 1, setupId: 'setup-1', toolKey: 'inv:flat-25', nc: 'G0 X0 Y0\nM02\n', programHash: 'h1', frameNc: null }], '2026-11-09T11:00:00.000Z');
    if (!made.ok) throw new Error(made.reason);
    const pkg = made.package;
    const checklisted: EngraveJob = {
      ...job,
      package: pkg,
      cutterChecklist: { [pkg.hash]: { 'inv:flat-25': { state: 'located', at: new Date(2026, 10, 9, 11, 58, 0).toISOString() } } },
    };
    const programs = [{ toolKey: 'inv:flat-25' }];
    expect(bitsLaidOutWords(checklisted, programs)).toBe('bits laid out: 1 of 1 at 11:58.');
    const record = buildRunRecord(checklisted, { nc: 'G0 X0 Y0\nM02\n', programs: [{ setupIndex: 1, setupId: 'setup-1', toolKey: 'inv:flat-25', nc: 'G0 X0 Y0\nM02\n' }] } as never, new Date('2026-11-09T12:00:00.000Z'));
    expect(record.cutterChecklist).toEqual([
      expect.objectContaining({ key: 'inv:flat-25', state: 'located', programs: [1] }),
    ]);
    // The record is a FILE a person hand-edits and the app reads back: the checklist survives the
    // round trip (a silent drop would print one thing and read another).
    const parsed = parseRunRecordText(JSON.stringify(record));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.run.cutterChecklist).toEqual(record.cutterChecklist);
  });
});
