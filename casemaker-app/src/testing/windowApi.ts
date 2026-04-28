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
import { getLastSmartCutoutDecisions } from '@/engine/compiler/ProjectCompiler';
import type { SmartCutoutDecision } from '@/engine/compiler/smartCutoutLayout';
import { useSettingsStore } from '@/store/settingsStore';
import { useViewportStore } from '@/store/viewportStore';

export interface SceneNodeSummary {
  id: string;
  triangleCount: number;
  vertexCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
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
  getBoardVisualization(): 'none' | 'schematic' | 'photo' | '3d';
  setBoardVisualization(mode: 'none' | 'schematic' | 'photo' | '3d'): void;
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
    getSmartCutoutDecisions: () => getLastSmartCutoutDecisions(),
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
    getBoardVisualization: () => useViewportStore.getState().boardVisualization,
    setBoardVisualization: (mode) => {
      useViewportStore.getState().setBoardVisualization(mode);
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
  };

  (window as unknown as { __caseMaker: CaseMakerTestApi }).__caseMaker = api;
}

declare global {
  interface Window {
    __caseMaker?: CaseMakerTestApi;
  }
}
