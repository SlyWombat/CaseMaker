/**
 * #1093 R2 — ONE LIST OF THE FILES A RUN POSTS, AND ONE PLACE THAT NAMES THEM.
 *
 * A multi-program run's programs leave the app through this list only: the file bar's *Save all*
 * (a folder where a picker exists, else a zip), the run sheet's per-program rows, and the run
 * record. The NAMES come from `releaseFileName` — the same function the release store's upload
 * list and the CLI use (#1093 R1) — so a file the operator saves is byte- and name-identical to
 * the file the machine runs, and the sheet can never point at a name nothing wrote.
 *
 * Frames ride beside their program (`<program>-frame.nc`) where the generator produced one; a
 * program with none (the goal/model path writes no air-trace frame) contributes no entry, and the
 * sheet says why on its row.
 */
import { releaseFileName } from './release';
import { runSheetFaceFileName } from './runSheet';
import { statusLogFileName } from './runStatusLog';

/** The slice of a generated program this list reads. */
export interface ProgramFilesSource {
  kind?: 'facing' | 'engrave';
  nc: string;
  frameNc: string | null;
  /** #1154 — the program's FNV (the run log's key); absent means no status-log lookup. */
  programHash?: string;
}

/** One program's file names, in cut order; `frameName` is null when the program produced none. */
export interface ProgramName {
  /** 1-based cut order across the run's programs, the facing file included (its own `-face` name). */
  index: number;
  /** The program's own number among the ENGRAVING programs, 1-based — the sheet's "program N". */
  engravingIndex: number;
  ncFile: string;
  frameName: string | null;
}

/** One file of a run: its name, its bytes, and the program (1-based cut order) it belongs to. */
export interface ProgramFile {
  /** 1-based cut order across the run's programs, the facing file included (`releaseFileName`). */
  index: number;
  /** The program's own number among the ENGRAVING programs, 1-based — the sheet's "program N". */
  engravingIndex: number;
  name: string;
  bytes: string;
  kind: 'nc' | 'frame' | 'facing' | 'record' | 'log' | 'status';
}

/**
 * EVERY PROGRAM'S NAME, once: Save, the sheet, the record and the release store's upload list all
 * read this table (`releaseFileName` underneath), so they cannot disagree.
 *
 * The numbering counts the ENGRAVING programs; the skim keeps `runSheetFaceFileName` (#473) and is
 * not numbered among them, exactly as the sheet's "program N" and the CLI have always counted.
 */
export function programNames(programs: readonly ProgramFilesSource[], jobName: string): ProgramName[] {
  const engravingTotal = programs.filter((p) => (p.kind ?? 'engrave') !== 'facing').length;
  let engravingIndex = 0;
  return programs.map((program, i) => {
    if ((program.kind ?? 'engrave') === 'facing') {
      return { index: i + 1, engravingIndex: 0, ncFile: runSheetFaceFileName(jobName), frameName: null };
    }
    engravingIndex += 1;
    const ncFile = releaseFileName(jobName, engravingIndex, engravingTotal);
    return {
      index: i + 1,
      engravingIndex,
      ncFile,
      frameName: program.frameNc === null ? null : `${ncFile.slice(0, -'.nc'.length)}-frame.nc`,
    };
  });
}

/**
 * Every file the run writes, in cut order: each program's `.nc`, then its frame when it has one;
 * the facing skim keeps its own `-face.nc` name and no frame (its dry run is the sheet, #473).
 *
 * The list is the ONE source for Save-all, the sheet's rows and the run record. The release store
 * names the same set through `releasePrograms`/`releaseFileName`; both read that naming function,
 * so the uploaded file and the saved file cannot disagree.
 */
export function programFiles(programs: readonly ProgramFilesSource[], jobName: string): ProgramFile[] {
  const out: ProgramFile[] = [];
  const names = programNames(programs, jobName);
  programs.forEach((program, i) => {
    const named = names[i]!;
    if ((program.kind ?? 'engrave') === 'facing') {
      out.push({ index: named.index, engravingIndex: 0, name: named.ncFile, bytes: program.nc, kind: 'facing' });
      return;
    }
    out.push({ index: named.index, engravingIndex: named.engravingIndex, name: named.ncFile, bytes: program.nc, kind: 'nc' });
    if (named.frameName !== null) {
      out.push({ index: named.index, engravingIndex: named.engravingIndex, name: named.frameName, bytes: program.frameNc!, kind: 'frame' });
    }
  });
  return out;
}

