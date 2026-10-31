// @vitest-environment jsdom
// The panel's sentences BESIDE and INSIDE the cutter recommendation:
//   #442 — the pick's condition note on its own line;
//   #455/#458 — the catalogue note, the hand-pick warning, and a `no-catalogue-row` candidate's
//     own reason;
//   #454/#458, #687 — the `Why?` row's broken attribution, and the filter that keeps the list to
//     rejections the operator can act on.
//
// Each note is a DIFFERENT claim from the reason beside it — "why this cutter", "what the catalogue
// lists it for", "check this one before you cut" — so none may be folded into the reason's
// sentence. This drives the real panel with a seeded preview and asserts each line is there when
// the recommendation carries it and gone when it does not. The notes' own words are
// `toolCondition`'s and the pick's rules are `recommendTool.spec.ts`; what this pins is the
// rendering half of the wiring.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetEngraveRows } from '@/store/engraveRowStore';
import { resetShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { ToolCandidate } from '@/engine/cnc/engrave/recommendTool';
import { flatEndMill } from '@/engine/cnc/tool';
import { resetRegistry, setInventoryEntries } from '@/engine/cnc/toolRegistry';
import type { EngravePreview } from '@/workers/sim/engravePreview';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A client that answers "no new preview", so the mount's own request leaves the seeded one alone. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

/** An empty mesh — the panel reads only `findings` and `recommendation` off the preview. */
const EMPTY_MESH: NodeMeshOutput = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  triangleCount: 0,
  vertexCount: 0,
  bbox: { min: [0, 0, 0], max: [0, 0, 0] },
  componentCount: 0,
};

/** The recommended candidate the panel reads the pick from — one 1.0 mm cutter, no condition set. */
const PICK: ToolCandidate = {
  key: 'flat-1.0',
  diameter: 1,
  qualifies: true,
  worst: null,
  reachKnown: false,
  reachOk: true,
  condition: null,
};

/**
 * The smallest object the `EngravePreview` type allows that this part of the panel can render: the
 * panel reads only `findings` and `recommendation` off it, so the rest are empty. The three notes are
 * the fields under test — the single thing that differs between each pair of cases below — and
 * `candidates` is overridden for the "why?" disclosure's rows (#458).
 */
function previewWith(
  notes: {
    conditionNote?: string | null;
    catalogueNote?: string | null;
    selectedNote?: string | null;
  } = {},
  candidates: ToolCandidate[] = [PICK],
): EngravePreview {
  const { conditionNote = null, catalogueNote = null, selectedNote = null } = notes;
  return {
    stock: EMPTY_MESH,
    floors: [],
    outlines: [],
    fixture: [],
    sacrificial: [],
    voids: [],
    registration: [],
    lost: [],
    engravability: [],
    findings: [],
    stages: [],
    colourBoundaryDepth: null,
    supportingFloors: {},
    goal: null,
    recommendation: {
      key: PICK.key,
      compromise: false,
      reason: 'Largest cutter that keeps every item intact.',
      conditionNote,
      // #455's sentences, printed since #458. Null is the ordinary "the catalogue had nothing to
      // add", and the default for the cases that are about the condition note alone.
      catalogueNote,
      selectedNote,
      candidates,
    },
  };
}

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  resetShopDefaultsStore();
  // #411 — the fold is module-level session state, so a spec that expanded a row would otherwise
  // leave the next one with an editor already showing.
  resetEngraveRows();
  act(() => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });
  useEngravePreviewStore.getState().dispose(); // cancel any debounce the reset scheduled
});

afterEach(() => {
  cleanup();
  act(() => resetRegistry());
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
  resetShopDefaultsStore();
});

