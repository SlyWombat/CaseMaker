import type { Project } from '@/types';
import type { BuildPlan, BuildNode, BuildOp } from './buildPlan';
import { union, translate } from './buildPlan';
import { buildOuterShell } from './caseShell';
import { computeBossPlacements, buildBossesUnion } from './bosses';
import { buildFlatLid, computeLidDims } from './lid';

export function compileProject(project: Project): BuildPlan {
  const { board, case: caseParams } = project;

  const shellOuter = buildOuterShell(board, caseParams);
  const bossPlacements = computeBossPlacements(board, caseParams);
  const bossOps = buildBossesUnion(bossPlacements);

  const shellOp: BuildOp =
    bossOps.length > 0 ? union([shellOuter, ...bossOps]) : shellOuter;

  const nodes: BuildNode[] = [{ id: 'shell', op: shellOp }];

  const lidOp = buildFlatLid(board, caseParams);
  const lidDims = computeLidDims(board, caseParams);
  // Translate lid up so it visually sits on top of the shell rim.
  nodes.push({
    id: 'lid',
    op: translate([0, 0, lidDims.zPosition + 1], lidOp),
  });

  return { nodes };
}
