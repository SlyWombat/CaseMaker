import type { Project } from '@/types';
import { createDefaultProject } from '@/store/projectStore';
import { autoPortsForBoard } from '@/engine/compiler/portFactory';

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
  // Add a PoE+ HAT placement
  p.hats.push({
    id: 'tpl-hat-poe',
    hatId: 'rpi-poe-plus',
    stackIndex: 0,
    ports: [],
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
  p.hats.push({
    id: 'tpl-hat-dmx',
    hatId: 'cqrobot-dmx-shield-max485',
    stackIndex: 0,
    ports: [],
    enabled: true,
  });
  // Auto-fill ports for the HAT
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
    id: 'esp32-dev-tray',
    name: 'ESP32 dev tray',
    description: 'ESP32 DevKit V1 in an open flat-lid tray for prototyping.',
    estPrintMinutes: 90,
    build: esp32DevTray,
  },
];

export function findTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
