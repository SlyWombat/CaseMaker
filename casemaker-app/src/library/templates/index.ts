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
  /** Built-in board this template is the curated recipe for. The welcome
   * screen's pick-a-board flow applies the first template matching the
   * chosen board instead of generating a bare default shell. Omit for
   * templates with no host board (protective-case, large-box-200). */
  boardId?: string;
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
  // Wall tangent length for the ±y faces — used by both the hinge
  // (back, +y) and the latches (front, -y) so they scale together when
  // the user resizes the board. outerX = pcb.x + 2 × (wall + clearance).
  const pcbX = p.board.pcb.size.x;
  const wallTangentLen = pcbX + 2 * (p.case.wallThickness + p.case.internalClearance);
  // Piano-segmented hinge on the back face. Length scales to ~75% of the
  // wall tangent so the hinge dominates the back face on any case size,
  // not just the default 150 mm one. featureScale.clampHinge enforces
  // the printable minimums (knuckle OD ≥ 5 mm, pin ≥ 2 mm, length ≥ 25
  // mm) so the hinge stays buildable down to ~50 mm wall lengths.
  p.case.hinge = {
    id: 'tpl-protective-hinge',
    style: 'piano-segmented',
    face: '+y',
    numKnuckles: 7,
    knuckleOuterDiameter: 8,
    pinDiameter: 3,
    knuckleClearance: 0.4,
    positioning: 'centered',
    hingeLength: wallTangentLen * 0.75,
    pinMode: 'separate',
    enabled: true,
  };
  // Two latches on the FRONT face (-y), opposite the hinge. Positions
  // are a FRACTION of the wall tangent so the template auto-fits when
  // the user shrinks the board.
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
  p.case.internalClearance = 2;
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

function esp32C61DevTray(): Project {
  // ESP32-C61-DevKitC-1: 25.4×51.8 mm devkit with NO mounting holes, dual
  // USB-C on the -y edge (UART left, native right), and the WROOM-1 module's
  // PCB antenna overhanging the +y edge by 6.35 mm. No holes → no bosses;
  // snap retention with the board's own retentionClips: a two-jaw clip on
  // each side edge ahead of the header rows (the only clear segments), plus
  // a shelf-only support tab reaching 10 mm under the antenna end — there is
  // no room for a finger above the board there. The USB-C wall cutouts
  // register the front; the +y clearance tweak opens 6.6 mm past the PCB
  // edge so the antenna clears the back wall.
  const p = createDefaultProject('esp32-c61-devkitc-1');
  p.name = 'ESP32-C61 dev tray';
  p.case.joint = 'flat-lid';
  p.case.boardRetention = 'snap';
  p.case.internalClearance = 0.3;
  p.case.clearanceTweaks = { xMin: 0, xMax: 0, yMin: 0, yMax: 6.3 };
  p.ports = autoPortsForBoard(p.board);
  return p;
}

function elpCameraEnclosure(): Project {
  // ELP-USBGS1200P01-H120: 38×38 mm AR0234 USB camera mounted lens-DOWN.
  // The lens stack is encoded on the board profile as a `-z`-facing
  // component, so autoPortsForBoard generates the floor cutout
  // automatically — no template-specific cutout wiring needed. The
  // template just picks snap-fit (matches user preference for camera
  // enclosures) and disables ventilation.
  const p = createDefaultProject('elp-usbgs1200p01-h120');
  p.name = 'ELP AR0234 camera enclosure';
  p.case.joint = 'snap-fit';
  p.case.ventilation = { enabled: false, pattern: 'none', coverage: 0 };
  p.ports = autoPortsForBoard(p.board);
  return p;
}

