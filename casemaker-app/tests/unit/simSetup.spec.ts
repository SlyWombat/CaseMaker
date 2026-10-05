// The Simulate form's state (#196 §3, §4): the prefill from an untrusted header, user edits that
// win, and the pure `Setup` builder. No wasm, no worker, no DOM.

import { describe, it, expect, beforeEach } from 'vitest';
import { buildSimSetup, DEFAULT_STOCK, useSimSetupStore } from '@/store/simSetupStore';
import { buildTimeline, parseGcode, Z1 } from '@/engine/cnc';

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
    // #196 decision (a): the Z1 stub fits the part's EXTENT inside the envelope, not the model
    // origin at the envelope's centre. For a 100 x 80 part on the 200 x 200 Z1 the bbox centre
    // goes to (-100, -100), so the front-left origin lands at (-150, -140).
    expect(setup.placement.source).toBe('stub');
    expect(setup.placement.origin).toEqual([-150, -140, Z1.toolChange.safeZ - 6]);
    expect(setup.wcs.origin).toEqual([-150, -140, Z1.toolChange.safeZ]);
  });

  it('honours an explicit starting tool', () => {
    expect(buildSimSetup(DEFAULT_STOCK, 1).startingTool).toBe(1);
    expect(buildSimSetup(DEFAULT_STOCK, -1).startingTool).toBe(-1);
  });
});

// #196 decision (a), both directions, through the runner that does the envelope check.
describe('the Z1 stub fits the work frame inside the envelope', () => {
  it('a program written inside its own stock runs with no outside-envelope error', () => {
    const setup = buildSimSetup({ length: 60, width: 30, thickness: 6 }, 1);
    const tl = buildTimeline(parseGcode('G0 X5 Y5 Z5\nS1000 M3\nG1 Z-1 F100\nG1 X55 Y25\nG0 Z5\n'), setup, Z1);
    expect(tl.diagnostics.filter((d) => d.code === 'outside-envelope')).toEqual([]);
  });

  it('a program genuinely larger than the envelope still fails', () => {
    // Work X 250 maps to machine X = -130 + 250 = +120, past the Z1's x = 0 face.
    const setup = buildSimSetup({ length: 60, width: 30, thickness: 6 }, 1);
    const tl = buildTimeline(parseGcode('G0 X250 Y5 Z5\n'), setup, Z1);
    expect(tl.diagnostics.map((d) => d.code)).toContain('outside-envelope');
  });
});
