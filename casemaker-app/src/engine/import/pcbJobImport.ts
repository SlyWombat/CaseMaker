/**
 * A picked Gerber set becomes JOB ITEMS (#743 P-4b) — the browser door's one step between files
 * and the document.
 *
 * It is deliberately thin: `readPcbArchive` (one `.zip`) and `planPcbImport` (the set → items)
 * do the reading and the geometry; this module turns the PICKED FILES into their bytes, hands the
 * manifold toplevel in (the store loads it lazily), and records each file as a `JobSource` by its
 * SHA-256 so a re-import can prove it is the same file. Nothing here touches the job: the store's
 * one `apply` owns the write, so the import is one undo step.
 */

import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { embedSource, type EmbeddedSource } from '@/engine/cnc/engrave/jobSources';
import { newEngraveCutoutId, newEngraveDrillId, newEngraveShapeId } from '@/engine/cnc/engrave/defaults';
import { newId } from '@/utils/id';
import { readPcbArchive } from './pcbArchive';
import { planPcbImport, type PcbImportOk, type PcbSourceFile } from './pcbImport';

export interface PcbJobImportOk {
  ok: true;
  plan: PcbImportOk;
  /** The document's content-addressed records, one per file the set used. */
  sources: EmbeddedSource[];
  /** Names the archive held and this import did not read (a README, a fab drawing). */
  skipped: string[];
}

export type PcbJobImportResult = PcbJobImportOk | { ok: false; error: string };

export interface PcbJobImportOpts {
  blank: { length: number; width: number; thickness: number };
  tabs: { count: number; width: number; height: number };
}

/** Ids by item kind: the document's own prefixes, as every other import mints them. */
function idFor(what: string): string {
  switch (what) {
    case 'pcb-copper':
    case 'pcb-outline':
      return newId('vec');
    case 'pcb-isolation':
      return newEngraveShapeId();
    case 'pcb-hole':
      return newEngraveDrillId();
    case 'pcb-cutout':
      return newEngraveCutoutId();
    default:
      return newId('pcb');
  }
}

/**
 * Read the picked files (or the single `.zip` among them) and plan the board on the blank.
 * `tl` is the manifold toplevel the store loads on the first PCB import; the test passes its own.
 */
export async function planPcbJobImport(
  tl: ManifoldToplevel,
  files: readonly File[],
  opts: PcbJobImportOpts,
): Promise<PcbJobImportResult> {
  if (files.length === 0) return { ok: false, error: 'No files were picked.' };
  const sourceFiles: PcbSourceFile[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name)) {
      const archive = readPcbArchive(bytes);
      if (!archive.ok) return { ok: false, error: `${file.name}: ${archive.error}` };
      sourceFiles.push(...archive.files);
      skipped.push(...archive.skipped);
      continue;
    }
    sourceFiles.push({ name: file.name, bytes });
  }
  const plan = planPcbImport(tl, sourceFiles, { blank: opts.blank, tabs: opts.tabs, idFor });
  if (!plan.ok) return { ok: false, error: plan.error };

  // The report is keyed by the file NAME the planner read; the archive's entries keep their own
  // basename, so the two lists line up. A duplicate basename (two folders in one zip) takes the
  // first record — the planner has already merged its bytes, and one record per hash is the rule.
  const kindByName = new Map(plan.files.map((f) => [f.name, f.kind] as const));
  const sources: EmbeddedSource[] = [];
  for (const file of sourceFiles) {
    const kind = kindByName.get(file.name);
    if (kind === undefined) continue;
    const copy = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer;
    sources.push(await embedSource({ kind, name: file.name, bytes: copy }));
  }
  return { ok: true, plan, sources, skipped };
}
