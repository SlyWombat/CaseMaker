// Issue #179 — a `+z` text label must land on the LID, not the shell.
//
// The shell and the lid are SEPARATE top-level nodes (ProjectCompiler pushes
// `shell` and `lid`), and the lid's outer top surface is not at the shell's
// `outerZ`. Pre-fix, `textLabels.ts` built the `+z` frame from the SHELL
// envelope, so an engraved label cut empty space above the cavity and an
// embossed one floated as extra component(s) inside the shell mesh. A `+z`
// label is the default face for a newly added label, so users hit it first.
//
// These specs exercise the fix at the level the placement is computed
// (buildTextLabelOps + buildLid) AND end-to-end through compileProject.

import { describe, it, expect } from 'vitest';
import { buildTextLabelOps } from '@/engine/compiler/textLabels';
import { buildLid } from '@/engine/compiler/lid';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { intersection, union } from '@/engine/compiler/buildPlan';
import { createDefaultProject } from '@/store/projectStore';
import type { TextLabel } from '@/types/textLabel';
import type { CaseParameters, Project } from '@/types';
import { exec } from './helpers/manifoldExec';

interface LidMode {
  name: string;
  patch: (c: CaseParameters) => void;
}

/** Every lid the compiler can build for the default shell (`buildLid` switch). */
const LID_MODES: LidMode[] = [
  { name: 'flat-lid', patch: () => {} },
  { name: 'screw-down', patch: (c) => { c.joint = 'screw-down'; } },
  { name: 'snap-fit barb', patch: (c) => { c.joint = 'snap-fit'; c.snapType = 'barb'; } },
  { name: 'snap-fit full-lid', patch: (c) => { c.joint = 'snap-fit'; c.snapType = 'full-lid'; } },
  { name: 'recessed lid', patch: (c) => { c.lidRecess = true; } },
  { name: 'cavity-mode lid', patch: (c) => { c.lidCavityHeight = 4; } },
];

function projectFor(mode: LidMode): Project {
  const project = createDefaultProject('rpi-4b');
  mode.patch(project.case);
  return project;
}

/** A `+z` label centred on the face, where the shell has only a cavity. */
function centeredLidLabel(project: Project, mode: TextLabel['mode']): TextLabel {
  const d = computeShellDims(project.board, project.case, project.hats ?? [], () => undefined);
  return {
    id: 'lbl-1',
    text: 'CASE',
    font: 'sans-default',
    weight: 'regular',
    size: 5,
    face: '+z',
    position: { u: d.outerX / 2, v: d.outerY / 2 },
    rotation: 0,
    depth: 0.6,
    mode,
    enabled: true,
  };
}

function componentCount(op: import('@/engine/compiler/buildPlan').BuildOp): number {
  const m = exec(op);
  try {
    const parts = m.decompose();
    parts.forEach((p) => p.delete());
    return parts.length;
  } finally {
    m.delete();
  }
}

describe('Issue #179 — +z labels target the lid, in every lid mode', () => {
  for (const mode of LID_MODES) {
    describe(mode.name, () => {
      it('engrave produces a lid-local subtractive op that cuts into the lid solid', () => {
        const project = projectFor(mode);
        const ops = buildTextLabelOps(
          [centeredLidLabel(project, 'engrave')],
          project.board,
          project.case,
          project.hats ?? [],
          () => undefined,
        );
        // The +z label must be lid-targeted, not shell-targeted.
        expect(ops.lidSubtractive).toHaveLength(1);
        expect(ops.subtractive).toHaveLength(0);
        expect(ops.additive).toHaveLength(0);
        expect(ops.lidAdditive).toHaveLength(0);

        const lid = buildLid(project.board, project.case, project.hats ?? [], () => undefined);
        const inter = exec(intersection([lid, ops.lidSubtractive[0]!]));
        try {
          expect(inter.isEmpty()).toBe(false);
          expect(inter.volume()).toBeGreaterThan(0.01);
        } finally {
          inter.delete();
        }
      });

      it('emboss produces a lid-local additive op fused to the lid (one component)', () => {
        const project = projectFor(mode);
        const ops = buildTextLabelOps(
          [centeredLidLabel(project, 'emboss')],
          project.board,
          project.case,
          project.hats ?? [],
          () => undefined,
        );
        expect(ops.lidAdditive).toHaveLength(1);
        expect(ops.additive).toHaveLength(0);
        expect(ops.subtractive).toHaveLength(0);
        expect(ops.lidSubtractive).toHaveLength(0);

        const lid = buildLid(project.board, project.case, project.hats ?? [], () => undefined);
        const label = ops.lidAdditive[0]!;

        // The emboss overlaps the lid volumetrically (embedded a hair) — the
        // precondition for a real fuse, not a coplanar touch.
        const inter = exec(intersection([lid, label]));
        try {
          expect(inter.volume()).toBeGreaterThan(0.01);
        } finally {
          inter.delete();
        }

        // Unioning the label must add NO new disconnected component. (Compared
        // to the label-less lid, so an unrelated pre-existing cavity-lid post
        // separation doesn't mask whether the LETTERS floated.)
        const baseCount = componentCount(lid);
        const fused = exec(union([lid, label]));
        try {
          const parts = fused.decompose();
          expect(parts).toHaveLength(baseCount); // letters fused, no floaters
          parts.forEach((p) => p.delete());
        } finally {
          fused.delete();
        }
      });
    });
  }
});

