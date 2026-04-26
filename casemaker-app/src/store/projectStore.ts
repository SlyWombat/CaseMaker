import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { produce } from 'immer';
import type { Project, BoardProfile, CaseParameters, PortPlacement } from '@/types';
import { getBuiltinBoard } from '@/library';
import { newId } from '@/utils/id';

const DEFAULT_BOARD_ID = 'rpi-4b';

function defaultCase(): CaseParameters {
  return {
    wallThickness: 2,
    floorThickness: 2,
    lidThickness: 2,
    cornerRadius: 2,
    internalClearance: 0.5,
    zClearance: 5,
    joint: 'flat-lid',
    ventilation: { enabled: false, pattern: 'none', coverage: 0 },
    bosses: {
      enabled: true,
      insertType: 'self-tap',
      outerDiameter: 5,
      holeDiameter: 2.5,
    },
  };
}

export function createDefaultProject(boardId = DEFAULT_BOARD_ID): Project {
  const board = getBuiltinBoard(boardId);
  if (!board) throw new Error(`Unknown built-in board: ${boardId}`);
  const now = new Date(0).toISOString();
  return {
    schemaVersion: 1,
    id: newId('proj'),
    name: `${board.name} Case`,
    createdAt: now,
    modifiedAt: now,
    board: structuredClone(board),
    case: defaultCase(),
    ports: [],
    externalAssets: [],
  };
}

export interface ProjectState {
  project: Project;
  setProject: (p: Project) => void;
  patchCase: (patch: Partial<CaseParameters>) => void;
  loadBuiltinBoard: (boardId: string) => void;
  addPort: (port: PortPlacement) => void;
  removePort: (portId: string) => void;
  setBoard: (board: BoardProfile) => void;
}

export const useProjectStore = create<ProjectState>()(
  subscribeWithSelector((set) => ({
    project: createDefaultProject(),
    setProject: (p) => set({ project: p }),
    patchCase: (patch) =>
      set((s) => ({
        project: produce(s.project, (draft) => {
          Object.assign(draft.case, patch);
          draft.modifiedAt = new Date(0).toISOString();
        }),
      })),
    loadBuiltinBoard: (boardId) =>
      set(() => ({ project: createDefaultProject(boardId) })),
    addPort: (port) =>
      set((s) => ({
        project: produce(s.project, (draft) => {
          draft.ports.push(port);
        }),
      })),
    removePort: (portId) =>
      set((s) => ({
        project: produce(s.project, (draft) => {
          draft.ports = draft.ports.filter((p) => p.id !== portId);
        }),
      })),
    setBoard: (board) =>
      set((s) => ({
        project: produce(s.project, (draft) => {
          draft.board = structuredClone(board);
        }),
      })),
  })),
);
