/**
 * Open a file from disk (#196). The File System Access picker where it exists, an
 * `<input type="file">` fallback otherwise, `null` on cancel.
 *
 * `openTextFile` reads it as text (G-code, SVG, DXF); `openBinaryFile` hands back the `File`
 * for a caller that decodes it itself (a bitmap, #252). Both share `pickFile` so the picker is
 * implemented once.
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

/** Refuse text files larger than this. The largest vendor corpus file is 2.8 MB (#196). */
export const MAX_TEXT_FILE_BYTES = 64 * 1024 * 1024;
/** Refuse images larger than this (#252). A 32 MB bitmap is far past what a cut region needs. */
export const MAX_IMAGE_FILE_BYTES = 32 * 1024 * 1024;

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

export interface OpenFileOptions {
  /** Shown in the native picker's file-type dropdown. */
  description: string;
  /** Extensions including the dot, e.g. `['.nc', '.gcode']`. */
  extensions: string[];
  /** The MIME type the picker maps those extensions to. Defaults to `text/plain`. */
  mime?: string;
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

/** Pick one file; the caller decides what to do with it. `null` on cancel. */
async function pickFile(opts: OpenFileOptions): Promise<File | null> {
  const { description, extensions, mime = 'text/plain' } = opts;
  if (!isE2E()) {
    const open = boundOpenPicker();
    if (open) {
      try {
        const [handle] = await open({
          multiple: false,
          types: [{ description, accept: { [mime]: extensions } }],
        });
        if (!handle) return null;
        return await handle.getFile();
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return null;
        throw e;
      }
    }
  }
  return await new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.join(',');
    input.style.display = 'none';
    input.onchange = () => {
      const file = input.files?.[0];
      input.remove();
      resolve(file ?? null);
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

/** Reject an oversized pick with a message naming the file and the limit. */
function checkSize(file: File, maxBytes: number): void {
  if (file.size > maxBytes) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    throw new Error(`${file.name} is ${mb} MB — larger than the ${maxBytes / (1024 * 1024)} MB limit.`);
  }
}

/** Pick one text file. Resolves `null` on cancel; rejects with a message for an oversized file. */
export async function openTextFile(opts: OpenFileOptions): Promise<{ name: string; text: string } | null> {
  const file = await pickFile(opts);
  if (!file) return null;
  checkSize(file, MAX_TEXT_FILE_BYTES);
  return { name: file.name, text: await file.text() };
}

/**
 * Pick one binary file and hand back the `File` itself (#252) — the caller needs the bytes, not a
 * string, because decoding an image is `createImageBitmap`'s job. Resolves `null` on cancel;
 * rejects with a message for an oversized file.
 */
export async function openBinaryFile(opts: OpenFileOptions): Promise<File | null> {
  const file = await pickFile(opts);
  if (!file) return null;
  checkSize(file, MAX_IMAGE_FILE_BYTES);
  return file;
}
