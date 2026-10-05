// @vitest-environment jsdom
// Issue #154 — the print-notes sidecar must reach the file the user downloads,
// for every format branch. Two things are asserted here: the exported ids the
// sidecar is built from (meshNodesForExport), and that triggerExport actually
// writes a `*-PRINT-NOTES.txt` beside the mesh for STL and 3MF alike. The 3MF
// branch used to claim the format "carries its own metadata" — it does not, so
// it needs the sidecar too.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The mesh build worker and the scheduler are not what this spec is about.
vi.mock('@/engine/jobs/workerClient', () => ({
  exportStlBinary: vi.fn(async () => new ArrayBuffer(4)),
  exportStlAscii: vi.fn(async () => 'solid x\nendsolid x'),
  exportThreeMf: vi.fn(async () => new ArrayBuffer(4)),
}));
vi.mock('@/engine/jobs/JobScheduler', () => ({
  scheduleImmediate: vi.fn(async () => {}),
  waitForIdle: vi.fn(async () => {}),
}));

import {
  triggerExport,
  printNotesForGroups,
  meshNodesForExport,
  saveEngraveProgram,
  type ExportMeshGroups,
} from '@/engine/exportTrigger';
import { runSheetFileName, runSheetFrameFileName } from '@/engine/cnc/engrave/runSheet';
import { useJobStore } from '@/store/jobStore';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { MeshNode } from '@/types';

function node(id: string, z = 0): MeshNode {
  return {
    id,
    buffer: {
      positions: new Float32Array([0, 0, z, 10, 0, z, 0, 10, z]),
      indices: new Uint32Array([0, 1, 2]),
    },
    stats: { vertexCount: 3, triangleCount: 1, bbox: { min: [0, 0, z], max: [10, 10, z] } },
  };
}

/** Every anchor download this spec triggered, in order. */
let downloads: { name: string; blob: Blob }[];
let lastBlob: Blob | null;

beforeEach(() => {
  downloads = [];
  lastBlob = null;
  const project = createDefaultProject('rpi-4b');
  project.name = 'My Case';
  useProjectStore.setState({ project });
  useJobStore.setState({ nodes: new Map() });
  useSettingsStore.setState({ exportLayout: 'print-ready' });

  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    lastBlob = b;
    return 'blob:mock';
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({ name: this.download, blob: lastBlob as Blob });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('export sidecar (#154)', () => {
  it('meshNodesForExport reports the exported ids and drops the fused racks', () => {
    useJobStore.setState({
      nodes: new Map([
        ['shell', node('shell')],
        ['lid', node('lid', 4)],
        ['rack-assembled-frame', node('rack-assembled-frame')],
        ['gasket', node('gasket')],
      ]),
    });
    const groups = meshNodesForExport();
    // The assembled frame is an alternative to the parts, not a file in Save All.
    expect(groups.mainIds).toEqual(['shell', 'lid']);
    expect(groups.gasketId).toBe('gasket');
    expect(groups.mainIds.length).toBe(groups.main.length);
  });

  it('the sidecar text is layout-aware and names the parts being written', () => {
    const groups: ExportMeshGroups = {
      main: [],
      gasket: null,
      mainIds: ['rack-bottom'],
      gasketId: null,
    };
    const ready = printNotesForGroups(groups, 'print-ready');
    expect(ready).toContain('PRINT-READY');
    expect(ready).toContain('already turned over');

    const assembled = printNotesForGroups(groups, 'assembled');
    expect(assembled).toContain('ASSEMBLED');
    expect(assembled).toContain('NOT flipped (assembled layout)');
  });

  it('writes a PRINT-NOTES sidecar beside the STL in the binary branch', async () => {
    useJobStore.setState({ nodes: new Map([['shell', node('shell')]]) });
    await triggerExport('stl-binary');
    const names = downloads.map((d) => d.name);
    expect(names).toContain('My_Case.stl');
    expect(names).toContain('My_Case-PRINT-NOTES.txt');
  });

  it('writes the sidecar in the 3MF branch too (3MF carries no print metadata itself)', async () => {
    useJobStore.setState({ nodes: new Map([['shell', node('shell')]]) });
    await triggerExport('3mf');
    const names = downloads.map((d) => d.name);
    expect(names).toContain('My_Case.3mf');
    expect(names).toContain('My_Case-PRINT-NOTES.txt');
  });
});

describe('engrave job + frame save (#244)', () => {
  it('writes the frame file beside the job', async () => {
    await saveEngraveProgram(';@MKR|BEGIN\nM02\n', ';@MKR|BEGIN\nG0 Z20\nM02\n', 'Untitled engrave job');
    expect(downloads.map((d) => d.name)).toEqual([
      runSheetFileName('Untitled engrave job'),
      runSheetFrameFileName('Untitled engrave job'),
    ]);
  });

  it('writes the job alone when there is no frame (a run that never reached the post)', async () => {
    await saveEngraveProgram(';@MKR|BEGIN\nM02\n', null, 'Untitled engrave job');
    expect(downloads.map((d) => d.name)).toEqual([runSheetFileName('Untitled engrave job')]);
  });
});
