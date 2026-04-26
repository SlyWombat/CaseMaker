import { describe, it, expect } from 'vitest';
import { autoPortsForBoard } from '@/engine/compiler/portFactory';
import { buildPortCutoutOp } from '@/engine/compiler/ports';
import { getBuiltinBoard } from '@/library';
import { createDefaultProject } from '@/store/projectStore';

describe('port cutouts', () => {
  it('autoPortsForBoard skips +z facing components and includes side-facing ports', () => {
    const board = getBuiltinBoard('rpi-4b')!;
    const ports = autoPortsForBoard(board);
    const sourceIds = ports.map((p) => p.sourceComponentId);
    expect(sourceIds).toContain('usbc-power');
    expect(sourceIds).toContain('hdmi0');
    expect(sourceIds).toContain('rj45');
    expect(sourceIds).not.toContain('gpio'); // gpio faces +z
  });

  it('every auto-generated port is enabled by default', () => {
    const board = getBuiltinBoard('rpi-4b')!;
    const ports = autoPortsForBoard(board);
    expect(ports.every((p) => p.enabled)).toBe(true);
  });

  it('disabled ports produce no cutout op', () => {
    const project = createDefaultProject('rpi-4b');
    const port = { ...project.ports[0]!, enabled: false };
    expect(buildPortCutoutOp(port, project.board, project.case)).toBeNull();
  });

  it('+z facing ports always produce no cutout', () => {
    const project = createDefaultProject('rpi-4b');
    const port = { ...project.ports[0]!, facing: '+z' as const };
    expect(buildPortCutoutOp(port, project.board, project.case)).toBeNull();
  });

  it('Pi Zero 2 W ports include micro-USB and micro-HDMI on +y wall', () => {
    const board = getBuiltinBoard('rpi-zero-2w')!;
    const ports = autoPortsForBoard(board);
    const yPosPorts = ports.filter((p) => p.facing === '+y');
    expect(yPosPorts.length).toBe(3);
    expect(yPosPorts.map((p) => p.kind).sort()).toEqual(['micro-hdmi', 'micro-usb', 'micro-usb']);
  });
});
