import type { Project, MeshStats } from '@/types';
import {
  useProjectStore,
  undoProject,
  redoProject,
  canUndo,
  canRedo,
  clearHistory,
} from '@/store/projectStore';
import { useJobStore } from '@/store/jobStore';
import {
  setDebounce,
  getDebounce,
  getGeneration,
  scheduleImmediate,
  waitForIdle,
} from '@/engine/jobs/JobScheduler';
import { resetSeed, setSeededIds } from '@/utils/id';
import { triggerExport } from '@/engine/exportTrigger';
import { isZUp } from '@/engine/coords';
import { serializeProject, parseProject } from '@/store/persistence';
import { importStlFile } from '@/engine/import/assetImporter';
import type { SmartCutoutDecision } from '@/engine/compiler/smartCutoutLayout';
import { useSettingsStore } from '@/store/settingsStore';
import { useViewportStore } from '@/store/viewportStore';
import { useSimStore, type SimLayers, type SimState } from '@/store/simStore';
import { useSimSetupStore, buildSimSetup } from '@/store/simSetupStore';
import { checkpointAtStep } from '@/components/viewport/simGeometry';
import { libraryTool } from '@/engine/cnc/toolLibrary';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import { stubSetup, Z1 } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';
import { rectProfile } from '@/engine/compiler/profile';

export interface SceneNodeSummary {
  id: string;
  triangleCount: number;
  vertexCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /** Issue #88 — surface Manifold.decompose() count per node so the
   *  templates-smoke harness can assert no node ships with loose pieces. */
  componentCount?: number;
}

export interface CaseMakerTestApi {
  apiVersion: 1;
  isTestMode(): boolean;
  isZUp(): boolean;
  getProject(): Project;
  setProject(p: Project): Promise<void>;
  patchCase(patch: Partial<Project['case']>): Promise<void>;
  loadBuiltinBoard(id: string): Promise<void>;
  getMeshStats(node: 'shell' | 'lid' | 'all'): MeshStats | null;
  getSceneGraph(): SceneNodeSummary[];
  setDebounce(ms: number): void;
  getDebounce(): number;
  getGeneration(): number;
  waitForIdle(): Promise<void>;
  triggerExport(format: 'stl-binary' | 'stl-ascii' | '3mf'): Promise<void>;
  resetSeed(seed?: number): void;
  serializeProject(): string;
  loadSerializedProject(json: string): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  canUndo(): boolean;
  canRedo(): boolean;
  clearHistory(): void;
  cloneBoardForEditing(): Promise<void>;
  patchBoardPcb(patch: { x?: number; y?: number; z?: number }): Promise<void>;
  addMountingHole(): Promise<void>;
  importStlAsset(name: string, base64: string): Promise<string>;
  getLastDiag(): { meshOpsSeen: number; note?: string; componentSummary?: string } | null;
  getJobError(): string | null;
  getSmartCutoutDecisions(): SmartCutoutDecision[];
  getSettings(): { port: number; bindToAll: boolean };
  setPortSetting(port: number): void;
  setExportLayout(mode: 'print-ready' | 'assembled'): void;
  /** Issue #163 — shell/lid shading: 'xray' (default) or 'solid'. */
  setShellRender(mode: 'xray' | 'solid'): void;
  getShellRender(): 'xray' | 'solid';
  selectPort(portId: string | null): void;
  getSelectedPortId(): string | null;
  patchPort(
    portId: string,
    patch: { position?: { x?: number; y?: number; z?: number } },
  ): Promise<void>;
  addHat(hatId: string): Promise<string>;
  removeHat(placementId: string): Promise<void>;
  patchHat(
    placementId: string,
    patch: { enabled?: boolean; liftOverride?: number },
  ): Promise<void>;
  getHats(): import('@/types').HatPlacement[];
  getLidVisible(): boolean;
  setLidVisible(v: boolean): void;
  setHatMountingPosition(placementId: string, mountingPositionId: string): Promise<void>;
  /**
   * #193 — prove the sim worker shell in a real `Worker`. Loads a program through
   * `useSimStore`, waits for a terminal status, and reports what the store holds. The count and
   * volume are plain store data, so this exercises `sim.worker.ts` + Comlink + the store, not
   * just `session.ts` in-process.
   */
  simSmoke(gcode: string): Promise<{ status: string; count: number; removedVolume: number; errors: number }>;
  /**
   * #199 — the sim e2e surface. `simOpenText` pre-fills the Simulate form from a file's header,
   * `simRun` presses the same code path as the panel's Simulate button, `simSetStep` moves the
   * scrubber and resolves once the material for that position is on screen, and `getSimState`
   * reports what the store holds. Assertions on the material go through `getSimState`, never
   * through pixel colours.
   */
  simOpenText(name: string, text: string): void;
  simRun(): Promise<void>;
  simSetStep(step: number): Promise<void>;
  getSimState(): {
    status: SimState['status'];
    step: number;
    k: number;
    count: number;
    removedVolume: number;
    errorCodes: string[];
    gougeCount: number;
    pathVertexCount: number;
    visibleLayers: SimLayers;
  };
}

