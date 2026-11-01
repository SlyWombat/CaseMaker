/**
 * #814 — CHANGING A PCB JOB'S HOLDING REBUILDS THE TURNED-OVER SIDE.
 *
 * A two-sided board imported into a VISE job has setup 2 turned by the vise's flip (a half turn
 * about machine X). Pressing "Tape it to the bed" used to change `workholding` alone: the job said
 * taped while setup 2 still said vise and its bottom copper was still mirrored about X, which is
 * the wrong axis for a taped board's turn (about Y). The two answers disagreed, and the bottom
 * side no longer landed on its holes when the board was turned as the tape turns it.
 *
 * This pins the re-derive: the same setups, rebuilt through the new mount's own map, with the
 * bottom copper still on the drilled holes — and a hand-set mount kept and stated, never moved
 * behind the operator's back.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tl } from './helpers/manifoldExec';
import { flatEndMill } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { planPcbImport } from '@/engine/import/pcbImport';
import { pcbSetupPlan } from '@/engine/import/pcbSetups';
import { reHoldPcbJob } from '@/engine/import/pcbHold';
import { planFromSetups } from '@/engine/cnc/setups/authoring';
import { referenceOpenings } from '@/engine/cnc/setups/registration';
import { setupsSettings } from '@/engine/cnc/setups/settings';
import { pointInPolygons } from '@/engine/cnc/engrave/throughMask';
import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { EngraveJob, EngraveVectorShape } from '@/types/engraveJob';
import type { PcbImportOk } from '@/engine/import/pcbImport';

const HERE = join(process.cwd(), 'tests/unit');
const FIXTURES = join(HERE, 'fixtures/pcb');
const bytes = (name: string): Uint8Array<ArrayBuffer> => Uint8Array.from(readFileSync(join(FIXTURES, name)));
const BLANK = { length: 60, width: 40, thickness: 1.6 };
const TABS = { count: 3, width: 3, height: 1 };
const DEFAULTS = ShopDefaultsSchema.parse(
  (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown }).defaults,
);

const engraver: ToolLibraryEntry = {
  key: 'inv:engrave-60',
  provenance: 'test',
  tool: flatEndMill(3.175, {
    id: 'pcb-engrave-0-1-60',
    name: '60° 0.1 mm engraving bit',
    typeText: 'Engraving',
    shape: 'engraving',
    tipDiameter: 0.1,
    diameter: 3.175,
    halfAngle: 30,
    angle: 60,
    fluteLength: 12,
  }),
};
const corn: ToolLibraryEntry = {
  key: 'inv:corn-0-8',
  provenance: 'test',
  tool: flatEndMill(0.8, { id: 'pcb-corn-0-8', name: '0.8 mm corn bit', fluteLength: 20 }),
};
const bit = (key: string, id: string, d: number): ToolLibraryEntry => ({
  key,
  provenance: 'test',
  tool: flatEndMill(d, { id, shape: 'drill', tipDiameter: d, diameter: d, fluteLength: 12 }),
});
const TOOLS = [engraver, bit('inv:d08', 'pcb-drill-0-8', 0.8), bit('inv:d10', 'pcb-drill-1-0', 1.0), corn];
const ROWS: FeedCatalogueRow[] = [
  { cutterId: 'pcb-engrave-0-1-60', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.1 },
  { cutterId: 'pcb-corn-0-8', material: 'PCB', rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.2 },
  { cutterId: 'pcb-drill-0-8', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
  { cutterId: 'pcb-drill-1-0', material: 'PCB', rpm: 12000, feed: 300, plungeFeed: 100, stepDown: 1.6 },
];

const FILES = ['tiny-F_Cu.gbr', 'tiny-B_Cu.gbr', 'tiny-Edge_Cuts.gbr', 'tiny-inside.drl'].map((name) => ({
  name,
  bytes: bytes(name),
}));

/** A two-sided job imported into a VISE — the state #814 starts from. */
function viseImported(): EngraveJob {
  let n = 0;
  const idFor = (prefix: string): string => `${prefix}-${++n}`;
  const plan: PcbImportOk = (() => {
    const res = planPcbImport(tl, FILES, { blank: BLANK, tabs: TABS, mount: { kind: 'vise' }, idFor });
    if (!res.ok) throw new Error(res.error);
    return res;
  })();
  if (plan.second === null) throw new Error('the fixture is not two-sided');
  const setups = pcbSetupPlan(plan, TOOLS, BLANK.thickness, ROWS);
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: BLANK.length, width: BLANK.width, thickness: BLANK.thickness },
    workholding: { kind: 'vise', vise: base.workholding.kind === 'vise' ? base.workholding.vise : (undefined as never) },
    labels: [],
    shapes: [],
    vectors: [...plan.items.vectors, ...plan.second.items.vectors],
    combined: [...plan.items.frames, ...plan.second.items.frames],
    drills: [...plan.items.drills],
    cutouts: [...(plan.items.cutouts ?? []), ...(plan.second.items.cutouts ?? [])],
    setups: setups.sides.map((side) => side.setup),
  } as EngraveJob;
}