describe('the panel’s condition note (#442)', () => {
  const NOTE = 'the only usable copy of this cutter is marked worn — check it before the cut';

  it('prints the pick’s condition note on its own line, apart from the reason', () => {
    useEngravePreviewStore.setState({ preview: previewWith({ conditionNote: NOTE }), status: 'ready' });
    render(<EngravePanel />);

    const line = screen.getByTestId('engrave-recommendation-condition');
    expect(line.textContent).toBe(NOTE);
    // Its own line, not folded into the reason: the reason's own <p> must not carry the caution, so
    // a caller reading only the reason still cannot mistake it for the note.
    const block = screen.getByTestId('engrave-recommendation');
    expect(block.querySelector('p')!.textContent).not.toContain(NOTE);
  });

  it('prints no condition line when the recommendation carries no note', () => {
    useEngravePreviewStore.setState({ preview: previewWith(), status: 'ready' });
    render(<EngravePanel />);

    // The recommendation itself is on screen — so "absent" is a claim about a recommendation that
    // exists, not about a panel that rendered nothing.
    expect(screen.getByTestId('engrave-recommendation')).toBeTruthy();
    expect(screen.queryByTestId('engrave-recommendation-condition')).toBeNull();
  });
});

// #458 — the two notes #455 hands the panel and nothing printed: what the catalogue says about the
// pick, and what it says about a cutter the person named by hand. Both are their own lines for the
// condition note's reason (#442): three different claims, three sentences.
describe('the panel’s catalogue and hand-pick notes (#458)', () => {
  const CATALOGUE = 'Makera lists this cutter for ABS only — its ABS row is standing in, a mapping this app makes.';
  const SELECTED = 'The catalogue lists this cutter for PCB or Carbon Fiber, not PLA. The job will still run it; the decision is yours.';

  it('prints the pick’s catalogue note and the hand-pick warning, each on its own line', () => {
    useEngravePreviewStore.setState({
      preview: previewWith({ catalogueNote: CATALOGUE, selectedNote: SELECTED }),
      status: 'ready',
    });
    render(<EngravePanel />);

    expect(screen.getByTestId('engrave-recommendation-catalogue').textContent).toBe(CATALOGUE);
    expect(screen.getByTestId('engrave-recommendation-selected').textContent).toBe(SELECTED);
    // Not folded into the reason: a caller reading only the reason must not take the mapping for a
    // fact, nor miss that the catalogue does not recommend this cutter.
    const block = screen.getByTestId('engrave-recommendation');
    const firstP = block.querySelector('p')!.textContent;
    expect(firstP).not.toContain(CATALOGUE);
    expect(firstP).not.toContain(SELECTED);
  });

  it('prints neither line when the catalogue has nothing to add', () => {
    useEngravePreviewStore.setState({ preview: previewWith(), status: 'ready' });
    render(<EngravePanel />);

    expect(screen.getByTestId('engrave-recommendation')).toBeTruthy();
    expect(screen.queryByTestId('engrave-recommendation-catalogue')).toBeNull();
    expect(screen.queryByTestId('engrave-recommendation-selected')).toBeNull();
  });

  it('states a no-catalogue-row candidate’s own reason, not "no cutting parameters"', () => {
    // The sentence "no cutting parameters for this material" is the exact claim #455 exists to
    // stop making: the starting table answers this cutter, and it is the CATALOGUE that refused it
    // for a named material.
    const sentence = 'Makera’s catalogue lists TiN Coating Corn Bit for PCB or Carbon Fiber, not PLA';
    const excluded: ToolCandidate = {
      key: 'corn-1.0',
      diameter: 1,
      qualifies: false,
      worst: null,
      reachKnown: false,
      reachOk: true,
      condition: null,
      excluded: 'no-catalogue-row',
      catalogueNote: sentence,
    };
    useEngravePreviewStore.setState({ preview: previewWith({}, [PICK, excluded]), status: 'ready' });
    render(<EngravePanel />);

    // The rows live in the "why?" disclosure; jsdom keeps its content in the DOM either way.
    const row = screen.getByTestId('engrave-candidate-corn-1.0');
    expect(row.textContent).toContain(sentence);
    expect(row.textContent).not.toContain('no cutting parameters');
  });

  it('states the job’s own metal-line refusal for a cutter the recommendation passed over', () => {
    // #699b — the k3 walk: the house's metal 1 mm flat is a candidate by size and feeds, and the
    // job's own #572 check is what refuses it on PLA. The row says that check's reason, not the
    // generic feeds sentence.
    const sentence = 'on Makera\'s "for Metal" line, and this job cuts PLA';
    const excluded: ToolCandidate = {
      key: 'metal-1.0',
      diameter: 1,
      qualifies: false,
      worst: null,
      reachKnown: true,
      reachOk: true,
      condition: null,
      excluded: 'metal-line',
      refusal: sentence,
    };
    useEngravePreviewStore.setState({ preview: previewWith({}, [PICK, excluded]), status: 'ready' });
    render(<EngravePanel />);

    const row = screen.getByTestId('engrave-candidate-metal-1.0');
    expect(row.textContent).toContain(sentence);
    expect(row.textContent).not.toContain('no cutting parameters');
  });

  it('states the job’s own shape refusal for a cutter the recommendation passed over', () => {
    // #702 — the job has a bore, and the V-bit that would win on size is refused by the job's own
    // bore gate. The row says that gate's sentence, not the generic feeds wording.
    const sentence = 'the job bores a hole, and a bore helixes down with a flat end mill';
    const excluded: ToolCandidate = {
      key: 'v-2.0',
      diameter: 2,
      qualifies: false,
      worst: null,
      reachKnown: true,
      reachOk: true,
      condition: null,
      excluded: 'job-shape',
      refusal: sentence,
    };
    useEngravePreviewStore.setState({ preview: previewWith({}, [PICK, excluded]), status: 'ready' });
    render(<EngravePanel />);

    const row = screen.getByTestId('engrave-candidate-v-2.0');
    expect(row.textContent).toContain(sentence);
    expect(row.textContent).not.toContain('no cutting parameters');
  });

  it('keeps the old wording for a candidate excluded for want of cutting parameters', () => {
    // The guard for the branch above: `no-feeds` still reads as it did, so the new wording is a
    // branch and not a replacement.
    const excluded: ToolCandidate = {
      key: 'corn-1.0',
      diameter: 1,
      qualifies: false,
      worst: null,
      reachKnown: false,
      reachOk: true,
      condition: null,
      excluded: 'no-feeds',
    };
    useEngravePreviewStore.setState({ preview: previewWith({}, [PICK, excluded]), status: 'ready' });
    render(<EngravePanel />);

    expect(screen.getByTestId('engrave-candidate-corn-1.0').textContent).toContain(
      'no cutting parameters for this material',
    );
  });
});

