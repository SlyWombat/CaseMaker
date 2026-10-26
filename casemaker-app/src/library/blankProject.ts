/**
 * #680 — the blank project a stock becomes when a cutting job opens with no case around it.
 *
 * Both doors onto a cutting job need the same project: the wizard's step 2 (a typed piece, a shelf
 * pick, or a file) and the welcome card's recent job (a `.cutjob` reopened with no project in
 * front of it). The project IS the stock — the `blank` template with its blank sized to the job's
 * numbers — so the Design surface has a part to draw while the job supplies what is cut.
 *
 * Extracted from `StartWizard` when the second caller arrived, so the two cannot drift into two
 * differently-sized blanks. Returns null when the template is missing from this build.
 */

import { findTemplateAcrossSources } from './templateRegistry';
import type { Project } from '@/types/project';

export function blankProjectForStock(stock: {
  length: number;
  width: number;
  thickness: number;
}): Project | null {
  const template = findTemplateAcrossSources('blank');
  if (template === undefined) return null;
  const project = template.build();
  const blank = project.case.blank;
  if (blank === undefined) return null;
  return {
    ...project,
    case: {
      ...project.case,
      blank: {
        ...blank,
        enabled: true,
        width: stock.length,
        height: stock.width,
        thickness: stock.thickness,
        cornerRadius: 0,
      },
    },
  };
}