describe('#814 re-holding a two-sided board', () => {
  it('the vise import turns setup 2 about X; the tape re-hold turns it about Y and says so in the mount', () => {
    const job = viseImported();
    expect(job.setups).toHaveLength(2);
    expect(job.setups![0]!.mount.kind).toBe('vise');
    // The vise flip: a half turn about machine X — left stays left, front goes to back.
    expect(job.setups![1]!.orientation).toEqual({
      top: 'bottom',
      bottom: 'top',
      left: 'left',
      right: 'right',
      front: 'back',
      back: 'front',
    });

    const reheld = reHoldPcbJob(job, { kind: 'tape' }, null);
    expect(reheld.moved).toBe(2);
    expect(reheld.kept).toEqual([]);
    const [one, two] = reheld.job.setups!;
    expect(one!.mount.kind).toBe('tape');
    expect(one!.orientation.top).toBe('top');
    expect(two!.mount.kind).toBe('tape');
    // The tape flip: a half turn about machine Y — left goes to right, front stays front.
    expect(two!.orientation).toEqual({
      top: 'bottom',
      bottom: 'top',
      left: 'right',
      right: 'left',
      front: 'front',
      back: 'back',
    });
  });

  it('the bottom copper still lands on the holes after the re-hold — the pads stay on their pads', () => {
    const reheld = reHoldPcbJob(viseImported(), { kind: 'tape' }, null).job;
    const read = planFromSetups(reheld, setupsSettings(DEFAULTS));
    expect(read.setups).toHaveLength(2);
    const { openings } = referenceOpenings(read.setups[1]!);
    expect(openings.length).toBeGreaterThan(0);
    const bottomCopper = (reheld.vectors ?? []).find((v) => /bottom/i.test(v.name ?? '')) as EngraveVectorShape;
    expect(bottomCopper).toBeDefined();
    const rings = bottomCopper.contours.map((r) =>
      r.map(([x, y]): [number, number] => [x + bottomCopper.position.x, y + bottomCopper.position.y]),
    );
    // Every hole in setup 2's frame must sit inside the bottom copper that is meant to be on it.
    // (The fixture's five pads are on drills; the acceptance is the pad-on-hole coincidence.)
    let onCopper = 0;
    for (const opening of openings) {
      const cx = (opening.min[0] + opening.max[0]) / 2;
      const cy = (opening.min[1] + opening.max[1]) / 2;
      if (pointInPolygons(rings, cx, cy)) onCopper += 1;
    }
    expect(onCopper).toBeGreaterThanOrEqual(5);
  });

  it('a setup held a person’s own way keeps its mount, and the keep is stated', () => {
    const job = viseImported();
    // The operator set setup 2 to the bracket by hand.
    const hand = job.setups!.map((s, i) => (i === 1 ? { ...s, mount: { kind: 'bracket' as const } } : s));
    const reheld = reHoldPcbJob({ ...job, setups: hand }, { kind: 'tape' }, null);
    expect(reheld.job.setups![1]!.mount.kind).toBe('bracket');
    expect(reheld.kept.map((k) => k.setupId)).toContain(job.setups![1]!.id);
    expect(reheld.kept[0]!.reason).toContain('held your own way');
    // Setup 1, derived from the vise, still follows.
    expect(reheld.job.setups![0]!.mount.kind).toBe('tape');
  });

  it('the import’s alignment holes move onto the tape flip’s line, or are removed when it offers none', () => {
    const job = viseImported();
    const holes = job.drills!.slice(0, 2).map((d, i) => ({ ...d, name: `⌀2 alignment hole`, position: { x: 10 + i, y: 20 } }));
    const withHoles = { ...job, drills: [...job.drills!, ...holes] };
    const moved = reHoldPcbJob(withHoles, { kind: 'tape' }, { old: [[10, 20], [11, 20]], next: [[12, 20], [48, 20]] });
    expect(moved.alignment).toBe('moved');
    const after = (moved.job.drills ?? []).filter((d) => /alignment hole$/.test(d.name ?? ''));
    expect(after.map((d) => [d.position.x, d.position.y])).toEqual([
      [12, 20],
      [48, 20],
    ]);
    const removed = reHoldPcbJob(withHoles, { kind: 'tape' }, { old: [[10, 20], [11, 20]], next: [] });
    expect(removed.alignment).toBe('removed');
    expect((removed.job.drills ?? []).some((d) => /alignment hole$/.test(d.name ?? ''))).toBe(false);
  });
});