// #454/#458/#687 — the `Why?` disclosure is a short list of things to DO, not a transcript of the
// recommender's search. A shared or `cat:` key pools the shop's copies that correspond to it, so a
// condition summarised on it is about THOSE copies. Without the parenthetical the broken row reads
// exactly like a condition the operator set on the shipped definition.
describe('the panel’s Why? list (#687)', () => {
  const shopCopies = { adopted: true };

  /** A candidate of one kind, with every field the panel does not read left neutral. */
  function candidate(over: Partial<ToolCandidate> & Pick<ToolCandidate, 'key'>): ToolCandidate {
    return {
      diameter: 1,
      qualifies: false,
      worst: null,
      reachKnown: false,
      reachOk: true,
      condition: null,
      ...over,
    };
  }

  it('lists only rejections the operator can act on, and counts only those', () => {
    const ball = candidate({ key: 'inv:ball', diameter: 3, excluded: 'not-flat' });
    const broken = candidate({ key: 'flat-1.0', excluded: 'broken' });
    useEngravePreviewStore.setState({ preview: previewWith({}, [PICK, ball, broken]), status: 'ready' });
    render(<EngravePanel />);

    // A ball nose cannot become a flat end: "not a flat end mill" is not a thing to act on.
    expect(screen.queryByTestId('engrave-candidate-inv:ball')).toBeNull();
    // The qualifying pick is not a rejection either.
    expect(screen.queryByTestId('engrave-candidate-flat-1.0')).toBeTruthy();
    const summary = screen.getByTestId('engrave-recommendation').querySelector('summary')?.textContent ?? '';
    expect(summary).toContain('Why? — 1 cutter rejected');
  });

  it('draws no Why? disclosure when every candidate was kept or ruled out by its shape', () => {
    const ball = candidate({ key: 'inv:ball', diameter: 3, excluded: 'not-flat' });
    useEngravePreviewStore.setState({ preview: previewWith({}, [PICK, ball]), status: 'ready' });
    render(<EngravePanel />);

    expect(screen.getByTestId('engrave-recommendation')).toBeTruthy();
    expect(screen.getByTestId('engrave-recommendation').querySelector('details')).toBeNull();
  });

  it('says whose copies decided a broken built-in is out', () => {
    const adopted = candidate({
      key: 'flat-1.0',
      excluded: 'broken',
      condition: { best: 'broken', usable: 0, note: '…', ...shopCopies },
    });
    // `PICK` shares this key, so it is the only candidate: two rows with one test id would make
    // the query ambiguous rather than test anything.
    useEngravePreviewStore.setState({ preview: previewWith({}, [adopted]), status: 'ready' });
    render(<EngravePanel />);

    expect(screen.getByTestId('engrave-candidate-flat-1.0').textContent).toContain(
      'every copy is marked broken (the shop’s copies)',
    );
  });

  it('names the rejected cutter by the one display form, never a diameter + a guessed kind', () => {
    const broken = candidate({ key: 'flat-1.0', excluded: 'broken' });
    useEngravePreviewStore.setState({ preview: previewWith({}, [PICK, broken]), status: 'ready' });
    render(<EngravePanel />);

    const row = screen.getByTestId('engrave-candidate-flat-1.0');
    expect(row.textContent).toContain('⌀ 1 mm flat end');
    expect(row.textContent).not.toContain('1.0 mm flat end');
  });
});

