/**
 * A Gerber set delivered as one `.zip` (#743 P-4b, design §3.1).
 *
 * A board's files usually arrive as a folder or a zip from the CAD package, and the picker takes
 * "several, a folder's worth, or one `.zip`". This is the archive half: a zip is unpacked in
 * memory and filtered to the files a board is read from — copper, outline and drill layers — so a
 * `README`, a fabrication drawing or a licence file in the same folder is skipped and SAID, not
 * silently dropped and not taken for a layer.
 *
 * Nothing here runs or writes anything: the entries are bytes, and the caller hands them to
 * `planPcbImport`. A zip that holds no layer is refused with the list of what it did hold.
 */

import { unzipSync } from 'fflate';
import type { PcbSourceFile } from './pcbImport';

/** The extensions a layer may wear, from Studio's own dialog (`06-toolpath-cam.md`). */
const LAYER_EXTENSIONS = /\.(gbr|gtl|gbl|gko|gm1|gto|gbo|gts|gbs|gtp|gbp|drl|xln|art|top|bot|pho)$/i;

/**
 * Cap on the unpacked set, bytes. A Gerber set is text and rarely more than a few hundred KiB;
 * 64 MiB matches the text picker's ceiling and stops a zip bomb from filling the tab.
 */
export const MAX_PCB_SET_BYTES = 64 * 1024 * 1024;

export type PcbArchiveRead =
  | { ok: true; files: PcbSourceFile[]; skipped: string[] }
  | { ok: false; error: string };

/** Unpack a `.zip` into the layer files it holds, in the archive's own order. */
export function readPcbArchive(bytes: Uint8Array): PcbArchiveRead {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    return { ok: false, error: `the archive could not be unpacked (${e instanceof Error ? e.message : String(e)})` };
  }
  const files: PcbSourceFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const [path, content] of Object.entries(entries)) {
    if (path.endsWith('/')) continue; // a directory entry
    const name = path.split('/').pop() as string;
    if (!LAYER_EXTENSIONS.test(name)) {
      skipped.push(name);
      continue;
    }
    total += content.byteLength;
    if (total > MAX_PCB_SET_BYTES) {
      return { ok: false, error: `the archive's layers are larger than the ${MAX_PCB_SET_BYTES / (1024 * 1024)} MB limit` };
    }
    files.push({ name, bytes: content });
  }
  if (files.length === 0) {
    const held = Object.keys(entries).filter((p) => !p.endsWith('/'));
    return {
      ok: false,
      error: held.length === 0 ? 'the archive is empty' : `the archive holds no Gerber or drill files (it holds ${held.slice(0, 5).join(', ')}${held.length > 5 ? ', …' : ''})`,
    };
  }
  return { ok: true, files, skipped };
}