/**
 * #1093 R1/R3 — THE PROGRAMS AS THE SHEET READS THEM: `RunSheetProgram.nc`/`frameNc` are "the file
 * to load", so the app hands `buildRunSheet` the names rather than the program texts (the CLI has
 * always done this, #733; the app pasted its whole G-code into the sheet). The names come from the
 * same table as Save-all, so the sheet's rows and the saved files are the same files.
 */
export function nameProgramsForSheet<T extends { kind?: 'facing' | 'engrave'; nc: string; frameNc: string | null }>(
  programs: readonly T[],
  jobName: string,
): T[] {
  const names = programNames(programs, jobName);
  return programs.map((program, i) => ({ ...program, nc: names[i]!.ncFile, frameNc: names[i]!.frameName }));
}

/**
 * #1093 — THE REST PASS'S TWO PROGRAMS, BY NAME. `RestPassFacts` carries the pair's own `.nc`
 * TEXTS; the sheet matches those texts against its program list (`programNumberIn`) to place each
 * program's own Cut section, and the list now holds NAMES. Replace them with the names of the same
 * programs (matched by text, before anything else rewrites it), frame included. A text that is not
 * in the list is left alone — a caller with facts from another run keeps the old reading.
 */
export interface RestProgramLike {
  nc: string;
  frame: string | null;
}

export function nameRestPrograms<T extends { rough: RestProgramLike; rest: RestProgramLike }>(
  restPass: T,
  programs: readonly ProgramFilesSource[],
  jobName: string,
): T {
  const names = programNames(programs, jobName);
  const byText = new Map<string, ProgramName>();
  programs.forEach((program, i) => {
    if (!byText.has(program.nc)) byText.set(program.nc, names[i]!);
  });
  const rename = <R extends RestProgramLike>(program: R): R => {
    const named = byText.get(program.nc);
    if (named === undefined) return program;
    return { ...program, nc: named.ncFile, frame: program.frame === null ? null : named.frameName };
  };
  return { ...restPass, rough: rename(restPass.rough), rest: rename(restPass.rest) };
}

/**
 * #1093 R2 — THE FILES SAVE-ALL WRITES: every program file in cut order, then the run record
 * (`<job>-run.json`) when one is handed in. One call, one list, whether the files land in a chosen
 * folder or a zip.
 */
export function runSaveFiles(
  programs: readonly ProgramFilesSource[],
  jobName: string,
  runRecord: { name: string; bytes: string } | null,
  /** #1123 item 4 — the run's stage log (`<job>-run.log`); absent writes no log. */
  runLog: { name: string; bytes: string } | null = null,
  /** #1154 — one `<program>-status.log` per program whose run kept a heartbeat log. */
  statusLogs: readonly ProgramFile[] = [],
): ProgramFile[] {
  const files = programFiles(programs, jobName);
  const withRecord =
    runRecord === null
      ? files
      : [...files, { index: files.length + 1, engravingIndex: 0, name: runRecord.name, bytes: runRecord.bytes, kind: 'record' as const }];
  const withLog =
    runLog === null
      ? withRecord
      : [...withRecord, { index: withRecord.length + 1, engravingIndex: 0, name: runLog.name, bytes: runLog.bytes, kind: 'log' as const }];
  return [...withLog, ...statusLogs];
}

/**
 * #1154 — THE STATUS LOGS Save all writes. The run-log entry (the house copy of the
 * finished-program record) keeps the program's own `?` heartbeat lines; each one is written as
 * `<program>-status.log` — named after the program's own `.nc`, so it sits beside it and beside
 * the run record: `A-job-p02-status.log` for `A-job-p02.nc`, `A-job-face-status.log` for a faced
 * run's skim, `A-job-status.log` for a one-program run. A program that has not run has no entry
 * and contributes no file.
 */
export function statusLogFiles(
  programs: readonly ProgramFilesSource[],
  jobName: string,
  runLog: readonly { programHash: string; statusLog?: string }[] | undefined,
): ProgramFile[] {
  if (runLog === undefined || runLog.length === 0) return [];
  const byHash = new Map(
    runLog
      .filter((entry) => entry.statusLog !== undefined && entry.statusLog !== '')
      .map((entry) => [entry.programHash, entry.statusLog!] as const),
  );
  if (byHash.size === 0) return [];
  const names = programNames(programs, jobName);
  const out: ProgramFile[] = [];
  programs.forEach((program, i) => {
    const name = names[i];
    const text = program.programHash === undefined ? undefined : byHash.get(program.programHash);
    if (name === undefined || text === undefined) return;
    out.push({
      index: name.index,
      engravingIndex: name.engravingIndex,
      name: statusLogFileName(name.ncFile),
      bytes: text,
      kind: 'status',
    });
  });
  return out;
}