// #687 — the recommendation is APPLIED and NAMED, in the one display form, with the metal fact as a
// tag. A preview that resolved no cutter still says why, but has no name, tag or action to draw.
describe('the recommendation’s name and tag (#687)', () => {
  it('names the pick by the display form and tags a metal-line cutter, never by its vendor label', () => {
    setInventoryEntries([
      {
        key: 'inv:metal-flat',
        tool: flatEndMill(3.175, {
          name: '3.175*12mm Flat End(Metal)',
          fluteLength: 12,
          shoulderLength: 12,
        }),
        provenance: 'engraveRecommendationNotes spec',
      },
    ]);
    const preview = previewWith({}, [{ ...PICK, key: 'inv:metal-flat', diameter: 3.175 }]);
    preview.recommendation = { ...preview.recommendation!, key: 'inv:metal-flat' };
    useEngravePreviewStore.setState({ preview, status: 'ready' });
    render(<EngravePanel />);

    const box = screen.getByTestId('engrave-recommendation').textContent ?? '';
    expect(box).toContain('⌀ 3.175 mm flat end · 12 mm flute');
    expect(screen.getByTestId('engrave-recommendation-metal').textContent).toBe('metal');
    expect(box).not.toContain('3.175*12mm Flat End(Metal)');
    expect(box).not.toContain('3.17 mm');
  });

  it('shows the reason alone when no cutter resolved: no name, tag, Use it or Why?', () => {
    const preview = previewWith({}, []);
    preview.recommendation = { ...preview.recommendation!, key: null };
    useEngravePreviewStore.setState({ preview, status: 'ready' });
    render(<EngravePanel />);

    const box = screen.getByTestId('engrave-recommendation');
    expect(box.textContent).toContain('Largest cutter that keeps every item intact.');
    expect(screen.queryByTestId('engrave-tool-recommended-tag')).toBeNull();
    expect(screen.queryByTestId('engrave-recommendation-metal')).toBeNull();
    expect(screen.queryByTestId('engrave-use-recommended')).toBeNull();
    expect(box.querySelector('details')).toBeNull();
  });
});
