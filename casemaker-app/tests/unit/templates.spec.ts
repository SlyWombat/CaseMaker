import { describe, it, expect } from 'vitest';
import { TEMPLATES, findTemplate } from '@/library/templates';
import { parseProject, serializeProject } from '@/store/persistence';

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
    ]);
  });

  it('each template builds a current-version Project that round-trips through parseProject', () => {
    for (const tpl of TEMPLATES) {
      const project = tpl.build();
      expect(project.schemaVersion).toBe(5);
      const text = serializeProject(project);
      const parsed = parseProject(text);
      expect(parsed.schemaVersion).toBe(5);
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
});
