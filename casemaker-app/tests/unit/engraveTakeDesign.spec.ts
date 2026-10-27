// Taking a design file onto an OPEN job (#410 item 4 — the panel's import). Pure: the patch is
// built by hand here (`fromDesign.spec.ts` covers building it from a project file, and
// `designImport.spec.ts` the file-to-patch seam), so what is under test is what the STORE does with
// a patch, the gate that decides whether the job's own items survive it, and the re-import rule
// that replaces a design's own items instead of duplicating them (#437).
//
// The gate is the interesting half. `takeBadgeBlank` may replace a set of labels a route laid out;
// this route brings ITEMS, so the question it has to answer is bigger — "is this job still the one
// the app laid out?" — and getting that wrong either cuts `CASE` and `MAKER` into the user's badge
// or deletes work they did.

import { describe, it, expect, beforeEach } from 'vitest';
import { jobVise } from '@/engine/cnc/fixture';

import { useEngraveJobStore } from '@/store/engraveJobStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultStockProud } from '@/engine/cnc/fixture';
import {
  DESIGN_POCKET_KEEP_OUT_ID,
  designReplacesItems,
  type DesignJobPatch,
} from '@/engine/cnc/engrave/fromDesign';
import type { EngraveJob, EngraveKeepOutPolygon, EngraveVectorShape } from '@/types/engraveJob';

beforeEach(() => {
  useEngraveJobStore.setState({ job: defaultEngraveJob() });
});

/** The design's own item: an 8 × 2 mm ring, on the file's blank, at the file's own depth. */
function designVector(
  id = 'shp-1',
  importedFrom?: { name: string; sha256: string },
): EngraveVectorShape {
  return {
    kind: 'vector',
    id,
    name: 'Single Barrel',
    sourceName: 'Single Barrel',
    contours: [
      [
        [0, 0],
        [10, 0],
        [10, 4],
        [0, 4],
      ],
    ],
    fillRule: 'EvenOdd',
    width: 10,
    height: 4,
    position: { x: 40, y: 20 },
    rotation: 90,
    depth: 0.985,
    enabled: true,
    ...(importedFrom === undefined ? {} : { importedFrom }),
  };
}

/** The file's magnet pocket, as `designJobFor` builds it. */
function designPocket(): EngraveKeepOutPolygon {
  return {
    kind: 'polygon',
    id: DESIGN_POCKET_KEEP_OUT_ID,
    name: 'Magnet pocket',
    points: [
      [-22.5, -7.5],
      [22.5, -7.5],
      [22.5, 7.5],
      [-22.5, 7.5],
    ],
    position: { x: 38.1, y: 19.05 },
    rotation: 0,
    enabled: true,
    zCeiling: 2.3,
  };
}

/**
 * A patch of the kind `designJobFor` produces for the maintainer's badge file: the file's blank
 * (PRINTED, so the print keys are present — fromDesign writes them either way, `undefined` when the
 * file states none), one item, one pocket.
 */
function designPatch(over: Partial<DesignJobPatch> = {}): DesignJobPatch {
  return {
    name: 'Single Barrel Badge',
    stock: {
      length: 76.2,
      width: 38.1,
      thickness: 3.81,
      material: 'pla',
      colour: { kind: 'printed', capMm: 1.51, layerHeight: 0.2 },
    },
    vectors: [designVector()],
    keepOut: designPocket(),
    sources: {
      stock: {
        length: 'computed',
        width: 'computed',
        thickness: 'computed',
        material: 'computed',
        colour: 'computed',
      },
    },
    notes: ['The blank is 76.2 × 38.1 × 3.81 mm.'],
    ...over,
  };
}

/** The job as the store holds it. */
const job = (): EngraveJob => useEngraveJobStore.getState().job;

