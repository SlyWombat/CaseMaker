import { describe, it } from 'vitest';
import { buildTextLabelOps } from '@/engine/compiler/textLabels';
import { buildLid, computeLidDims } from '@/engine/compiler/lid';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { union, type BuildOp } from '@/engine/compiler/buildPlan';
import { createDefaultProject } from '@/store/projectStore';
import type { TextLabel } from '@/types/textLabel';
import { exec, tl } from './helpers/manifoldExec';

function bbox(op: BuildOp) {
  const m = exec(op);
  try {
    const b = m.boundingBox();
    return { min: [...b.min], max: [...b.max], vol: m.volume(), comps: m.decompose().length };
  } finally {
    m.delete();
  }
}

describe('scratch', () => {
  it('cavity debug', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.lidCavityHeight = 4;
    const d = computeShellDims(project.board, project.case, project.hats ?? [], () => undefined);
    const lidDims = computeLidDims(project.board, project.case, project.hats ?? [], () => undefined);
    console.log('outerX', d.outerX, 'outerY', d.outerY, 'outerZ', d.outerZ);
    console.log('lidDims', JSON.stringify(lidDims));
    const label: TextLabel = {
      id: 'l', text: 'CASE', font: 'sans-default', weight: 'regular', size: 5,
      face: '+z', position: { u: d.outerX / 2, v: d.outerY / 2 }, rotation: 0,
      depth: 0.6, mode: 'emboss', enabled: true,
    };
    const ops = buildTextLabelOps([label], project.board, project.case, project.hats ?? [], () => undefined);
    const lid = buildLid(project.board, project.case, project.hats ?? [], () => undefined);
    console.log('label bbox', JSON.stringify(bbox(ops.lidAdditive[0]!)));
    console.log('lid bbox', JSON.stringify(bbox(lid)));
    const fused = exec(union([lid, ops.lidAdditive[0]!]));
    try {
      const parts = fused.decompose();
      console.log('fused comps', parts.length, 'vol', fused.volume());
      parts.forEach((p, i) => {
        const b = p.boundingBox();
        console.log(' part', i, 'vol', p.volume(), 'min', [...b.min], 'max', [...b.max]);
      });
      parts.forEach((p) => p.delete());
    } finally {
      fused.delete();
    }
    void tl;
  });
});
