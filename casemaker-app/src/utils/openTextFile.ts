/**
 * Open a text file from disk (#196). The File System Access picker where it exists, an
 * `<input type="file">` fallback otherwise, `null` on cancel.
 *
 * The picker is BOUND to `window` (#144). Handing back the bare `window.showOpenFilePicker`
 * reference and calling it as a plain function makes `this` the returned literal, and Chrome's
 * WebIDL binding check then fails with "Illegal invocation". `fsAccess()` in
 * `src/store/persistence.ts` binds the same way; this module cannot import it (that helper is
 * not exported), so the binding is copied here deliberately rather than re-implemented.
 *
 * In e2e (`VITE_E2E`) and in vitest the input fallback is used, exactly as `exportTrigger.ts`
 * does for saving — headless Chromium exposes the picker but never resolves it.
 */

/** Refuse files larger than this. The largest vendor corpus file is 2.8 MB (#196). */
export const MAX_TEXT_FILE_BYTES = 64 * 1024 * 1024;

interface FileHandleLike {
  name: string;
  getFile: () => Promise<File>;
}

interface ShowOpenFilePicker {
  (opts?: {
    multiple?: boolean;
    types?: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileHandleLike[]>;
}

export interface OpenTextFileOptions {
  /** Shown in the native picker's file-type dropdown. */
  description: string;
  /** Extensions including the dot, e.g. `['.nc', '.gcode']`. */
  extensions: string[];
}

function boundOpenPicker(): ShowOpenFilePicker | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { showOpenFilePicker?: ShowOpenFilePicker };
  if (typeof w.showOpenFilePicker !== 'function') return null;
  return w.showOpenFilePicker.bind(window);
}

function isE2E(): boolean {
  return import.meta.env.VITE_E2E === '1' || import.meta.env.MODE === 'test';
}

async function readChecked(file: File): Promise<{ name: string; text: string }> {
  if (file.size > MAX_TEXT_FILE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(`${file.name} is ${mb} MB — larger than the ${MAX_TEXT_FILE_BYTES / (1024 * 1024)} MB limit.`);
  }
  return { name: file.name, text: await file.text() };
}

/** Pick one text file. Resolves `null` on cancel; rejects with a message for an oversized file. */
export async function openTextFile(opts: OpenTextFileOptions): Promise<{ name: string; text: string } | null> {
  const { description, extensions } = opts;
  if (!isE2E()) {
    const open = boundOpenPicker();
    if (open) {
      try {
        const [handle] = await open({
          multiple: false,
          types: [{ description, accept: { 'text/plain': extensions } }],
        });
        if (!handle) return null;
        return await readChecked(await handle.getFile());
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return null;
        throw e;
      }
    }
  }
  return await new Promise<{ name: string; text: string } | null>((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.join(',');
    input.style.display = 'none';
    input.onchange = () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve(null);
        return;
      }
      readChecked(file).then(resolve, reject);
    };
    // Fired when the dialog is dismissed without a choice (Chrome/Edge/Firefox).
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}
