import type { Project } from '@/types';
import { createDefaultProject } from '@/store/projectStore';
import { autoPortsForBoard } from '@/engine/compiler/portFactory';
import { autoPortsForHat } from '@/engine/compiler/hats';
import { getBuiltinHat } from '@/library/hats';
import { defaultSnapCatchesForCase } from '@/engine/compiler/snapCatches';

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
  p.case.ventilation = { enabled: false, pattern: 'none', coverage: 0 };
  // Templates set joint directly (bypassing patchCase), so the auto-populate
  // path in projectStore.patchCase doesn't fire. Seed the catches here so
  // the snap geometry actually shows up on first render.
  p.case.snapCatches = defaultSnapCatchesForCase(p.board, p.case);
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
];

export function findTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
