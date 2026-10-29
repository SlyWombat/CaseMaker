// #761 — SIMULATE › OPEN .nc CAN SIMULATE A ROTARY PROGRAM.
//
// Found by #753: a posted rotary file opened in the Simulate panel was shown path-only with two
// refusals ("the rotary axis is tracked but not interpreted" and "the rotary column engine sweeps
// a cylinder stock; the setup's part is a prism"). The engine simulates the same file; only the
// .nc door could not describe a rod in the chuck.
//
// The fix is the form's, not the engines': a file that moves A is offered as a ROD (diameter ×
// length) held by the Holding step's own chuck rule, and `buildSimSetup` builds a cylinder setup.
// The session's routing is unchanged and is asserted here through that setup: a wrapped program
// goes to the column engine, an indexed one to the exact sweeper.
import { describe, it, expect, beforeEach } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { buildSimSetup, rodChuckFor, useSimSetupStore } from '@/store/simSetupStore';
import { createSimSession, type SimLoadOk } from '@/workers/sim/session';
import { flatEndMill } from '@/engine/cnc/tool';
import { useSettingsStore } from '@/store/settingsStore';

/** A wrapped file from our post's own dialect: the ROTARY record states the radius. */
const WRAPPED_POSTED = [
  ';@CM|TOOL|key=flat-3.175x12-metal',
  ';@CM|ROTARY|radius=10',
  'S1000 M3',
  'G0 X5 Y0 Z13 A0',
  'G1 Z5 F100',
  'G1 X25 A360 F500',
  'G0 Z13',
].join('\n');

/** A vendor-style file: it moves A and states no radius. */
const VENDOR_A = ['S1000 M3', 'G0 X5 Y0 Z13 A0', 'G1 Z5 F100', 'G1 X25 A360 F500', 'G0 Z13'].join('\n');

const PLAIN = 'G0 X5 Y5 Z2\nG1 Z-0.5 F100\nG1 X20\nG0 Z2\n';

const rodStock = { length: 100, width: 20, thickness: 20, shape: 'rod' as const, diameter: 20 };

beforeEach(() => {
  useSimSetupStore.getState().reset();
  useSettingsStore.setState({ toolPicks: {} });
});

describe('#761 the Simulate form’s rod step', () => {
  it('offers a rod when the file moves A, with the diameter from its ROTARY record', () => {
    useSimSetupStore.getState().openFile('helix.nc', WRAPPED_POSTED);
    const s = useSimSetupStore.getState();
    expect(s.stock.shape).toBe('rod');
    expect(s.stock.diameter).toBe(20);
    // The box around the rod follows the diameter; the length is the form's own default.
    expect(s.stock.width).toBe(20);
    expect(s.stock.thickness).toBe(20);
    expect(s.stock.length).toBe(100);
    expect(s.stockSource.shape).toBe('header');
    expect(s.stockSource.diameter).toBe('header');
  });

  it('asks for the diameter when a vendor file moves A but states no radius', () => {
    useSimSetupStore.getState().openFile('vendor.nc', VENDOR_A);
    const s = useSimSetupStore.getState();
    expect(s.stock.shape).toBe('rod');
    expect(s.stock.diameter).toBe(0);
    expect(s.stockSource.diameter).toBe('default');
  });

  it('edits the diameter as one fact: the rod’s box moves with it', () => {
    useSimSetupStore.getState().openFile('vendor.nc', VENDOR_A);
    useSimSetupStore.getState().setStock({ diameter: 50 });
    const s = useSimSetupStore.getState();
    expect(s.stock.diameter).toBe(50);
    expect(s.stock.width).toBe(50);
    expect(s.stock.thickness).toBe(50);
    expect(s.stockSource.diameter).toBe('user');
  });

  it('a later flat file returns the form to the prism it was', () => {
    useSimSetupStore.getState().openFile('helix.nc', WRAPPED_POSTED);
    useSimSetupStore.getState().openFile('plain.nc', PLAIN);
    const s = useSimSetupStore.getState();
    expect(s.stock.shape).toBeUndefined();
    expect(s.stock.diameter).toBeUndefined();
    expect(s.stockSource.shape).toBeUndefined();
    expect(s.stockSource.diameter).toBeUndefined();
  });
});

describe('#761 buildSimSetup: a rod in the chuck', () => {
  it('builds a cylinder part with the Holding step’s stick-out, not a prism', () => {
    const setup = buildSimSetup(rodStock);
    expect(setup.part).toEqual({ kind: 'cylinder', diameter: 20, length: 100 });
    // The shop's grip fallback is 15 mm, so a 100 mm rod leaves an 85 mm stick-out, tailstock in.
    expect(setup.workholding).toEqual({ kind: 'rotary-chuck', jawDiameter: 20, stickout: 85 });
    const chuck = rodChuckFor(rodStock);
    expect(chuck.tailstock).toBe(true);
    expect(chuck.stickout).toBe(85);
  });

  it('refuses a rod whose diameter the form has not been given', () => {
    expect(() => buildSimSetup({ ...rodStock, diameter: 0 })).toThrow(/diameter above 0 mm/);
  });
});

describe('#761 the session routes through the form’s rod setup', () => {
  it('a wrapped program goes to the column engine', () => {
    const s = createSimSession(tl);
    const r = s.load(WRAPPED_POSTED, buildSimSetup(rodStock), flatEndMill(3.175), null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ok = r as SimLoadOk;
    expect(ok.summary.rotaryClass).toBe('wrapped');
    expect(ok.stats.engine).toBe('column');
    expect(ok.meshes.stock.triangleCount).toBeGreaterThan(0);
    s.dispose();
  });

  it('an indexed program goes to the exact sweeper', () => {
    const INDEXED = [
      'S1000 M3',
      'G0 X5 Y0 Z15 A0',
      'G1 Z9 F200',
      'G1 X25 F800',
      'G0 Z15',
      'G0 A180',
      'G1 Z9 F200',
      'G1 X5 F800',
      'G0 Z15',
    ].join('\n');
    const s = createSimSession(tl);
    // The exact sweeper is the #241 engine for a face held at a constant A; a ⌀10 flat covers the
    // face's chord so the sweep has a cut to take.
    const wide = flatEndMill(10, { shoulderLength: 20, fluteLength: 15 });
    const r = s.load(INDEXED, buildSimSetup(rodStock), wide, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ok = r as SimLoadOk;
    expect(ok.summary.rotaryClass).toBe('indexed');
    expect(ok.stats.engine).toBe('exact');
    s.dispose();
  });
});
