import type { Project } from '@/types';
import type { BuildPlan, BuildNode, BuildOp } from './buildPlan';
import { union, difference, translate } from './buildPlan';
import { buildOuterShell } from './caseShell';
import { computeBossPlacements, buildBossesUnion } from './bosses';
import { buildFlatLid, computeLidDims } from './lid';
import { buildPortCutoutsForProject } from './ports';

export function compileProject(project: Project): BuildPlan {
  const { board, case: caseParams, ports } = project;

  const shellOuter = buildOuterShell(board, caseParams);
  const bossPlacements = computeBossPlacements(board, caseParams);
  const bossOps = buildBossesUnion(bossPlacements);
  const cutoutOps = buildPortCutoutsForProject(ports, board, caseParams);

  let shellOp: BuildOp = bossOps.length > 0 ? union([shellOuter, ...bossOps]) : shellOuter;
  if (cutoutOps.length > 0) {
    shellOp = difference([shellOp, ...cutoutOps]);
  }

  const nodes: BuildNode[] = [{ id: 'shell', op: shellOp }];

  const lidOp = buildFlatLid(board, caseParams);
  const lidDims = computeLidDims(board, caseParams);
  nodes.push({
    id: 'lid',
    op: translate([0, 0, lidDims.zPosition + 1], lidOp),
  });

  return { nodes };
}
