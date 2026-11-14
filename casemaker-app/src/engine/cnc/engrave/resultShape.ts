/**
 * #1126 slice 2 — THE TWO WAYS A RESULT LEAVES THE ENGINE.
 *
 * A result carries its program text INLINE (the in-page worker's, and the store's once the house's
 * files are fetched back) OR names its FILES (the house's `resultDocument`, which carries no NC
 * text); never both. The files variant says so in its type: every text field is `null` and `files`
 * lists where each program's text lives. Both variants hold the same plan summary
 * (`PlanSummary`), never a whole plan.
 */
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';

export interface ResultFileRef {
  name: string;
  what: 'program' | 'frame';
  index: number;
}

/** A program as the house's document lists it: everything but the text, which is in a named file. */
export type EngraveProgramNoText = Omit<EngraveProgram, 'nc' | 'frameNc'> & { nc: null; frameNc: null };

/**
 * The house's v2 document. `ncProgram`/`frameProgram`/`facingProgram` name the index each top-level
 * alias mirrors (the generator's `nc` is the finishing program of a split goal, not program 1).
 */
export type EngraveResultFiles = Omit<EngraveGenerated, 'nc' | 'frameNc' | 'facingNc' | 'programs'> & {
  resultVersion: number;
  files: ResultFileRef[];
  nc: null;
  frameNc: null;
  facingNc: null;
  ncProgram: number | null;
  frameProgram: number | null;
  facingProgram: number | null;
  programs: EngraveProgramNoText[];
};

/** A result with its text inline: `EngraveGenerated`, which names no files. */
export type EngraveResultInline = EngraveGenerated & { files?: undefined };

export type EngraveResult = EngraveResultInline | EngraveResultFiles;
