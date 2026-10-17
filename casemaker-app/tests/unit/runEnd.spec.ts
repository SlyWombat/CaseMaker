// #414 — the end of a run: the leftover rectangle and the offcut (Q3), the cutting time from the
// program, which copy it goes to, and the run store's hook — once per run, only on a real finish.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyInMachine,
  cutsOnStock,
  largestLeftover,
  offcutOffer,
  programCuts,
  runtimeOf,
  separatedLeftover,
  wearClassFor,
  wearKey,
  weighRuntime,
  withRuntime,
  type CutSegment,
} from '@/engine/cnc/runEnd';
import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleClient } from '@/platform/machineConsole';
import { ToolCopySchema, type ToolCopy } from '@/engine/cnc/toolCondition';
import { ShopDefaultsSchema, readDefault } from '@/platform/defaultsClient';
import { StockItemSchema, type StockItem } from '@/platform/stockClient';
import type { InventoryItem } from '@/platform/houseClient';
import { programHash, type RunOutcome } from '@/platform/machineRun';
import { endOfRun, machineKey, resetMachineRunStore, setRunEndIO, useMachineRunStore, type RunContext, type RunEndIO } from '@/store/machineRunStore';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown; stock: unknown[] };
const DEFAULTS = ShopDefaultsSchema.parse(DOC.defaults);
const PLATE: StockItem = StockItemSchema.parse(DOC.stock[0]); // 100 × 100 × 5 aluminium, job-1 holds one

/** A slot down X = 30, full depth of the stock in Y, 0.5 mm deep, at F600; then a pocket line. */
const NC = ['G90 G21', 'T1 M6', 'G53 G0 Z-3', 'S12000 M3', 'G0 X30 Y0', 'G0 Z1', 'G1 Z-0.5 F600', 'G1 X30 Y100 F600', 'G0 Z5', 'M5', 'M2'].join('\n');
const HEAD = ['G90 G21', 'T1 M6', 'G53 G0 Z-3', 'S12000 M3'];
const TAIL = ['G0 Z5', 'M5', 'M2'];
/** A closed square profile cut through the 5 mm plate at Z −5.2 — a part cut free. `gap` leaves a tab. */
function profile(x0: number, y0: number, x1: number, y1: number, gap = false): string {
  const path = [`G0 X${x0} Y${y0}`, 'G0 Z1', 'G1 Z-5.2 F300', `G1 X${x1} Y${y0} F600`, `G1 X${x1} Y${y1}`, `G1 X${x0} Y${y1}`];
  if (gap) path.push(`G1 X${x0} Y${y0 + 10}`, 'G0 Z1', `G0 X${x0} Y${y0 + 4}`, 'G1 Z-5.2 F300', `G1 X${x0} Y${y0}`);
  else path.push(`G1 X${x0} Y${y0}`);
  return [...HEAD, ...path, ...TAIL].join('\n');
}
const CUT_OUT = profile(20, 20, 50, 50);

