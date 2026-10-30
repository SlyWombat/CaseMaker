import { describe, it, expect } from 'vitest';
import { autoPortsForBoard, defaultMarginFor } from '@/engine/compiler/portFactory';
import { buildPortCutoutOp } from '@/engine/compiler/ports';
import { getBuiltinBoard, listBuiltinBoardIds } from '@/library';
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

/** The cube a rect port cutout is built as, so a spec can read the opening it makes. */
function cutoutCube(op: ReturnType<typeof buildPortCutoutOp>): [number, number, number] {
  if (op === null || op.kind !== 'translate' || op.child.kind !== 'cube') {
    throw new Error('expected a translated rect cutout');
  }
  return op.child.size as [number, number, number];
}

function portOf(boardId: string, componentId: string) {
  const project = createDefaultProject(boardId);
  const port = project.ports.find((p) => p.sourceComponentId === componentId);
  if (port === undefined) throw new Error(`${boardId} has no auto-port ${componentId}`);
  return { project, port };
}

describe('#404 — a USB-C cutout takes the cable plug, not the bare receptacle', () => {
  it('the kind default is 1.75 mm per edge; every other kind keeps the generic 0.5', () => {
    expect(defaultMarginFor('usb-c')).toBe(1.75);
    for (const kind of ['usb-a', 'usb-b', 'micro-usb', 'hdmi', 'micro-hdmi', 'barrel-jack', 'ethernet-rj45', 'sd-card', 'custom'] as const) {
      expect(defaultMarginFor(kind), kind).toBe(0.5);
    }
  });

  it('a 9 × 3.2 receptacle opens 12.5 × 6.7 mm, centred on it', () => {
    const { project, port } = portOf('rpi-4b', 'usbc-power');
    expect(port.cutoutMargin).toBe(1.75);
    const [width, , height] = cutoutCube(buildPortCutoutOp(port, project.board, project.case));
    expect(width).toBeCloseTo(12.5, 6); // across the wall, for a -y port
    expect(height).toBeCloseTo(6.7, 6);
  });

  it('every USB-C component in the builtin library gets it from the board data alone', () => {
    const seen: string[] = [];
    for (const id of listBuiltinBoardIds()) {
      const board = getBuiltinBoard(id)!;
      for (const p of autoPortsForBoard(board)) {
        if (p.kind !== 'usb-c') continue;
        seen.push(`${id}/${p.sourceComponentId}`);
        expect(p.cutoutMargin, `${id}/${p.sourceComponentId}`).toBe(1.75);
      }
    }
    // Every side-facing USB-C in the table plus the Radxa's three; the Guition's +z bay is not a
    // generic auto-port, so it is deliberately not counted (or changed).
    expect(seen.length).toBe(16);
  });

  it('a component’s own cutoutMargin still wins over the kind default', () => {
    const board = getBuiltinBoard('rpi-4b')!;
    const tweaked = {
      ...board,
      components: board.components.map((c) =>
        c.kind === 'usb-c' ? { ...c, cutoutMargin: 0.8 } : c,
      ),
    };
    const port = autoPortsForBoard(tweaked).find((p) => p.sourceComponentId === 'usbc-power')!;
    expect(port.cutoutMargin).toBe(0.8);
  });

  it('the dual-port boards still compile: a 1.9 mm web on the C61, one merged slot on the S3', () => {
    const span = (boardId: string, componentId: string) => {
      const { port } = portOf(boardId, componentId);
      const m = port.cutoutMargin;
      return { lo: port.position.x - m, hi: port.position.x + port.size.x + m };
    };

    const c61a = span('esp32-c61-devkitc-1', 'usb-c-uart');
    const c61b = span('esp32-c61-devkitc-1', 'usb-c-native');
    // 14.4 mm centre spacing less a 12.5 mm opening: a solid web, above the 1.5 mm bridge threshold.
    expect(c61b.lo - c61a.hi).toBeCloseTo(1.9, 6);

    const s3a = span('esp32-s3-devkitc-1', 'usb-c-uart');
    const s3b = span('esp32-s3-devkitc-1', 'usb-c-native');
    // 11 mm centre spacing: the two openings overlap, and the CSG union makes ONE slot — there is no
    // middle web for a floater to detach from.
    expect(s3b.lo).toBeLessThan(s3a.hi);
  });

  it('the Elegoo’s 5.5 is the connector’s depth: its wall opening is still 12.5 mm wide', () => {
    // The issue read the 5.5 as a data error; on a +x port the width runs along Y (9 mm) and 5.5 is
    // the insertion depth, so the plug-sized opening is the ordinary one.
    const { project, port } = portOf('elegoo-esp32-wroom-usbc', 'usb-c');
    const [, width, height] = cutoutCube(buildPortCutoutOp(port, project.board, project.case));
    expect(width).toBeCloseTo(12.5, 6);
    expect(height).toBeCloseTo(6.7, 6);
  });

  it('a board without USB-C is untouched: the micro-USB boards keep their 0.5 margin', () => {
    const { port } = portOf('rpi-pico', 'usb-micro');
    expect(port.cutoutMargin).toBe(0.5);
  });
});
