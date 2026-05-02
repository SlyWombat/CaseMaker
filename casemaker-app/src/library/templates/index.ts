import type { BoardProfile, Project } from '@/types';
import { createDefaultProject } from '@/store/projectStore';
import { autoPortsForBoard } from '@/engine/compiler/portFactory';
import { autoPortsForHat } from '@/engine/compiler/hats';
import { getBuiltinHat } from '@/library/hats';
import { defaultSnapCatchesForCase } from '@/engine/compiler/snapCatches';

/**
 * Synthesize an empty board profile of the given size — no host PCB, no
 * components, no mounting holes. Used by the protective-case and large-box
 * templates that don't have a specific host board.
 */
function emptyBoard(opts: { id: string; name: string; x: number; y: number }): BoardProfile {
  return {
    id: opts.id,
    name: opts.name,
    manufacturer: 'CaseMaker (generic)',
    pcb: { size: { x: opts.x, y: opts.y, z: 1 } },
    mountingHoles: [],
    components: [],
    defaultStandoffHeight: 0,
    recommendedZClearance: 10,
    builtin: false,
  };
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  estPrintMinutes: number;
  build: () => Project;
}

function piServerTray(): Project {
  const p = createDefaultProject('rpi-4b');
  p.name = 'Pi 4 server tray';
  p.case.joint = 'screw-down';
  p.case.ventilation = { enabled: true, pattern: 'hex', coverage: 0.6 };
  p.mountingFeatures = [];
  return p;
}

function piPoeStack(): Project {
  const p = createDefaultProject('rpi-4b');
  p.name = 'Pi 4 with PoE+ HAT';
  p.case.joint = 'screw-down';
  p.case.ventilation = { enabled: true, pattern: 'slots', coverage: 0.5 };
  // Issue #62 — populate ports via autoPortsForHat so PoE+ pass-through and
  // fan exhaust cutouts aren't silently dropped (same #35 pattern).
  const placementId = 'tpl-hat-poe';
  const profile = getBuiltinHat('rpi-poe-plus');
  p.hats.push({
    id: placementId,
    hatId: 'rpi-poe-plus',
    stackIndex: 0,
    ports: profile ? autoPortsForHat(profile, placementId) : [],
    enabled: true,
  });
  return p;
}

function piZeroTablet(): Project {
  const p = createDefaultProject('rpi-zero-2w');
  p.name = 'Pi Zero 2W tablet (HyperPixel 4.0)';
  p.case.joint = 'snap-fit';
  p.display = {
    id: 'tpl-display-hyperpixel',
    displayId: 'hyperpixel-4',
    framing: 'recessed-bezel',
    offset: { x: 0, y: 0 },
    hostSupport: 'gpio-only',
    enabled: true,
  };
  return p;
}

function arduinoDmxController(): Project {
  const p = createDefaultProject('arduino-uno-r3');
  p.name = 'Arduino Uno DMX controller';
  p.case.joint = 'screw-down';
  p.case.ventilation = { enabled: false, pattern: 'none', coverage: 0 };
  const placementId = 'tpl-hat-dmx';
  const profile = getBuiltinHat('cqrobot-dmx-shield-max485');
  p.hats.push({
    id: placementId,
    hatId: 'cqrobot-dmx-shield-max485',
    stackIndex: 0,
    ports: profile ? autoPortsForHat(profile, placementId) : [],
    enabled: true,
  });
  return p;
}

function gigaDmxController(): Project {
  const p = createDefaultProject('arduino-giga-r1-wifi');
  p.name = 'GIGA R1 + CQRobot DMX shield';
  p.case.joint = 'screw-down';
  p.case.ventilation = { enabled: true, pattern: 'slots', coverage: 0.5 };
  const placementId = 'tpl-hat-giga-dmx';
  const profile = getBuiltinHat('cqrobot-dmx-shield-max485');
  // Uno-form-factor shield plugs into the Uno-compatible header column at the
  // -x (USB) end of the Mega/Giga, so the shield's coordinate frame aligns
  // with the host's coordinate frame at x=0 — no offset. The XLRs sit at the
  // shield's -x edge, above the Giga's USB / audio cluster on the same -x
  // wall (stacked in Z because the shield sits ~15 mm above the host PCB).
  p.hats.push({
    id: placementId,
    hatId: 'cqrobot-dmx-shield-max485',
    stackIndex: 0,
    ports: profile ? autoPortsForHat(profile, placementId) : [],
    enabled: true,
  });
  return p;
}

