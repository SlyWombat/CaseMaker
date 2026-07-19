import type { BoardProfile, Project } from '@/types';
import { createDefaultProject } from '@/store/projectStore';
import { applyCasePatch } from '@/engine/compiler/applyCasePatch';
import { autoPortsForHat } from '@/engine/compiler/hats';
import { getBuiltinHat } from '@/library/hats';
import type { TemplateSpec } from './templateSchema';

/**
 * Synthesize an empty board profile of the given size — no host PCB, no
 * components, no mounting holes. Used by templates that don't have a
 * specific host board (large box, protective case).
 */
export function emptyBoard(opts: { id: string; name: string; x: number; y: number }): BoardProfile {
  return {
    id: opts.id,
    name: opts.name,
    manufacturer: 'CaseMaker (generic)',
    pcb: { size: { x: opts.x, y: opts.y, z: 1 } },
    mountingHoles: [],
    components: [],
    defaultStandoffHeight: 0,
    recommendedZClearance: 10,
    builtin: false,
  };
}

/**
 * Build a project from a declarative template spec (#126). Order matters:
 * HATs are added BEFORE the case patch so snap-catch auto-seeding (inside
 * applyCasePatch) sees the stack height when placing catches on the rim.
 */
export function buildProjectFromSpec(spec: TemplateSpec): Project {
  let p: Project;
  if (spec.emptyBoard) {
    p = createDefaultProject();
    p.board = emptyBoard(spec.emptyBoard);
    p.ports = [];
    p.mountingFeatures = [];
    p.antennas = [];
  } else {
    p = createDefaultProject(spec.boardId);
  }
  p.name = spec.projectName ?? spec.name;

  for (const [i, hat] of (spec.hats ?? []).entries()) {
    const placementId = hat.placementId ?? `tpl-hat-${spec.id}-${i}`;
    const profile = getBuiltinHat(hat.hatId);
    p.hats.push({
      id: placementId,
      hatId: hat.hatId,
      stackIndex: hat.stackIndex ?? i,
      // #62 — ports via autoPortsForHat so HAT edge cutouts aren't dropped.
      ports: profile ? autoPortsForHat(profile, placementId) : [],
      enabled: true,
    });
  }

  if (spec.display) {
    p.display = {
      id: `tpl-display-${spec.id}`,
      displayId: spec.display.displayId,
      framing: spec.display.framing,
      offset: spec.display.offset ?? { x: 0, y: 0 },
      hostSupport: spec.display.hostSupport,
      enabled: true,
    };
  }

  if (spec.casePatch) {
    // Same path as the interactive patchCase — snap catches seed, vent
    // defaults apply. Templates cannot bypass auto-population (#35/#62/#29).
    applyCasePatch(p, spec.casePatch, getBuiltinHat);
  }

  if (spec.ports === 'none') {
    p.ports = [];
    p.mountingFeatures = [];
  }

  return p;
}
