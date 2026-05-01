import { describe, it, expect } from 'vitest';
import { TEMPLATES, findTemplate } from '@/library/templates';
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
    expect(project.case.lidRecess).toBe(true);
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
    // PCB 192 + 2*(wall=3 + cl=1) = 200 mm outer.
    expect(project.board.pcb.size.x).toBe(192);
    expect(project.board.pcb.size.y).toBe(192);
    expect(project.case.wallThickness).toBe(3);
    expect(project.case.internalClearance).toBe(1);
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
