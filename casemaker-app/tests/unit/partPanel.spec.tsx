// @vitest-environment jsdom
// The board-less part editor (#282). Before it, `case.badge` and `case.blank` were written once at
// creation and never again: the wizard could make either one and no control anywhere could change
// it, while `badgeParamsProblem`/`blankParamsProblem` were already raising errors about numbers the
// user had no way to reach.
//
// What this proves: the panel picks the part the archetype actually compiles, every control writes
// through `patchCase` (which validates a TOP-LEVEL partial, so an update that sent a nested
// fragment would be silently dropped rather than fail), the quick-adds are conveniences over a free
// number rather than a cage, the validator's repair path is reachable, and the job-side note fires
// on a stale hand-off and only on one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PartPanel } from '@/components/panels/PartPanel';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { findTemplate } from '@/library/templates';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { BADGE_POCKET_KEEP_OUT_ID } from '@/engine/cnc/engrave/fromBadge';
import type { BadgeParams, BlankParams } from '@/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The project's live badge — read from the store, so an update that never reached `patchCase`
 *  (or that got stripped by it) fails here rather than passing on rendered state alone. */
function badge(): BadgeParams {
  const b = useProjectStore.getState().project?.case.badge;
  if (!b) throw new Error('no badge on the project');
  return b;
}

function blank(): BlankParams {
  const b = useProjectStore.getState().project?.case.blank;
  if (!b) throw new Error('no blank on the project');
  return b;
}

/** The engrave job's stock was taken from the part and the part has since moved on (#254's
 *  per-field provenance is what tells that apart from the user's own answer). */
function jobTakenFromPart(): void {
  const job = defaultEngraveJob();
  useEngraveJobStore.setState({
    job: {
      ...job,
      sources: { stock: { length: 'computed', width: 'computed', thickness: 'computed' } },
    },
  });
}

beforeEach(() => {
  cleanup();
  useEngraveJobStore.setState({ job: defaultEngraveJob() });
});

afterEach(cleanup);

describe('PartPanel (#282) — the name badge', () => {
  beforeEach(() => {
    useProjectStore.getState().setProject(findTemplate('badge-blank')!.build());
  });

  it('renders the badge the project actually compiles, with nothing wrong', () => {
    render(<PartPanel />);
    expect(screen.getByTestId('part-panel')).toBeTruthy();
    expect(screen.getByTestId('part-summary').textContent).toContain('76.2 × 38.1 × 3.81');
    expect(screen.getByTestId('part-summary').textContent).toContain('pocket');
    expect(screen.queryByTestId('part-problem')).toBeNull();
  });

  it('writes a typed dimension straight through, leaving the siblings alone', () => {
    render(<PartPanel />);
    fireEvent.change(screen.getByTestId('badge-width'), { target: { value: '90' } });
    expect(badge().width).toBe(90);
    expect(badge().height).toBe(38.1);
    expect(badge().thickness).toBe(3.81);
    expect(badge().magnetPocket).toEqual({ length: 45, width: 13, depth: 2.3 });
  });

  it('treats the size presets as conveniences over a free number, not a cage', () => {
    render(<PartPanel />);
    fireEvent.click(screen.getByTestId('badge-size-85.6x54'));
    expect(badge().width).toBe(85.6);
    expect(badge().height).toBe(54);

    fireEvent.change(screen.getByTestId('badge-height'), { target: { value: '41' } });
    expect(badge().height).toBe(41);
    expect(badge().width).toBe(85.6);
  });

  it('turns the magnet pocket off and back on at the template’s own magnet', () => {
    render(<PartPanel />);
    fireEvent.click(screen.getByTestId('badge-pocket-on'));
    expect(badge().magnetPocket).toBeNull();
    expect(screen.getByTestId('badge-pocket-none')).toBeTruthy();

    fireEvent.click(screen.getByTestId('badge-pocket-on'));
    expect(badge().magnetPocket).toEqual({ length: 45, width: 13, depth: 2.3 });
  });

  it('reaches the numbers the validator complains about — a pocket through the colour split', () => {
    render(<PartPanel />);
    // 3.0 mm of split, so a 3.5 mm pocket would be cut by the colour change.
    fireEvent.change(screen.getByTestId('badge-pocket-depth'), { target: { value: '3.5' } });
    expect(badge().magnetPocket?.depth).toBe(3.5);
    expect(screen.queryByTestId('part-summary')).toBeNull();
    expect(screen.getByTestId('part-problem').textContent).toContain('colour split');
  });

  it('shows the print the badge states, and where the number came from (#368)', () => {
    render(<PartPanel />);
    expect((screen.getByTestId('badge-layer-height') as HTMLInputElement).value).toBe('0.2');
    expect(screen.getByTestId('badge-first-layer-height').textContent).toContain('0.2');
    // The provenance is not decoration: 0.2 mm is the print spec's stated default, NOT a reading of
    // the user's slicer, and the note is where that is said.
    expect(screen.getByTestId('badge-print-source').textContent).toContain('Provisional');
    expect(screen.queryByTestId('badge-print-none')).toBeNull();
  });

  it('edits the layer height without disturbing the rest of the badge (#368)', () => {
    render(<PartPanel />);
    fireEvent.change(screen.getByTestId('badge-layer-height'), { target: { value: '0.28' } });
    // Through `patchCase` to the store, and the first layer — a read-only statement about the print,
    // not a control — stays where it was.
    expect(badge().print).toEqual({ layerHeight: 0.28, firstLayerHeight: 0.2 });
    expect(badge().width).toBe(76.2);
    expect(badge().magnetPocket).toEqual({ length: 45, width: 13, depth: 2.3 });
  });

  it('says what a badge with no print means, instead of showing rows with no value (#368)', () => {
    const project = findTemplate('badge-blank')!.build();
    const { print: _dropped, ...badgeWithoutPrint } = project.case.badge!;
    useProjectStore.setState({
      project: { ...project, case: { ...project.case, badge: badgeWithoutPrint } },
    });

    render(<PartPanel />);
    expect(screen.queryByTestId('badge-layer-height')).toBeNull();
    // The consequence, not just the absence: without a print there is no colour boundary to hit, so
    // the depth limit stays analytic and Engrave offers no colour-split control.
    expect(screen.getByTestId('badge-print-none').textContent).toContain('analytic');
  });
});