describe('#414 the program: where it cut, and for how long', () => {
  it('reads the cutting footprint and the cutting-feed minutes', () => {
    const c = programCuts(NC);
    expect(c.segments).toEqual([
      { from: [30, 0], to: [30, 0], lowZ: -0.5 },
      { from: [30, 0], to: [30, 100], lowZ: -0.5 },
    ]);
    expect(c.unplaced).toBe(0);
    expect(c.tools).toEqual([1]);
    // 1.5 mm plunge + 100 mm at 600 mm/min = 101.5 / 600 min.
    expect(c.feedMinutes).toBeCloseTo(101.5 / 600, 6);
    expect(runtimeOf(c, 30)?.source).toBe('program-feeds');
    expect(runtimeOf(c, 30)?.note).toContain('rapids and homing included');
  });

  it('times an arc along its length, and counts a plunge after a G53 retract as placed but not timed', () => {
    const arc = programCuts([...HEAD, 'G0 X10 Y0', 'G0 Z1', 'G1 Z-0.5 F600', 'G3 X0 Y10 I-10 J0 F600', ...TAIL].join('\n'));
    // 1.5 mm plunge + a quarter circle of radius 10 (15.708 mm) at 600 mm/min.
    expect(arc.feedMinutes).toBeCloseTo((1.5 + (Math.PI * 10) / 2) / 600, 3);
    const afterG53 = programCuts([...HEAD, 'G0 X10 Y10', 'G53 G0 Z-3', 'G1 Z-0.5 F300', 'G1 X20 Y10 F600', ...TAIL].join('\n'));
    expect(afterG53).toMatchObject({ unplaced: 0, untimed: 1 });
    expect(afterG53.segments[0]).toMatchObject({ from: [10, 10], to: [10, 10] });
    expect(runtimeOf(afterG53, 10)?.note).toContain('1 plunge(s) from an unplaced height not timed');
    // A cutting move from an XY the program never placed is counted as unplaced, and the program not trusted.
    const blind = programCuts(['G90 G21', 'S12000 M3', 'G1 Z-0.5 F300', 'G1 X20 Y10 F600', ...TAIL].join('\n'));
    expect(blind.unplaced).toBeGreaterThan(0);
    expect(runtimeOf(blind, 60)).toMatchObject({ source: 'run-elapsed', note: expect.stringContaining('no known position') });
  });

  it('weights the minutes by the material, from the shop’s chosen weights', () => {
    const reading = runtimeOf(programCuts(NC), 30)!;
    const w = readDefault(DEFAULTS, 'tools.wearWeight.aluminium');
    expect(w).toEqual({ value: 3, source: 'seeded' });
    const al = weighRuntime(reading, 'aluminium-6061', w);
    expect(al.minutes).toBeCloseTo(reading.minutes * 3, 9);
    expect(al.note).toContain('× 3 for aluminium-6061 (aluminium, seeded — tools.wearWeight.aluminium)');
    expect(readDefault(DEFAULTS, 'tools.wearWeight.plastic').value).toBe(1);
    expect(weighRuntime(reading, null, null)).toMatchObject({ weight: 1, note: expect.stringContaining('unweighted') });
  });

  it('gives the fibre-filled nylons their own abrasive weight (#456)', () => {
    // PA-CF and PA-GF are the abrasive classes; unfilled PA is an ordinary plastic.
    expect(wearKey('pa-cf')).toBe('tools.wearWeight.abrasive');
    expect(wearKey('pa-gf')).toBe('tools.wearWeight.abrasive');
    expect(wearKey('pa')).toBe('tools.wearWeight.plastic');

    const w = readDefault(DEFAULTS, 'tools.wearWeight.abrasive');
    expect(w).toEqual({ value: 5, source: 'seeded' });
    expect(DEFAULTS['tools.wearWeight.abrasive']?.note).toContain('chosen, not measured');

    const reading = runtimeOf(programCuts(NC), 30)!;
    const gf = weighRuntime(reading, 'pa-gf', w);
    expect(gf.minutes).toBeCloseTo(reading.minutes * 5, 9);
    expect(gf.note).toContain('× 5 for pa-gf (abrasive, seeded — tools.wearWeight.abrasive)');
  });

  it('weights a filled base plastic by its fibre flag (#464)', () => {
    // PET-CF is a `pet` blank — the app has no `pet-cf` material. The base alone is an ordinary
    // plastic; the flag is the whole reason the minute is abrasive, whatever plastic carries it.
    expect(wearClassFor('pet')).toBe('plastic');
    expect(wearClassFor('pet', 'cf')).toBe('abrasive');
    expect(wearClassFor('pc', 'cf')).toBe('abrasive');
    expect(wearClassFor('petg', 'gf')).toBe('abrasive');
    expect(wearKey('pet')).toBe('tools.wearWeight.plastic');
    expect(wearKey('pet', 'cf')).toBe('tools.wearWeight.abrasive');
    expect(wearKey('petg', 'gf')).toBe('tools.wearWeight.abrasive');

    const reading = runtimeOf(programCuts(NC), 30)!;
    const w = readDefault(DEFAULTS, 'tools.wearWeight.abrasive');
    const cf = weighRuntime(reading, 'pet', w, 'cf');
    expect(cf.minutes).toBeCloseTo(reading.minutes * 5, 9);
    expect(cf.note).toContain('× 5 for pet (carbon fibre, abrasive, seeded — tools.wearWeight.abrasive)');
  });

  it('falls back to the run’s elapsed time, said so, when a cutting move has no feed', () => {
    const noFeed = programCuts(NC.replace('G1 Z-0.5 F600', 'G1 Z-0.5').replace('G1 X30 Y100 F600', 'G1 X30 Y100'));
    expect(noFeed.feedMinutes).toBeNull();
    expect(runtimeOf(noFeed, 120)).toMatchObject({ minutes: 2, source: 'run-elapsed', note: expect.stringContaining('includes rapids') });
    expect(runtimeOf(noFeed, null)).toBeNull();
  });
});

