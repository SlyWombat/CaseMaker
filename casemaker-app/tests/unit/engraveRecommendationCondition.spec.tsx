// @vitest-environment jsdom
// #442 — the panel prints the pick's condition note on its own line.
//
// The note is a DIFFERENT claim from the reason beside it — "why this cutter" versus "check this one
// before you cut" — so it must not be folded into the reason's sentence. This drives the real panel
// with a seeded preview and asserts the line is there when the recommendation carries a note and gone
// when it does not. The note's own words are `toolCondition`'s and the pick's rule is
// `recommendTool.spec.ts`; what this pins is the rendering half of the wiring.

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
 * panel reads only `findings` and `recommendation` off it, so the rest are empty. `conditionNote` is
 * the field under test — the single thing that differs between the two cases below.
 */
function previewWith(conditionNote: string | null): EngravePreview {
  return {
    stock: EMPTY_MESH,
    floors: [],
    fixture: [],
    sacrificial: [],
    voids: [],
    engravability: [],
    findings: [],
    colourBoundaryDepth: null,
    recommendation: {
      key: PICK.key,
      compromise: false,
      reason: 'Largest cutter that keeps every item intact.',
      conditionNote,
      // #455's sentences, added to `ToolRecommendation` after this spec was written. They are not
      // what this file tests (the panel does not render them yet — the #455 report says so), and
      // null is the ordinary "the catalogue had nothing to add".
      catalogueNote: null,
      selectedNote: null,
      candidates: [PICK],
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
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
  resetShopDefaultsStore();
});

describe('the panel’s condition note (#442)', () => {
  const NOTE = 'the only usable copy of this cutter is marked worn — check it before the cut';

  it('prints the pick’s condition note on its own line, apart from the reason', () => {
    useEngravePreviewStore.setState({ preview: previewWith(NOTE), status: 'ready' });
    render(<EngravePanel />);

    const line = screen.getByTestId('engrave-recommendation-condition');
    expect(line.textContent).toBe(NOTE);
    // Its own line, not folded into the reason: the reason's own <p> must not carry the caution, so
    // a caller reading only the reason still cannot mistake it for the note.
    const block = screen.getByTestId('engrave-recommendation');
    expect(block.querySelector('p')!.textContent).not.toContain(NOTE);
  });

  it('prints no condition line when the recommendation carries no note', () => {
    useEngravePreviewStore.setState({ preview: previewWith(null), status: 'ready' });
    render(<EngravePanel />);

    // The recommendation itself is on screen — so "absent" is a claim about a recommendation that
    // exists, not about a panel that rendered nothing.
    expect(screen.getByTestId('engrave-recommendation')).toBeTruthy();
    expect(screen.queryByTestId('engrave-recommendation-condition')).toBeNull();
  });
});
