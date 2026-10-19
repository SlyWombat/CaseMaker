import type { Project } from '@/types';
import { openTextFile } from '@/utils/openTextFile';
// The pure project round-trip lives in `projectFile.ts` so headless scripts can import
// `serializeProject` / `parseProject` without reaching this module's browser-only picker and
// download code (#544, same class as #534). Re-exported here so the app's existing imports stay.
import { serializeProject, parseProject } from './projectFile';
export { serializeProject, parseProject };

// Issue #70 — File System Access API gives us a real native save/open
// dialog with filename + folder control. The handle returned is opaque but
// reusable: subsequent saves to the same handle overwrite in place. Falls
// back to <a download> / <input type="file"> in browsers without support
// (e.g. Firefox without the flag, Safari).

export type ProjectFileHandle = unknown;

interface FileSystemFileHandle {
  name: string;
  createWritable: () => Promise<{
    write: (data: string | Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
  getFile: () => Promise<File>;
}

interface ShowSaveFilePicker {
  (opts?: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileSystemFileHandle>;
}

interface ShowOpenFilePicker {
  (opts?: {
    multiple?: boolean;
    types?: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileSystemFileHandle[]>;
}

function fsAccess(): { save: ShowSaveFilePicker; open: ShowOpenFilePicker } | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    showSaveFilePicker?: ShowSaveFilePicker;
    showOpenFilePicker?: ShowOpenFilePicker;
  };
  if (!w.showSaveFilePicker || !w.showOpenFilePicker) return null;
  // BIND the receiver (issue #144). Handing back the bare function references
  // and calling them as `api.save(...)` makes `this` the returned literal, and
  // Chrome's WebIDL binding checks it: "Failed to execute 'showSaveFilePicker'
  // on 'Window': Illegal invocation". It broke Save as... and Load in production
  // while export kept working, because exportTrigger still calls the picker on
  // `window` itself.
  return {
    save: w.showSaveFilePicker.bind(window),
    open: w.showOpenFilePicker.bind(window),
  };
}

const PROJECT_FILE_TYPE: { description: string; accept: Record<string, string[]> } = {
  description: 'Case Maker project',
  accept: { 'application/json': ['.caseproj.json', '.json'] },
};

/** Save via the File System Access API. Returns the file handle so the caller
 *  can do subsequent in-place saves. Throws if the user cancels. */
export async function saveProjectViaPicker(
  project: Project,
  existingHandle?: ProjectFileHandle,
): Promise<ProjectFileHandle> {
  const text = serializeProject(project);
  const safeName = project.name.replace(/[^a-z0-9-_]+/gi, '_');
  if (existingHandle) {
    const handle = existingHandle as FileSystemFileHandle;
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
    return handle;
  }
  const api = fsAccess();
  if (!api) {
    // Fallback: trigger a download.
    downloadProjectJson(project);
    return null;
  }
  const handle = await api.save({
    suggestedName: `${safeName}.caseproj.json`,
    types: [PROJECT_FILE_TYPE],
  });
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
  return handle;
}

/** Open via the File System Access API. Returns the parsed project + the
 *  handle for in-place save-on-top. Throws if the user cancels. */
export async function openProjectViaPicker(): Promise<{
  project: Project;
  handle: ProjectFileHandle;
}> {
  const api = fsAccess();
  if (!api) throw new Error('File System Access API not available');
  const [handle] = await api.open({ types: [PROJECT_FILE_TYPE] });
  if (!handle) throw new Error('No file selected');
  const file = await handle.getFile();
  const text = await file.text();
  return { project: parseProject(text), handle };
}

export function fileSystemAccessAvailable(): boolean {
  return fsAccess() !== null;
}

export function downloadProjectJson(project: Project): void {
  const text = serializeProject(project);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = project.name.replace(/[^a-z0-9-_]+/gi, '_');
  a.href = url;
  a.download = `${safeName}.caseproj.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readProjectFromFile(file: File): Promise<Project> {
  const text = await file.text();
  return parseProject(text);
}

// ---------------------------------------------------------------------------------------------
// Generic text-file pickers (#425). The project's functions above predate the job document; a job
// file needs the same File System Access path but a different type and no project schema. Keeping
// the binding (#144) and the E2E fallback in one place is the point — a second copy is how the
// "Illegal invocation" bug comes back.

export interface TextFileType {
  description: string;
  accept: Record<string, string[]>;
}

export type SaveTextOutcome =
  /** Written through a handle that can be reused for the next in-place Save. */
  | { kind: 'saved'; handle: ProjectFileHandle }
  /** No picker (or E2E, where the native dialog cannot complete): the file landed in Downloads. */
  | { kind: 'downloaded' }
  | { kind: 'cancelled' };

/** True where a native dialog cannot be completed: headless E2E and vitest. */
export function nativeDialogUnavailable(): boolean {
  return import.meta.env.VITE_E2E === '1' || import.meta.env.MODE === 'test';
}

/** Write text through a bound handle. */
export async function writeTextToHandle(handle: ProjectFileHandle, text: string): Promise<void> {
  const h = handle as FileSystemFileHandle;
  const writable = await h.createWritable();
  await writable.write(text);
  await writable.close();
}

/** Save text in place (a handle) or through the picker/download fallback. */
export async function saveTextFile(
  text: string,
  suggestedName: string,
  type: TextFileType,
  existingHandle?: ProjectFileHandle | null,
): Promise<SaveTextOutcome> {
  if (existingHandle !== undefined && existingHandle !== null) {
    await writeTextToHandle(existingHandle, text);
    return { kind: 'saved', handle: existingHandle };
  }
  const api = fsAccess();
  if (api !== null && !nativeDialogUnavailable()) {
    try {
      const handle = await api.save({ suggestedName, types: [type] });
      await writeTextToHandle(handle, text);
      return { kind: 'saved', handle };
    } catch (error) {
      // User cancelled the dialog: not a failure and not a write.
      if (error instanceof DOMException && error.name === 'AbortError') return { kind: 'cancelled' };
      throw error;
    }
  }
  downloadText(text, suggestedName);
  return { kind: 'downloaded' };
}

/**
 * Open one text file: the native picker where it can complete, the `<input type="file">` fallback
 * in E2E/vitest (where a picker exists but never resolves). `null` on cancel.
 */
export async function openTextFileViaPicker(
  type: TextFileType,
): Promise<{ text: string; name: string; handle: ProjectFileHandle | null } | null> {
  const api = fsAccess();
  if (api !== null && !nativeDialogUnavailable()) {
    try {
      const [handle] = await api.open({ multiple: false, types: [type] });
      if (!handle) return null;
      const file = await handle.getFile();
      return { text: await file.text(), name: handle.name, handle };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }
  }
  // The `<input>` fallback wants one MIME/extensions pair; every type here has exactly one.
  const entry = Object.entries(type.accept)[0];
  const mime = entry?.[0] ?? 'application/json';
  const extensions = entry?.[1] ?? ['.json'];
  const picked = await openTextFile({ description: type.description, extensions, mime });
  return picked === null ? null : { ...picked, handle: null };
}

/** The anchor-download fallback, named once. */
export function downloadText(text: string, filename: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