describe('#414 the leftover, and the offcut only when it has some size to it (Q3)', () => {
  const minSide = readDefault(DEFAULTS, 'offcut.minSideMm');
  it('the minimum is the location’s, seeded 20 and labelled chosen', () => {
    expect(minSide).toEqual({ value: 20, source: 'seeded' });
    expect(DEFAULTS['offcut.minSideMm']?.note).toContain('chosen, not measured');
  });

  it('the largest rectangle never touches a cut', () => {
    const slot: CutSegment[] = [{ from: [30, 0], to: [30, 100] }];
    const r = largestLeftover({ x: 100, y: 100 }, slot, 1.5)!;
    // Right of the slot: from 31.5 (rounded toward the cut) to 100.
    expect(r.x).toBeGreaterThanOrEqual(31.5);
    expect(r.x).toBeLessThan(32.5);
    expect(r.x + r.length).toBe(100);
    expect(r).toMatchObject({ y: 0, width: 100 });
    expect(largestLeftover({ x: 100, y: 100 }, [], 1)).toEqual({ x: 0, y: 0, length: 100, width: 100 });
    // A cut everywhere: nothing.
    const raster: CutSegment[] = Array.from({ length: 51 }, (_, i) => ({ from: [0, i * 2], to: [100, i * 2] }));
    expect(largestLeftover({ x: 100, y: 100 }, raster, 1.5)).toBeNull();
  });

  it('proposes an offcut above the minimum and none below it', () => {
    const base = { parent: PLATE, stockXY: { x: 100, y: 100 }, toolRadius: 1.5, minSideMm: 20, jobId: 'job-1', id: 'stock-off1', at: '2026-10-16T12:00:00.000Z' };
    const offer = offcutOffer({ ...base, cuts: programCuts(CUT_OUT) });
    if (offer.kind !== 'offer') throw new Error(offer.reason);
    expect(offer.item).toMatchObject({ source: 'offcut', quantity: 1, material: 'aluminium-6061', form: 'plate', reservations: [], consumed: [] });
    // The part (20..50 square) is cut free; the frame around it is the leftover: right of X 51.5, full depth.
    expect(offer.item.size.length).toBe(100);
    expect(offer.item.size.width).toBeGreaterThan(48);
    expect(offer.item.size.width).toBeLessThan(48.5);
    expect(offer.item.size.thickness).toBe(5);
    expect(offer.item.notes).toContain('job-1');
    expect(StockItemSchema.safeParse(offer.item).success).toBe(true);
    // Slots every 15 mm leave nothing 20 mm wide: none, with the size it found.
    // A part cut out of a plate only a little bigger leaves strips under 20 mm: none, with the size.
    const small = offcutOffer({ ...base, stockXY: { x: 40, y: 40 }, cuts: programCuts(profile(12, 12, 28, 28)) });
    expect(small).toMatchObject({ kind: 'none', reason: expect.stringContaining('under the 20 mm smallest offcut') });
  });

  describe('only when the cuts divide the stock into at least two pieces (the maintainer, 2026-10-16)', () => {
    const base = { parent: PLATE, stockXY: { x: 100, y: 100 }, toolRadius: 1.5, minSideMm: 20, jobId: 'job-1', id: 'x', at: 'now' };
    const ONE_PIECE = 'did not divide it into two pieces';

    it('a drilled through-hole: one piece with a hole in it, no offer', () => {
      const drill = [...HEAD, 'G0 X50 Y50', 'G0 Z1', 'G1 Z-5.5 F200', 'G0 Z5', 'G0 X20 Y80', 'G0 Z1', 'G1 Z-5.5 F200', ...TAIL].join('\n');
      expect(offcutOffer({ ...base, cuts: programCuts(drill) })).toMatchObject({ kind: 'none', reason: expect.stringContaining(ONE_PIECE) });
    });

    it('a cleared through-pocket, or a slot that separates nothing: no offer', () => {
      const pocket = [...HEAD, 'G0 X20 Y20', 'G0 Z1', 'G1 Z-5.2 F300'];
      for (let y = 20; y <= 50; y += 2) pocket.push(`G1 X50 Y${y} F600`, `G1 X20 Y${y + 1}`);
      pocket.push(...TAIL);
      expect(offcutOffer({ ...base, cuts: programCuts(pocket.join('\n')) })).toMatchObject({ kind: 'none', reason: expect.stringContaining(ONE_PIECE) });
      const slot = [...HEAD, 'G0 X20 Y50', 'G0 Z1', 'G1 Z-5.2 F300', 'G1 X80 Y50 F600', ...TAIL].join('\n');
      expect(offcutOffer({ ...base, cuts: programCuts(slot) })).toMatchObject({ kind: 'none', reason: expect.stringContaining(ONE_PIECE) });
      // A profile with a tab left in it holds the part on: still one piece.
      expect(offcutOffer({ ...base, cuts: programCuts(profile(20, 20, 50, 50, true)) })).toMatchObject({ kind: 'none', reason: expect.stringContaining(ONE_PIECE) });
      // Engraving only: nothing went through at all.
      expect(offcutOffer({ ...base, cuts: programCuts(NC) })).toMatchObject({ kind: 'none', reason: expect.stringContaining('still one piece') });
    });

    it('a profile cut-out that splits the stock, leftover above the minimum: offered', () => {
      expect(separatedLeftover({ x: 100, y: 100 }, programCuts(CUT_OUT).segments, 1.5, -5)).toMatchObject({ ok: true, pieces: 2 });
      expect(offcutOffer({ ...base, cuts: programCuts(CUT_OUT) }).kind).toBe('offer');
    });

    it('the same split with the leftover below the minimum: none', () => {
      expect(offcutOffer({ ...base, stockXY: { x: 40, y: 40 }, cuts: programCuts(profile(12, 12, 28, 28)) })).toMatchObject({
        kind: 'none',
        reason: expect.stringContaining('under the 20 mm smallest offcut'),
      });
    });

    it('a cut edge to edge is two pieces: offered from the one that is not the part, when the job says where its part is', () => {
      const split = [...HEAD, 'G0 X30 Y0', 'G0 Z1', 'G1 Z-5.2 F300', 'G1 X30 Y100 F600', ...TAIL].join('\n');
      expect(offcutOffer({ ...base, cuts: programCuts(split) })).toMatchObject({ kind: 'none', reason: expect.stringContaining('does not say which one is its part') });
      const offer = offcutOffer({ ...base, cuts: programCuts(split), partAt: { x: 15, y: 50 } });
      if (offer.kind !== 'offer') throw new Error(offer.reason);
      // The part is the left 30 mm; the scrap is right of X 31.5.
      expect(offer.leftover.x).toBeGreaterThanOrEqual(31.5);
      expect(offer.item.size).toMatchObject({ length: 100 });
    });
  });

  it('refuses when the cuts are not on the stock as given', () => {
    const shifted = profile(120, 20, 150, 50);
    expect(cutsOnStock({ x: 100, y: 100 }, programCuts(shifted).segments, 1.5)).toContain('outside the 100 × 100 mm stock');
    expect(cutsOnStock({ x: 100, y: 100 }, programCuts(CUT_OUT).segments, 1.5)).toBeNull();
    // A cut along the very edge (centre on the edge) is on the stock.
    const edge = [...HEAD, 'G0 X0 Y0', 'G0 Z1', 'G1 Z-1 F300', 'G1 X100 Y0 F600', ...TAIL].join('\n');
    expect(cutsOnStock({ x: 100, y: 100 }, programCuts(edge).segments, 1.5)).toBeNull();
    const r = largestLeftover({ x: 100, y: 100 }, programCuts(edge).segments, 1.5)!;
    expect(r.y).toBeGreaterThanOrEqual(1.5);
    expect(r.y + r.width).toBe(100);
  });

  it('no offcut for a rod, or when the footprint is not known', () => {
    const rod = StockItemSchema.parse({ ...PLATE, form: 'rod', size: { diameter: 10, length: 100 }, reservations: [] });
    expect(offcutOffer({ parent: rod, stockXY: { x: 100, y: 10 }, cuts: programCuts(NC), toolRadius: 1, minSideMm: 20, jobId: 'j', id: 'x', at: 'now' })).toMatchObject({ kind: 'none' });
    const blind = { ...programCuts(NC), unplaced: 2 };
    expect(offcutOffer({ parent: PLATE, stockXY: { x: 100, y: 100 }, cuts: blind, toolRadius: 1, minSideMm: 20, jobId: 'j', id: 'x', at: 'now' })).toMatchObject({ kind: 'none', reason: expect.stringContaining('no known position') });
  });
});