describe('PartPanel (#282) — the bare blank', () => {
  beforeEach(() => {
    useProjectStore.getState().setProject(findTemplate('blank')!.build());
  });

  it('renders the blank, and the corner radius — the field no other route could reach', () => {
    render(<PartPanel />);
    expect(screen.getByTestId('part-summary').textContent).toContain('100 × 60 × 12');
    fireEvent.change(screen.getByTestId('blank-corner-radius'), { target: { value: '8' } });
    expect(blank().cornerRadius).toBe(8);
    expect(blank().width).toBe(100);
  });

  it('says why an impossible corner radius is impossible, rather than going blank', () => {
    render(<PartPanel />);
    fireEvent.change(screen.getByTestId('blank-corner-radius'), { target: { value: '40' } });
    expect(screen.getByTestId('part-problem').textContent).toContain('too big');
  });

  it('fills in a stock size from a preset and leaves thickness and radius alone', () => {
    render(<PartPanel />);
    fireEvent.click(screen.getByTestId('blank-size-85.6x54'));
    expect(blank().width).toBe(85.6);
    expect(blank().height).toBe(54);
    expect(blank().thickness).toBe(12);
    expect(blank().cornerRadius).toBe(3);
  });
});

describe('PartPanel (#282) — the engrave job’s side of it', () => {
  it('stays silent when the part and the job’s stock agree', () => {
    useProjectStore.getState().setProject(findTemplate('blank')!.build());
    jobTakenFromPart();
    render(<PartPanel />);
    expect(screen.queryByTestId('part-job-note')).toBeNull();
  });

  it('says so when the part moves under a stock the job took from it', () => {
    useProjectStore.getState().setProject(findTemplate('blank')!.build());
    jobTakenFromPart();
    render(<PartPanel />);
    fireEvent.change(screen.getByTestId('blank-width'), { target: { value: '90' } });
    const note = screen.getByTestId('part-job-note').textContent ?? '';
    expect(note).toContain('length 100 → 90 mm');
    expect(note).toContain('Use the blank');
  });

  it('never calls a stock the user asserted stale — that is the job’s business, not the part’s', () => {
    useProjectStore.getState().setProject(findTemplate('blank')!.build());
    const job = defaultEngraveJob();
    useEngraveJobStore.setState({ job: { ...job, sources: { stock: { length: 'user' } } } });
    render(<PartPanel />);
    fireEvent.change(screen.getByTestId('blank-width'), { target: { value: '90' } });
    expect(blank().width).toBe(90);
    expect(screen.queryByTestId('part-job-note')).toBeNull();
  });

  it('says nothing about a badge’s pocket until the job has taken that badge’s blank', () => {
    useProjectStore.getState().setProject(findTemplate('badge-blank')!.build());
    render(<PartPanel />);
    // A fresh badge project and a fresh job: the bridge has not run, so there is no hand-off to be
    // out of date. (The badge does have a pocket and the job does not know it — saying so here
    // would be a nag about a bridge nobody asked for.)
    expect(screen.queryByTestId('part-job-note')).toBeNull();
  });

  it('flags a magnet pocket the job has not been told about — the cutter would gouge it', () => {
    useProjectStore.getState().setProject(findTemplate('badge-blank')!.build());
    const job = defaultEngraveJob();
    useEngraveJobStore.setState({
      job: {
        ...job,
        stock: { ...job.stock, length: 76.2, width: 38.1, thickness: 3.81 },
        sources: { stock: { length: 'computed', width: 'computed', thickness: 'computed' } },
      },
    });
    render(<PartPanel />);
    expect(screen.getByTestId('part-job-note').textContent).toContain('declares no matching void');
  });

  it('flags a pocket the job was given and the badge has since changed', () => {
    useProjectStore.getState().setProject(findTemplate('badge-blank')!.build());
    // The badge's pocket is declared by a keep-out, so a job holding one that is no longer the
    // badge's own is the state a bridge leaves behind after the badge is edited.
    const job = defaultEngraveJob();
    useEngraveJobStore.setState({
      job: {
        ...job,
        stock: { ...job.stock, length: 76.2, width: 38.1, thickness: 3.81 },
        sources: { stock: { length: 'computed', width: 'computed', thickness: 'computed' } },
        keepOuts: [
          {
            id: BADGE_POCKET_KEEP_OUT_ID,
            name: 'Magnet pocket',
            kind: 'rect',
            position: { x: 38.1, y: 19.05 },
            rotation: 0,
            enabled: true,
            zCeiling: 2.3,
            width: 30,
            height: 13,
            cornerRadius: 0,
          },
        ],
      },
    });
    render(<PartPanel />);
    const note = screen.getByTestId('part-job-note').textContent ?? '';
    expect(note).toContain('30 × 13 mm pocket');
    expect(note).toContain('45 × 13 mm');
  });

  /** The job as “Use the badge blank” leaves it (#368): the blank's numbers, its print and its
   *  pocket, all stamped `computed`. Only the job's own copy can be called stale, so the print has to
   *  be the computed one — and the matching keep-out is here so the POCKET cannot also go stale and
   *  muddy the note. */
  function jobBlankTakenFromBadge(): void {
    const job = defaultEngraveJob();
    useEngraveJobStore.setState({
      job: {
        ...job,
        stock: {
          ...job.stock,
          length: 76.2,
          width: 38.1,
          thickness: 3.81,
          print: { split: 3, layerHeight: 0.2, firstLayerHeight: 0.2 },
        },
        sources: {
          stock: { length: 'computed', width: 'computed', thickness: 'computed', print: 'computed' },
        },
        keepOuts: [
          {
            id: BADGE_POCKET_KEEP_OUT_ID,
            name: 'Magnet pocket',
            kind: 'rect',
            position: { x: 38.1, y: 19.05 },
            rotation: 0,
            enabled: true,
            zCeiling: 2.3,
            width: 45,
            height: 13,
            cornerRadius: 0,
          },
        ],
      },
    });
  }

  it('notices a badge whose print the job took and that has since changed (#368)', () => {
    useProjectStore.getState().setProject(findTemplate('badge-blank')!.build());
    jobBlankTakenFromBadge();
    render(<PartPanel />);
    // Silence first: the stock, the print and the pocket all still match, so there is nothing to say.
    expect(screen.queryByTestId('part-job-note')).toBeNull();

    fireEvent.change(screen.getByTestId('badge-layer-height'), { target: { value: '0.28' } });
    const note = screen.getByTestId('part-job-note').textContent ?? '';
    expect(note).toContain('layer height 0.2 → 0.28 mm');
    expect(note).toContain('Use the badge blank');
  });

  it('notices a badge that lost its print after the job took one (#368)', () => {
    const project = findTemplate('badge-blank')!.build();
    const { print: _dropped, ...badgeWithoutPrint } = project.case.badge!;
    useProjectStore.setState({
      project: { ...project, case: { ...project.case, badge: badgeWithoutPrint } },
    });
    jobBlankTakenFromBadge();
    render(<PartPanel />);
    // The job is still slicing on a layer grid the badge no longer states, so the note names what the
    // grid would become — nothing, the value “Use the badge blank” would write.
    const note = screen.getByTestId('part-job-note').textContent ?? '';
    expect(note).toContain('layer height 0.2 → none mm');
    expect(note).toContain('colour split 3 → none mm');
  });
});

describe('PartPanel (#282) — everywhere else', () => {
  it('has nothing to edit on a shell project, and says where a part comes from', () => {
    useProjectStore.getState().setProject(createDefaultProject('rpi-4b'));
    render(<PartPanel />);
    expect(screen.getByTestId('part-panel-empty')).toBeTruthy();
    expect(screen.queryByTestId('part-panel')).toBeNull();
  });
});