describe('designReplacesItems (#410)', () => {
  it('is true for the job the app laid out, and false the moment a person has put anything on it', () => {
    expect(designReplacesItems(defaultEngraveJob())).toBe(true);
    // The person's own words: the demo set is gone, so the design's items are added beside them.
    const typed = defaultEngraveJob();
    typed.labels = [{ ...typed.labels[0]!, text: 'Sly' }];
    expect(designReplacesItems(typed)).toBe(false);
    // …and a job that never had any: an emptied set is a decision, and adding to it changes nothing
    // about what is on the blank.
    const emptied = { ...defaultEngraveJob(), labels: [] };
    expect(designReplacesItems(emptied)).toBe(false);
  });

  it('looks at EVERY item list, not just the labels', () => {
    // The demo words are still standing, so a labels-only gate would say "replace" and drop the
    // shape someone drew. Each list is checked for that reason.
    const drawn: EngraveJob = defaultEngraveJob();
    drawn.shapes = [
      { kind: 'rect', id: 'shp-9', position: { x: 10, y: 10 }, rotation: 0, depth: 1, enabled: true, width: 5, height: 5, cornerRadius: 0 },
    ];
    expect(designReplacesItems(drawn)).toBe(false);
    expect(designReplacesItems({ ...defaultEngraveJob(), vectors: [designVector()] })).toBe(false);
    expect(
      designReplacesItems({
        ...defaultEngraveJob(),
        traces: [
          {
            kind: 'line',
            id: 'tr-1',
            position: { x: 0, y: 0 },
            rotation: 0,
            depth: 0.2,
            enabled: true,
            points: [
              [0, 0],
              [1, 1],
            ],
            closed: false,
          },
        ],
      }),
    ).toBe(false);
  });
});

describe('takeDesign (#410)', () => {
  it('makes the file the blank, the items and the void of a job the app laid out', () => {
    useEngraveJobStore.getState().takeDesign(designPatch());
    const after = job();
    // The blank, turned: 38.1 mm across the jaws, 76.2 mm along the feed.
    expect(after.stock).toMatchObject({ length: 76.2, width: 38.1, thickness: 3.81, material: 'pla' });
    // The demo words are GONE — they are laid out for the 100 × 60 mm plank and would be cut into
    // this badge — and the file's own item is what replaced them.
    expect(after.labels).toEqual([]);
    expect(after.vectors).toHaveLength(1);
    expect(after.vectors![0]!.name).toBe('Single Barrel');
    expect(after.vectors![0]!.depth).toBe(0.985);
    expect(after.keepOuts?.some((k) => k.id === DESIGN_POCKET_KEEP_OUT_ID)).toBe(true);
    // The project's title, and the provenance of everything the patch wrote (#254).
    expect(after.name).toBe('Single Barrel Badge');
    expect(after.sources?.stock?.length).toBe('computed');
    expect(after.sources?.stock?.width).toBe('computed');
    // The dropped lines' claim map goes with them; a claim about a label that is gone is not a fact
    // about the job (#363 review).
    expect(after.sources?.labels).toBeUndefined();
  });

  it('leaves the cutter, the feeds, the vise and the margins exactly as they were', () => {
    // The design states no cutter, so this route must not invent one: which bit cuts it is the
    // reachability decision (#410's second half), made with numbers this patch does not carry.
    useEngraveJobStore.getState().setTool('flat-2.0', 'user');
    const before = job();
    useEngraveJobStore.getState().takeDesign(designPatch());
    const after = job();
    // Compared against the job as it stood, not against a literal: the claim is that the patch
    // changed nothing here, and the cutter's own provenance is whatever the person's choice was.
    expect(after.toolKey).toBe(before.toolKey);
    expect(after.sources?.tool).toBe(before.sources?.tool);
    expect(after.minFloor).toBe(before.minFloor);
    expect(after.edgeMargin).toBe(before.edgeMargin);
    // The vise is the one thing that DOES follow, and by #344's rule rather than this route's: the
    // blank is 3.81 mm thick, so the seating is re-derived (`defaultStockProud`) and every other
    // jaw number is left alone.
    expect(jobVise(after).stockProud).toBe(defaultStockProud(3.81));
    expect(jobVise(after).stockProud).not.toBe(jobVise(before).stockProud);
    expect({ ...jobVise(after), stockProud: 0 }).toEqual({ ...jobVise(before), stockProud: 0 });
  });

  it('CLEARS a print the file does not state, so a stale layer grid cannot survive the blank it was for', () => {
    // The key is always present in the patch (`undefined` when the file states none), which is the
    // whole reason `setStock` reads it: without that, taking a design after a printed badge blank
    // left the badge's colour split governing a design that never declared one.
    const printed = designPatch();
    useEngraveJobStore.getState().takeDesign(printed);
    expect(job().stock.colour).toBeDefined();

    const plain = designPatch();
    plain.stock = { length: 76.2, width: 38.1, thickness: 3.81, material: 'pla', colour: undefined, flatness: undefined };
    plain.sources = { stock: { length: 'computed', width: 'computed', thickness: 'computed', material: 'computed' } };
    useEngraveJobStore.getState().takeDesign(plain);
    expect(job().stock.colour).toBeUndefined();
    expect(job().stock.flatness).toBeUndefined();
    expect(job().sources?.stock?.colour).toBeUndefined();
  });

  it('ADDS the design’s items to a job a person has worked on, and keeps their name', () => {
    // The other half of the gate. Their job, their words, their name — the design arrives as an
    // extra item on the file's blank, and whatever no longer fits is reported by `validateJob`.
    const own = defaultEngraveJob();
    own.name = 'Whiskey plaque';
    own.labels = [
      { ...own.labels[0]!, id: 'lbl-keep', text: 'Sly', size: 6, position: { x: 20, y: 20 }, depth: 0.8 },
    ];
    own.sources = { ...(own.sources ?? {}), labels: { 'lbl-keep': { depth: 'user', layout: 'user' } } };
    useEngraveJobStore.setState({ job: own });

    useEngraveJobStore.getState().takeDesign(designPatch());

    const after = job();
    expect(after.name).toBe('Whiskey plaque'); // never renamed over a person's
    expect(after.labels.map((l) => l.text)).toEqual(['Sly']);
    // …and the depth the person typed is still the depth they typed: the re-depth walk this route
    // ends with may not touch a stated number (#362).
    expect(after.labels[0]!.depth).toBe(0.8);
    expect(after.vectors?.map((v) => v.name)).toEqual(['Single Barrel']);
    // The blank is the file's either way — that is not the person's to keep.
    expect(after.stock.length).toBe(76.2);
  });

  it('takes away the void it declared and no other', () => {
    // A pocket the person declared is a fact about the blank they were cutting; a design that states
    // no pocket has said nothing about it, so only the design's OWN id is removed.
    const mine: EngraveKeepOutPolygon = { ...designPocket(), id: 'ko-mine', name: 'Their pocket' };
    const setup = defaultEngraveJob();
    setup.keepOuts = [mine];
    useEngraveJobStore.setState({ job: setup });

    useEngraveJobStore.getState().takeDesign(designPatch({ keepOut: null }));
    expect(job().keepOuts?.map((k) => k.id)).toEqual(['ko-mine']);

    // And a design that HAS one lands on its fixed id rather than beside a previous design's.
    useEngraveJobStore.getState().takeDesign(designPatch());
    useEngraveJobStore.getState().takeDesign(designPatch());
    expect((job().keepOuts ?? []).filter((k) => k.id === DESIGN_POCKET_KEEP_OUT_ID)).toHaveLength(1);
  });
});

