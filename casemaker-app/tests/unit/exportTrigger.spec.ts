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
  exportSinglePart,
  exportFitGrade,
  printNotesForGroups,
  meshNodesForExport,
  saveEngraveProgram,
  type ExportMeshGroups,
} from '@/engine/exportTrigger';
import { defaultInsert } from '@/engine/compiler/insert';
import type { CaseParameters, Project, RackParams } from '@/types';
import type { FitVariant } from '@/types/snap';
import { runSheetFileName, runSheetFrameFileName } from '@/engine/cnc/engrave/runSheet';
import { useJobStore } from '@/store/jobStore';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { MeshNode } from '@/types';

function node(id: string, z = 0, material?: MeshNode['material']): MeshNode {
  return {
    id,
    buffer: {
      positions: new Float32Array([0, 0, z, 10, 0, z, 0, 10, z]),
      indices: new Uint32Array([0, 1, 2]),
    },
    material,
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
        ['gasket', node('gasket', 0, { separateFile: true })],
      ]),
    });
    const groups = meshNodesForExport();
    // The assembled frame is an alternative to the parts, not a file in Save All.
    expect(groups.mainIds).toEqual(['shell', 'lid']);
    expect(groups.gasketId).toBe('gasket');
    expect(groups.mainIds.length).toBe(groups.main.length);
  });

  // Issue #168 — the split is driven by what the part says about itself, not by
  // its name. Same node id, no flag: it stays in the bundle.
  it('a separate-file part is split out by its own flag, not by being called gasket', () => {
    useJobStore.setState({
      nodes: new Map([
        ['shell', node('shell')],
        ['gasket', node('gasket')],
      ]),
    });
    expect(meshNodesForExport().gasketId).toBeNull();

    useJobStore.setState({
      nodes: new Map([
        ['shell', node('shell')],
        ['some-future-flex-part', node('some-future-flex-part', 0, { separateFile: true })],
      ]),
    });
    expect(meshNodesForExport().gasketId).toBe('some-future-flex-part');
  });

  // Issue #168 — the slicer assignment rides along with the geometry, in both
  // layout modes, and the node id comes with it as the volume label.
  it('carries material and the volume name onto the exported meshes', () => {
    useJobStore.setState({
      nodes: new Map([
        ['badge-bottom', node('badge-bottom', 0, { extruder: 2 })],
        ['badge-top', node('badge-top', 3, { extruder: 3 })],
      ]),
    });
    for (const mode of ['print-ready', 'assembled'] as const) {
      useSettingsStore.setState({ exportLayout: mode });
      const { main } = meshNodesForExport();
      expect(main.map((m) => [m.name, m.material?.extruder])).toEqual([
        ['badge-bottom', 2],
        ['badge-top', 3],
      ]);
    }
    useSettingsStore.setState({ exportLayout: 'print-ready' });
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

// Issue #153, step 6 — a user who prints two fit grades needs the files to say
// which is which, and the fit is a project-level choice, so the project names
// the file. The rule reads the same two conditions the panel's select is shown
// under, so a name never claims a grade the export does not have.
describe('export name carries the print-fit grade (#153)', () => {
  const project = (): Project => useProjectStore.getState().project;
  const setCase = (patch: Partial<CaseParameters>): void => {
    useProjectStore.setState({ project: { ...project(), case: { ...project().case, ...patch } } });
  };
  const setRackFit = (fit: FitVariant | undefined): void => {
    // The naming rule reads only `enabled` and `fit`; the rest of the rack
    // params belong to the compiler, which this spec does not run.
    setCase({ rack: { enabled: true, fit } as unknown as RackParams });
  };

  it('is silent for the default project — tight IS the as-designed number', () => {
    expect(exportFitGrade(project())).toBeNull();
  });

  it('names a relieved shell snap, and a relieved board clip', () => {
    setCase({ joint: 'snap-fit', fit: 'loose' });
    expect(exportFitGrade(project())).toBe('loose');
    setCase({ joint: 'screw-down', boardRetention: 'snap', fit: 'standard' });
    expect(exportFitGrade(project())).toBe('standard');
  });

  it('stays silent when the fit is set but nothing in the project is relieved', () => {
    // A leftover setting must not put a grade on a file that has no snap.
    setCase({ joint: 'screw-down', boardRetention: 'screws', fit: 'loose' });
    expect(exportFitGrade(project())).toBeNull();
    setCase({ joint: 'snap-fit', fit: 'tight' });
    expect(exportFitGrade(project())).toBeNull();
  });

  it('reads the rack archetype off the rack, not the shell', () => {
    setRackFit('loose');
    setCase({ joint: 'snap-fit', fit: 'standard' }); // must be ignored: rack wins
    expect(exportFitGrade(project())).toBe('loose');
    setRackFit(undefined);
    expect(exportFitGrade(project())).toBeNull();
  });

  it('never names a grade on an archetype with no mating interface', () => {
    setCase({ insert: defaultInsert(), fit: 'loose' });
    expect(exportFitGrade(project())).toBeNull();
  });

  it('suffixes the mesh, the notes sidecar and a single part alike', async () => {
    setCase({ joint: 'snap-fit', fit: 'loose' });
    useJobStore.setState({ nodes: new Map([['shell', node('shell')], ['lid', node('lid', 4)]]) });
    await triggerExport('stl-binary');
    expect(downloads.map((d) => d.name)).toEqual([
      'My_Case-loose.stl',
      'My_Case-loose-PRINT-NOTES.txt',
    ]);

    downloads = [];
    const result = await exportSinglePart('lid', 'stl-binary');
    expect(result?.filename).toBe('My_Case-lid-loose.stl');
  });

  it('says what the grade means in the notes, since the slicer shows only the name', async () => {
    setCase({ joint: 'snap-fit', fit: 'loose' });
    useJobStore.setState({ nodes: new Map([['shell', node('shell')]]) });
    await triggerExport('stl-binary');
    const notes = downloads.find((d) => d.name.endsWith('-PRINT-NOTES.txt'))?.blob;
    const text = await notes!.text();
    expect(text).toContain('Snap fit:    loose');
    expect(text).toContain('0.25 mm');
  });

  it('leaves the notes unsuffixed and unqualified at the default grade', () => {
    const groups: ExportMeshGroups = {
      main: [],
      gasket: null,
      mainIds: ['shell'],
      gasketId: null,
    };
    expect(printNotesForGroups(groups, 'print-ready')).not.toContain('Snap fit');
  });
});
