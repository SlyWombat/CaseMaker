// #428 phase 1 — the setups engine: grouping by direction, override, the carried stock (facing
// included), the per-setup checks, the mount steps (proper rotations, landmark words, the mirror
// check) and registration after a remount via #430's planner.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { registrationSettings } from '@/engine/cnc/registration';
import { Z1 } from '@/engine/cnc/machine';
import {
  FACES,
  checkRemountAnswer,
  det,
  describeRemount,
  editSetups,
  orient,
  planSetups,
  registrationFor,
  setupsSettings,
  type Removal,
  type SetupsInput,
} from '@/engine/cnc/setups';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = ShopDefaultsSchema.parse((JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults);
const S = setupsSettings(DEFAULTS);
/** The machine's own travel height, MACHINE Z — required on every registration input, never defaulted (#448). */
const Z1_CLEARANCE_Z = Z1.toolChange.clearanceZ;

/** A 100 × 60 × 10 plate (X × Y × Z). */
const STOCK = { x: 100, y: 60, z: 10 };
const pocket: Removal = { id: 'pocket', name: 'pocket A', volume: 1000, box: { min: [30, 20, 6], max: [70, 40, 10] }, opensTo: ['top'] };
const holes: Removal = { id: 'holes', name: 'the four holes', volume: 200, box: { min: [10, 10, 0], max: [20, 50, 10] }, opensTo: ['top', 'bottom'] };
const chamfer: Removal = { id: 'chamfer', name: 'back chamfer', volume: 100, box: { min: [40, 20, 0], max: [60, 40, 2] }, opensTo: ['bottom'] };
const sideSlot: Removal = { id: 'slot', name: 'side slot', volume: 50, box: { min: [0, 20, 3], max: [5, 40, 7] }, opensTo: ['left'] };

const input = (over: Partial<SetupsInput> = {}): SetupsInput => ({
  stock: STOCK,
  removals: [pocket, holes, chamfer],
  mount: { kind: 'bracket', board: true },
  rotaryEnvelope: Z1.rotary?.envelope,
  ...over,
});

describe('#428 orientations are turns, never mirror images', () => {
  it('every orientation orient() returns has det +1, for every face and mount', () => {
    for (const kind of ['vise', 'bracket', 'tape'] as const) {
      for (const up of FACES) {
        const o = orient(up, { kind, viseOpeningMm: 500 }, STOCK);
        if (o.ok) expect(det(o.matrix), `${kind} ${up}`).toBe(1);
      }
    }
  });

  it('left up on the vise puts the top on the MOVING jaw, and keeps the front at the front', () => {
    const o = orient('left', { kind: 'vise' }, STOCK);
    if (!o.ok) throw new Error(o.reason);
    expect(o.orientation.top).toBe('left');
    expect(o.orientation.right).toBe('top');
    expect(o.orientation.left).toBe('bottom');
    expect(o.orientation.front).toBe('front');
    const r = orient('right', { kind: 'vise' }, STOCK);
    expect(r.ok && r.orientation.left).toBe('top'); // right up: the top faces the fixed jaw
  });
});

describe('#428 grouping, order, lost and unholdable', () => {
  it('groups greedily by volume; a through feature joins the first', () => {
    const plan = planSetups(input(), S);
    expect(plan.setups.map((s) => [s.faceUp, s.itemIds])).toEqual([
      ['top', ['pocket', 'holes']],
      ['bottom', ['chamfer']],
    ]);
    expect(plan.unholdable).toEqual([]);
    expect(plan.lost).toEqual([]);
    expect(plan.rotaryOffer).toBeNull(); // a flip is not a rotary job
  });

  it('puts the face the operator chose up first, and tells them how to mount it', () => {
    const plan = planSetups(input({ firstUp: 'bottom' }), S);
    const first = plan.setups[0]!;
    expect(first.faceUp).toBe('bottom');
    expect(first.remount?.turnWords[0]).toContain('the face the design calls bottom UP');
    expect(describeRemount(first, plan.setups.length, { kind: 'bracket' })!.title).toBe('Mount for setup 1 of 2');
    expect(planSetups(input(), S).setups[0]!.remount).toBeNull(); // top up: mounted as supplied
  });

  it('reports a removal that opens to no face as lost, never drops it', () => {
    const nowhere: Removal = { ...pocket, id: 'inside', name: 'a void', opensTo: [] };
    const plan = planSetups(input({ removals: [pocket, nowhere] }), S);
    expect(plan.lost).toEqual([{ itemId: 'inside', reason: expect.stringContaining('opens to no face') }]);
    expect(plan.setups.flatMap((s) => s.itemIds)).toEqual(['pocket']);
  });

  it('a direction the mount cannot hold is unholdable; the rotary is offered only for two side directions', () => {
    const one = planSetups(input({ removals: [pocket, sideSlot], mount: { kind: 'tape', board: true } }), S);
    expect(one.unholdable).toEqual([{ face: 'left', reason: expect.stringContaining('tape cannot hold'), itemIds: ['slot'] }]);
    expect(one.rotaryOffer).toBeNull();
    const back: Removal = { ...sideSlot, id: 'back', name: 'back slot', opensTo: ['back'], box: { min: [40, 55, 3], max: [60, 60, 7] } };
    const two = planSetups(input({ removals: [pocket, sideSlot, back], mount: { kind: 'tape', board: true } }), S);
    expect(two.rotaryOffer).toContain('rotary');
  });

  it('the vise stands the stock on an edge only when the opening takes it', () => {
    expect(planSetups(input({ removals: [pocket, sideSlot], mount: { kind: 'vise', viseOpeningMm: 5 } }), S).unholdable[0]?.reason).toContain('opening');
    expect(planSetups(input({ removals: [pocket, sideSlot], mount: { kind: 'vise', viseOpeningMm: 120 } }), S).setups.map((s) => s.faceUp)).toEqual(['top', 'left']);
  });
});

describe('#428 the stock is carried, facing included', () => {
  it('setup 2 starts from setup 1’s cuts and its faced bounds', () => {
    const face: Removal = { id: 'face', name: 'facing', volume: 6000, box: { min: [0, 0, 9], max: [100, 60, 10] }, opensTo: ['top'], facing: true };
    const plan = planSetups(input({ removals: [face, chamfer], mount: { kind: 'vise', viseOpeningMm: 120 } }), S);
    const [one, two] = plan.setups;
    expect(one!.stockBefore.bounds.max[2]).toBe(10);
    expect(two!.stockBefore.bounds.max[2]).toBe(9); // a millimetre faced off the top
    expect(two!.stockBefore.cuts.map((c) => c.id)).toEqual(['face']);
    // The next registration expects the surface a millimetre lower: 9 mm tall now, not 10.
    const reg = registrationFor(two!, { kind: 'vise' }, { seatMachineZ: -66, seekFromMachineZ: Z1_CLEARANCE_Z, cornerRadius: 0 }, registrationSettings(DEFAULTS).settings);
    expect(reg.plan.ok && reg.plan.plan.seek.band).toEqual({ min: -57.4, max: -56.6 });
  });
});

describe('#428 checks per setup', () => {
  it('a clean plan raises nothing', () => {
    for (const s of planSetups(input({ mount: { kind: 'vise', viseOpeningMm: 120 } }), S).setups) expect(s.findings).toEqual([]);
  });

  it('vise: an earlier cut in a jaw face’s grip band, and one on the ledge strip, after the flip', () => {
    const edgeNotch: Removal = { id: 'notch', name: 'edge notch', volume: 300, box: { min: [0, 20, 8], max: [5, 40, 10] }, opensTo: ['top'] };
    const ledgeCut: Removal = { id: 'ledge', name: 'rim groove', volume: 250, box: { min: [0, 0, 9], max: [1.5, 60, 10] }, opensTo: ['top'] };
    const [one, two] = planSetups(input({ removals: [edgeNotch, ledgeCut, chamfer], mount: { kind: 'vise', viseOpeningMm: 120 } }), S).setups;
    expect(one!.findings).toEqual([]);
    const codes = two!.findings.map((f) => f.code);
    expect(codes).toContain('rests-on-cut');
    expect(codes).toContain('clamp-on-cut');
    expect(codes).not.toContain('cuts-clamped-face');
  });

  it('vise: this setup cutting into the grip band is `cuts-clamped-face`', () => {
    const low: Removal = { id: 'low', name: 'low step', volume: 500, box: { min: [0, 10, 0], max: [8, 50, 2] }, opensTo: ['top'] };
    expect(planSetups(input({ removals: [low], mount: { kind: 'vise' } }), S).setups[0]!.findings.map((f) => f.code)).toEqual(['cuts-clamped-face']);
  });

  it('tape: a flipped face that was cut rests on the cut, unless a board carries it', () => {
    expect(planSetups(input({ mount: { kind: 'tape' } }), S).setups[1]!.findings.map((f) => f.code)).toEqual(['rests-on-cut']);
    expect(planSetups(input({ mount: { kind: 'tape', board: true } }), S).setups[1]!.findings).toEqual([]);
  });

  it('stock too thin for the vise cannot seat — said in jaw terms — and the shop’s grip can ask for more than the ledge gives', () => {
    const thin = planSetups(input({ stock: { x: 100, y: 60, z: 2.5 }, removals: [pocket], mount: { kind: 'vise' } }), S);
    const seat = thin.setups[0]!.findings.find((f) => f.code === 'cannot-seat')!;
    expect(seat.text).toContain('below the jaw tops');
    const strict = planSetups(input({ mount: { kind: 'vise', viseOpeningMm: 120 } }), { ...S, minGripMm: 4 });
    expect(strict.setups[0]!.findings.map((f) => f.code)).toEqual(['thin-grip']);
  });
});

describe('#428 the mount steps', () => {
  it('the vise flip: landmark words, what stays first', () => {
    const two = planSetups(input({ mount: { kind: 'vise', viseOpeningMm: 120 } }), S).setups[1]!;
    expect(two.remount).toMatchObject({ kind: 'remount', needsDone: true, rotate: { about: 'x', degrees: 180 }, faceDown: 'top', faceAgainstReference: 'left' });
    expect(two.remount!.turnWords).toEqual([
      'Keep the edge on the fixed jaw where it is.',
      'Turn it so the edge now nearest you goes to the back.',
      'Turn it so the face now up goes DOWN.',
    ]);
  });

  it('the bracket flip is sideways, in landmark words', () => {
    const plan = planSetups(input(), S);
    const two = plan.setups[1]!;
    expect(two.remount!.rotate).toEqual({ about: 'y', degrees: 180 });
    expect(two.remount!.turnWords).toEqual([
      'Keep the edge nearest you where it is.',
      'Turn it so the edge now against the bracket’s long arm goes to the right.',
      'Turn it so the face now up goes DOWN.',
    ]);
    expect(describeRemount(two, 2, { kind: 'bracket' })!.title).toBe('Remount for setup 2 of 2');
  });

  it('a quarter turn onto an edge says which way, in landmarks', () => {
    const plan = planSetups(input({ removals: [pocket, sideSlot], mount: { kind: 'vise', viseOpeningMm: 120 } }), S);
    const side = plan.setups[1]!;
    expect(side.faceUp).toBe('left');
    expect(side.remount!.rotate).toEqual({ about: 'y', degrees: 90 });
    expect(side.remount!.turnWords).toEqual([
      'Keep the edge nearest you where it is.',
      'Turn it so the edge now on the fixed jaw comes UP.',
      'Turn it so the face now up goes onto the moving jaw.',
    ]);
  });

  it('asks about a lopsided landmark and refuses the mirror image; the right answer is not always first', () => {
    const two = planSetups(input({ mount: { kind: 'vise', viseOpeningMm: 120 } }), S).setups[1]!;
    const c = two.remount!.confirm!;
    expect(c.question).toContain('the four holes');
    expect(c.options[c.correct]).toContain('fixed jaw'); // the holes (X 10–20 of 100) stay near the fixed jaw
    expect(c.correct).toBe(0); // setup 2 puts it first, setup 3 second: never always the same slot
    expect(checkRemountAnswer(two.remount!, c.correct)).toEqual({ ok: true });
    expect(checkRemountAnswer(two.remount!, 1 - c.correct)).toMatchObject({ ok: false, reason: expect.stringContaining('mirror-image') });
  });

  it('a symmetric landmark asks nothing, and says plainly the mirror check is not possible', () => {
    // The pocket and a through hole both sit dead centre: from below, the hole is all there is to see.
    const centred: Removal = { id: 'c', name: 'centre hole', volume: 100, box: { min: [45, 25, 0], max: [55, 35, 10] }, opensTo: ['top', 'bottom'] };
    const back: Removal = { ...chamfer, box: { min: [45, 25, 0], max: [55, 35, 2] } };
    const plan = planSetups(input({ removals: [pocket, centred, back], mount: { kind: 'vise', viseOpeningMm: 120 } }), S);
    expect(plan.setups.map((s) => s.faceUp)).toEqual(['top', 'bottom']);
    const two = plan.setups[1]!;
    expect(two.remount!.confirm).toBeNull();
    expect(two.remount!.mirrorCheck).toContain('mirror image');
    expect(checkRemountAnswer(two.remount!, 0)).toEqual({ ok: true });
  });
});

describe('#471 per-setup mounts', () => {
  const mixed = (): SetupsInput =>
    input({
      mount: { kind: 'vise', viseOpeningMm: 120 },
      mounts: { bottom: { kind: 'bracket', board: true } },
    });

  it('setup 1 in the vise and setup 2 on the bracket, each checked against its own fixture', () => {
    const plan = planSetups(mixed(), S);
    expect(plan.setups.map((s) => [s.faceUp, s.mount.kind])).toEqual([
      ['top', 'vise'],
      ['bottom', 'bracket'],
    ]);
    // The stock is carried and the second setup's checks read the bracket, not the vise: no
    // `cannot-seat`/`thin-grip` from a vise that is not holding it.
    expect(plan.setups[1]!.findings.map((f) => f.code)).not.toContain('cannot-seat');
  });

  it('says the stock leaves one fixture for another, then turns it in the new one', () => {
    const two = planSetups(mixed(), S).setups[1]!;
    expect(two.remount!.turnWords[0]).toBe(
      'Take the stock out of the vise and put it in the bracket with the face that was up still up and its front edge nearest you, its left edge against the bracket’s long arm.',
    );
    // The turn is from the UNTURNED placement in the new fixture: no "keep the edge on the fixed
    // jaw", which is no longer holding anything.
    expect(two.remount!.turnWords.slice(1)).toEqual([
      'Keep the edge nearest you where it is.',
      'Turn it so the edge now against the bracket’s long arm goes to the right.',
      'Turn it so the face now up goes DOWN.',
    ]);
    expect(two.remount!.rotate).toEqual({ about: 'y', degrees: 180 });
  });

  it('a mount edit changes that setup only; the fixture-change words follow it', () => {
    const inp = input({ mount: { kind: 'bracket', board: true } });
    const plan = planSetups(inp, S);
    const edited = editSetups(inp, plan, [{ kind: 'mount', face: 'bottom', mount: { kind: 'vise', viseOpeningMm: 120 } }], S);
    if (!edited.ok) throw new Error(edited.reason);
    expect(edited.plan.setups.map((s) => [s.faceUp, s.mount.kind])).toEqual([
      ['top', 'bracket'],
      ['bottom', 'vise'],
    ]);
    expect(edited.plan.setups[1]!.remount!.turnWords[0]).toContain('Take the stock out of the bracket and put it in the vise');
  });

  it('refuses a mount edit for a face that is not a setup, and reports a mount that cannot hold it', () => {
    const inp = input({ mount: { kind: 'vise', viseOpeningMm: 120 }, removals: [pocket, sideSlot] });
    const plan = planSetups(inp, S);
    expect(editSetups(inp, plan, [{ kind: 'mount', face: 'back', mount: { kind: 'bracket' } }], S)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no back setup'),
    });
    // A side setup standing on an edge cannot be moved to the bracket: the direction becomes
    // `unholdable` with the engine's reason, and the items are not silently dropped.
    const moved = editSetups(inp, plan, [{ kind: 'mount', face: 'left', mount: { kind: 'bracket', board: true } }], S);
    if (!moved.ok) throw new Error(moved.reason);
    expect(moved.plan.setups.map((s) => s.faceUp)).toEqual(['top']);
    expect(moved.plan.unholdable).toEqual([{ face: 'left', reason: expect.stringContaining('bracket cannot hold'), itemIds: ['slot'] }]);
  });
});

