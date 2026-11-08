import { simTurningRadians } from '@/components/viewport/rotarySimView';
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
import { GRBL_PRESETS } from '@/engine/cnc/machine';
import { machineRecordFromPreset } from '@/platform/genericMachines';
import { triggerExport } from '@/engine/exportTrigger';
import { isZUp } from '@/engine/coords';
import { serializeProject, parseProject } from '@/store/persistence';
import { importStlFile } from '@/engine/import/assetImporter';
import type { SmartCutoutDecision } from '@/engine/compiler/smartCutoutLayout';
import { useSettingsStore } from '@/store/settingsStore';
import { useViewportStore } from '@/store/viewportStore';
import { useSimStore, type SimLayers, type SimState } from '@/store/simStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { placedSize, targetTurns } from '@/engine/cnc/engrave/targetScale';
import { goalHandleCentreClientPoint, goalHandleClientPoint } from '@/components/viewport/goalHandleFrame';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useEngraveRunStore, gateViewFor, saveBlocker, runErrorCodes } from '@/store/engraveRunStore';
import { useMachineRunStore } from '@/store/machineRunStore';
import { programHash } from '@/engine/cnc/programHash';
import { jobMachine } from '@/engine/cnc/calibration';
import { useRunRecordStore } from '@/store/runRecordStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useSimSetupStore, buildSimSetup } from '@/store/simSetupStore';
import { checkpointAtStep } from '@/components/viewport/simGeometry';
import { getTools, resolveTool, setRegistry } from '@/engine/cnc/toolRegistry';
import { setFeedCatalogue, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { useToolRegistryStore, type HouseStatus } from '@/store/toolRegistryStore';
import { useManageModeStore } from '@/store/manageModeStore';
import { useMachineStore } from '@/store/machineStore';
import { machineRecordByProfile, useLocationStore } from '@/store/locationStore';
import { useShopDefaultsStore } from '@/store/shopDefaultsStore';
import { planRegistration } from '@/engine/cnc/registration/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { probeFor } from '@/engine/cnc/registration/mountContext';
import { machineSize, materializeSetups, planFromSetups, setupsSettings } from '@/engine/cnc/setups';
import type { MachineObservation } from '@/platform/machineProbe';
import { releaseFileName } from '@/engine/cnc/engrave/release';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
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
  /**
   * #206 — the engrave-run e2e surface. `engraveReset` puts the deterministic default job (#200)
   * on screen and forgets any run, so a spec starts from a known state regardless of what earlier
   * tests left in localStorage. `getEngraveRunState` reports the run's own words, so assertions
   * never read pixels.
   */
  engraveReset(): void;
  /**
   * #743 P-6 — SEED THE BENCH for an e2e: the tool registry and Makera's rows. A PCB has no
   * starting-table row (P-1), so a board only generates against a cutter the catalogue answers;
   * a spec that must watch a board post needs this seam. Test-only, like everything here.
   */
  seedCutters(entries: readonly ToolLibraryEntry[], rows: readonly FeedCatalogueRow[]): void;

  /**
   * #688 — the clearance acknowledgement's UI home is Cut step 1 (#689). Until that step is on
   * screen, the Design e2e specs cannot tick it there; this writes the same run-store field the
   * Cut statement writes, so the Save path stays testable. Testing surface only: no app code calls
   * it, and `saveBlocker`'s gate is untouched.
   */
  /**
   * #530/#656/#659 e2e — a connected machine WITHOUT one. E2E has no controller, and the Cut one
   * screen, the status strip and its state popover are all gated on `machine !== null`; this puts
   * the observation a probe would have written on the store, and (optionally) the live line a
   * heartbeat would have read. Testing surface only: no app code calls it.
   */
  setMachine(observation: MachineObservation, statusLine?: string): void;
  /**
   * #656 e2e — the FROZEN program as the Cut one screen names it: the file name and the cutter's
   * display name, computed by the same functions that screen uses. A spec cannot know which cutter
   * the first Generate recommended any other way. Null until a package is frozen.
   */
  getFrozenProgram(): { filename: string; toolKey: string; cutterName: string } | null;
  /**
   * #723 R-4 e2e — THE PROGRAM TEXT the run produced, exactly the bytes Save would write. A rotary
   * job's Save is refused by the bench line (#545/#240: simulate-only), so an e2e that wants to
   * carry the relief program into Simulate has no other door; this is the run store's own field.
   * Testing surface only: no app code calls it.
   */
  engraveProgramText(): string | null;
  /**
   * #723 R-4 e2e — the engrave PREVIEW's own state, so a spec can tell "the picture has not been
   * built yet" from "the picture is wrong". Testing surface only.
   */
  engravePreviewState(): { status: string; error: string | null };
  /**
   * #831 e2e — the goal's turns (degrees), position and placed size (mm), and the client pixel of a
   * point on its on-canvas handles (a ring at `value` degrees, an arrow at `value` mm), or null
   * while the handles are not drawn. Testing surface only.
   */
  engraveTargetPlacement(): {
    turns: { x: number; y: number; z: number };
    position: { x: number; y: number; z: number };
    placed: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number } | null;
  } | null;
  engraveGoalHandlePoint(kind: 'ring' | 'arrow', axis: 'x' | 'y' | 'z', value: number): { x: number; y: number } | null;
  /** #876 e2e — the goal compass centre's client pixel; the scale band is measured from it. */
  engraveGoalHandleCentre(): { x: number; y: number } | null;
  /** #723 R-4 e2e — the open job's target object as the stores hold it (bytes included?). */
  engraveTargetState(): { role: string | null; enabled: boolean; format: string; hasData: boolean } | null;
  /**
   * #888 e2e — the job's setups and each side's goal, with the depth band that side cuts (mm) and
   * the pin count it registers on. Lets a spec prove the budget split BUILT two bands without
   * waiting for two programs at the budget edge to generate.
   */
  engraveSetups(): { id: string; goalId: string | null; bandMm: number | null; pinCount: number }[];
  /**
   * #811 e2e — THE GOAL'S DRAWING as the preview worker built it: the mode and the two volumes'
   * closed-form sizes (mm³). A spec can then tell "the picture changed with the mode toggle" from
   * "the legend's word changed", without reading pixels. Null until a goal drawing exists.
   */
  engraveGoalDrawing(): {
    mode: 'item' | 'mold';
    partVolumeMm3: number | null;
    removedVolumeMm3: number | null;
  } | null;
  /**
   * #816 — PREPARE A MACHINE RUN without an upload, so an e2e can drive the run panel against a
   * fake console (tests/e2e/fixtures/fakeConsole.ts). The same store seam the upload's last step
   * uses; testing surface only, no app code calls it.
   */
  machineRunPrepare(host: string, port: number, filename: string, nc: string): boolean;
  /**
   * #827 e2e — SEED THE REGISTER STEP'S CENTRE PANEL: a measured 3D probe checked out to the Z1's
   * location record, and the open job's first setup planned through the app's OWN setup planner
   * with an approved tape registration plan attached. Returns the plan's estimate (work XY) so a
   * spec can hand the fake machine the same feature centre.
   */
  centrePanelSeed(host: string, port: number): { x: number; y: number } | { reason: string } | null;
  /**
   * #607 e2e — SEED THE ROTARY TAP: a Z1 record with an address and an ACTIVE bed profile whose
   * surface top is measured, the 3D probe and the 4th-axis module checked out to the same machine.
   * Returns the module's id so a spec can open its card in Manage › Accessories.
   */
  rotaryTapSeed(): { machineId: string; moduleId: string };
  /**
   * #877 e2e — A STATED PRESET IN THE LOCATION, and the open job pointed at it. The record is the
   * one the preset picker writes (`machineRecordFromPreset`), so the sheet and the preview read
   * the same profile a person choosing Shapeoko would. Returns the profile id the job now names,
   * or a reason the id is not a shipped stated preset.
   */
  statedMachineSeed(profileId: string): { machineId: string } | { reason: string };
  getEngraveRunState(): {
    phase: string;
    stale: boolean;
    stage: string | null;
    ok: boolean;
    operations: number | null;
    cuttingMoves: number | null;
    /** #667 — the run's files in cut order (a rest pair is 2, a one-cutter job 1). */
    programs: number;
    verifyErrors: number;
    simStatus: string | null;
    oracleOk: boolean | null;
    worst: { underCut: number; overCut: number } | null;
    canSave: boolean;
    saveReason: string | null;
    error: string | null;
    /**
     * #1032 — each program's own sweep facts, in cut order: the engine that swept it, whether it
     * restarted from the blank, and whether the earlier setup's carried floor was still supplied
     * to that restart. The e2e walk pins the multi-side carry through these, not only through the
     * panel's prose.
     */
    simPrograms: {
      label: string;
      engine: string | null;
      fromBlank: boolean;
      carriedFloor: boolean;
      seedFrom: string | null;
      /** #1050 — which route seeded it: 'field', 'removal' (the exact route), or null. */
      seedRoute: 'field' | 'removal' | null;
    }[];
    /**
     * #1041/#1042 — THE PLAN'S OWN WORDS, so a spec can assert what the plan did NOT say: the
     * notes carry the seam's house note (the built-in fallback) and every typed statement's text;
     * the codes name the statements (a chosen cutter the shop does not own is one).
     */
    planNotes: string[];
    planStatementCodes: string[];
  };
  /**
   * #277 — the run-record half of the engrave e2e surface. `openRunRecordText` hands the app the
   * text of a run record file, exactly as the panel's "Open run record…" does, so a spec can drive
   * the whole round trip: Save, fill the record, open it, read the measured line beside the
   * estimate. It returns the same result the panel shows, so a spec can assert a REFUSAL too.
   */
  openRunRecordText(text: string): { ok: boolean; reason: string | null; ncFile: string | null };
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
    /** #241 slice 3 — the viewport's stock-group turn about X at the current step, degrees (0 flat / Unroll). */
    turningDeg: number;
    /** #241 slice 3 — each run's A and step span, so a spec can scrub inside a face. */
    runs: { a: number | null; firstStep: number; lastStep: number }[];
    visibleLayers: SimLayers;
  };
  /**
   * #306 — what the app concluded about a house service, and what that did to the tool list. The
   * probe's outcome is otherwise invisible in a browser: an absent service is a quiet fallback,
   * not a rendered message, so a spec would have nothing to assert but pixels. `registryKeys` is
   * what every picker reads (`getTools()`), `houseKeys` only the tiers the service supplied — so a
   * single call proves both the conclusion and its effect on the registry.
   */
  getToolRegistry(): {
    status: HouseStatus;
    error: string | null;
    /** The last validator `GET /api/v1/tools` returned, or null if it was never read. */
    etag: string | null;
    houseKeys: string[];
    registryKeys: string[];
  };
  /**
   * #311 — enter and leave the Manage surface from a script. The toolbar button is the way in for a
   * person, and a spec drives that button too; this is for the cases where the button is not the
   * point (the compact layout hides it behind ⋯) and for getting to one scope in a single call.
   */
  openManage(scope?: 'tools' | 'accessories' | 'materials' | 'machines'): void;
  closeManage(): void;
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
    seedCutters(entries, rows) {
      setRegistry(entries);
      setFeedCatalogue(rows, '2026-10-31T00:00:00.000Z');
    },
    engraveReset() {
      // The pure default job (#200), not `newDefaultJob()`: the latter reads the SAVED setup from
      // settings, so a measured vise or sacrificial setup left by an earlier test would leak in.
      useEngraveJobStore.getState().replace(defaultEngraveJob());
      useEngraveRunStore.getState().reset();
      // #277 — records opened by an earlier test live in localStorage, where they would otherwise
      // put a "last measured" line under a later test's estimate.
      useRunRecordStore.getState().clear();
    },
    setMachine(observation, statusLine) {
      // The app's own "a check found it" path (and its persistence), then the live line the
      // heartbeat would have read — the strip's monitor rows come from `S:` on that line.
      useMachineStore.getState().setProbeResult({ kind: 'found', observation, calibration: null, route: 'manual' });
      if (statusLine !== undefined) useMachineStore.getState().noteLiveStatusLine(statusLine);
    },
    getFrozenProgram() {
      const job = useEngraveJobStore.getState().job;
      const toolKey = job.package?.programs[0]?.toolKey ?? null;
      if (toolKey === null) return null;
      const tool = resolveTool(toolKey);
      return {
        filename: releaseFileName(job.name, 1, 1, false),
        toolKey,
        cutterName: tool === null ? toolKey : toolDisplayName(tool),
      };
    },
    openRunRecordText(text) {
      const result = useRunRecordStore.getState().openText(text);
      return result.ok
        ? { ok: true, reason: null, ncFile: result.run.ncFile }
        : { ok: false, reason: result.reason, ncFile: null };
    },
    engraveProgramText() {
      return useEngraveRunStore.getState().generated?.nc ?? null;
    },
    engravePreviewState() {
      const p = useEngravePreviewStore.getState();
      return { status: p.status, error: p.error };
    },
    engraveTargetState() {
      const t = useEngraveJobStore.getState().job.targetObject;
      if (t === undefined) return null;
      return { role: t.role ?? null, enabled: t.enabled, format: t.format, hasData: t.data !== undefined };
    },
    engraveSetups() {
      const job = useEngraveJobStore.getState().job;
      const goals = job.targetObjects ?? (job.targetObject === undefined ? [] : [job.targetObject]);
      return (job.setups ?? []).map((setup) => {
        const goal = goals.find((g) => g.setupId === setup.id) ?? null;
        return {
          id: setup.id,
          goalId: goal?.id ?? null,
          bandMm: goal?.bandMm ?? null,
          pinCount: setup.pins?.at.length ?? 0,
        };
      });
    },
    engraveTargetPlacement() {
      const t = useEngraveJobStore.getState().job.targetObject;
      if (t === undefined) return null;
      return { turns: targetTurns(t), position: { ...t.position }, placed: placedSize(t), scale: t.scale ?? null };
    },
    engraveGoalHandlePoint(kind, axis, value) {
      return goalHandleClientPoint(kind, axis, value);
    },
    engraveGoalHandleCentre() {
      return goalHandleCentreClientPoint();
    },
    engraveGoalDrawing() {
      const goal = useEngravePreviewStore.getState().preview?.goal ?? null;
      if (goal === null) return null;
      return {
        mode: goal.mode,
        partVolumeMm3: goal.part === null ? null : Math.abs(meshVolume(goal.part)),
        removedVolumeMm3: goal.removed === null ? null : Math.abs(meshVolume(goal.removed)),
      };
    },
    machineRunPrepare(host, port, filename, nc) {
      return useMachineRunStore.getState().prepare({ host, port }, filename, programHash(nc), { nc });
    },
    centrePanelSeed(host, port) {
      void host;
      void port;
      const probe = {
        id: 'fx-probe-3d',
        kind: 'probe',
        product: 'Makera 3D Probe',
        variant: '3d',
        unit: { tipDiameterMm: 2, rimOffsetMm: 0.875, rimOffsetUncertaintyMm: 0.01 },
        whereabouts: { kind: 'machine', machineId: 'e2e-machine' },
        provenance: {},
      };
      const machine = {
        id: 'e2e-machine',
        name: 'QA Z1',
        profileId: 'Z1',
        // The registration step resolves the record by the ADDRESS the check reached (`machineAt`).
        address: { host: '192.0.2.10', port: 2222 },
        whereabouts: { kind: 'bench' },
        unit: {},
        provenance: {},
      };
      useLocationStore.setState({
        status: 'ready',
        location: { machines: [machine], accessories: [probe], stock: [], tools: [] } as never,
        etag: '"e2e"',
      } as never);
      const job = useEngraveJobStore.getState().job;
      const defaults = useShopDefaultsStore.getState().defaults;
      // Two of the app's own forms: the PLANNER's setup (rotation + stock states, for the stock's
      // size as mounted) and the document's JobSetup (the full shape the Setups section writes).
      const rich = planFromSetups(job, setupsSettings(useShopDefaultsStore.getState().defaults), undefined).setups[0];
      const setups = materializeSetups(job);
      const first = setups[0];
      if (rich === undefined || first === undefined) return { reason: 'the open job has no setup to plan against' };
      const dims = machineSize(rich.rotation, rich.stockBefore.bounds);
      const probeSpec = probeFor(machineRecordByProfile('Z1'));
      const made = planRegistration(
        {
          stock: { xMin: 0, yMin: 0, xMax: dims.x, yMax: dims.y, cornerRadius: 0 },
          mount: 'tape',
          expectedSurface: { machineZ: -8, from: 'the e2e fixture' },
          seekFromMachineZ: -3,
          stockThicknessMm: dims.z,
          probe: probeSpec,
        },
        registrationSettings(defaults, probeSpec).settings,
      );
      if (!made.ok) return { reason: made.reason };
      useEngraveJobStore.setState((state) => ({
        job: {
          ...state.job,
          setups: [{ ...first, registration: { method: 'tape', plan: made.plan, expected: 'the e2e fixture' } }, ...setups.slice(1)],
        },
      }));
      return { x: made.plan.surfacePoint.x, y: made.plan.surfacePoint.y };
    },
    rotaryTapSeed() {
      const now = '2026-10-31T00:00:00.000Z';
      // The bench's own shapes: the 3D probe's measured tip/rim (#789/#827), and the module checked
      // out to the Z1 it is fitted to.
      const probe = {
        id: 'fx-probe-3d',
        kind: 'probe',
        product: 'Makera 3D Probe',
        variant: '3d',
        unit: { tipDiameterMm: 2, rimOffsetMm: 0.875, rimOffsetUncertaintyMm: 0.01 },
        whereabouts: { kind: 'machine', machineId: 'e2e-machine', since: now },
        provenance: {},
        history: [],
      };
      const module = {
        id: 'e2e-rotary',
        kind: 'rotary-module',
        product: 'Makera 4th-axis module',
        variant: null,
        constants: {},
        unit: { axisXMm: -150 },
        provenance: {},
        whereabouts: { kind: 'machine', machineId: 'e2e-machine', since: now },
        history: [],
      };
      const machine = {
        id: 'e2e-machine',
        name: 'QA Z1',
        profileId: 'Z1',
        // The tap resolves the record by the ADDRESS the check reached (`machineAt`).
        address: { host: '192.0.2.10', port: 2222 },
        whereabouts: { kind: 'bench' },
        unit: {},
        provenance: {},
        activeBedProfileId: 'bed-e2e',
        bedProfiles: [
          {
            id: 'bed-e2e',
            name: 'QA bed',
            createdAt: now,
            basedOn: null,
            surface: { kind: 'bare-bed' },
            datums: {
              surfaceTopZ: { value: -76, measuredAt: now, by: 'fx-probe-3d', at: null },
              viseJawTopZ: null,
              bracketSeatZ: null,
              rotaryAxis: null,
              rotaryFaceAngle: null,
            },
            placements: [],
            preferredMounting: [],
            consumables: null,
            history: [],
          },
        ],
      };
      useLocationStore.setState({
        status: 'ready',
        location: { machines: [machine], accessories: [probe, module], stock: [], tools: [] } as never,
        etag: '"e2e"',
      } as never);
      return { machineId: machine.id, moduleId: module.id };
    },
    statedMachineSeed(profileId) {
      const model = GRBL_PRESETS.find((p) => p.id === profileId);
      if (model === undefined) return { reason: `${profileId} is not a shipped stated preset` };
      const record = machineRecordFromPreset(model, { id: 'e2e-stated', now: '2026-11-01T00:00:00.000Z' });
      useLocationStore.setState({
        status: 'ready',
        location: { machines: [record], accessories: [], stock: [], tools: [] } as never,
        etag: '"e2e"',
      } as never);
      // The job names the PROFILE (`machineRecordByProfile` matches on it), which is also what
      // `jobMachine` resolves the model from.
      useEngraveJobStore.setState((s) => ({ job: { ...s.job, machineId: model.id } }));
      return { machineId: model.id };
    },
    getEngraveRunState() {
      const r = useEngraveRunStore.getState();
      // #724 W5 — the gate needs the machine and the holding. Without them a rotary job read as
      // one for a machine with no module ("no rotary module" on a profile that has one).
      const job = useEngraveJobStore.getState().job;
      const view = gateViewFor(r, jobMachine(job, useSettingsStore.getState().machineCalibration ?? null), job.workholding.kind === 'rotary-chuck');
      return {
        phase: r.phase,
        stale: r.staleSince !== null,
        stage: r.generated?.stage ?? null,
        ok: r.generated?.ok ?? false,
        operations: r.generated?.cam?.operations ?? null,
        cuttingMoves: r.generated?.cam?.cuttingMoves ?? null,
        programs: r.generated?.programs.length ?? 0,
        verifyErrors: runErrorCodes(r).length,
        simStatus: r.simStatus,
        oracleOk: r.oracle?.ok ?? null,
        worst: r.oracle ? { ...r.oracle.worst } : null,
        canSave: saveBlocker(view) === null,
        saveReason: saveBlocker(view),
        error: r.error,
        simPrograms: r.simPrograms.map((p) => ({ label: p.label, engine: p.engine, fromBlank: p.fromBlank, carriedFloor: p.carriedFloor === true, seedFrom: p.seedFrom ?? null, seedRoute: p.seedRoute ?? null })),
        planNotes: r.generated?.plan?.perSetup.flatMap((setup) => setup.notes) ?? [],
        planStatementCodes: (r.generated?.planStatements ?? []).map((statement) => statement.code),
      };
    },
    simOpenText(name, text) {
      useSimSetupStore.getState().openFile(name, text);
    },
    async simRun() {
      const setupState = useSimSetupStore.getState();
      const tool = setupState.toolKey ? resolveTool(setupState.toolKey) : null;
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
        turningDeg: (simTurningRadians(s.path, s.step, s.design === 'map') * 180) / Math.PI,
        runs: (s.info?.checkpoints ?? []).map((c) => ({ a: c.a, firstStep: c.firstStep, lastStep: c.lastStep })),
        visibleLayers: s.layers,
      };
    },
    getToolRegistry() {
      const s = useToolRegistryStore.getState();
      return {
        status: s.status,
        error: s.error,
        etag: s.etag,
        houseKeys: s.entries.map((e) => e.key),
        registryKeys: getTools().map((e) => e.key),
      };
    },
    openManage(scope) {
      useManageModeStore.getState().openManage(scope);
    },
    closeManage() {
      useManageModeStore.getState().closeManage();
    },
  };

  (window as unknown as { __caseMaker: CaseMakerTestApi }).__caseMaker = api;
}

declare global {
  interface Window {
    __caseMaker?: CaseMakerTestApi;
  }
}