function snapFitTestCube(): Project {
  // Issue #65 — small printable test fixture for snap-fit cantilever
  // validation. ~50×40 mm board → case is ~60×50×~12 mm. Prints in roughly
  // 30 min on PLA, 0.2 mm layers. Use this to physically verify catch geometry.
  const p = createDefaultProject('snap-test-fixture');
  p.name = 'Snap-fit test cube';
  p.case.joint = 'snap-fit';
  p.case.wallThickness = 2;
  p.case.lidThickness = 2;
  p.case.floorThickness = 2;
  p.case.zClearance = 4;
  // Recessed lid by default — exercises the snap-catch geometry against the
  // recess pocket (the more interesting failure mode after #121/#123) and
  // matches what most real snap cases look like. Flat-lid is still one click
  // away if the user wants to test that variant.
  p.case.lidRecess = true;
  p.case.ventilation = { enabled: false, pattern: 'none', coverage: 0 };
  // Templates set joint directly (bypassing patchCase), so the auto-populate
  // path in projectStore.patchCase doesn't fire. Seed the catches here so
  // the snap geometry actually shows up on first render.
  p.case.snapCatches = defaultSnapCatchesForCase(p.board, p.case);
  return p;
}

/**
 * Issue #112 — Pelican-style protective case. Composite of #107 (gasket) +
 * #108 (TPU export) + #109 (latches) + #110 (piano hinge) + #111 (rugged).
 * Sized for a typical hand-portable enclosure (~150 × 100 × ~60 mm). The
 * user replaces the empty board with their actual host PCB after the
 * project is created.
 */
function protectiveCase(): Project {
  // Generic 140×90 mm interior gives ~150×100 mm outer at 5 mm walls.
  const board = emptyBoard({
    id: 'generic-protective-cavity',
    name: 'Protective case interior',
    x: 140,
    y: 90,
  });
  const p = createDefaultProject();
  p.name = 'Protective case (waterproof, hinged, latched)';
  p.board = board;
  p.case.wallThickness = 4;
  p.case.floorThickness = 4;
  p.case.lidThickness = 4;
  p.case.cornerRadius = 6;
  p.case.zClearance = 50;
  // Pelican-standard: lid sits ON TOP of the rim (NOT recessed). The lid
  // overhangs slightly so the latch striker tab projects past the case
  // envelope and the cam arm can grab it. The seal still works without
  // recess — gasket compresses between lid underside and rim top.
  p.case.lidRecess = false;
  // Pelican lids have their OWN cavity (depth to accommodate the top of
  // the latches plus interior padding). Shell-mode buildLid emits a
  // hollow box with side walls extending UP from the rim; the latch
  // striker rides directly on the lid's outer side wall (no separate tab).
  p.case.lidCavityHeight = 25;
  p.case.joint = 'flat-lid';
  p.case.ventilation = { enabled: false, pattern: 'none', coverage: 0 };
  p.case.bosses.enabled = false;
  // Issue #107 — gasket
  p.case.seal = {
    enabled: true,
    profile: 'flat',
    width: 4,
    depth: 2,
    compressionFactor: 0.25,
    gasketMaterial: 'tpu',
  };
  // Issue #110 — piano-segmented hinge on the back face. Sits OUTSIDE the
  // gasket loop; the lid pivots up without breaking the seal.
  p.case.hinge = {
    id: 'tpl-protective-hinge',
    style: 'piano-segmented',
    face: '+y',
    numKnuckles: 7,
    knuckleOuterDiameter: 8,
    pinDiameter: 3,
    knuckleClearance: 0.4,
    positioning: 'centered',
    hingeLength: 110,
    pinMode: 'separate',
    enabled: true,
  };
  // Two latches on the FRONT face (-y), opposite the hinge. Positions
  // are computed as a FRACTION of the wall tangent length so the
  // template auto-fits when the user shrinks the board — pre-fix the
  // positions were hard-coded uPos=40 and uPos=110, which left the
  // second latch hanging off any case shorter than ~120 mm wide. Wall
  // tangent for a -y wall = outerX = pcb.x + 2 × (wall + internalClear).
  const pcbX = p.board.pcb.size.x;
  const wallTangentLen = pcbX + 2 * (p.case.wallThickness + p.case.internalClearance);
  p.case.latches = [
    { id: 'tpl-latch-1', wall: '-y', uPosition: wallTangentLen * 0.27, enabled: true, throw: 1.5, width: 14, height: 30 },
    { id: 'tpl-latch-2', wall: '-y', uPosition: wallTangentLen * 0.73, enabled: true, throw: 1.5, width: 14, height: 30 },
  ];
  // Issue #111 — rugged exterior
  p.case.rugged = {
    enabled: true,
    corners: { enabled: true, radius: 8, flexBumper: false },
    ribbing: { enabled: true, direction: 'vertical', ribCount: 4, ribDepth: 1.5, clearBand: 6 },
    feet: { enabled: true, pads: 4, padDiameter: 12, padHeight: 2 },
  };
  p.ports = [];
  p.mountingFeatures = [];
  return p;
}

