// #513 — A JOB BINDS TO THE BED PROFILE IT WAS SET UP ON.
//
// The binding (which profile, which version, a snapshot of the datums it used), the differences
// between the bed a job was planned on and the bed the machine has now, and the findings that say
// so — under the maintainer's severity rules:
//
//   - `bed-changed` WARNS in Design (the Cut gate turns the same words into the error, pinned by
//     `preflightHub`'s own spec); its two answers are presses beside the sentence.
//   - `fixture-overlap` is an ERROR (two fixtures on the same pins is a physical collision).
//   - `mount-not-on-bed`, `stock-off-surface`, `cut-leaves-board` and `surface-top-unmeasured`
//     INFORM with the fix; nothing refuses on a tolerance or on a size alone.
//   - `bed-unmeasured` is NOT a per-job finding: a fresh bed's datums are all unmeasured, so a
//     per-job warning would fire on every job (the maintainer's noise rule). The Start line states
//     it once (`bedNeverMeasured`), and `surface-top-unmeasured` speaks only where a datum the JOB
//     needs is absent.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  BedPlacementSchema,
  BedProfileSchema,
  LocationViewSchema,
  type BedProfile,
  type MachineRecord,
} from '@/platform/locationClient';
import {
  bedChangedSentence,
  bedFindings,
  bedLine,
  bedNeverMeasured,
  bindJob,
  diffBed,
  overhangOf,
  profileVersion,
  scarsUnder,
  tapeFootprint,
} from '@/engine/cnc/bed/binding';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob, TapeHold } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEW = LocationViewSchema.parse(JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')));
const MACHINE = VIEW.machines[0]!;

const datum = (value: number, measuredAt = '2026-10-18T10:00:00.000Z') => ({
  value,
  measuredAt,
  by: 'fx-probe-1',
  at: [10, -20] as [number, number],
});

/**
 * A bed profile, parsed through the schema so every default is the schema's own. The override is
 * loosely typed ON PURPOSE: a test states only the fields its case is about, and the schema — the
 * same one the app holds the record to — supplies (and validates) everything else.
 */
function profile(over: Record<string, unknown> = {}): BedProfile {
  return BedProfileSchema.parse({
    id: 'bp-test',
    name: 'Z1 — Wasteboard + tape',
    createdAt: '2026-10-15T09:00:00.000Z',
    surface: { kind: 'wasteboard', thickness: 10 },
    datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null },
    placements: [],
    history: [{ at: '2026-10-16T10:00:00.000Z', what: 'measured' }],
    ...over,
  });
}

function machineWith(profiles: BedProfile[], activeId = profiles[0]!.id): MachineRecord {
  return { ...MACHINE, bedProfiles: profiles, activeBedProfileId: activeId };
}

/** A 100 × 60 × 6 plate; `throughAt` gives the first label a depth that reaches the bottom. */
function job(over: Partial<EngraveJob> = {}): EngraveJob {
  const base = defaultEngraveJob();
  const plate: EngraveJob = { ...base, stock: { ...base.stock, length: 100, width: 60, thickness: 6 } };
  return { ...plate, ...over };
}

const TAPE: TapeHold = { width: 20, thickness: 0.1, inset: 2, where: null, squareTo: 'front', source: 'default' };
const taped = (over: Partial<EngraveJob> = {}): EngraveJob => job({ workholding: { kind: 'tape', tape: { ...TAPE } }, ...over });

describe('#513 the profile version and the binding', () => {
  it('the version is the last history line’s time; a profile edited without one falls back to its creation', () => {
    expect(profileVersion(profile())).toBe('2026-10-16T10:00:00.000Z');
    expect(profileVersion({ ...profile(), history: [] })).toBe('2026-10-15T09:00:00.000Z');
    expect(profileVersion({ ...profile(), history: [{ at: '  ', what: 'x' }] })).toBe('2026-10-15T09:00:00.000Z');
  });

  it('bindJob records the profile, its version and the datums the job was planned against', () => {
    const bound = bindJob(
      profile({
        datums: {
          surfaceTopZ: datum(-112.3, '2026-10-17T09:00:00.000Z'),
          viseJawTopZ: null,
          bracketSeatZ: datum(-70.2),
          rotaryAxis: null,
        },
      }),
    );
    expect(bound).toEqual({
      profileId: 'bp-test',
      profileVersion: '2026-10-16T10:00:00.000Z',
      datums: { surfaceTopZ: -112.3, viseJawTopZ: null, bracketSeatZ: -70.2, rotaryAxis: null },
    });
  });
});