function esp32S3TouchLcd43BPanel(): Project {
  // Waveshare ESP32-S3-Touch-LCD-4.3B: an all-in-one board with a 4.3"
  // 800x480 capacitive touch LCD bonded to the front, and NO screw holes.
  // The board is modelled screen-DOWN: the 95.54x54.36 active area is a
  // `-z`-facing component, so autoPortsForBoard punches the window through
  // the case FLOOR (front bezel) — intrinsic to the board, so it appears
  // whether you pick the board or this template. You drop the panel in
  // glass-down: the window is smaller than the 112.4x75.1 glass, so the
  // glass rests on the floor bezel lip and can't fall through. Screwless
  // retention: boardRetention 'snap' adds wall fingers that hold the board
  // down onto the lip; the snap-fit lid is the roomy back cover. Connectors
  // face up into the cavity — one USB-C (-X) and the 16-pos 3.5mm terminal
  // block (-Y) exit the side walls near the back seam.
  const p = createDefaultProject('esp32-s3-touch-lcd-4.3b');
  p.name = 'ESP32-S3 4.3" touch panel';
  p.case.joint = 'snap-fit';
  p.case.boardRetention = 'snap';
  p.case.ventilation = { enabled: false, pattern: 'none', coverage: 0 };
  p.case.snapCatches = defaultSnapCatchesForCase(p.board, p.case);
  p.ports = autoPortsForBoard(p.board);
  return p;
}

function guitionDeskStand(): Project {
  // Guition JC4880P443C (4.3" 480x800 ESP32-P4 panel, in its vendor shell):
  // a FINISHED module, so there's no cavity to build — the case is a desk
  // stand. Geometry comes from Guition's own structure drawing: the 117.01 x
  // 69.41 flange, the 102.6 x 65.06 rear body that passes through the frame's
  // opening, and four Ø5.4 x 5.0 mm bosses with M2 holes on a 108 x 60 grid.
  // Landscape, leaning back 15°. The frame's middle is open so the two
  // back-facing USB-C ports and the 2x10 header stay reachable.
  const p = createDefaultProject('guition-jc4880p443c');
  p.name = 'Guition 4.3" panel — desk stand';
  p.case.stand = {
    enabled: true,
    tiltAngleDeg: 15,
    // 10 mm, not 8: the boss pocket eats 5.2 mm, and the screw head's
    // counterbore another 1.5 — an 8 mm frame would leave only 1.3 mm of
    // plastic under each head, thin enough to pull through.
    frameThickness: 10,
    bezelMargin: 0,
    openingClearance: 0.4,
    screwHoleDiameter: 2.4,
    baseDepth: 55,
    baseThickness: 5,
    gussetThickness: 6,
    gussetHeightFraction: 0.55,
  };
  p.case.bosses.enabled = false;
  p.case.ventilation = { enabled: false, pattern: 'none', coverage: 0 };
  p.ports = [];
  p.mountingFeatures = [];
  return p;
}

function slythermPanel(): Project {
  // SlyTherm: the ESP32-S3-Touch-LCD-4.3B panel extended +X to co-locate a
  // Seeed MSR-2 mmWave radar module. Same screen-down bezel + snap retention as
  // the touch panel (scoped to the 112.4x75.1 screen so its rim/fingers stay on
  // the glass), plus snap-clip standoffs that hold the 21x37.5 MSR-2 PCB 10 mm
  // above the floor in the extension bay, radar facing out the front.
  const p = createDefaultProject('slytherm');
  p.name = 'SlyTherm (4.3" touch + MSR-2 radar)';
  p.case.joint = 'snap-fit';
  p.case.boardRetention = 'snap';
  p.case.ventilation = { enabled: false, pattern: 'none', coverage: 0 };
  p.case.snapCatches = defaultSnapCatchesForCase(p.board, p.case);
  p.ports = autoPortsForBoard(p.board);
  return p;
}