describe('#428 the operator’s edits', () => {
  it('moves only to a face an item opens to; refuses merging a face into itself; merges, reorders, re-validates', () => {
    const inp = input();
    const plan = planSetups(inp, S);
    const moved = editSetups(inp, plan, [{ kind: 'move', itemId: 'holes', toFace: 'bottom' }], S);
    if (!moved.ok) throw new Error(moved.reason);
    expect(moved.plan.setups.map((s) => [s.faceUp, s.itemIds])).toEqual([
      ['top', ['pocket']],
      ['bottom', ['chamfer', 'holes']],
    ]);
    expect(editSetups(inp, plan, [{ kind: 'move', itemId: 'pocket', toFace: 'bottom' }], S)).toMatchObject({ ok: false });
    expect(editSetups(inp, plan, [{ kind: 'merge', from: 'bottom', into: 'top' }], S)).toMatchObject({ ok: false });
    expect(editSetups(inp, plan, [{ kind: 'merge', from: 'top', into: 'top' }], S)).toMatchObject({ ok: false, reason: expect.stringContaining('into itself') });
    const reordered = editSetups(inp, plan, [{ kind: 'reorder', faces: ['bottom', 'top'] }], S);
    expect(reordered.ok && reordered.plan.setups.map((s) => s.faceUp)).toEqual(['bottom', 'top']);
    expect(editSetups(inp, plan, [{ kind: 'reorder', faces: ['top'] }], S)).toMatchObject({ ok: false });
  });
});