describe('#513 the differences between the job’s bed and the machine’s bed', () => {
  const active = profile({
    datums: { surfaceTopZ: datum(-112.3), viseJawTopZ: datum(-56.65), bracketSeatZ: null, rotaryAxis: null },
  });

  it('the same bed, unchanged, differs in nothing', () => {
    expect(diffBed(bindJob(active), active)).toEqual([]);
  });

  it('a different profile is ONE difference, because two profiles’ numbers are not one measurement', () => {
    const other = profile({ id: 'bp-other', name: 'Z1 — Low-profile vise' });
    expect(diffBed(bindJob(other), active)).toEqual([
      { what: 'profile', text: 'the bed is now “Z1 — Wasteboard + tape”, not the profile this job was set up on (“bp-other”)' },
    ]);
  });

  it('a moved, re-measured or unmeasured datum is named with both values', () => {
    const bound = { ...bindJob(active), profileVersion: '2026-10-15T09:00:00.000Z', datums: { surfaceTopZ: -112.3, viseJawTopZ: -56.8, bracketSeatZ: -70.2, rotaryAxis: null } };
    const moved = diffBed(bound, active);
    expect(moved.map((d) => d.what)).toEqual(['viseJawTopZ', 'bracketSeatZ']);
    expect(moved[0]!.text).toBe('the jaw top moved from -56.8 mm to -56.65 mm');
    expect(moved[1]!.text).toContain('bracket seat');
    expect(moved[1]!.text).toContain('is unmeasured now');
  });

  it('an edited profile with no datum the job states says so rather than staying silent', () => {
    const bound = { ...bindJob(active), profileVersion: '2026-10-15T09:00:00.000Z' };
    expect(diffBed(bound, active)).toEqual([{ what: 'version', text: 'the bed profile was edited since this job was set up' }]);
  });
});

describe('#513 the findings, under the maintainer’s rules', () => {
  it('a job bound to another bed WARNS in Design, naming both beds', () => {
    const oldBed = profile({ id: 'bp-old', name: 'Old bed' });
    const bound = bindJob(oldBed);
    // The machine still HOLDS the old profile — the switch-back press exists because of that; its
    // name is what the sentence uses, never the record's id.
    const findings = bedFindings({ job: taped({ bed: bound }), machine: machineWith([profile(), oldBed]), mount: 'tape' });
    const changed = findings.find((f) => f.code === 'bed-changed');
    expect(changed).toMatchObject({ severity: 'warning' });
    expect(changed!.message).toContain('“Old bed”');
    expect(changed!.message).toContain('Re-plan on the current bed, or switch the bed back.');
    // A machine that no longer holds it falls back to the id it was recorded under.
    const gone = bedFindings({ job: taped({ bed: bound }), machine: machineWith([profile()]), mount: 'tape' });
    expect(gone.find((f) => f.code === 'bed-changed')!.message).toContain('“bp-old”');
  });

  it('a job with no binding raises no bed-changed: it was never bound to anything', () => {
    const findings = bedFindings({ job: taped(), machine: machineWith([profile()]), mount: 'tape' });
    expect(findings.some((f) => f.code === 'bed-changed')).toBe(false);
  });

  it('two fixtures on the same locating pins is an ERROR', () => {
    // The schema refuses this at save; the finding defends a record that reached the machine some
    // other way (a hand-edited location, an import, an older service), so it is built past the parse.
    const both: BedProfile = {
      ...profile(),
      placements: [
        BedPlacementSchema.parse({ id: 'pl-vise', fixture: 'fx-vise', where: { kind: 'pins', pins: 'vise' } }),
        BedPlacementSchema.parse({ id: 'pl-rot', fixture: 'fx-rot', where: { kind: 'pins', pins: 'rotary' } }),
      ],
    };
    const findings = bedFindings({ job: job(), machine: machineWith([both]), mount: 'vise' });
    expect(findings.find((f) => f.code === 'fixture-overlap')).toMatchObject({ severity: 'error' });
  });

  it('a vise job on a bed with no vise INFORMS with the two fixes', () => {
    const findings = bedFindings({ job: job(), machine: machineWith([profile()]), mount: 'vise' });
    const f = findings.find((x) => x.code === 'mount-not-on-bed');
    expect(f).toMatchObject({ severity: 'warning' });
    expect(f!.message).toContain('Switch the bed profile');
  });

  it('a tape job whose surface top is unmeasured INFORMS; a vise job on the same bed does not', () => {
    const machine = machineWith([profile()]);
    expect(bedFindings({ job: taped(), machine, mount: 'tape' }).map((f) => f.code)).toContain('surface-top-unmeasured');
    expect(bedFindings({ job: job(), machine, mount: 'vise' }).some((f) => f.code === 'surface-top-unmeasured')).toBe(false);
  });

  it('a stock larger than the surface INFORMS by size when the blank’s place is not known (bracket)', () => {
    const board = profile({ surface: { kind: 'wasteboard', thickness: 10, length: 80, width: 50 } });
    const findings = bedFindings({ job: job(), machine: machineWith([board]), mount: 'bracket' });
    expect(findings.find((f) => f.code === 'stock-off-surface')).toMatchObject({ severity: 'warning' });
  });

  it('a taped job knows where the blank sits, so the overhang names the edge and the distance', () => {
    const board = profile({
      surface: { kind: 'wasteboard', thickness: 10, length: 200, width: 200, position: { frontLeft: [0, 0], frame: 'machine' } },
    });
    const placed = taped({ workholding: { kind: 'tape', tape: { ...TAPE, where: { x: 150, y: 40 } } } });
    const f = bedFindings({ job: placed, machine: machineWith([board]), mount: 'tape' }).find((x) => x.code === 'stock-off-surface');
    expect(f).toMatchObject({ severity: 'warning' });
    expect(f!.message).toContain('50 mm past the right edge'); // 150 + 100 − 200
  });

  it('the same overhang on a job that cuts THROUGH is the hazard, not the size', () => {
    const board = profile({
      surface: { kind: 'wasteboard', thickness: 10, length: 200, width: 200, position: { frontLeft: [0, 0], frame: 'machine' } },
    });
    const through = taped({
      workholding: { kind: 'tape', tape: { ...TAPE, where: { x: 150, y: 40 } } },
      labels: [{ ...job().labels[0]!, depth: 6 }], // the plate is 6 mm thick: depth 6 reaches the bottom
    });
    const findings = bedFindings({ job: through, machine: machineWith([board]), mount: 'tape' });
    expect(findings.map((f) => f.code)).toContain('cut-leaves-board');
    expect(findings.some((f) => f.code === 'stock-off-surface')).toBe(false);
    expect(findings.find((f) => f.code === 'cut-leaves-board')!.message).toContain('breaks through past the board');
  });

  it('an unmeasured bed is NOT a finding on every job — only where the job needs the datum', () => {
    const fresh = profile();
    expect(bedNeverMeasured(fresh)).toBe(true);
    const codes = bedFindings({ job: job(), machine: machineWith([fresh]), mount: 'vise' }).map((f) => f.code);
    expect(codes).not.toContain('bed-unmeasured');
    expect(codes).not.toContain('surface-top-unmeasured');
  });
});

