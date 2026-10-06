import { useProjectStore } from '@/store/projectStore';
import { useJobStore } from '@/store/jobStore';
import { useSettingsStore, type ExportFormat } from '@/store/settingsStore';
import { exportStlBinary, exportStlAscii, exportThreeMf } from '@/engine/jobs/workerClient';
import { scheduleImmediate, waitForIdle } from '@/engine/jobs/JobScheduler';
import type { StlMeshInput } from '@/workers/export/stlBinary';
import {
  applyLayoutToMeshes,
  PRINT_FLIP_NODE_IDS,
  type ExportLayoutMode,
} from '@/engine/exportLayout';
import type { MeshNode, Project } from '@/types';
import type { FitVariant } from '@/types/snap';
import { derivedKind } from '@/engine/compiler/archetype';
import { isAlternativeNode, partForId } from '@/engine/exporters/parts';
import { printNotesText } from '@/engine/exporters/printNotes';
import { runSheetFileName, runSheetFrameFileName } from '@/engine/cnc/engrave/runSheet';

export type { ExportFormat };

async function downloadArrayBuffer(buf: ArrayBuffer, filename: string, mime: string): Promise<void> {
  const blob = new Blob([buf], { type: mime });
  await saveBlob(blob, filename);
}

async function downloadText(text: string, filename: string, mime: string): Promise<void> {
  const blob = new Blob([text], { type: mime });
  await saveBlob(blob, filename);
}

/** Save a blob using the File System Access API's showSaveFilePicker
 *  (Chrome/Edge — opens the native "Save As" dialog so the user picks
 *  filename + folder), with a graceful fallback to anchor-tag download
 *  for browsers that don't support it (Firefox/Safari → file lands in
 *  the default Downloads folder, no picker). */
/**
 * A filesystem-safe file name from arbitrary user text (#206). Same character rule the mesh
 * exports use, plus trimming the leading/trailing underscores the rule can leave.
 */
export function sanitizeFileName(name: string): string {
  const s = name.replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '');
  return s.length > 0 ? s : 'case';
}

/**
 * Issue #153, step 6 — the print-fit grade this export actually carries, or
 * `null` when nothing in it is relieved.
 *
 * The fit is a project-level choice, so the project names the file: a user who
 * prints two grades needs the files to say which is which (`case-loose.stl`),
 * and the whole point of the variants is printing both and keeping the one
 * that fits. Only the two RELIEVED grades suffix a name — `tight` is the
 * as-designed number, so a project that never touched the setting (and every
 * project saved before #153) keeps the exact file name it always had.
 *
 * Mirrors `compileProject`'s dispatch: a rack compiles to rack parts and reads
 * its own `rack.fit`; a shell reads `case.fit`, and only when a relieved snap
 * interface is actually in play — the same pair of conditions that shows the
 * panel's "Snap fit" select. A stand / badge / insert has no snap interface, so
 * it never carries a grade. A per-`SnapCatch` override is deliberately NOT
 * reflected: it is advanced and unexposed, and a name that reported it would
 * have to name several grades at once.
 */
export function exportFitGrade(project: Project): FitVariant | null {
  const kind = derivedKind(project);
  const relieved = (fit: FitVariant | undefined): FitVariant | null =>
    fit === 'standard' || fit === 'loose' ? fit : null;
  if (kind === 'rack') return relieved(project.case.rack?.fit);
  if (kind !== 'shell') return null;
  const { joint, boardRetention, fit } = project.case;
  if (joint !== 'snap-fit' && boardRetention !== 'snap') return null;
  return relieved(fit);
}

/** `-loose` / `-standard`, or `''` — spliced into every file name an export
 *  writes, so the mesh, the gasket, the 3MF and the print notes all agree. */
function fitSuffix(project: Project): string {
  const grade = exportFitGrade(project);
  return grade ? `-${grade}` : '';
}

/**
 * Save plain text through the same path the mesh exports use (#206): the native picker when it
 * exists, and the anchor download under E2E where the picker has no dialog to complete.
 */
export async function saveText(text: string, filename: string, mime: string): Promise<void> {
  await downloadText(text, filename, mime);
}

/**
 * Save the engrave job AND its frame file together (#244). The job is written under the name the
 * run sheet prints; the frame file sits beside it with `-frame` before the extension, so the two
 * cannot be confused. The frame is the SAME generate (#206) output as the job — never re-derived
 * here — so what is written is exactly what was verified. A null `frameNc` (a run that never
 * reached the post) writes the job only.
 */
