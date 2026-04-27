import { describe, it, expect, beforeEach } from 'vitest';
import { buildTextLabelOps } from '@/engine/compiler/textLabels';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import type { TextLabel } from '@/types/textLabel';

describe('Marketing gap #16 — text engraving (block-letter Phase 1)', () => {
  beforeEach(() => {
    useProjectStore.getState().setProject(createDefaultProject('rpi-4b'));
  });

  it('addTextLabel appends to project; removeTextLabel removes', () => {
    const label: TextLabel = {
      id: 'lbl-1',
      text: 'USB-C',
      font: 'sans-default',
      weight: 'regular',
      size: 4,
      face: '-y',
      position: { u: 10, v: 4 },
      rotation: 0,
      depth: 0.6,
      mode: 'engrave',
      enabled: true,
    };
    useProjectStore.getState().addTextLabel(label);
    expect(useProjectStore.getState().project.textLabels.length).toBe(1);
    useProjectStore.getState().removeTextLabel('lbl-1');
    expect(useProjectStore.getState().project.textLabels.length).toBe(0);
  });

  it('engraved label produces subtractive ops, one per non-space char', () => {
    const label: TextLabel = {
      id: 'lbl-1',
      text: 'ABC',
      font: 'sans-default',
      weight: 'regular',
      size: 4,
      face: '-y',
      position: { u: 10, v: 4 },
      rotation: 0,
      depth: 0.6,
      mode: 'engrave',
      enabled: true,
    };
    const project = useProjectStore.getState().project;
    const ops = buildTextLabelOps([label], project.board, project.case);
    expect(ops.subtractive.length).toBe(3);
    expect(ops.additive.length).toBe(0);
  });

  it('embossed label produces additive ops', () => {
    const label: TextLabel = {
      id: 'lbl-1',
      text: 'X',
      font: 'sans-default',
      weight: 'regular',
      size: 4,
      face: '+z',
      position: { u: 10, v: 4 },
      rotation: 0,
      depth: 0.6,
      mode: 'emboss',
      enabled: true,
    };
    const project = useProjectStore.getState().project;
    const ops = buildTextLabelOps([label], project.board, project.case);
    expect(ops.additive.length).toBe(1);
    expect(ops.subtractive.length).toBe(0);
  });

  it('disabled label is skipped', () => {
    const project = useProjectStore.getState().project;
    const ops = buildTextLabelOps(
      [
        {
          id: 'lbl-1',
          text: 'X',
          font: 'sans-default',
          weight: 'regular',
          size: 4,
          face: '-y',
          position: { u: 10, v: 4 },
          rotation: 0,
          depth: 0.6,
          mode: 'engrave',
          enabled: false,
        },
      ],
      project.board,
      project.case,
    );
    expect(ops.subtractive.length).toBe(0);
  });
});