/**
 * Volume of a closed triangle mesh in mm³, about its bbox centre to keep float32 error down —
 * the same rule `tests/unit/simFixtures.spec.ts` uses. A `SimFrame`'s `removalSoFar` is the
 * cumulative removal solid, so its volume is the material removed at that checkpoint.
 */
function meshVolume(m: NodeMeshOutput): number {
  const c = [0, 1, 2].map((i) => ((m.bbox.min[i] as number) + (m.bbox.max[i] as number)) / 2);
  const p = (i: number) => [0, 1, 2].map((a) => (m.positions[i * 3 + a] as number) - (c[a] as number));
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = p(m.indices[t] as number);
    const b = p(m.indices[t + 1] as number);
    const d = p(m.indices[t + 2] as number);
    v += a[0]! * (b[1]! * d[2]! - b[2]! * d[1]!) - a[1]! * (b[0]! * d[2]! - b[2]! * d[0]!) + a[2]! * (b[0]! * d[1]! - b[1]! * d[0]!);
  }
  return v / 6;
}

/**
 * The material removed at the store's current position (#199). At the final step the viewport
 * shows the load's finished `result` and the load's own total is exact; before that the current
 * frame's cumulative removal mesh is the truth (the same source `SimMeshes` draws).
 */
function removedVolumeAt(s: Pick<SimState, 'info' | 'step' | 'frame'>): number {
  if (!s.info) return 0;
  const lastStep = s.info.summary.steps - 1;
  if (lastStep >= 0 && s.step >= lastStep) return s.info.stats.removedVolume;
  const k = checkpointAtStep(s.info.checkpoints, s.step);
  if (k < 0) return 0;
  const f = s.frame;
  return f && f.k === k && f.removalSoFar ? meshVolume(f.removalSoFar) : 0;
}

