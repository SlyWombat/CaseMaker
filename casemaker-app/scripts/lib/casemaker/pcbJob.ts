/**
 * A Gerber set becomes a JOB DOCUMENT, on the command line (#743 P-4b).
 *
 * The browser door's `pcbJobImport.ts` and this share the same engine step (`planPcbImport`); this
 * one is the CLI's half: it owns the blank the files say nothing about, builds the document the app
 * would have built, records each file as a content-addressed source, applies §3.4's drill/bore rule
 * against the machine's own tool list, and names the piece after its board.
 *
 * The document is the app's own: a default job (the vise, the margins, the machine) with the board
 * substituted — PCB stock with copper's cap, the items of §3.3, and the board's holding. A board
 * 1.6 mm thick is below the vise's ledge and a 0.1 mm cut follows its top, so the design's default
 * for a PCB is the BED, TAPED, over a board under it (Q8) — stated here, never measured.
 *
 * Pure apart from reading the files the caller hands in; no wasm beyond the toplevel the planner
 * needs.
 */

import { basename, extname } from 'node:path';

import type { ManifoldToplevel } from '../../../src/workers/geometry/evaluateOp';
import { PCB_COPPER_MM } from '../../../src/engine/cnc/stockStart';
import { defaultEngraveJob, newEngraveCutoutId, newEngraveDrillId, newEngraveShapeId } from '../../../src/engine/cnc/engrave/defaults';
import { defaultTapeHold, jobSetups } from '../../../src/engine/cnc/engrave/jobSetup';
import { embedSource } from '../../../src/engine/cnc/engrave/jobSources';
import { viseForNewJob } from '../../../src/engine/cnc/fixture';
import { getTools } from '../../../src/engine/cnc/toolRegistry';
import type { ToolLibraryEntry } from '../../../src/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '../../../src/engine/cnc/feeds';
import { pcbCutterPlan, pcbHoleAssignment } from '../../../src/engine/import/pcbCutters';
import { planPcbImport, type PcbImportOk, type PcbSourceFile, type PcbWarning } from '../../../src/engine/import/pcbImport';
import { readPcbArchive } from '../../../src/engine/import/pcbArchive';
import { defaultSacrificialUnder, noneSacrificial } from '../../../src/engine/cnc/sacrificial';
import { newId } from '../../../src/utils/id';
import { parseEngraveJob } from '../../../src/store/engraveJobSchema';
import type { EngraveJob, JobSource } from '../../../src/types/engraveJob';

export interface PcbJobFile {
  name: string;
  bytes: Uint8Array;
}

export interface PcbJobBuildOpts {
  /** The board's blank, mm. The Gerber files do not say what it is cut from. */
  blank: { length: number; width: number; thickness: number };
  /** The shop's holding tabs for the cut-out. */
  tabs: { count: number; width: number; height: number };
  /** The owned cutters §3.4 chooses between (default: the registry's own list). */
  tools?: readonly ToolLibraryEntry[];
  /**
   * Makera's feed rows, when the caller has them: the engraver and the outline cutter are chosen
   * from the rows that answer PCB first (§3.4). Absent, a house with no synced catalogue gets its
   * own cutters and the feeds gate says what it cannot cut.
   */
  catalogue?: readonly FeedCatalogueRow[];
}

export interface PcbJobBuild {
  job: EngraveJob;
  plan: PcbImportOk;
  /** What the run should say: skipped entries, the planner's notes, §3.4's boring note. */
  notes: string[];
  warnings: PcbWarning[];
}

export type PcbJobBuildResult = ({ ok: true } & PcbJobBuild) | { ok: false; error: string };

/** Ids by item kind — the document's own prefixes, as every other import mints them. */
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
 * The board's name from the file set: the outline's stem when there is one, else the copper's,
 * with the CAD package's layer suffix taken off (`blinky-Edge_Cuts` → `blinky`).
 */
export function boardNameOf(names: readonly string[]): string {
  const outline = names.find((n) => /edge[_-]?cuts|\.gko$|\.gm1$/i.test(n));
  const stem = (name: string): string => basename(name, extname(name));
  const board = stem(outline ?? names[0] ?? 'board').replace(/[-_](F[_-]?Cu|B[_-]?Cu|Edge[_-]?Cuts|Cu)$/i, '');
  return board === '' ? 'board' : board;
}

/**
 * Read the files (or the single `.zip` among them), plan the board and assemble the job document.
 * A `.zip` entry that is not a layer is named in `notes` and not used; a board the blank cannot
 * hold is refused by the planner with its own sentence (`pcb-off-blank`).
 */
