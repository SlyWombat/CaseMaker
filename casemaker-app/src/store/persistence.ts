import type { Project } from '@/types';
import { projectSchema } from './projectSchema';

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

export function parseProject(text: string): Project {
  const raw = JSON.parse(text);
  const parsed = projectSchema.parse(raw);
  return parsed as Project;
}

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
  return { save: w.showSaveFilePicker, open: w.showOpenFilePicker };
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
