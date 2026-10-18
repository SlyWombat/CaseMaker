// Build sample STLs from the real ProjectCompiler + Manifold pipeline.
// Run with `npm run sample:export`.
//
// Each sample exercises geometry that downstream users care about — currently
// the snap-fit calibration cube tracked by issue #2 and a representative
// ESP32 DevKit V1 case with snap-fit lid.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrap } from '../src/platform/headless/bootstrap';
import { createDefaultProject } from '../src/store/projectStore';
import { autoPortsForBoard } from '../src/engine/compiler/portFactory';
import { defaultSnapCatchesForCase } from '../src/engine/compiler/snapCatches';
import { findTemplate } from '../src/library/templates';
import type { Project, BoardProfile } from '../src/types';
import { writeProjectStl } from './lib/casemaker/projectExport';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const samplesDir = join(repoRoot, 'samples');
mkdirSync(samplesDir, { recursive: true });

// The wasm module and the bundled faces (#180 — a `file:` URL is not fetchable, and the compiler
// typesets labels synchronously) come from the shared headless bootstrap (#476). No shipped sample
// carries labels today, but seeding keeps a label-bearing sample compiling.
const { manifold: tl } = await bootstrap();

function buildCalibrationProject(): Project {
  // 30 × 30 × 1.6 mm "PCB" with no components and no holes — produces a tiny
  // hollow box + snap-fit lid that's quick to print for tolerance tuning.
  const board: BoardProfile = {
    id: 'snap-fit-calibration',
    name: 'Snap-fit calibration',
    manufacturer: 'Case Maker samples',
    pcb: { size: { x: 30, y: 30, z: 1.6 } },
    mountingHoles: [],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 4,
    builtin: false,
  };
  const now = new Date(0).toISOString();
  return {
    schemaVersion: 1,
    id: 'sample-calibration',
    name: 'Snap-fit calibration cube',
    createdAt: now,
    modifiedAt: now,
    board,
    case: {
      wallThickness: 2,
      floorThickness: 2,
      lidThickness: 2,
      cornerRadius: 2,
      internalClearance: 0.5,
      zClearance: 4,
      joint: 'snap-fit',
      ventilation: { enabled: false, pattern: 'none', coverage: 0 },
      bosses: {
        enabled: false,
        insertType: 'self-tap',
        outerDiameter: 5,
        holeDiameter: 2.5,
      },
    },
    ports: [],
    externalAssets: [],
  };
}

function buildEsp32Project(): Project {
  const project = createDefaultProject('esp32-devkit-v1');
  project.case.joint = 'snap-fit';
  project.name = 'ESP32 DevKit V1 — snap-fit sample';
  // Re-run port factory in case the default board profile changed shape
  project.ports = autoPortsForBoard(project.board);
  // Same as the RPi 3B sample — direct project mutation bypasses the
  // store's auto-population, so populate snap catches explicitly.
  project.case.snapCatches = defaultSnapCatchesForCase(project.board, project.case);
  return project;
}

function buildRpi3bProject(): Project {
  // Calibration print following the 2026-05-03 fixes:
  //   • USB-A x: 70 → 74 (+4mm outward, user-measured)
  //   • Snap catch placement now scans tall connectors per wall and
  //     skips U-positions where the lid arm would collide with USB/RJ45.
  // Use snap-fit to exercise the new placement logic, default 1mm
  // internal clearance, recommended Z clearance (18mm) so the lid
  // actually closes over the 16mm USB-A stack.
  const project = createDefaultProject('rpi-3b');
  project.case.joint = 'snap-fit';
  project.case.zClearance = project.board.recommendedZClearance;
  project.name = 'Raspberry Pi 3B — snap-fit calibration';
  project.ports = autoPortsForBoard(project.board);
  // The store's patchCase auto-populates snap catches when joint flips to
  // 'snap-fit'; we bypass that here by mutating the project directly, so
  // populate them ourselves.
  project.case.snapCatches = defaultSnapCatchesForCase(project.board, project.case);
  return project;
}

interface SampleSpec {
  filename: string;
  description: string;
  build: () => Project;
}

const SAMPLES: SampleSpec[] = [
  {
    filename: 'snap-fit-calibration-30x30.stl',
    description: 'Tiny snap-fit calibration cube (30×30 mm PCB, no components)',
    build: buildCalibrationProject,
  },
  {
    filename: 'esp32-devkit-snap-fit.stl',
    description: 'ESP32 DevKit V1 with snap-fit lid (full real-world test case)',
    build: buildEsp32Project,
  },
  {
    filename: 'rpi-3b-snap-fit-calibration.stl',
    description:
      'RPi 3B snap-fit calibration print — verify USB-A 4mm shift + snap-arm/USB collision avoidance',
    build: buildRpi3bProject,
  },
  {
    filename: 'u7-pro-outdoor-bench-stand.stl',
    description:
      'UniFi U7 Pro Outdoor slide-on bench stand — CHANNEL DIMS UNVERIFIED, caliper the AP first',
    build: () => findTemplate('u7-pro-outdoor-desk-stand')!.build(),
  },
  {
    filename: 'Rack/mini-rack-10in-sample-size.stl',
    description:
      'Parametric 10" mini rack at the original 252×250×16-slot size (Prusa XL class) — sides, top/bottom, keystone plate, blank, short+long shelves, cable tray',
    build: () => findTemplate('mini-rack-10in')!.build(),
  },
  {
    filename: 'Rack/mini-rack-200-bedslinger.stl',
    description:
      'Same rack resized for 220 mm printers (200 wide × 180 deep × 10 slots, wall-mount ears) — same screws, same keystone jacks, smaller envelope',
    build: () => {
      const p = findTemplate('mini-rack-10in')!.build();
      p.case.rack = {
        ...p.case.rack!,
        width: 200,
        depth: 180,
        slots: 10,
        wallMount: 'ears',
        printer: { preset: 'ender-3', x: 220, y: 220, z: 250 },
        accessories: [
          { id: 'acc-keystone', type: 'keystone' },
          { id: 'acc-shelf', type: 'shelf', slots: 3, shelfDepth: 86 },
          { id: 'acc-blank', type: 'blank', slots: 2 },
        ],
      };
      return p;
    },
  },
];

let totalTris = 0;
for (const sample of SAMPLES) {
  const project = sample.build();
  // The compile → lay-out → STL → PRINT-NOTES path is shared with `casemaker export` (#477).
  const written = await writeProjectStl(tl, project, samplesDir, sample.filename);
  totalTris += written.triangles;
  console.log(
    `${sample.filename}  ${written.triangles} triangles  ${(written.bytes / 1024).toFixed(1)} KB`,
  );
}
console.log(`\nWrote ${SAMPLES.length} samples (${totalTris} total triangles) to ${samplesDir}`);