export const TEMPLATES: ReadonlyArray<ProjectTemplate> = [
  {
    id: 'pi-server-tray',
    boardId: 'rpi-4b',
    name: 'Pi 4 server tray',
    description: 'Pi 4B with hex-vent screw-down lid and 4 corner mounting tabs.',
    estPrintMinutes: 180,
    build: piServerTray,
  },
  {
    id: 'pi-poe-stack',
    boardId: 'rpi-4b',
    name: 'Pi 4 with PoE+ HAT',
    description: 'Pi 4B + PoE+ HAT, screw-down lid, slot ventilation.',
    estPrintMinutes: 210,
    build: piPoeStack,
  },
  {
    id: 'pi-zero-tablet',
    boardId: 'rpi-zero-2w',
    name: 'Pi Zero 2W tablet',
    description: 'Pi Zero 2W + HyperPixel 4.0 in a recessed-bezel frame.',
    estPrintMinutes: 150,
    build: piZeroTablet,
  },
  {
    id: 'arduino-dmx',
    boardId: 'arduino-uno-r3',
    name: 'Arduino DMX controller',
    description: 'Arduino Uno R3 + CQRobot DMX MAX485 shield with screw-down lid.',
    estPrintMinutes: 200,
    build: arduinoDmxController,
  },
  {
    id: 'giga-dmx-controller',
    boardId: 'arduino-giga-r1-wifi',
    name: 'GIGA R1 + DMX shield',
    description: 'Arduino GIGA R1 WiFi + CQRobot DMX shield, slot-vented screw-down lid.',
    estPrintMinutes: 240,
    build: gigaDmxController,
  },
  {
    id: 'esp32-dev-tray',
    boardId: 'esp32-devkit-v1',
    name: 'ESP32 dev tray',
    description: 'ESP32 DevKit V1 in an open flat-lid tray for prototyping.',
    estPrintMinutes: 90,
    build: esp32DevTray,
  },
  {
    id: 'esp32-c61-dev-tray',
    boardId: 'esp32-c61-devkitc-1',
    name: 'ESP32-C61 dev tray',
    description: 'ESP32-C61-DevKitC-1 (Wi-Fi 6, dual USB-C) in a press-fit flat-lid tray with both USB-C cutouts and back-wall clearance for the overhanging PCB antenna.',
    estPrintMinutes: 60,
    build: esp32C61DevTray,
  },
  {
    id: 'elp-camera-enclosure',
    boardId: 'elp-usbgs1200p01-h120',
    name: 'ELP AR0234 camera enclosure',
    description: 'ELP-USBGS1200P01-H120 (1080P global-shutter USB camera, 120° lens) in a screw-down enclosure with a lens lid hole and a USB-A pass-through cutout sized for the pigtail plug.',
    estPrintMinutes: 75,
    build: elpCameraEnclosure,
  },
  {
    id: 'esp32-s3-touch-panel',
    boardId: 'esp32-s3-touch-lcd-4.3b',
    name: 'ESP32-S3 4.3" touch panel',
    description: 'Waveshare ESP32-S3-Touch-LCD-4.3B (4.3" 800x480 capacitive touch) in a screw-down bezel case: the lid frames the active-area window, with USB-C and the 16-position 3.5mm terminal block brought out to the edges.',
    estPrintMinutes: 150,
    build: esp32S3TouchLcd43BPanel,
  },
  {
    id: 'slytherm',
    boardId: 'slytherm',
    name: 'SlyTherm (4.3" touch + MSR-2 radar)',
    description: 'ESP32-S3 4.3" touch panel extended with a snap-clip bay for a Seeed MSR-2 mmWave radar module held 10mm off the floor, radar facing out the front alongside the screen.',
    estPrintMinutes: 170,
    build: slythermPanel,
  },
  {
    id: 'guition-desk-stand',
    boardId: 'guition-jc4880p443c',
    name: 'Guition 4.3" panel — desk stand',
    description: 'Desk stand for the Guition JC4880P443C (4.3" 480x800 ESP32-P4 touch panel in its vendor shell). Picture-frame plate the panel screws into on its four M2 bosses, leaning back 15° on a braced foot. No lid — the frame\'s open centre keeps the back USB-C ports and pin header reachable.',
    estPrintMinutes: 200,
    build: guitionDeskStand,
  },
  {
    id: 'snap-fit-test',
    boardId: 'snap-test-fixture',
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

/**
 * First template curated for the given built-in board, if any. Boards can
 * back multiple templates (rpi-4b → pi-server-tray + pi-poe-stack); list
 * order in TEMPLATES decides which one the pick-a-board flow applies.
 */
export function findTemplateByBoard(boardId: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.boardId === boardId);
}
