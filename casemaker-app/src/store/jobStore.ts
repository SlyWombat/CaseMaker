import { create } from 'zustand';
import type { MeshNode, MeshStats } from '@/types';
import type { PlacementReport } from '@/engine/compiler/placementValidator';
import type { SmartCutoutDecision } from '@/engine/compiler/smartCutoutLayout';
import type { SplitOffer } from '@/engine/compiler/buildPlan';
import type { StackConnectorReport } from '@/engine/compiler/stackConnector';
import type { ClashStatement } from '@/engine/compiler/caseClashes';

export type JobStatus = 'idle' | 'rebuilding' | 'error';

export interface JobState {
  generation: number;
  status: JobStatus;
  error: string | null;
  durationMs: number;
  nodes: Map<string, MeshNode>;
  combinedStats: MeshStats | null;
  lastDiag: { meshOpsSeen: number; note?: string; componentSummary?: string } | null;
  /**
   * Issue #51 — diagnostics produced by the compiler are carried through to
   * the UI here, instead of having consumers re-run validatePlacements on
   * every render or read from module-level mutable state.
   */
  placementReport: PlacementReport | null;
  smartCutoutDecisions: SmartCutoutDecision[];
  /**
   * Issue #148 — the split the current bed can have, as the COMPILER decided
   * it, or null when the shell fits. The export modal reads the offer from
   * here rather than re-deriving it from the mesh bounds: only the compiler
   * knows the case's own keep-outs, and only it can say whether a seam exists.
   */
  splitOffer: SplitOffer | null;
  /**
   * Issue #149 — the stacking connector's placed sockets and statements, as
   * the compiler laid them out against the case's real features; null when the
   * project asks for no connector.
   */
  connector: StackConnectorReport | null;
  /** The compiler's clash statements for magnets and dividers (empty when none). */
  clashes: ClashStatement[];
  /**
   * Issue #265 — the LID's split offer, decided by the compiler alongside the
   * shell's. Both can be present: one over-bed part does not make the other.
   */
  lidSplitOffer: SplitOffer | null;
  setStatus: (status: JobStatus, error?: string | null) => void;
  applyResult: (
    generation: number,
    nodes: MeshNode[],
    combinedStats: MeshStats,
    durationMs: number,
    diag?: { meshOpsSeen: number; note?: string; componentSummary?: string },
    diagnostics?: {
      placementReport?: PlacementReport;
      smartCutoutDecisions?: SmartCutoutDecision[];
      splitOffer?: SplitOffer;
      connector?: StackConnectorReport;
      clashes?: ClashStatement[];
      lidSplitOffer?: SplitOffer;
    },
  ) => void;
}

export const useJobStore = create<JobState>()((set) => ({
  generation: 0,
  status: 'idle',
  error: null,
  durationMs: 0,
  nodes: new Map(),
  combinedStats: null,
  lastDiag: null,
  placementReport: null,
  smartCutoutDecisions: [],
  splitOffer: null,
  connector: null,
  clashes: [],
  lidSplitOffer: null,
  setStatus: (status, error = null) => set({ status, error }),
  applyResult: (generation, nodes, combinedStats, durationMs, diag, diagnostics) =>
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
        lastDiag: diag ?? null,
        placementReport: diagnostics?.placementReport ?? null,
        smartCutoutDecisions: diagnostics?.smartCutoutDecisions ?? [],
        splitOffer: diagnostics?.splitOffer ?? null,
        connector: diagnostics?.connector ?? null,
        clashes: diagnostics?.clashes ?? [],
        lidSplitOffer: diagnostics?.lidSplitOffer ?? null,
      };
    }),
}));