export async function buildPcbJob(
  tl: ManifoldToplevel,
  files: readonly PcbJobFile[],
  opts: PcbJobBuildOpts,
): Promise<PcbJobBuildResult> {
  if (files.length === 0) return { ok: false, error: 'No files were named.' };
  const sourceFiles: PcbSourceFile[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      const archive = readPcbArchive(file.bytes);
      if (!archive.ok) return { ok: false, error: `${file.name}: ${archive.error}` };
      sourceFiles.push(...archive.files);
      skipped.push(...archive.skipped);
      continue;
    }
    sourceFiles.push({ name: file.name, bytes: file.bytes });
  }
  const plan = planPcbImport(tl, sourceFiles, { blank: opts.blank, tabs: opts.tabs, idFor });
  if (!plan.ok) return { ok: false, error: plan.error };

  // One content-addressed record per file the set used. A duplicate basename (two folders in one
  // zip) takes the planner's role for the name it merged the bytes under, as the browser door does.
  const kindByName = new Map(plan.files.map((f) => [f.name, f.kind] as const));
  const sources: JobSource[] = [];
  const skippedNotes: string[] = skipped.map((n) => `${n} is not a Gerber or drill file and was not used.`);
  for (const file of sourceFiles) {
    const kind = kindByName.get(file.name);
    if (kind === undefined) continue;
    const copy = file.bytes.buffer.slice(
      file.bytes.byteOffset,
      file.bytes.byteOffset + file.bytes.byteLength,
    ) as ArrayBuffer;
    const embedded = await embedSource({ kind, name: file.name, bytes: copy });
    sources.push(embedded.source);
    if (embedded.skipped !== null) skippedNotes.push(embedded.skipped);
  }

  // §3.4 — drill where an owned cutter is the hole's size, bore where a flat must helix it; the
  // engraver owns the isolation and a flat that reaches through the board owns the cut-out. The
  // modes and the assignment are computed once, from the library as it stands.
  const holes = pcbHoleAssignment(plan.items.drills, opts.tools ?? getTools());
  const drills = plan.items.drills.map((d) => ({ ...d, mode: holes.modes.get(d.id) ?? d.mode }));

  const stock = {
    length: opts.blank.length,
    width: opts.blank.width,
    thickness: opts.blank.thickness,
    material: 'pcb' as const,
    // D2 — the copper is the stock's colour cap, so every existing depth rule reads it unchanged.
    colour: { kind: 'laminate' as const, capMm: PCB_COPPER_MM },
  };
  const base = defaultEngraveJob(viseForNewJob(undefined, stock));
  const job: EngraveJob = {
    ...base,
    name: boardNameOf(sourceFiles.map((f) => f.name)),
    stock,
    // The demo lines are laid out for a 100 × 60 plank; leaving them would cut CASE and MAKER
    // into the board. The design route drops them for the same reason (#410).
    labels: [],
    vectors: plan.items.vectors,
    combined: plan.items.frames,
    drills,
    cutouts: plan.items.cutouts,
    sourceFiles: sources,
    sources: {
      ...base.sources,
      stock: {
        length: 'user',
        width: 'user',
        thickness: 'user',
        material: 'user',
        colour: 'assumed',
      },
    },
    // Q8 — a board is held on the bed, taped, over a board under it: the drills and the outline
    // go through, and the vise's jaws bow a thin board a 0.1 mm cut cannot follow.
    workholding: { kind: 'tape', tape: defaultTapeHold() },
    sacrificial: {
      under: defaultSacrificialUnder(),
      sides: noneSacrificial().sides,
      source: 'default',
    },
  };
  // §3.4 — the setup's cutters, written as ordinary `setups[].tools`/`toolItems` (#472/#746): the
  // board arrives with all three programs assigned, and a role no owned cutter fills is stated.
  // Read off the ASSEMBLED job, so the setup's item list is the board's own (the demo lines are
  // gone by now).
  const cutters = pcbCutterPlan(
    { frames: plan.items.frames, drills, cutouts: plan.items.cutouts },
    opts.tools ?? getTools(),
    job.stock.thickness + job.breakthrough,
    opts.catalogue ?? [],
  );
  const setup = jobSetups(job)[0]!;
  const withCutters: EngraveJob =
    cutters.tools.length === 0
      ? job
      : {
          ...job,
          setups: [
            {
              ...setup,
              tools: [...cutters.tools],
              toolItems: Object.fromEntries(
                cutters.tools.map((key) => [
                  key,
                  [...cutters.assignment].filter(([, owns]) => owns === key).map(([id]) => id),
                ]),
              ),
            },
          ],
        };
  return {
    ok: true,
    job: withCutters,
    plan,
    // `cutters.notes` already carries §3.4's hole notes (its own `pcbHoleAssignment` call), so a
    // missing size is said once.
    notes: [...skippedNotes, ...plan.notes, ...cutters.notes],
    warnings: plan.warnings,
  };
}

/**
 * Round the assembled document through the SAME schema the app loads with and require it back
 * unchanged: a field the schema does not know is silently stripped on load, so a document built
 * here and a document the app reads would differ — and the difference would only show up at the
 * bench. Sorted keys, so a reordered object is not mistaken for a lost field.
 */
export function jobDocumentProblem(job: EngraveJob): string | null {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  const reparsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
  if (!reparsed.ok) return `the job built from the files does not parse:\n  ${reparsed.errors.join('\n  ')}`;
  if (JSON.stringify(canonical(reparsed.job)) !== JSON.stringify(canonical(job))) {
    return (
      'the job schema does not round-trip the document built from the files — a field it does not ' +
      'know is stripped on load, so it would be lost. Add it to the schema first.'
    );
  }
  return null;
}
