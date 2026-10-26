// @vitest-environment jsdom
// The design-file entry in the Engrave panel (#410 item 4). The panel is rendered for real and
// driven through the hidden file input, exactly as a person does; only the WORKER is faked
// (`setDesignImportClient`, the seam `designImport.spec.ts` uses), so what is proved here is the
// wiring the panel owns: the button reaches the input, the picked file reaches the reader, the
// patch reaches the store, and both the notes and the failures reach the screen.
//
// The reader's own behaviour (the size guard, the direction, the parser's sentences) is that spec's
// business, and the patch's effect on the job is `engraveTakeDesign.spec.ts`'s.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { setDesignImportClient } from '@/engine/import/designImport';
import type { DesignJobPatch } from '@/engine/cnc/engrave/fromDesign';

// #437 — the design door is a `featureSim` route like every other project-file reader; this spec
// flips the switch to prove the panel does not offer it in a build without the simulator.
const features = vi.hoisted(() => ({ sim: true }));
vi.mock('@/platform/features', async (orig) => {
  const real = await orig<typeof import('@/platform/features')>();
  return {
    ...real,
    get featureSim() {
      return features.sim;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A client that answers every preview request with "no new preview", which the panel must survive. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

/** The patch the fake reader hands back: the file's blank, one item and a note. */
const PATCH: DesignJobPatch = {
  name: 'Single Barrel Badge',
  stock: { length: 76.2, width: 38.1, thickness: 3.81, material: 'pla', colour: undefined, flatness: undefined },
  vectors: [
    {
      kind: 'vector',
      id: 'shp-design-1',
      name: 'Single Barrel',
      sourceName: 'Single Barrel',
      contours: [[[0, 0], [10, 0], [10, 4], [0, 4]]],
      fillRule: 'EvenOdd',
      width: 10,
      height: 4,
      position: { x: 40, y: 20 },
      rotation: 90,
      depth: 0.985,
      enabled: true,
    },
  ],
  keepOut: null,
  sources: { stock: { length: 'computed', width: 'computed', thickness: 'computed', material: 'computed' } },
  // The engine's own order is what the note numbers follow (`fromDesign.spec.ts` holds the real
  // list, off the maintainer's file); two of them here are enough to tell the summary from the body.
  notes: [
    'The blank is 76.2 × 38.1 × 3.81 mm, measured from the file’s 2 ModelPart volumes.',
    'The design was turned 90° COUNTER-CLOCKWISE as seen from above to get there.',
  ],
};

/** A `.3mf` is a zip; the fake reader never looks, but the panel hands over the file's real bytes. */
function pickDesign(name = 'single.3mf'): void {
  const input = screen.getByTestId('engrave-design-input') as HTMLInputElement;
  const file = new File([new Uint8Array([0x50, 0x4b])], name);
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  act(() => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });
  useEngravePreviewStore.getState().dispose();
  try {
    localStorage.clear();
  } catch {
    // no localStorage in some environments
  }
});

afterEach(() => {
  features.sim = true;
  cleanup();
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
  setDesignImportClient(null);
});

describe('EngravePanel — the design import entry (#410)', () => {
  it('reads the picked file, applies it to the job, and states what the file settled', async () => {
    setDesignImportClient(async () => ({ readDesign3mf: async () => PATCH }));
    render(<EngravePanel />);
    await act(async () => {
      pickDesign();
      await Promise.resolve();
    });

    // What the panel SAYS: the summary names the file and counts what is behind it, and the notes
    // themselves are one press away rather than forty lines between the button and the Stock fields
    // (#410 review). They are in the DOM either way — a `<details>` is a disclosure, not a delete —
    // so the turn the design was given is still readable, which is the promise that route makes.
    expect(screen.getByTestId('engrave-design-summary').textContent).toContain('single.3mf');
    expect(screen.getByTestId('engrave-design-note-0').textContent).toContain('76.2 × 38.1 × 3.81');
    expect(screen.getByTestId('engrave-design-note-1').textContent).toContain('COUNTER-CLOCKWISE');
    expect(screen.queryByTestId('engrave-design-error')).toBeNull();

    // What it DID: the blank and the items are the file's, and the demo words are gone — the whole
    // point of the route, since `CASE` on a 76.2 mm badge runs off the back edge.
    const job = useEngraveJobStore.getState().job;
    expect(job.stock).toMatchObject({ length: 76.2, width: 38.1, thickness: 3.81, material: 'pla' });
    expect(job.labels).toEqual([]);
    expect(job.vectors?.map((v) => v.name)).toEqual(['Single Barrel']);
    expect(job.name).toBe('Single Barrel Badge');
  });

  it('shows the reader’s refusal instead of applying anything', async () => {
    setDesignImportClient(async () => ({
      readDesign3mf: async () => {
        throw new Error('3MF: missing 3D/3dmodel.model entry');
      },
    }));
    render(<EngravePanel />);
    await act(async () => {
      pickDesign('not-a-project.3mf');
      await Promise.resolve();
    });

    expect(screen.getByTestId('engrave-design-error').textContent).toContain('missing 3D/3dmodel.model');
    expect(screen.queryByTestId('engrave-design-notes')).toBeNull();
    // The job is untouched: a file that could not be read is not a partial design.
    const job = useEngraveJobStore.getState().job;
    expect(job.stock.length).toBe(100);
    expect(job.labels.length).toBe(3);
  });

  it('offers no design door in a build without the simulator (#437)', () => {
    // The reader itself refuses there (`designImport`), so a button would only lead to that
    // refusal — the same rule the sweep, Manage and the CNC guide follow.
    features.sim = false;
    render(<EngravePanel />);
    // #686 — the door lives in the File menu now, so the menu has to be open for its absence to
    // mean anything: a closed menu would answer null in either build.
    fireEvent.click(screen.getByTestId('engrave-file-menu-toggle'));
    expect(screen.getByTestId('engrave-file-menu')).toBeTruthy();
    expect(screen.getByTestId('engrave-job-save')).toBeTruthy();
    expect(screen.queryByTestId('engrave-design-import')).toBeNull();
    expect(screen.queryByTestId('engrave-design-input')).toBeNull();
  });

  it('offers the design door as the File menu’s last item in a simulator build (#686)', () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-file-menu-toggle'));
    const items = screen.getByTestId('engrave-file-menu').querySelectorAll('[role="menuitem"]');
    // #686 follow-up — "New cutting job…" is the first item; the design read is still last, after
    // the three file actions it belongs beside.
    expect([...items].map((el) => el.getAttribute('data-testid'))).toEqual([
      'engrave-job-new',
      'engrave-job-save',
      'engrave-job-save-as',
      'engrave-job-open',
      'engrave-design-import',
    ]);
  });
});