describe('Issue #179 — end to end through compileProject', () => {
  it('an embossed +z label does not leave disconnected islands in the shell node', () => {
    const project = createDefaultProject('rpi-4b');
    project.textLabels = [centeredLidLabel(project, 'emboss')];
    const plan = compileProject(project);
    const shell = plan.nodes.find((n) => n.id === 'shell')!;
    // Pre-fix the 4 letters floated above the cavity as extra shell components.
    expect(componentCount(shell.op)).toBe(1);
  });

  it('an embossed +z label fuses to the lid node (one component, no floater)', () => {
    const base = createDefaultProject('rpi-4b');
    const withLabel: Project = { ...base, textLabels: [centeredLidLabel(base, 'emboss')] };

    const lidComponents = (project: Project): number => {
      const plan = compileProject(project);
      const lid = plan.nodes.find((n) => n.id === 'lid')!;
      return componentCount(lid.op);
    };

    // Relative to the label-less lid so an unrelated pre-existing split in a
    // given lid build can't mask whether the LETTERS are the floater.
    expect(lidComponents(withLabel)).toBe(lidComponents(base));
  });

  it('an engraved +z label removes material from the lid and none from the shell', () => {
    const base = createDefaultProject('rpi-4b');
    const withLabel: Project = { ...base, textLabels: [centeredLidLabel(base, 'engrave')] };

    const volumeOf = (project: Project, nodeId: string): number => {
      const plan = compileProject(project);
      const m = exec(plan.nodes.find((n) => n.id === nodeId)!.op);
      try {
        return m.volume();
      } finally {
        m.delete();
      }
    };

    const lidBase = volumeOf(base, 'lid');
    const lidCut = volumeOf(withLabel, 'lid');
    expect(lidCut).toBeLessThan(lidBase - 0.1); // the groove is real
    expect(lidCut).toBeGreaterThan(lidBase - 100); // a groove, not the whole plate

    // The floor/shell carve path for the same label must stay untouched.
    expect(volumeOf(withLabel, 'shell')).toBeCloseTo(volumeOf(base, 'shell'), 4);
  });

  it('-z (floor) labels stay on the shell and cut the floor — no equivalent bug', () => {
    const base = createDefaultProject('rpi-4b');
    const d = computeShellDims(base.board, base.case, base.hats ?? [], () => undefined);
    const label: TextLabel = {
      id: 'lbl-floor',
      text: 'FLOOR',
      font: 'sans-default',
      weight: 'regular',
      size: 5,
      face: '-z',
      position: { u: d.outerX / 2, v: d.outerY / 2 },
      rotation: 0,
      depth: 0.6,
      mode: 'engrave',
      enabled: true,
    };
    const ops = buildTextLabelOps([label], base.board, base.case, base.hats ?? [], () => undefined);
    // The floor IS part of the shell, so a -z label stays shell-targeted.
    expect(ops.subtractive).toHaveLength(1);
    expect(ops.lidSubtractive).toHaveLength(0);

    const shellVolume = (project: Project): number => {
      const plan = compileProject(project);
      const m = exec(plan.nodes.find((n) => n.id === 'shell')!.op);
      try {
        return m.volume();
      } finally {
        m.delete();
      }
    };
    const withLabel: Project = { ...base, textLabels: [label] };
    expect(shellVolume(withLabel)).toBeLessThan(shellVolume(base) - 0.1);
  });
});