describe('#414 which copy the runtime goes to', () => {
  const copy = (id: string, machine: string | null): ToolCopy =>
    ToolCopySchema.parse({ id, condition: 'used', whereabouts: machine ? { kind: 'machine', machineId: machine } : { kind: 'box' } });
  const items = [
    { id: 'kz-a', copies: [copy('a1', 'm-1'), copy('a2', null)] },
    { id: 'kz-b', copies: [copy('b1', null)] },
  ];

  it('the one copy in this machine, or a refusal — never a guess', () => {
    expect(copyInMachine(items, 'm-1')).toEqual({ ok: true, itemId: 'kz-a', copyId: 'a1' });
    expect(copyInMachine(items, 'm-2')).toMatchObject({ ok: false, reason: expect.stringContaining('no cutter copy') });
    expect(copyInMachine(items, 'm-1', 'inv:kz-b')).toMatchObject({ ok: false, reason: expect.stringContaining('the job’s cutter is kz-b') });
    const two = [...items, { id: 'kz-c', copies: [copy('c1', 'm-1')] }];
    expect(copyInMachine(two, 'm-1')).toMatchObject({ ok: false });
  });

  it('adds to the copy’s counted runtime; the field round-trips and is bounded', () => {
    const once = withRuntime(items[0]!, 'a1', 1.25);
    const twice = withRuntime(once, 'a1', 0.5);
    expect(twice.copies[0]!.runtimeMinutes).toBe(1.75);
    expect(twice.copies[1]!.runtimeMinutes).toBeNull();
    expect(ToolCopySchema.parse(twice.copies[0]).runtimeMinutes).toBe(1.75);
    expect(ToolCopySchema.safeParse({ ...twice.copies[0], runtimeMinutes: -1 }).success).toBe(false);
  });
});

