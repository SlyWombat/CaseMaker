// The Simulate form's state (#196 §3, §4): the prefill from an untrusted header, user edits that
// win, and the pure `Setup` builder. No wasm, no worker, no DOM.

import { describe, it, expect, beforeEach } from 'vitest';
import { buildSimSetup, DEFAULT_STOCK, useSimSetupStore } from '@/store/simSetupStore';
import { Z1 } from '@/engine/cnc';

// Verbatim from reference-gcode/Z1/TopClamp.nc (also in tests/unit/cncSetupFromHeader.spec.ts).
const STOCK = ';@MKR|STOCK|id=cuboid|length=100|width=100|height=5|diameter=1';
const TOOL =
  ';@MKR|TOOL|number=1|id=112111313812|name=3.175*12mm Flat End(Metal)|type=Flat End|handlediameter=3.175|sticklength=0|shoulderlength=12|flutelength=12|diameter=3.175|tipdiameter=3.175|cornerradius=0|angle=0|halfAngle=0';

const headerText = (...lines: string[]): string => lines.join('\n') + '\n';

beforeEach(() => {
  useSimSetupStore.getState().reset();
});

describe('simSetupStore.openFile', () => {
  it('prefills stock and tool from the real TopClamp header lines', () => {
    useSimSetupStore.getState().openFile('TopClamp.nc', headerText(STOCK, TOOL));
    const s = useSimSetupStore.getState();
    expect(s.fileName).toBe('TopClamp.nc');
    expect(s.stock).toEqual({ length: 100, width: 100, thickness: 5 });
    expect(s.stockSource).toEqual({ length: 'header', width: 'header', thickness: 'header' });
    expect(s.toolKey).toBe('flat-3.175x12-metal');
    expect(s.toolSource).toBe('header');
    expect(s.headerDiagnostics).toEqual([]);
  });

  it('gives defaults and no tool when the text has no header', () => {
    useSimSetupStore.getState().openFile('plain.nc', 'G0 X0 Y0\nG1 Z-1 F100\n');
    const s = useSimSetupStore.getState();
    expect(s.stock).toEqual(DEFAULT_STOCK);
    expect(s.stockSource).toEqual({ length: 'default', width: 'default', thickness: 'default' });
    expect(s.toolKey).toBeNull();
    expect(s.toolSource).toBeNull();
  });

  it('leaves the other fields alone when one stock field is edited after a prefill', () => {
    useSimSetupStore.getState().openFile('TopClamp.nc', headerText(STOCK, TOOL));
    useSimSetupStore.getState().setStock({ length: 80 });
    const s = useSimSetupStore.getState();
    expect(s.stock).toEqual({ length: 80, width: 100, thickness: 5 });
    expect(s.stockSource).toEqual({ length: 'user', width: 'header', thickness: 'header' });
  });

  it('prefills nothing for an invalid STOCK field and records a warning', () => {
    useSimSetupStore.getState().openFile('bad.nc', headerText(STOCK.replace('length=100', 'length=-5')));
    const s = useSimSetupStore.getState();
    expect(s.stock).toEqual(DEFAULT_STOCK);
    expect(s.stockSource.length).toBe('default');
    expect(s.headerDiagnostics.length).toBeGreaterThan(0);
    expect(s.headerDiagnostics.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('a header tool with no library match is "tool required", not a guess', () => {
    const odd = TOOL.replace('type=Flat End', 'type=Ball End');
    useSimSetupStore.getState().openFile('ball.nc', headerText(STOCK, odd));
    expect(useSimSetupStore.getState().toolKey).toBeNull();
    expect(useSimSetupStore.getState().toolSource).toBeNull();
  });

  it('reopening a file resets a user-edited stock back to the new header', () => {
    useSimSetupStore.getState().openFile('TopClamp.nc', headerText(STOCK, TOOL));
    useSimSetupStore.getState().setStock({ length: 80 });
    useSimSetupStore.getState().openFile('TopClamp.nc', headerText(STOCK, TOOL));
    const s = useSimSetupStore.getState();
    expect(s.stock).toEqual({ length: 100, width: 100, thickness: 5 });
    expect(s.stockSource.length).toBe('header');
  });
});

describe('buildSimSetup', () => {
  it('is a tape-down prism at the Z1 stub, starting with an unknown tool', () => {
    const setup = buildSimSetup({ length: 100, width: 80, thickness: 6 });
    expect(setup.part).toEqual({
      kind: 'prism',
      outline: { kind: 'p-rect', size: [100, 80], center: false },
      thickness: 6,
    });
    expect(setup.workholding).toEqual({
      kind: 'tape-down',
      contact: { kind: 'p-rect', size: [100, 80], center: false },
    });
    expect(setup.startingTool).toBe('unknown');
    // The Z1 stub centres the part in the envelope — the placement is assumed, not measured.
    expect(setup.placement.source).toBe('stub');
    expect(setup.placement.origin[0]).toBe((Z1.envelope.x.min + Z1.envelope.x.max) / 2);
  });

  it('honours an explicit starting tool', () => {
    expect(buildSimSetup(DEFAULT_STOCK, 1).startingTool).toBe(1);
    expect(buildSimSetup(DEFAULT_STOCK, -1).startingTool).toBe(-1);
  });
});
