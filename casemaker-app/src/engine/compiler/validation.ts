import type { Project } from '@/types';
import { computeBossPlacements } from './bosses';

export type ValidationCode =
  | 'lid-post-collides-component'
  | 'lid-hole-misaligned'
  | 'board-overlap-boss';

export interface ValidationIssue {
  code: ValidationCode;
  severity: 'warn' | 'error';
  message: string;
  refId?: string;
}

const POST_BOARD_CLEARANCE = 0.3;

/**
 * Validate that the screw-down configuration produces a buildable assembly:
 * lid posts don't pass through +z board components, lid holes line up with
 * floor bosses, and the board outline isn't overrun by boss footprints.
 */
export function validateScrewDownAlignment(project: Project): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (project.case.joint !== 'screw-down') return issues;

  const placements = computeBossPlacements(project.board, project.case);
  if (placements.length === 0) return issues;

  // Check 1: lid posts vs +z board components
  const standoff = project.board.defaultStandoffHeight;
  const boardTopZ =
    project.case.floorThickness + standoff + project.board.pcb.size.z;
  for (const b of placements) {
    for (const c of project.board.components) {
      if (c.facing !== '+z') continue;
      const halfX = c.size.x / 2;
      const halfY = c.size.y / 2;
      const cx = c.position.x + project.case.wallThickness + project.case.internalClearance;
      const cy = c.position.y + project.case.wallThickness + project.case.internalClearance;
      // Issue #44 — must include the standoff that lifts the host PCB above
      // the floor; otherwise componentTopZ is biased low by `standoff` and
      // most real +z components silently pass the lid-post collision check.
      const componentTopZ =
        project.case.floorThickness +
        standoff +
        project.board.pcb.size.z +
        c.position.z +
        c.size.z;
      if (componentTopZ < boardTopZ + POST_BOARD_CLEARANCE) continue;
      const dx = Math.abs(b.x - cx);
      const dy = Math.abs(b.y - cy);
      if (dx <= halfX + b.outerDiameter / 2 && dy <= halfY + b.outerDiameter / 2) {
        issues.push({
          code: 'lid-post-collides-component',
          severity: 'warn',
          message: `Lid post for ${b.id} would collide with component "${c.id}" (${c.kind}). Consider relocating the component or switching to flat-lid.`,
          refId: b.id,
        });
      }
    }
  }

  // Check 2: every floor boss has a corresponding mounting hole within the
  // PCB outline (otherwise board can't fit over the boss footprint).
  const pcb = project.board.pcb.size;
  for (const b of placements) {
    const px = b.x - project.case.wallThickness - project.case.internalClearance;
    const py = b.y - project.case.wallThickness - project.case.internalClearance;
    if (px < 0 || py < 0 || px > pcb.x || py > pcb.y) {
      issues.push({
        code: 'board-overlap-boss',
        severity: 'error',
        message: `Boss ${b.id} sits outside the PCB outline at (${px.toFixed(2)}, ${py.toFixed(2)}).`,
        refId: b.id,
      });
    }
  }

  return issues;
}