describe('re-importing a design replaces its own items (#437)', () => {
  const source = (sha: string) => ({ name: 'Single Barrel Badge', sha256: sha.repeat(64) });

  /** A job a person has worked on, so `takeDesign` takes the ADD path rather than replacing. */
  const personJob = (): void => {
    useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), labels: [] } });
  };

  /** One import of the design: the source stamped on the patch and on every item it brings. */
  const imported = (sha: string, ids: string[]): DesignJobPatch => {
    const s = source(sha);
    return designPatch({
      source: s,
      vectors: ids.map((id) => designVector(id, s)),
    });
  };

  it('does not append a second copy of every volume', () => {
    personJob();
    useEngraveJobStore.getState().takeDesign(imported('a', ['shp-1']));
    expect(job().vectors!.map((v) => v.id)).toEqual(['shp-1']);

    // The file was edited and re-imported: the first import's items go, the new file's arrive.
    useEngraveJobStore.getState().takeDesign(imported('b', ['shp-2', 'shp-3']));
    expect(job().vectors!.map((v) => v.id)).toEqual(['shp-2', 'shp-3']);
  });

  it('is a no-op when the bytes are identical, leaving a hand-edited import alone', () => {
    personJob();
    useEngraveJobStore.getState().takeDesign(imported('a', ['shp-1']));
    // Deepen the imported item by hand, then import the very same file again.
    useEngraveJobStore.setState({
      job: {
        ...job(),
        vectors: job().vectors!.map((v) => ({ ...v, depth: 1.4 })),
      },
    });
    useEngraveJobStore.getState().takeDesign(imported('a', ['shp-9']));
    expect(job().vectors!.map((v) => v.id)).toEqual(['shp-1']);
    expect(job().vectors![0]!.depth).toBe(1.4);
  });

  it('keeps another design’s items beside it — only the same source is replaced', () => {
    personJob();
    useEngraveJobStore.getState().takeDesign(imported('a', ['shp-1']));

    const other = { name: 'Another Design', sha256: 'c'.repeat(64) };
    useEngraveJobStore.getState().takeDesign(
      designPatch({ name: 'Another Design', source: other, vectors: [designVector('shp-9', other)] }),
    );
    expect(job().vectors!.map((v) => v.id)).toEqual(['shp-1', 'shp-9']);
  });
});
