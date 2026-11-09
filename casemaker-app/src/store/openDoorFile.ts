/**
 * #1122 — THE DOOR'S LOAD TAKES BOTH KINDS OF FILE.
 *
 * The maintainer pressed the door's Load with a `.cutjob.json` and got a raw Zod dump across the top
 * bar: the loader was parsing it as a project. Load (and a drop on the door) now reads the file's
 * kind first — by its name where the name says it, else by the document's own fields — and sends a
 * project down the project path and a job down {@link openJobFromText}.
 *
 * A file that is neither is refused in ONE SENTENCE. The schema detail goes to the console, never
 * to the top bar: a Zod dump is the app talking to itself, not to the operator.
 */

import { ZodError } from 'zod';
import { JOB_FILE_EXTENSION } from '@/engine/cnc/engrave/jobFile';
import { clearHistory, useProjectStore } from './projectStore';
import { parseProject } from './projectFile';
import { openJobFromText } from './openJobFromText';
import type { ProjectFileHandle, TextFileType } from './persistence';

/** The one picker at the door: both documents, one dropdown entry. */
export const DOOR_FILE_TYPE: TextFileType = {
  description: 'Case Maker project or cutting job',
  accept: { 'application/json': ['.caseproj.json', JOB_FILE_EXTENSION, '.json'] },
};

export type DoorFileKind = 'job' | 'project';

export type OpenDoorFileResult =
  | { ok: true; kind: DoorFileKind }
  | { ok: false; error: string };

export interface DoorFileInput {
  text: string;
  /** The file's name, as the picker or the input gave it. */
  name: string;
  /** A reusable handle when the OS picker gave one; null from an `<input>` or a drop. */
  handle: ProjectFileHandle | null;
}

/**
 * What kind of document this is, or null when it is neither.
 *
 * The suffix is the strongest statement a file makes about itself, so it is read first. A file
 * without a telling suffix is read by shape: a project names a board and the case grown around it;
 * a job carries the blank, the labels, the workholding and the cutter.
 */
export function doorFileKind(name: string, raw: unknown): DoorFileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(JOB_FILE_EXTENSION)) return 'job';
  if (lower.endsWith('.caseproj.json')) return 'project';
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  if ('board' in doc && ('case' in doc || 'ports' in doc)) return 'project';
  if (
    'stock' in doc &&
    ('labels' in doc || 'workholding' in doc || 'toolKey' in doc || 'setups' in doc)
  ) {
    return 'job';
  }
  return null;
}

/** The first thing wrong with a document that claimed a kind it did not have, in one line. */
function oneLine(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    if (issue !== undefined) {
      const path = issue.path.length === 0 ? 'the document' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    }
  }
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]!.slice(0, 240);
}

/** "…(it parsed as …)" — what the file actually was, in a person's words. */
function jsonWords(raw: unknown): string {
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return 'a list';
  switch (typeof raw) {
    case 'object':
      return 'an object with no project or job fields';
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    default:
      return typeof raw;
  }
}

/**
 * Open one file from the door. On success the project or the job is the open document and the
 * welcome overlay has gone; on failure nothing changed and the sentence says what the file was.
 */
export async function openDoorFile(file: DoorFileInput): Promise<OpenDoorFileResult> {
  let raw: unknown;
  let notJson = false;
  try {
    raw = JSON.parse(file.text);
  } catch {
    notJson = true;
  }

  const kind = doorFileKind(file.name, notJson ? undefined : raw);
  if (kind === 'job') {
    const result = await openJobFromText({
      text: file.text,
      fileName: file.name,
      handle: file.handle,
      savedAt: Date.now(),
      opened: `Opened ${file.name}.`,
    });
    if (!result.ok) {
      console.error(`[door] ${file.name} did not open as a cutting job:`, result.error);
      const reason = result.error.replace(/\.$/, '');
      return { ok: false, error: `The cutting job in ${file.name} could not be opened: ${reason}.` };
    }
    return { ok: true, kind: 'job' };
  }

  if (kind === 'project') {
    try {
      const project = parseProject(file.text);
      useProjectStore.getState().setProject(project); // also flips welcomeMode off
      clearHistory();
      return { ok: true, kind: 'project' };
    } catch (error) {
      // #1122 — the schema dump is for the console; the top bar gets one sentence.
      console.error(`[door] ${file.name} did not open as a project:`, error);
      return { ok: false, error: `The project in ${file.name} could not be opened: ${oneLine(error)}.` };
    }
  }

  return { ok: false, error: refusalSentence(raw, notJson) };
}

/** The one sentence a wrong kind gets (#1122). */
export function refusalSentence(raw: unknown, notJson: boolean): string {
  if (notJson) return 'This file is neither a project nor a job — it is not JSON.';
  return `This file is neither a project nor a job (it parsed as ${jsonWords(raw)}).`;
}
