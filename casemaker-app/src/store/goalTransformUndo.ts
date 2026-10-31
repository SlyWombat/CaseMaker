import { create } from 'zustand';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import type { EngraveTargetObject } from '@/types/engraveJob';

/**
 * #831 — UNDO FOR A GOAL'S TURN, MOVE AND FIT. The engrave job has no general history (only the
 * removal strip, #411), so the placement writes the turn controls make — the +90° buttons, "Lay it
 * flat", the on-canvas rings and arrows — each remember the placement they replaced here. The
 * panel's Undo and Ctrl+Z (on the engrave screen) put the last one back. An entry belongs to one
 * target: a different goal (a new import, another job) never receives another goal's placement.
 */
export interface GoalPlacementSnapshot {
  targetId: string;
  rotation: number;
  rotationX: number | undefined;
  rotationY: number | undefined;
  scale: EngraveTargetObject['scale'] | undefined;
  position: EngraveTargetObject['position'];
}

const MAX = 20;

interface GoalUndoState {
  stack: GoalPlacementSnapshot[];
}

export const useGoalTransformUndo = create<GoalUndoState>(() => ({ stack: [] }));

export function snapshotOf(target: EngraveTargetObject): GoalPlacementSnapshot {
  return {
    targetId: target.id,
    rotation: target.rotation,
    rotationX: target.rotationX,
    rotationY: target.rotationY,
    scale: target.scale,
    position: { ...target.position },
  };
}

/** Remember the job's current goal placement, before a write that changes it. */
export function rememberGoalPlacement(
  target: EngraveTargetObject | undefined = useEngraveJobStore.getState().job.targetObject,
): void {
  if (target === undefined) return;
  const stack = [...useGoalTransformUndo.getState().stack, snapshotOf(target)].slice(-MAX);
  useGoalTransformUndo.setState({ stack });
}

/** True when the last remembered placement belongs to the job's current goal. */
export function canUndoGoalPlacement(targetId: string | undefined): boolean {
  const { stack } = useGoalTransformUndo.getState();
  return targetId !== undefined && stack.length > 0 && stack[stack.length - 1]!.targetId === targetId;
}

/** Put the last remembered placement back. False when there is none for the current goal. */
export function undoGoalPlacement(): boolean {
  const target = useEngraveJobStore.getState().job.targetObject;
  if (!canUndoGoalPlacement(target?.id)) {
    // Entries for a goal that is no longer the job's can never apply: drop them.
    if (useGoalTransformUndo.getState().stack.length > 0) useGoalTransformUndo.setState({ stack: [] });
    return false;
  }
  const stack = [...useGoalTransformUndo.getState().stack];
  const snap = stack.pop()!;
  useGoalTransformUndo.setState({ stack });
  useEngraveJobStore.getState().updateTargetObject({
    rotation: snap.rotation,
    rotationX: snap.rotationX,
    rotationY: snap.rotationY,
    scale: snap.scale ?? null,
    position: snap.position,
  });
  return true;
}

/** Test seam: forget every remembered placement. */
export function resetGoalTransformUndo(): void {
  useGoalTransformUndo.setState({ stack: [] });
}
