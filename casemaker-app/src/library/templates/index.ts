import type { Project } from '@/types';
import { createDefaultProject } from '@/store/projectStore';
import { templateSpecSchema, type TemplateSpec } from './templateSchema';
import { buildProjectFromSpec, emptyBoard } from './buildFromSpec';

/**
 * Project templates (#126). Most templates are declarative JSON specs in
 * ./specs/*.json — pure data interpreted by buildFromSpec, which routes case
 * patches through the same auto-population path as interactive patchCase.
 * Adding a simple template is now just "drop a JSON file in specs/".
 *
 * Templates that COMPUTE geometry stay as code below (the protective case
 * scales its hinge/latches to the wall tangent length) — the spec format
 * deliberately has no expression language for two templates' sake.
 *
 * TEMPLATES is ordered by each entry's `order` (specs carry it in JSON):
 * findTemplateByBoard picks the FIRST match for a board, templates.spec.ts
 * pins the full sequence, and tests/e2e/templates-smoke.spec.ts mirrors the
 * id list — update both when adding a template.
 */
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  estPrintMinutes: number;
  /** Built-in board this template is the curated recipe for. The welcome
   * screen's pick-a-board flow applies the first template matching the
   * chosen board instead of generating a bare default shell. Omit for
   * templates with no host board (protective-case, large-box-200). */
  boardId?: string;
  build: () => Project;
}

type OrderedTemplate = ProjectTemplate & { order: number };

const specModules = import.meta.glob<{ default: unknown }>('./specs/*.json', { eager: true });

const specTemplates: OrderedTemplate[] = Object.entries(specModules).map(([path, mod]) => {
  let spec: TemplateSpec;
  try {
    spec = templateSpecSchema.parse(mod.default);
  } catch (err) {
    throw new Error(`Invalid template spec ${path}: ${String(err)}`);
  }
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    estPrintMinutes: spec.estPrintMinutes,
    boardId: spec.boardId,
    order: spec.order,
    build: () => buildProjectFromSpec(spec),
  };
});

/**
 * Issue #112 — Pelican-style protective case. Composite of #107 (gasket) +
 * #108 (TPU export) + #109 (latches) + #110 (piano hinge) + #111 (rugged).
 * Stays as CODE: hinge length and latch positions are FRACTIONS of the wall
 * tangent length so the template auto-fits when the user resizes the board.
 */
function protectiveCase(): Project {
  // Generic 140×90 mm interior gives ~150×100 mm outer at 5 mm walls.
  const board = emptyBoard({
    id: 'generic-protective-cavity',
    name: 'Protective case interior',
    x: 140,
    y: 90,
  });
  const p = createDefaultProject();
  p.name = 'Protective case (waterproof, hinged, latched)';
  p.board = board;
  p.case.wallThickness = 4;
  p.case.floorThickness = 4;
  p.case.lidThickness = 4;
  p.case.cornerRadius = 6;
  p.case.zClearance = 50;
  // Pelican-standard: lid sits ON TOP of the rim (NOT recessed). The lid
  // overhangs slightly so the latch striker tab projects past the case
  // envelope and the cam arm can grab it. The seal still works without
  // recess — gasket compresses between lid underside and rim top.
  p.case.lidRecess = false;
  // Pelican lids have their OWN cavity (depth to accommodate the top of
  // the latches plus interior padding). Shell-mode buildLid emits a
  // hollow box with side walls extending UP from the rim; the latch
  // striker rides directly on the lid's outer side wall (no separate tab).
  p.case.lidCavityHeight = 25;
  p.case.joint = 'flat-lid';
  p.case.ventilation = { enabled: false, pattern: 'none', coverage: 0 };
  p.case.bosses.enabled = false;
  // Issue #107 — gasket
  p.case.seal = {
    enabled: true,
    profile: 'flat',
    width: 4,
    depth: 2,
    compressionFactor: 0.25,
    gasketMaterial: 'tpu',
  };
  // Wall tangent length for the ±y faces — used by both the hinge
  // (back, +y) and the latches (front, -y) so they scale together when
  // the user resizes the board. outerX = pcb.x + 2 × (wall + clearance).
  const pcbX = p.board.pcb.size.x;
  const wallTangentLen = pcbX + 2 * (p.case.wallThickness + p.case.internalClearance);
  // Piano-segmented hinge on the back face. Length scales to ~75% of the
  // wall tangent so the hinge dominates the back face on any case size,
  // not just the default 150 mm one. featureScale.clampHinge enforces
  // the printable minimums (knuckle OD ≥ 5 mm, pin ≥ 2 mm, length ≥ 25
  // mm) so the hinge stays buildable down to ~50 mm wall lengths.
  p.case.hinge = {
    id: 'tpl-protective-hinge',
    style: 'piano-segmented',
    face: '+y',
    numKnuckles: 7,
    knuckleOuterDiameter: 8,
    pinDiameter: 3,
    knuckleClearance: 0.4,
    positioning: 'centered',
    hingeLength: wallTangentLen * 0.75,
    pinMode: 'separate',
    enabled: true,
  };
  // Two latches on the FRONT face (-y), opposite the hinge. Positions
  // are a FRACTION of the wall tangent so the template auto-fits when
  // the user shrinks the board.
  p.case.latches = [
    { id: 'tpl-latch-1', wall: '-y', uPosition: wallTangentLen * 0.27, enabled: true, throw: 1.5, width: 14, height: 30 },
    { id: 'tpl-latch-2', wall: '-y', uPosition: wallTangentLen * 0.73, enabled: true, throw: 1.5, width: 14, height: 30 },
  ];
  // Issue #111 — rugged exterior
  p.case.rugged = {
    enabled: true,
    corners: { enabled: true, radius: 8, flexBumper: false },
    ribbing: { enabled: true, direction: 'vertical', ribCount: 4, ribDepth: 1.5, clearBand: 6 },
    feet: { enabled: true, pads: 4, padDiameter: 12, padHeight: 2 },
  };
  p.ports = [];
  p.mountingFeatures = [];
  return p;
}

const codeTemplates: OrderedTemplate[] = [
  {
    id: 'protective-case',
    name: 'Protective case (waterproof, hinged, latched)',
    description:
      'Pelican-style protective enclosure with TPU gasket, piano-segmented hinge, two spring-cam latches, rugged corners, vertical ribs, and feet. Replace the empty interior with your host PCB after creating the project. (#106)',
    estPrintMinutes: 480,
    order: 150,
    build: protectiveCase,
  },
];

const ordered = [...specTemplates, ...codeTemplates].sort((a, b) => a.order - b.order);
{
  const ids = new Set(ordered.map((t) => t.id));
  if (ids.size !== ordered.length) {
    throw new Error('Duplicate template id in templates/specs');
  }
}

export const TEMPLATES: ReadonlyArray<ProjectTemplate> = ordered.map(
  ({ order: _order, ...t }) => t,
);

export function findTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * First template curated for the given built-in board, if any. Boards can
 * back multiple templates (rpi-4b → pi-server-tray + pi-poe-stack); list
 * order in TEMPLATES decides which one the pick-a-board flow applies.
 */
export function findTemplateByBoard(boardId: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.boardId === boardId);
}
