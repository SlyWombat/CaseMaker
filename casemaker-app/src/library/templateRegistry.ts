import { TEMPLATES, type ProjectTemplate } from './templates';
import { buildProjectFromSpec } from './templates/buildFromSpec';
import { useLibraryStore } from '@/store/libraryStore';
import { getBoard } from './registry';

/**
 * Template lookup across ALL sources: bundled templates (./templates) plus
 * quickstart specs shipped by enabled remote board sources (#126). Kept
 * separate from templates/index.ts so the module graph stays acyclic
 * (templates → projectStore → board registry; this module is UI-facing).
 *
 * Bundled templates win id collisions; remote templates list after them in
 * index order. A remote template whose boardId doesn't resolve builds
 * against whatever getBoard finds — createDefaultProject throws for unknown
 * boards, so filter those out here rather than exploding the picker.
 */
export interface RegisteredTemplate extends ProjectTemplate {
  sourceLabel?: string;
}

export function listTemplates(): RegisteredTemplate[] {
  const out: RegisteredTemplate[] = [...TEMPLATES];
  const seen = new Set(out.map((t) => t.id));
  const { localTemplates, remoteSources } = useLibraryStore.getState();
  for (const spec of localTemplates) {
    if (seen.has(spec.id)) continue;
    if (spec.boardId && !getBoard(spec.boardId)) continue;
    seen.add(spec.id);
    out.push({
      id: spec.id,
      name: spec.name,
      description: spec.description,
      estPrintMinutes: spec.estPrintMinutes,
      boardId: spec.boardId,
      sourceLabel: 'your library',
      build: () => buildProjectFromSpec(spec),
    });
  }
  for (const source of remoteSources) {
    if (!source.enabled) continue;
    for (const spec of source.templates) {
      if (seen.has(spec.id)) continue;
      // Skip templates whose host board isn't resolvable from this install
      // (board disabled/shadowed/missing) — building them would throw.
      if (spec.boardId && !getBoard(spec.boardId)) continue;
      seen.add(spec.id);
      out.push({
        id: spec.id,
        name: spec.name,
        description: spec.description,
        estPrintMinutes: spec.estPrintMinutes,
        boardId: spec.boardId,
        sourceLabel: source.label,
        build: () => buildProjectFromSpec(spec),
      });
    }
  }
  return out;
}

export function findTemplateAcrossSources(id: string): RegisteredTemplate | undefined {
  return listTemplates().find((t) => t.id === id);
}

export function findTemplateByBoardAcrossSources(boardId: string): RegisteredTemplate | undefined {
  return listTemplates().find((t) => t.boardId === boardId);
}
