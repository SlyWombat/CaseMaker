import { describe, it, expect } from 'vitest';
import { TEMPLATES, findTemplate, findTemplateByBoard } from '@/library/templates';
import { parseProject, serializeProject } from '@/store/persistence';
import { getBuiltinHat } from '@/library/hats';
import { autoPortsForHat } from '@/engine/compiler/hats';

describe('Marketing gap #15 — project templates', () => {
  it('exposes the starter template set in expected order', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      'pi-server-tray',
      'pi-poe-stack',
      'pi-zero-tablet',
      'arduino-dmx',
      'giga-dmx-controller',
      'esp32-dev-tray',
      'esp32-c61-dev-tray',
      'elp-camera-enclosure',
      'esp32-s3-touch-panel',
      'slytherm',
      'snap-fit-test',
      'protective-case',
      'large-box-200',
    ]);
  });

  it('each template builds a current-version Project that round-trips through parseProject', () => {
    for (const tpl of TEMPLATES) {
      const project = tpl.build();
      expect(project.schemaVersion).toBe(7);
      const text = serializeProject(project);
      const parsed = parseProject(text);
      expect(parsed.schemaVersion).toBe(7);
      expect(parsed.board.id).toBe(project.board.id);
    }
  });

  it('pi-zero-tablet sets the HyperPixel display in recessed-bezel framing', () => {
    const tpl = findTemplate('pi-zero-tablet')!;
    const project = tpl.build();
    expect(project.display).not.toBeNull();
    expect(project.display!.displayId).toBe('hyperpixel-4');
    expect(project.display!.framing).toBe('recessed-bezel');
  });

  it('esp32-s3-touch-panel cuts the LCD window in the floor and snaps the board in screwless', () => {
    const tpl = findTemplate('esp32-s3-touch-panel')!;
    const project = tpl.build();
    expect(project.board.clonedFrom).toBe('esp32-s3-touch-lcd-4.3b');
    // Screwless: no mounting holes, board held by snap fingers + snap-fit lid.
    expect(project.board.mountingHoles.length).toBe(0);
    expect(project.case.joint).toBe('snap-fit');
    expect(project.case.boardRetention).toBe('snap');
    // The screen window is an intrinsic -z (floor) cutout — present on the
    // board itself, so picking the board alone (no display) still gets it.
    expect(project.display).toBeNull();
    const window = project.ports.find((p) => p.sourceComponentId === 'lcd-window');
    expect(window).toBeDefined();
    expect(window!.facing).toBe('-z');
    expect(window!.size.x).toBeCloseTo(95.54);
    expect(window!.size.y).toBeCloseTo(54.36);
  });

  it('esp32-c61-dev-tray press-fits the hole-less devkit and clears the antenna overhang', () => {
    const tpl = findTemplate('esp32-c61-dev-tray')!;
    const project = tpl.build();
    expect(project.board.clonedFrom).toBe('esp32-c61-devkitc-1');
    // No mounting holes on the DevKitC — press-fit walls hold the board.
    expect(project.board.mountingHoles.length).toBe(0);
    expect(project.case.boardRetention).toBe('press-fit');
    expect(project.case.internalClearance).toBeCloseTo(0.3);
    // Header pin tails (~3 mm) + 20 mm of under-board room for jumper wires.
    expect(project.board.defaultStandoffHeight).toBe(23);
    // WROOM-1 antenna overhangs the +y edge by 6.35 mm — back wall opens up.
    expect(project.case.clearanceTweaks?.yMax).toBeGreaterThanOrEqual(6.05);
    // Both USB-C connectors get -y wall cutouts.
    const usbPorts = project.ports.filter(
      (p) => p.sourceComponentId === 'usb-c-uart' || p.sourceComponentId === 'usb-c-native',
    );
    expect(usbPorts.length).toBe(2);
    for (const p of usbPorts) expect(p.facing).toBe('-y');
    // On-module PCB antenna — internal, no SMA wall hole.
    expect(project.antennas.length).toBe(1);
    expect(project.antennas[0]!.type).toBe('internal');
  });

  it('findTemplateByBoard links boards to their quickstart recipe', () => {
    expect(findTemplateByBoard('esp32-c61-devkitc-1')?.id).toBe('esp32-c61-dev-tray');
    // Multi-template board: list order wins.
    expect(findTemplateByBoard('rpi-4b')?.id).toBe('pi-server-tray');
    // Boards without a curated template fall back to the bare shell flow.
    expect(findTemplateByBoard('generic-zero')).toBeUndefined();
  });

  it('arduino-dmx adds the CQRobot DMX shield', () => {
    const tpl = findTemplate('arduino-dmx')!;
    const project = tpl.build();
    expect(project.hats.length).toBe(1);
    expect(project.hats[0]!.hatId).toBe('cqrobot-dmx-shield-max485');
  });

  // Issue #62 — piPoeStack used to push the HAT with `ports: []`, silently
  // dropping any edge cutouts the HAT profile defines. The current rpi-poe-plus
  // profile only has a top-facing fan (no edge ports), so autoPortsForHat
  // returns []. Test that the template's port set MATCHES whatever the factory
  // produces — so if the HAT profile later grows an edge component (Ethernet
  // pass-through, side connector), the template picks it up automatically
  // instead of silently dropping it.
  it('protective-case wires gasket + hinge + latches + rugged (#112)', () => {
    const tpl = findTemplate('protective-case')!;
    const project = tpl.build();
    expect(project.case.seal?.enabled).toBe(true);
    // Pelican-standard: lid sits ON TOP of the rim (not recessed), so the
    // latch striker tab can project past the case envelope and the cam arm
    // can grab it. Seal still works (gasket between lid underside + rim top).
    expect(project.case.lidRecess).toBe(false);
    expect(project.case.hinge?.enabled).toBe(true);
    expect(project.case.hinge?.style).toBe('piano-segmented');
    expect(project.case.latches?.length).toBe(2);
    expect(project.case.rugged?.enabled).toBe(true);
    expect(project.case.rugged?.corners.enabled).toBe(true);
    expect(project.case.rugged?.feet.enabled).toBe(true);
  });

  it('large-box-200 produces a ~200×200×100 mm flat-lid box (#112)', () => {
    const tpl = findTemplate('large-box-200')!;
    const project = tpl.build();
    expect(project.case.joint).toBe('flat-lid');
    // PCB 192 + 2*(wall=3 + cl=2) = 202 mm outer (2 mm default clearance).
    expect(project.board.pcb.size.x).toBe(192);
    expect(project.board.pcb.size.y).toBe(192);
    expect(project.case.wallThickness).toBe(3);
    expect(project.case.internalClearance).toBe(2);
  });

  it('pi-poe-stack ports come from autoPortsForHat (regression #62)', () => {
    const tpl = findTemplate('pi-poe-stack')!;
    const project = tpl.build();
    expect(project.hats.length).toBe(1);
    const hat = project.hats[0]!;
    expect(hat.hatId).toBe('rpi-poe-plus');
    const profile = getBuiltinHat('rpi-poe-plus')!;
    const expected = autoPortsForHat(profile, hat.id);
    expect(hat.ports).toEqual(expected);
  });
});