export async function saveEngraveProgram(
  nc: string,
  frameNc: string | null,
  jobName: string,
): Promise<void> {
  await saveText(nc, runSheetFileName(jobName), 'text/plain');
  if (frameNc !== null) await saveText(frameNc, runSheetFrameFileName(jobName), 'text/plain');
}

async function saveBlob(blob: Blob, filename: string): Promise<void> {
  type SaveFilePicker = (opts: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
  const w = window as Window & { showSaveFilePicker?: SaveFilePicker };
  // E2E runs need the anchor-download path: headless Chromium exposes
  // showSaveFilePicker but there's no native dialog to complete, so the
  // picker never resolves and Playwright's `download` event never fires.
  const isE2E = import.meta.env.VITE_E2E === '1' || import.meta.env.MODE === 'test';
  if (!isE2E && typeof w.showSaveFilePicker === 'function') {
    try {
      const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
      const mime = blob.type || 'application/octet-stream';
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: ext ? [{ description: ext.slice(1).toUpperCase() + ' file', accept: { [mime]: [ext] } }] : undefined,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      // User cancelled the picker — silently bail.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Anything else: fall through to anchor download as a last resort.
      console.warn('showSaveFilePicker failed; falling back to anchor download', err);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Issue #108 — the TPU gasket is pulled out of the main bundle and written as
 *  its own file. Issue #168 — this is no longer keyed off the node id: the node
 *  says so itself, via `material.separateFile`, which is also where the gasket's
 *  reason for being separate (a different filament) is recorded. */
export function meshesForExport(): StlMeshInput[] {
  return meshNodesForExport().main;
}

export interface ExportMeshGroups {
  /** Main case body parts (case + lid + hinge-pin etc.) — same material. */
  main: StlMeshInput[];
  /** The part written as its own file, currently only the TPU gasket (#108).
   *  One slot: the export path writes it under a `-gasket` name and pairs it
   *  with the gasket slicer hints, so a second separate-file part would need a
   *  real multi-file path rather than a second flag. */
  gasket: StlMeshInput | null;
  /** Node ids of the meshes in `main`, in the same order. Kept so the #154
   *  print-notes sidecar can name exactly what is in the files (an id is not
   *  retained on `StlMeshInput`). */
  mainIds: string[];
  /** Node id of `gasket` when present. */
  gasketId: string | null;
}

export function meshNodesForExport(): ExportMeshGroups {
  const layoutMode = useSettingsStore.getState().exportLayout;
  const nodes = useJobStore.getState().nodes;
  const main: MeshNode[] = [];
  let gasketNode: MeshNode | null = null;
  for (const n of nodes.values()) {
    // The fused one-piece rack exports are alternatives to the parts they are
    // made from. Including them in Save All would hand you the whole rack
    // twice — once in pieces, once welded.
    if (isAlternativeNode(n)) continue;
    if (n.material?.separateFile) gasketNode = n;
    else main.push(n);
  }
  const toMesh = (n: MeshNode): StlMeshInput => ({
    positions: n.buffer.positions,
    indices: n.buffer.indices,
    material: n.material,
    // The node id doubles as the volume label inside a multi-material 3MF
    // object (#168), so PrusaSlicer's part list names what it is showing.
    name: n.id,
  });
  if (layoutMode === 'assembled') {
    return {
      main: main.map(toMesh),
      gasket: gasketNode ? toMesh(gasketNode) : null,
      mainIds: main.map((n) => n.id),
      gasketId: gasketNode ? gasketNode.id : null,
    };
  }
  // Print-ready: lay main parts out flat, lid flipped, side-by-side along +X.
  const laid = applyLayoutToMeshes(main, { flipNodeIds: PRINT_FLIP_NODE_IDS });
  return {
    main: laid.map((m) => ({
      positions: m.positions,
      indices: m.indices,
      material: m.material,
      name: m.id,
    })),
    gasket: gasketNode ? toMesh(gasketNode) : null,
    mainIds: laid.map((m) => m.id),
    gasketId: gasketNode ? gasketNode.id : null,
  };
}

/**
 * Issue #154 — the PRINT-NOTES sidecar text for the meshes about to be
 * written. Pure: it needs only the exported ids and the layout mode, so the
 * sidecar's content is testable without a DOM or the build worker. `mainIds` /
 * `gasketId` are kept on the groups for exactly this.
 */
export function printNotesForGroups(
  groups: ExportMeshGroups,
  layoutMode: ExportLayoutMode,
  fit: FitVariant | null = null,
): string {
  const ids = [...groups.mainIds, ...(groups.gasketId ? [groups.gasketId] : [])];
  return printNotesText(ids.map((id) => partForId(id)), layoutMode, fit);
}

/**
 * Issue #120 — export a single named part as a separate file. The user
 * picks the node from the export modal; this helper triggers a download
 * for just that one mesh in the chosen format. Returns the file's byte
 * size so the caller can show "saved 142 KB" feedback.
 */
export async function exportSinglePart(
  nodeId: string,
  format: ExportFormat,
): Promise<{ filename: string; bytes: number } | null> {
  const project = useProjectStore.getState().project;
  await scheduleImmediate(project);
  await waitForIdle();
  const nodes = useJobStore.getState().nodes;
  const node = nodes.get(nodeId);
  if (!node) return null;
  // Orient for the BED, not for the assembly.
  //
  // A single part used to export exactly as it sits in the rack, leaving the
  // print orientation to a hint the user had to read and act on. That cost a
  // 1.1 kg print: the fused frame stands on four stacking feet, so only 2.3%
  // of its footprint touched and a slicer supported the entire bottom plate.
  // Routing through the same layout the Save All path uses applies the flip
  // AND corrects the triangle winding a flip inverts.
  const [laid] = applyLayoutToMeshes([node]);
  const mesh: StlMeshInput = laid
    ? { positions: laid.positions, indices: laid.indices, material: laid.material, name: nodeId }
    : {
        positions: node.buffer.positions,
        indices: node.buffer.indices,
        material: node.material,
        name: nodeId,
      };
  const safeProject = project.name.replace(/[^a-z0-9-_]+/gi, '_');
  const safePart = nodeId.replace(/[^a-z0-9-_]+/gi, '_');
  const baseName = `${safeProject}-${safePart}${fitSuffix(project)}`;
  if (format === 'stl-binary') {
    const buf = await exportStlBinary([mesh]);
    const filename = `${baseName}.stl`;
    await downloadArrayBuffer(buf, filename, 'model/stl');
    return { filename, bytes: buf.byteLength };
  }
  if (format === 'stl-ascii') {
    const text = await exportStlAscii([mesh]);
    const filename = `${baseName}.ascii.stl`;
    await downloadText(text, filename, 'model/stl');
    return { filename, bytes: new Blob([text]).size };
  }
  const buf = await exportThreeMf([mesh], { objectName: `${project.name} — ${nodeId}` });
  const filename = `${baseName}.3mf`;
  await downloadArrayBuffer(buf, filename, 'model/3mf');
  return { filename, bytes: buf.byteLength };
}

function gasketSlicerHints(material: 'tpu' | 'eva' | 'epdm' | undefined): string {
  // Issue #115 — honest IP-rating context. TPU print = moisture resistance,
  // NOT certified immersion. EVA / EPDM are pre-formed gaskets the user
  // buys; the included STL is for fit-checking only.
  if (material === 'eva' || material === 'epdm') {
    return [
      `# Gasket — DO NOT PRINT.`,
      '#',
      `# Buy a pre-formed ${material.toUpperCase()} gasket of the dimensions in the project.`,
      '# The included STL is for fit-checking only — the case channel and lid',
      '# tongue are sized to compress the dimensioned gasket by ~25%.',
      '#',
      `# ${material.toUpperCase()} is recommended for IP67-rated immersion. For full`,
      '# waterproofness you ALSO need a pressure-equalization vent (Goretex',
      '# membrane plug) — temperature swings break a sealed enclosure if there',
      '# is no pressure relief.',
      '',
    ].join('\n');
  }
  return [
    '# Gasket — print in TPU 95A flex filament.',
    '#',
    '# IP-rating expectations:',
    '#   • Printed TPU 95A at 100% infill, 3+ walls, no layer voids ≈ IP54',
    '#     (dust + splash). Useful for outdoor electronics, RV / boat panels',
    '#     that see rain but not submersion.',
    '#   • IP67 (1 m immersion, 30 min) is NOT achievable from a printed',
    '#     gasket — switch the project to gasketMaterial=epdm to get a',
    '#     "buy a real gasket" sidecar instead.',
    '#   • True submersion ALSO needs a pressure-equalization vent (Goretex',
    '#     membrane plug). Temperature swings break a fully-sealed box.',
    '#',
    '# Slicer settings:',
    '#   Nozzle:        0.4 mm',
    '#   Layer height:  0.2 mm',
    '#   Infill:        100%',
    '#   Walls:         3+',
    '#   Supports:      NONE',
    '#   Print speed:   20–25 mm/s (TPU is slow)',
    '#   Bed adhesion:  brim',
    '#   Retraction:    minimal (0.5 mm) — TPU oozes',
    '#',
    '# Installation:',
    '#   The gasket presses into the case channel before the lid is attached.',
    '#   The lid tongue compresses it by ~25% to form the seal. If the gasket',
    '#   does not seat fully, ream the channel with a sharp blade to remove',
    '#   layer-line elephant-foot before re-installing.',
    '',
  ].join('\n');
}

export async function triggerExport(format: ExportFormat): Promise<void> {
  const project = useProjectStore.getState().project;
  await scheduleImmediate(project);
  await waitForIdle();
  const groups = meshNodesForExport();
  if (groups.main.length === 0 && !groups.gasket) {
    throw new Error('No mesh available to export');
  }
  // Issue #153 — the fit grade rides in the name, so the STL, the gasket, the
  // 3MF and the notes sidecar all say which variant was printed.
  const safeName = project.name.replace(/[^a-z0-9-_]+/gi, '_') + fitSuffix(project);
  if (format === 'stl-binary') {
    if (groups.main.length > 0) {
      const buf = await exportStlBinary(groups.main);
      await downloadArrayBuffer(buf, `${safeName}.stl`, 'model/stl');
    }
    if (groups.gasket) {
      // Issue #108 — separate STL for the TPU gasket. Different material;
      // not bundled with the case body to avoid mixed-material slicer
      // confusion. Sidecar text file describes recommended slicer settings.
      const buf = await exportStlBinary([groups.gasket]);
      await downloadArrayBuffer(buf, `${safeName}-gasket.stl`, 'model/stl');
      const hints = gasketSlicerHints(project.case.seal?.gasketMaterial);
      await downloadText(hints, `${safeName}-gasket-print-instructions.txt`, 'text/plain');
    }
  } else if (format === 'stl-ascii') {
    if (groups.main.length > 0) {
      const text = await exportStlAscii(groups.main);
      await downloadText(text, `${safeName}.ascii.stl`, 'model/stl');
    }
    if (groups.gasket) {
      const text = await exportStlAscii([groups.gasket]);
      await downloadText(text, `${safeName}-gasket.ascii.stl`, 'model/stl');
      const hints = gasketSlicerHints(project.case.seal?.gasketMaterial);
      await downloadText(hints, `${safeName}-gasket-print-instructions.txt`, 'text/plain');
    }
  } else {
    // 3MF: bundle everything in one file. Slicers that read 3MF can split
    // by object group at print time. The 3MF does NOT carry the print
    // guidance — `threeMf.ts` writes only an `Application` metadata tag —
    // so the sidecar below is emitted here too (#154).
    //
    // Issue #168 — it DOES now carry the slicer assignment, for parts that
    // have one (the badge's two colours). Those parts arrive as a single
    // multi-material object with a `Slic3r_PE_model.config` sidecar, so the
    // two-colour badge opens ready to print instead of as two loose objects.
    const all = [...groups.main, ...(groups.gasket ? [groups.gasket] : [])];
    const buf = await exportThreeMf(all, { objectName: project.name });
    await downloadArrayBuffer(buf, `${safeName}.3mf`, 'model/3mf');
  }

  // Issue #154 — the print notes sidecar. The plan already carries the
  // orientation/supports/walls metadata; this is where it reaches the file the
  // user downloads, for ALL three format branches. It must describe the parts
  // actually written (assembled racks are excluded above) and must know the
  // layout mode, because the flip is skipped in `assembled` mode.
  const exportedCount = groups.mainIds.length + (groups.gasketId ? 1 : 0);
  if (exportedCount > 0) {
    const layoutMode = useSettingsStore.getState().exportLayout;
    await downloadText(
      printNotesForGroups(groups, layoutMode, exportFitGrade(project)),
      `${safeName}-PRINT-NOTES.txt`,
      'text/plain',
    );
  }
}