describe('#428 registration after a remount', () => {
  it('the flip: #430’s plan for the new up face, and the through holes as a reference at the mirrored Y', () => {
    const inp = input({ mount: { kind: 'vise', viseOpeningMm: 120 } });
    const two = planSetups(inp, S).setups[1]!;
    const { plan, references } = registrationFor(two, inp.mount, { seatMachineZ: -66, seekFromMachineZ: Z1_CLEARANCE_Z, cornerRadius: 0 }, registrationSettings(DEFAULTS).settings);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.plan.seek.band).toEqual({ min: -56.4, max: -55.6 });
    expect(references).toEqual([{ itemId: 'holes', name: 'the four holes', at: { x: 15, y: 30 } }]);
  });

  it('a side setup: references and dimensions in the turned frame', () => {
    const notch: Removal = { id: 'n', name: 'edge notch', volume: 20, box: { min: [0, 40, 7], max: [10, 50, 9] }, opensTo: ['top', 'left'] };
    const plan = planSetups(input({ removals: [pocket, notch, sideSlot], mount: { kind: 'vise', viseOpeningMm: 120 } }), S);
    const side = plan.setups.find((s) => s.faceUp === 'left')!;
    expect(side).toBeDefined();
    // Left up: machine X = the stock's height (the top on the moving jaw, X 10), Y = its depth, Z = its width.
    const reg = registrationFor(side, { kind: 'vise' }, { seatMachineZ: -140, seekFromMachineZ: Z1_CLEARANCE_Z, cornerRadius: 0 }, { ...registrationSettings(DEFAULTS).settings, scanInsideMm: 1 });
    if (!reg.plan.ok) throw new Error(reg.plan.reason);
    expect(reg.plan.plan.stock).toMatchObject({ xMax: 10, yMax: 60 });
    // The notch (stock Z 7–9, Y 40–50) sits near the moving jaw: machine X 8 of 10, Y 45.
    expect(reg.references).toEqual([{ itemId: 'n', name: 'edge notch', at: { x: 8, y: 45 } }]);
  });
});
