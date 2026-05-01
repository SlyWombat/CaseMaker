import { useProjectStore } from '@/store/projectStore';
import { useJobStore } from '@/store/jobStore';
import { useSettingsStore, type ExportFormat } from '@/store/settingsStore';
import { exportStlBinary, exportStlAscii, exportThreeMf } from '@/engine/jobs/workerClient';
import { scheduleImmediate, waitForIdle } from '@/engine/jobs/JobScheduler';
import type { StlMeshInput } from '@/workers/export/stlBinary';
import { applyLayoutToMeshes } from '@/engine/exportLayout';
import type { MeshNode } from '@/types';

export type { ExportFormat };

function downloadArrayBuffer(buf: ArrayBuffer, filename: string, mime: string): void {
  const blob = new Blob([buf], { type: mime });
  triggerDownload(blob, filename);
}

function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Issue #108 — node id for the TPU gasket. The export pipeline pulls
 *  this node out of the main mesh bundle and emits it as a separate STL
 *  so the user prints it in flex filament. */
const GASKET_NODE_ID = 'gasket';

export function meshesForExport(): StlMeshInput[] {
  return meshNodesForExport().main;
}

export interface ExportMeshGroups {
  /** Main case body parts (case + lid + hinge-pin etc.) — same material. */
  main: StlMeshInput[];
  /** TPU gasket — separate file, separate material (#108). */
  gasket: StlMeshInput | null;
}

export function meshNodesForExport(): ExportMeshGroups {
  const layoutMode = useSettingsStore.getState().exportLayout;
  const nodes = useJobStore.getState().nodes;
  const main: MeshNode[] = [];
  let gasketNode: MeshNode | null = null;
  for (const n of nodes.values()) {
    if (n.id === GASKET_NODE_ID) gasketNode = n;
    else main.push(n);
  }
  const toMesh = (n: MeshNode): StlMeshInput => ({
    positions: n.buffer.positions,
    indices: n.buffer.indices,
  });
  if (layoutMode === 'assembled') {
    return {
      main: main.map(toMesh),
      gasket: gasketNode ? toMesh(gasketNode) : null,
    };
  }
  // Print-ready: lay main parts out flat, lid flipped, side-by-side along +X.
  const laid = applyLayoutToMeshes(main, { flipNodeIds: ['lid'] });
  return {
    main: laid.map((m) => ({ positions: m.positions, indices: m.indices })),
    gasket: gasketNode ? toMesh(gasketNode) : null,
  };
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
  const mesh: StlMeshInput = {
    positions: node.buffer.positions,
    indices: node.buffer.indices,
  };
  const safeProject = project.name.replace(/[^a-z0-9-_]+/gi, '_');
  const safePart = nodeId.replace(/[^a-z0-9-_]+/gi, '_');
  const baseName = `${safeProject}-${safePart}`;
  if (format === 'stl-binary') {
    const buf = await exportStlBinary([mesh]);
    const filename = `${baseName}.stl`;
    downloadArrayBuffer(buf, filename, 'model/stl');
    return { filename, bytes: buf.byteLength };
  }
  if (format === 'stl-ascii') {
    const text = await exportStlAscii([mesh]);
    const filename = `${baseName}.ascii.stl`;
    downloadText(text, filename, 'model/stl');
    return { filename, bytes: new Blob([text]).size };
  }
  const buf = await exportThreeMf([mesh]);
  const filename = `${baseName}.3mf`;
  downloadArrayBuffer(buf, filename, 'model/3mf');
  return { filename, bytes: buf.byteLength };
}

function gasketSlicerHints(material: 'tpu' | 'eva' | 'epdm' | undefined): string {
  // Default to TPU 95A. EVA and EPDM are pre-formed gaskets the user
  // installs; if those materials are picked the gasket STL is for
  // reference only (the user buys the gasket — doesn't print it).
  if (material === 'eva' || material === 'epdm') {
    return [
      `# Gasket — DO NOT PRINT. Buy a pre-formed ${material.toUpperCase()} gasket of`,
      '# the dimensions specified in the project. The included STL is for',
      '# reference / fit-checking only.',
      '',
    ].join('\n');
  }
  return [
    '# Gasket — print in TPU 95A flex filament.',
    '#',
    '#   Nozzle:        0.4 mm',
    '#   Layer height:  0.2 mm',
    '#   Infill:        100%',
    '#   Walls:         3+',
    '#   Supports:      NONE',
    '#   Print speed:   20–25 mm/s (TPU is slow)',
    '#   Bed adhesion:  brim',
    '#   Retraction:    minimal (0.5 mm) — TPU oozes',
    '#',
    '# The gasket should be installed in the case channel before the lid is',
    '# attached. The lid tongue compresses it by ~25% to form the seal.',
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
  const safeName = project.name.replace(/[^a-z0-9-_]+/gi, '_');
  if (format === 'stl-binary') {
    if (groups.main.length > 0) {
      const buf = await exportStlBinary(groups.main);
      downloadArrayBuffer(buf, `${safeName}.stl`, 'model/stl');
    }
    if (groups.gasket) {
      // Issue #108 — separate STL for the TPU gasket. Different material;
      // not bundled with the case body to avoid mixed-material slicer
      // confusion. Sidecar text file describes recommended slicer settings.
      const buf = await exportStlBinary([groups.gasket]);
      downloadArrayBuffer(buf, `${safeName}-gasket.stl`, 'model/stl');
      const hints = gasketSlicerHints(project.case.seal?.gasketMaterial);
      downloadText(hints, `${safeName}-gasket-print-instructions.txt`, 'text/plain');
    }
  } else if (format === 'stl-ascii') {
    if (groups.main.length > 0) {
      const text = await exportStlAscii(groups.main);
      downloadText(text, `${safeName}.ascii.stl`, 'model/stl');
    }
    if (groups.gasket) {
      const text = await exportStlAscii([groups.gasket]);
      downloadText(text, `${safeName}-gasket.ascii.stl`, 'model/stl');
      const hints = gasketSlicerHints(project.case.seal?.gasketMaterial);
      downloadText(hints, `${safeName}-gasket-print-instructions.txt`, 'text/plain');
    }
  } else {
    // 3MF: bundle everything in one file. Slicers that read 3MF can split
    // by object group at print time. No sidecar needed — the 3MF carries
    // its own metadata.
    const all = [...groups.main, ...(groups.gasket ? [groups.gasket] : [])];
    const buf = await exportThreeMf(all);
    downloadArrayBuffer(buf, `${safeName}.3mf`, 'model/3mf');
  }
}