export function installCaseMakerTestApi(): void {
  if (typeof window === 'undefined') return;
  const isE2E = import.meta.env.VITE_E2E === '1' || import.meta.env.MODE === 'test';
  if (isE2E) {
    setSeededIds(true);
    setDebounce(0);
  }

  const api: CaseMakerTestApi = {
    apiVersion: 1,
    isTestMode: () => isE2E,
    isZUp,
    getProject: () => useProjectStore.getState().project,
    async setProject(p) {
      useProjectStore.getState().setProject(p);
      await scheduleImmediate(p);
      await waitForIdle();
    },
    async patchCase(patch) {
      useProjectStore.getState().patchCase(patch);
      await waitForIdle();
    },
    async loadBuiltinBoard(id) {
      useProjectStore.getState().loadBuiltinBoard(id);
      await waitForIdle();
    },
    getMeshStats(node) {
      const job = useJobStore.getState();
      if (node === 'all') return job.combinedStats;
      const n = job.nodes.get(node);
      return n ? n.stats : null;
    },
    getSceneGraph() {
      const job = useJobStore.getState();
      const out: SceneNodeSummary[] = [];
      for (const n of job.nodes.values()) {
        out.push({
          id: n.id,
          triangleCount: n.stats.triangleCount,
          vertexCount: n.stats.vertexCount,
          bbox: n.stats.bbox,
          componentCount: n.stats.componentCount,
        });
      }
      return out;
    },
    setDebounce,
    getDebounce,
    getGeneration,
    waitForIdle,
    triggerExport,
    resetSeed: (seed = 0) => resetSeed(seed),
    serializeProject: () => serializeProject(useProjectStore.getState().project),
    async loadSerializedProject(json: string) {
      const p = parseProject(json);
      useProjectStore.getState().setProject(p);
      clearHistory();
      await scheduleImmediate(p);
      await waitForIdle();
    },
    async undo() {
      undoProject();
      await waitForIdle();
    },
    async redo() {
      redoProject();
      await waitForIdle();
    },
    canUndo,
    canRedo,
    clearHistory,
    async cloneBoardForEditing() {
      useProjectStore.getState().cloneBoardForEditing();
      await waitForIdle();
    },
    async patchBoardPcb(patch) {
      useProjectStore.getState().patchBoardPcb(patch);
      await waitForIdle();
    },
    async addMountingHole() {
      useProjectStore.getState().addMountingHole();
      await waitForIdle();
    },
    getLastDiag: () => useJobStore.getState().lastDiag,
    getJobError: () => useJobStore.getState().error,
    getSmartCutoutDecisions: () => useJobStore.getState().smartCutoutDecisions,
    async importStlAsset(name, base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], name, { type: 'model/stl' });
      const asset = await importStlFile(file);
      useProjectStore.getState().addExternalAsset(asset);
      await waitForIdle();
      return asset.id;
    },
    getSettings: () => {
      const s = useSettingsStore.getState();
      return { port: s.port, bindToAll: s.bindToAll };
    },
    setPortSetting: (port) => {
      useSettingsStore.getState().setPort(port);
    },
    setShellRender: (mode) => {
      useViewportStore.getState().setShellRender(mode);
    },
    getShellRender: () => useViewportStore.getState().shellRender,
    setExportLayout: (mode) => {
      useSettingsStore.getState().setExportLayout(mode);
    },
    selectPort: (portId) => {
      useViewportStore.getState().selectPort(portId);
    },
    getSelectedPortId: () => useViewportStore.getState().selectedPortId,
    getLidVisible: () => useViewportStore.getState().showLid,
    setLidVisible: (v) => {
      useViewportStore.getState().setShowLid(v);
    },
    async setHatMountingPosition(placementId, mountingPositionId) {
      useProjectStore.getState().patchHat(placementId, { mountingPositionId });
      await waitForIdle();
    },
    async patchPort(portId, patch) {
      useProjectStore.getState().patchPort(portId, patch);
      await waitForIdle();
    },
    async addHat(hatId) {
      const before = useProjectStore.getState().project.hats.length;
      useProjectStore.getState().addHat(hatId);
      await waitForIdle();
      const hats = useProjectStore.getState().project.hats;
      return hats[before]?.id ?? '';
    },
    async removeHat(placementId) {
      useProjectStore.getState().removeHat(placementId);
      await waitForIdle();
    },
    async patchHat(placementId, patch) {
      useProjectStore.getState().patchHat(placementId, patch);
      await waitForIdle();
    },
    getHats: () => useProjectStore.getState().project.hats,
    async simSmoke(gcode) {
      const setup = stubSetup(
        { kind: 'prism', outline: rectProfile(40, 20), thickness: 5 },
        { kind: 'tape-down', contact: rectProfile(40, 20) },
        { startingTool: 1 },
        Z1,
      );
      // Subscribe BEFORE loading. `loadProgram` sets `loading` synchronously and only reaches a
      // terminal status across a worker round-trip, so nothing can be missed from here on.
      const settled = new Promise<void>((resolve) => {
        const unsubscribe = useSimStore.subscribe((s) => {
          if (s.status === 'ready' || s.status === 'refused' || s.status === 'error') {
            unsubscribe();
            resolve();
          }
        });
      });
      void useSimStore.getState().loadProgram(gcode, setup, flatEndMill(3.175), Z1.id);
      await settled;
      const s = useSimStore.getState();
      return {
        status: s.status,
        count: s.info?.count ?? 0,
        removedVolume: s.info?.stats.removedVolume ?? 0,
        errors: s.diagnostics.filter((d) => d.severity === 'error').length,
      };
    },
    simOpenText(name, text) {
      useSimSetupStore.getState().openFile(name, text);
    },
    async simRun() {
      const setupState = useSimSetupStore.getState();
      const tool = setupState.toolKey ? libraryTool(setupState.toolKey) : null;
      if (!setupState.gcodeText || !tool) return;
      // Subscribe BEFORE loading: `loadProgram` sets `loading` synchronously and only reaches a
      // terminal status across a worker round-trip, so no transition can be missed from here on.
      const settled = new Promise<void>((resolve) => {
        const unsubscribe = useSimStore.subscribe((s) => {
          if (s.status !== 'loading' && s.status !== 'idle') {
            unsubscribe();
            resolve();
          }
        });
      });
      void useSimStore
        .getState()
        .loadProgram(setupState.gcodeText, buildSimSetup(setupState.stock, 'unknown'), tool, Z1.id);
      await settled;
    },
    async simSetStep(step) {
      const before = useSimStore.getState().k;
      useSimStore.getState().setStep(step);
      const targetK = useSimStore.getState().k;
      // No checkpoint changed: the frame already on screen IS the frame for this position.
      if (targetK === before) return;
      // A seek was issued. Resolve only when the frame for that checkpoint has arrived — waiting
      // on `k` alone would resolve against the stale previous frame (the seek sets `k` first).
      await new Promise<void>((resolve) => {
        const unsubscribe = useSimStore.subscribe((s) => {
          if (s.frame && s.frame.k === targetK) {
            unsubscribe();
            resolve();
          }
        });
      });
    },
    getSimState() {
      const s = useSimStore.getState();
      return {
        status: s.status,
        step: s.step,
        k: s.k,
        count: s.info?.count ?? 0,
        removedVolume: removedVolumeAt(s),
        errorCodes: s.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
        gougeCount: s.meshes?.gouges.length ?? 0,
        pathVertexCount: s.path?.step.length ?? 0,
        visibleLayers: s.layers,
      };
    },
  };

  (window as unknown as { __caseMaker: CaseMakerTestApi }).__caseMaker = api;
}

declare global {
  interface Window {
    __caseMaker?: CaseMakerTestApi;
  }
}
