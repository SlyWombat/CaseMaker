import { create } from 'zustand';
import type { MeshNode, MeshStats } from '@/types';

export type JobStatus = 'idle' | 'rebuilding' | 'error';

export interface JobState {
  generation: number;
  status: JobStatus;
  error: string | null;
  durationMs: number;
  nodes: Map<string, MeshNode>;
  combinedStats: MeshStats | null;
  setStatus: (status: JobStatus, error?: string | null) => void;
  applyResult: (
    generation: number,
    nodes: MeshNode[],
    combinedStats: MeshStats,
    durationMs: number,
  ) => void;
}

export const useJobStore = create<JobState>()((set) => ({
  generation: 0,
  status: 'idle',
  error: null,
  durationMs: 0,
  nodes: new Map(),
  combinedStats: null,
  setStatus: (status, error = null) => set({ status, error }),
  applyResult: (generation, nodes, combinedStats, durationMs) =>
    set(() => {
      const map = new Map<string, MeshNode>();
      for (const n of nodes) map.set(n.id, n);
      return {
        generation,
        status: 'idle',
        error: null,
        durationMs,
        nodes: map,
        combinedStats,
      };
    }),
}));