describe('#414 the run store: once per run, and only on a real finish', () => {
  const TARGET = { host: '192.0.2.10', port: 2222 };
  const M = machineKey(TARGET);
  const calls: string[] = [];
  const item = (copies: ToolCopy[]): InventoryItem => ({ id: 'kz-a', copies, tool: { name: '3.175 flat' } }) as unknown as InventoryItem;
  let inventory: InventoryItem[] = [];
  let shelfLoaded = true;
  let offer = true;
  let runningAtWrite: (boolean | undefined)[] = [];
  const io: RunEndIO = {
    refreshStock: async () => {
      calls.push('refresh');
      shelfLoaded = true;
    },
    stockItem: (id) => (shelfLoaded && id === PLATE.id ? PLATE : null),
    consume: async (e, j) => (runningAtWrite.push(useMachineRunStore.getState().runs[M]?.running), calls.push(`consume ${e} ${j}`), { ok: true, text: '' }),
    addOffcut: async (i) => (calls.push(`add ${i.id}`), { ok: true, text: '' }),
    inventory: () => inventory,
    updateItem: async (i) => (runningAtWrite.push(useMachineRunStore.getState().runs[M]?.running), calls.push(`runtime ${i.copies[0]?.runtimeMinutes}`), { ok: true, text: '' }),
    machineIdFor: () => 'm-1',
    recordFinishedProgram: async (machineId, hash) => (calls.push(`finished ${machineId} ${hash}`), { ok: true, added: true, text: '' }),
    minSideMm: () => 20,
    offerOffcuts: () => offer,
    wearWeight: (key) => readDefault(DEFAULTS, key),
    newId: () => 'stock-off1',
    now: () => '2026-10-16T12:00:00.000Z',
  };
  const ctx: RunContext = { nc: CUT_OUT, jobId: 'job-1', stockEntryId: PLATE.id, stockXY: { x: 100, y: 100 }, toolRadius: 1.5, toolKey: 'inv:kz-a' };
  const last = { state: 'Idle', line: 9, percent: 100, elapsedS: 30 };
  const finished: RunOutcome = { kind: 'finished', last, homed: true, vacuumOff: true };
  /** The cut-out's cutting minutes × aluminium's 3, rounded as `withRuntime` stores them. */
  const cutMinutes = programCuts(CUT_OUT).feedMinutes!;
  const stored = Math.round(cutMinutes * 3 * 1000) / 1000;
  const entry = (over: Partial<ReturnType<typeof useMachineRunStore.getState>['runs'][string]> = {}) => ({
    running: false, filename: 'j.nc', programHash: 'h', progress: null, lines: [], outcome: finished, stopAsked: false, context: ctx, end: null, pendingStock: null, ...over,
  });

  beforeEach(() => {
    calls.length = 0;
    runningAtWrite = [];
    shelfLoaded = true;
    offer = true;
    inventory = [item([ToolCopySchema.parse({ id: 'a1', condition: 'used', whereabouts: { kind: 'machine', machineId: 'm-1' } })])];
    setRunEndIO(io);
    resetMachineRunStore();
  });
  afterEach(() => {
    setRunEndIO(null);
    setMachineConsoleLoader(null);
  });

  it('a finish refreshes the shelf, consumes the stock, adds the weighted runtime, and asks about the offcut', async () => {
    shelfLoaded = false; // the shelf store is loaded only by Manage › Materials
    const end = await endOfRun(TARGET, finished, ctx);
    expect(calls).toEqual([`finished m-1 ${programHash(CUT_OUT)}`, 'refresh', 'consume stock-plate1 job-1', `runtime ${stored}`]);
    expect(end.kind).toBe('finished');
    expect(end.offcut?.state).toBe('asked');
    expect(end.offcut?.text).toContain('left over from the cut-out');
    expect(end.lines.join(' ')).toContain('× 3 for aluminium-6061');
  });

  it('the run context’s fibre flag makes a base plastic’s minute abrasive (#464)', async () => {
    // The job's material is PET — a PETG-CF blank keeps its base — and the flag travels with it so
    // the runtime is weighted 5×, not the plastic 1×.
    const end = await endOfRun(TARGET, finished, { ...ctx, material: 'pet', fibre: 'cf' });
    expect(calls).toContain(`runtime ${Math.round(cutMinutes * 5 * 1000) / 1000}`);
    expect(end.lines.join(' ')).toContain('× 5 for pet (carbon fibre, abrasive, seeded — tools.wearWeight.abrasive)');
  });

  it('no stock entry: the shelf is left alone with a note; the runtime is still counted, unweighted', async () => {
    const end = await endOfRun(TARGET, finished, { nc: CUT_OUT });
    expect(calls).toEqual([`finished m-1 ${programHash(CUT_OUT)}`, `runtime ${Math.round(cutMinutes * 1000) / 1000}`]);
    expect(end.lines.join(' ')).toContain('No shelf entry is recorded');
    expect(end.lines.join(' ')).toContain('unweighted');
    expect(end.offcut).toBeNull();
  });

  it('an engrave-only finish consumes the stock but offers no offcut, and says why', async () => {
    const end = await endOfRun(TARGET, finished, { ...ctx, nc: NC });
    expect(end.offcut).toBeNull();
    expect(end.lines.join(' ')).toContain('still one piece');
  });

  it('a stop asks whether the stock was used, and changes nothing until answered', async () => {
    const stopped = await endOfRun(TARGET, { kind: 'aborted', stop: { kind: 'stopped' } as never, last }, ctx);
    expect(stopped).toMatchObject({ kind: 'stopped', stockQuestion: 'ask', offcut: null });
    expect(calls).toEqual([]);
  });

  it('an alarm or an unreachable machine changes nothing', async () => {
    for (const o of [
      { kind: 'alarm', alarm: 'ALARM:1', last },
      { kind: 'unreachable', last, misses: 3 },
      { kind: 'refused', reason: 'busy' },
    ] as RunOutcome[]) {
      expect((await endOfRun(TARGET, o, ctx)).kind).toBe('nothing');
    }
    expect(calls).toEqual([]);
  });

  it('offcut.offer false: no offer at all, said so', async () => {
    offer = false;
    const end = await endOfRun(TARGET, finished, ctx);
    expect(end.offcut).toBeNull();
    expect(end.lines.join(' ')).toContain('offcut offers turned off (offcut.offer)');
    expect(calls.some((c) => c.startsWith('add'))).toBe(false);
  });

  it('“Ignore scrap” on this run: no offer kept and no shelf change', async () => {
    const end = await endOfRun(TARGET, finished, ctx);
    useMachineRunStore.setState({ runs: { [M]: entry({ end }) } });
    calls.length = 0;
    useMachineRunStore.getState().skipOffcut(M);
    await useMachineRunStore.getState().keepOffcut(M);
    expect(calls).toEqual([]);
    const after = useMachineRunStore.getState().runs[M]!.end!;
    expect(after.offcut!.state).toBe('skipped');
    expect(after.lines.join(' ')).toContain('Scrap ignored');
  });

  it('the offcut is kept once; dismissing skips it', async () => {
    const end = await endOfRun(TARGET, finished, ctx);
    calls.length = 0;
    useMachineRunStore.setState({ runs: { [M]: entry({ end }) } });
    await useMachineRunStore.getState().keepOffcut(M);
    await useMachineRunStore.getState().keepOffcut(M);
    useMachineRunStore.getState().skipOffcut(M);
    expect(calls).toEqual(['add stock-off1']);
    expect(useMachineRunStore.getState().runs[M]!.end!.offcut!.state).toBe('kept');
    useMachineRunStore.setState({ runs: { [M]: entry({ end }) } });
    calls.length = 0;
    useMachineRunStore.getState().skipOffcut(M);
    await useMachineRunStore.getState().keepOffcut(M);
    expect(calls).toEqual([]);
  });

  it('a stopped run’s question is answered once, and survives the next upload unanswered', async () => {
    useMachineRunStore.setState({ runs: { [M]: entry({ pendingStock: { entryId: PLATE.id, jobId: 'job-1' } }) } });
    // A new upload to the same machine keeps the open question.
    useMachineRunStore.getState().prepare(TARGET, 'next.nc', 'h2', { nc: NC });
    expect(useMachineRunStore.getState().runs[M]!.pendingStock).toEqual({ entryId: PLATE.id, jobId: 'job-1' });
    await useMachineRunStore.getState().answerStockUsed(M, true);
    await useMachineRunStore.getState().answerStockUsed(M, true);
    expect(calls).toEqual(['consume stock-plate1 job-1']);
    useMachineRunStore.setState({ runs: { [M]: entry({ pendingStock: { entryId: PLATE.id, jobId: 'job-1' } }) } });
    calls.length = 0;
    await useMachineRunStore.getState().answerStockUsed(M, false);
    expect(calls).toEqual([]);
    expect(useMachineRunStore.getState().runs[M]!.end!.lines.join(' ')).toContain('stays reserved for job-1');
  });

  it('a failed or busy runtime save is reported, not retried', async () => {
    setRunEndIO({ ...io, updateItem: async () => (calls.push('runtime-attempt'), { ok: false, text: 'another save to the inventory (update-item) was still in progress' }) });
    const end = await endOfRun(TARGET, finished, ctx);
    expect(calls.filter((c) => c === 'runtime-attempt')).toHaveLength(1);
    expect(end.lines.join(' ')).toContain('NOT added');
    expect(end.lines.join(' ')).toContain('still in progress');
  });

  /** A controller: Idle before play; one Run poll; then Idle at 100 % — or an alarm. */
  function z1(after: 'finish' | 'alarm'): MachineConsoleClient {
    let played = false;
    let polls = 0;
    return {
      async open() {
        return {
          async send(line: string): Promise<ConsoleSend> {
            let text = 'ok';
            if (line === '?') {
              if (!played) text = '<Idle|MPos:0,0,0>';
              else if (polls++ < 1) text = '<Run|MPos:0,0,0|P:10,20,5>';
              else text = after === 'alarm' ? '<Alarm|MPos:0,0,0>\nALARM: Hard limit' : '<Idle|P:30,100,30>';
            } else if (line.startsWith('play')) {
              played = true;
              text = 'File size 10';
            }
            return { ok: true, line, text, frames: 1, elapsedMs: 1 };
          },
          async close() {
            calls.push('closed');
          },
        };
      },
    };
  }

  it('end to end through start(): the run is over (session closed, not running) before the end-of-run saves', async () => {
    setMachineConsoleLoader(async () => z1('finish'));
    useMachineRunStore.getState().prepare(TARGET, 'job.nc', programHash(ctx.nc), ctx);
    expect(useMachineRunStore.getState().start(TARGET, { pollMs: 2000, noProgressMs: 30000, missLimit: 3 })).toBe(true);
    await waitForEnd();
    const run = useMachineRunStore.getState().runs[M]!;
    expect(run.outcome?.kind).toBe('finished');
    expect(run.end?.kind).toBe('finished');
    // The persisted key is the program's own FNV hash (#419 §4.5) — what the upload computed and
    // what the plan will compare against.
    expect(calls).toContain(`finished m-1 ${programHash(ctx.nc)}`);
    expect(calls.indexOf('closed')).toBeLessThan(calls.indexOf('consume stock-plate1 job-1'));
    expect(runningAtWrite).toEqual([false, false]);
    expect(calls.filter((c) => c.startsWith('consume'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('runtime'))).toHaveLength(1);
  }, 20000);

  it('end to end: an alarm changes nothing', async () => {
    setMachineConsoleLoader(async () => z1('alarm'));
    useMachineRunStore.getState().prepare(TARGET, 'job.nc', 'h', ctx);
    useMachineRunStore.getState().start(TARGET, { pollMs: 2000, noProgressMs: 30000, missLimit: 3 });
    await waitForEnd();
    expect(useMachineRunStore.getState().runs[M]!.end?.kind).toBe('nothing');
    expect(calls.filter((c) => c !== 'closed')).toEqual([]);
  }, 20000);

  async function waitForEnd(): Promise<void> {
    for (let i = 0; i < 150; i++) {
      if (useMachineRunStore.getState().runs[M]?.end) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the run did not end: ${JSON.stringify(useMachineRunStore.getState().runs[M]?.outcome)}`);
  }
});