describe('#513 the scar under the blank, at the moment its place is chosen', () => {
  const scarred = profile({
    surface: {
      kind: 'wasteboard',
      thickness: 10,
      length: 200,
      width: 200,
      position: { frontLeft: [0, 0], frame: 'machine' },
      scars: [{ x: 140, y: 30, width: 40, height: 20, at: '2026-10-12T08:00:00.000Z', jobId: null }],
    },
  });

  it('the footprint is the stated place, or the middle of the surface', () => {
    expect(tapeFootprint(scarred, { where: { x: 10, y: 20 } }, { length: 100, width: 60 })).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 60,
    });
    expect(tapeFootprint(scarred, { where: null }, { length: 100, width: 60 })).toEqual({
      x: 50,
      y: 70,
      width: 100,
      height: 60,
    });
  });

  it('a footprint over a scar finds it; one beside it does not', () => {
    const over = tapeFootprint(scarred, { where: { x: 100, y: 20 } }, { length: 100, width: 60 });
    expect(scarsUnder(scarred, over!)).toHaveLength(1);
    const beside = tapeFootprint(scarred, { where: { x: 0, y: 20 } }, { length: 100, width: 60 });
    expect(scarsUnder(scarred, beside!)).toHaveLength(0);
  });

  it('the overhang is per side, in mm', () => {
    const over = tapeFootprint(scarred, { where: { x: 150, y: -5 } }, { length: 100, width: 60 });
    expect(overhangOf(scarred, over!)).toEqual({ left: 0, right: 50, front: 5, back: 0 });
  });
});

describe('#513 the run sheet’s Bed line', () => {
  it('names the mount, the datum the job reads with its day, and the surface under it', () => {
    const viseBed = profile({
      placements: [{ id: 'pl-vise', fixture: 'fx-vise', where: { kind: 'pins', pins: 'vise', anchor: null } }],
      datums: { surfaceTopZ: null, viseJawTopZ: datum(-56.65, '2026-10-17T09:00:00.000Z'), bracketSeatZ: null, rotaryAxis: null },
    });
    expect(bedLine(viseBed, 'vise')).toBe(
      'Vise on the pins; jaw top -56.65 mm measured 2026-10-17; surface top not measured',
    );
    // A tape job under the same bed reads the surface the registration reads.
    expect(bedLine(viseBed, 'tape')).toBe('Vise on the pins; surface top not measured');
  });
});

describe('#513 the one sentence both surfaces print', () => {
  it('is null when the beds agree, and names the change when they do not', () => {
    const active = profile({ datums: { surfaceTopZ: datum(-112.3), viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null } });
    const machine = machineWith([active]);
    expect(bedChangedSentence(taped({ bed: bindJob(active) }), machine)).toBeNull();
    const stale = taped({ bed: { ...bindJob(active), profileVersion: '2026-01-01T00:00:00.000Z', datums: { surfaceTopZ: -113, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null } } });
    const sentence = bedChangedSentence(stale, machine)!;
    expect(sentence).toContain('the bed has changed since');
    expect(sentence).toContain('the surface top moved from -113 mm to -112.3 mm');
  });
});
