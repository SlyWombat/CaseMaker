/**
 * #1093 R2 — THE RUN'S FILES, NAMED ONCE.
 *
 * `programFiles` is the list Save-all, the run sheet's per-program rows and the run record read.
 * Its NAMES come from `releaseFileName`, the same function the release store's upload list uses,
 * so a saved file is byte- and name-identical to the file the machine runs.
 *
 * RED before the change: no such list existed — Save wrote `programs[0]` only and the record
 * carried one `ncFile`/`ncHash`.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { nameRestPrograms, programFiles, runSaveFiles } from '@/engine/cnc/engrave/programFiles';
import { releasePrograms, type ReleaseSource } from '@/engine/cnc/engrave/release';
import { buildRunRecord, parseRunRecord } from '@/engine/cnc/engrave/runRecord';
import { sha256Hex, type RunSheetGenerated, type RunSheetProgram } from '@/engine/cnc/engrave/runSheet';

function program(index: number, extra: Partial<RunSheetProgram> = {}): RunSheetProgram {
  return { setupIndex: 1, toolKey: 'inv:flat', nc: `G1 X${index}\nM2`, frameNc: null, cam: null, ...extra };
}

function generated(programs: RunSheetProgram[]): RunSheetGenerated {
  return {
    findings: [],
    feeds: null,
    cam: null,
    nc: programs[0]?.nc ?? null,
    verify: null,
    frameNc: programs[0]?.frameNc ?? null,
    programs,
  };
}

describe('#1093 R2 — programFiles names every file of a run', () => {
  it('a five-program run writes five .nc files, no frames, named p1..p5', () => {
    const programs = [program(1), program(2), program(3), program(4), program(5)];
    const files = programFiles(programs, 'm1trayB-bottom');
    expect(files.map((f) => f.name)).toEqual([
      'm1trayB-bottom-p1.nc',
      'm1trayB-bottom-p2.nc',
      'm1trayB-bottom-p3.nc',
      'm1trayB-bottom-p4.nc',
      'm1trayB-bottom-p5.nc',
    ]);
    expect(files.every((f) => f.kind === 'nc')).toBe(true);
    expect(files[0]!.bytes).toBe(programs[0]!.nc);
  });

  it('the flip twin’s nineteen programs, with the one frame beside p10', () => {
    const programs = Array.from({ length: 19 }, (_, i) =>
      program(i + 1, { setupIndex: i < 10 ? 1 : 2, frameNc: i === 9 ? 'G1 X0\n;frame\n' : null }),
    );
    const files = programFiles(programs, 'm1trayF-banded2');
    const nc = files.filter((f) => f.kind === 'nc');
    const frames = files.filter((f) => f.kind === 'frame');
    expect(nc).toHaveLength(19);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.name).toBe('m1trayF-banded2-p10-frame.nc');
    expect(frames[0]!.bytes).toBe('G1 X0\n;frame\n');
    expect(nc[9]!.name).toBe('m1trayF-banded2-p10.nc');
    expect(nc[18]!.name).toBe('m1trayF-banded2-p19.nc');
  });

  it('a facing program keeps its -face name and carries no frame', () => {
    const files = programFiles([program(1, { kind: 'facing' }), program(2), program(3)], 'tray');
    expect(files.map((f) => [f.kind, f.name])).toEqual([
      ['facing', 'tray-face.nc'],
      ['nc', 'tray-p1.nc'],
      ['nc', 'tray-p2.nc'],
    ]);
  });

  it('the same names come out of the release store’s own list', () => {
    const programs = [program(1), program(2), program(3)];
    const sources: ReleaseSource[] = programs.map((p, i) => ({
      setupIndex: p.setupIndex,
      setupId: `setup-${i + 1}`,
      toolKey: p.toolKey,
      nc: p.nc,
      hash: `h${i + 1}`,
      verify: null,
    }));
    const released = releasePrograms('m1trayB-bottom', sources, []);
    const saved = programFiles(programs, 'm1trayB-bottom').filter((f) => f.kind === 'nc');
    expect(saved.map((f) => f.name)).toEqual(released.map((r) => r.filename));
    saved.forEach((file, i) => expect(file.bytes).toBe(released[i]!.nc));
  });

  it('Save all’s set is every program file then the one run record', () => {
    const programs = [program(1), program(2), program(3), program(4), program(5)];
    const files = runSaveFiles(programs, 'm1trayB-bottom', { name: 'm1trayB-bottom-run.json', bytes: '{"a":1}' });
    expect(files.map((f) => f.name)).toEqual([
      'm1trayB-bottom-p1.nc',
      'm1trayB-bottom-p2.nc',
      'm1trayB-bottom-p3.nc',
      'm1trayB-bottom-p4.nc',
      'm1trayB-bottom-p5.nc',
      'm1trayB-bottom-run.json',
    ]);
    expect(files.filter((f) => f.kind === 'frame')).toHaveLength(0);
    expect(files.at(-1)!.kind).toBe('record');
  });

  it('the rest pass’s two programs are renamed by their own texts — the sheet places their sections', () => {
    const rough = program(1, { nc: 'G21\n;rough\nM2', frameNc: 'G21\n;rough-frame\nM2' });
    const rest = program(2, { nc: 'G21\n;rest\nM2' });
    const programs = [rough, rest];
    const facts = {
      rough: { key: 'a', nc: rough.nc, frame: rough.frameNc, diameter: 3 },
      rest: { key: 'b', nc: rest.nc, frame: null, diameter: 1 },
    };
    const named = nameRestPrograms(facts, programs, 'tray');
    expect(named.rough.nc).toBe('tray-p1.nc');
    expect(named.rough.frame).toBe('tray-p1-frame.nc');
    expect(named.rest.nc).toBe('tray-p2.nc');
    expect(named.rest.frame).toBeNull();
    // A text from another run is left exactly as it was.
    const stranger = nameRestPrograms({ ...facts, rest: { ...facts.rest, nc: 'from-another-run.nc' } }, programs, 'tray');
    expect(stranger.rest.nc).toBe('from-another-run.nc');
  });

  it('the run record lists every program, with hashes the file bytes produce', () => {
    const programs = Array.from({ length: 5 }, (_, i) => program(i + 1, { setupIndex: i < 3 ? 1 : 2 }));
    const job = defaultEngraveJob();
    const record = buildRunRecord(job, generated(programs));
    expect(record.programs).toHaveLength(5);
    expect(record.programs!.map((p) => p.ncFile)).toEqual(programFiles(programs, job.name).map((f) => f.name));
    record.programs!.forEach((p, i) => {
      expect(p.ncHash).toBe(sha256Hex(programs[i]!.nc).slice(0, 8));
      expect(p.setupIndex).toBe(programs[i]!.setupIndex);
    });
    // The top-level pair stays program 1's, and a record round-trips through the parser.
    expect(record.ncHash).toBe(sha256Hex(programs[0]!.nc).slice(0, 8));
    const parsed = parseRunRecord(JSON.parse(JSON.stringify(record)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.run.programs).toHaveLength(5);
  });
});