/**
 * Large 200×200×100 mm general-purpose case. No host board, flat lid,
 * basic envelope — user adds whichever board / parts they want. Useful as
 * a starting point for storage boxes, LiPo battery packs, RV instrument
 * panels, etc.
 */
function largeBoxTemplate(): Project {
  // Outer dims target ~200×200×100 mm. With wall=3 and clearance=1,
  // pcb = 200 - 2*(3+1) = 192. Cavity height target 100 - floor(3) -
  // lidThickness(3) ≈ 94 mm ⇒ zClearance + standoff + pcbZ = 94. Standoff=0,
  // pcbZ=1 → zClearance ≈ 93.
  const board = emptyBoard({
    id: 'generic-200-cavity',
    name: '200×200 mm interior',
    x: 192,
    y: 192,
  });
  const p = createDefaultProject();
  p.name = '200 × 200 × 100 mm box';
  p.board = board;
  p.case.wallThickness = 3;
  p.case.floorThickness = 3;
  p.case.lidThickness = 3;
  p.case.internalClearance = 1;
  p.case.cornerRadius = 4;
  p.case.zClearance = 93;
  p.case.joint = 'flat-lid';
  p.case.ventilation = { enabled: false, pattern: 'none', coverage: 0 };
  p.case.bosses.enabled = false;
  p.ports = [];
  p.mountingFeatures = [];
  return p;
}

function esp32DevTray(): Project {
  const p = createDefaultProject('esp32-devkit-v1');
  p.name = 'ESP32 DevKit dev tray';
  p.case.joint = 'flat-lid';
  p.ports = autoPortsForBoard(p.board);
  return p;
}

export const TEMPLATES: ReadonlyArray<ProjectTemplate> = [
  {
    id: 'pi-server-tray',
    name: 'Pi 4 server tray',
    description: 'Pi 4B with hex-vent screw-down lid and 4 corner mounting tabs.',
    estPrintMinutes: 180,
    build: piServerTray,
  },
  {
    id: 'pi-poe-stack',
    name: 'Pi 4 with PoE+ HAT',
    description: 'Pi 4B + PoE+ HAT, screw-down lid, slot ventilation.',
    estPrintMinutes: 210,
    build: piPoeStack,
  },
  {
    id: 'pi-zero-tablet',
    name: 'Pi Zero 2W tablet',
    description: 'Pi Zero 2W + HyperPixel 4.0 in a recessed-bezel frame.',
    estPrintMinutes: 150,
    build: piZeroTablet,
  },
  {
    id: 'arduino-dmx',
    name: 'Arduino DMX controller',
    description: 'Arduino Uno R3 + CQRobot DMX MAX485 shield with screw-down lid.',
    estPrintMinutes: 200,
    build: arduinoDmxController,
  },
  {
    id: 'giga-dmx-controller',
    name: 'GIGA R1 + DMX shield',
    description: 'Arduino GIGA R1 WiFi + CQRobot DMX shield, slot-vented screw-down lid.',
    estPrintMinutes: 240,
    build: gigaDmxController,
  },
  {
    id: 'esp32-dev-tray',
    name: 'ESP32 dev tray',
    description: 'ESP32 DevKit V1 in an open flat-lid tray for prototyping.',
    estPrintMinutes: 90,
    build: esp32DevTray,
  },
  {
    id: 'snap-fit-test',
    name: 'Snap-fit test cube',
    description: 'Small ~60×50×12 mm test fixture for physically validating snap-fit cantilever geometry.',
    estPrintMinutes: 30,
    build: snapFitTestCube,
  },
  {
    id: 'protective-case',
    name: 'Protective case (waterproof, hinged, latched)',
    description: 'Pelican-style protective enclosure with TPU gasket, piano-segmented hinge, two spring-cam latches, rugged corners, vertical ribs, and feet. Replace the empty interior with your host PCB after creating the project. (#106)',
    estPrintMinutes: 480,
    build: protectiveCase,
  },
  {
    id: 'large-box-200',
    name: '200 × 200 × 100 mm box',
    description: 'Large general-purpose flat-lid box (~200 × 200 × 100 mm outer). No host board — drop in whichever boards / parts you want.',
    estPrintMinutes: 360,
    build: largeBoxTemplate,
  },
];

export function findTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
