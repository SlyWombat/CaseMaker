import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { temporal } from 'zundo';
import { produce } from 'immer';
import type {
  Project,
  BoardProfile,
  CaseParameters,
  PortPlacement,
  BoardComponent,
  ComponentKind,
  Facing,
  HatPlacement,
} from '@/types';
import type { MountingFeature } from '@/types/mounting';
import { getBuiltinBoard } from '@/library';
import { getBuiltinHat } from '@/library/hats';
import { newId } from '@/utils/id';
import { autoPortsForBoard } from '@/engine/compiler/portFactory';
import { autoPortsForHat } from '@/engine/compiler/hats';
import { defaultAntennasForBoard } from '@/engine/compiler/antennas';
import { fourCornerScrewTabs } from '@/engine/compiler/mountingFeatures';
import { computeShellDims } from '@/engine/compiler/caseShell';

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
    schemaVersion: 5,
    id: newId('proj'),
    name: `${board.name} Case`,
    createdAt: now,
    modifiedAt: now,
    board: structuredClone(board),
    case: defaultCase(),
    ports: autoPortsForBoard(board),
    externalAssets: [],
    hats: [],
    customHats: [],
    mountingFeatures: [],
    display: null,
    customDisplays: [],
    fanMounts: [],
    textLabels: [],
    antennas: defaultAntennasForBoard(board),
  };
}

export interface ProjectState {
  project: Project;
  setProject: (p: Project) => void;
  patchCase: (patch: Partial<CaseParameters>) => void;
  loadBuiltinBoard: (boardId: string) => void;
  addPort: (port: PortPlacement) => void;
  removePort: (portId: string) => void;
  setPortEnabled: (portId: string, enabled: boolean) => void;
  patchPort: (
    portId: string,
    patch: { position?: Partial<{ x: number; y: number; z: number }>; locked?: boolean },
  ) => void;
  setBoard: (board: BoardProfile) => void;
  cloneBoardForEditing: () => void;
  patchBoardPcb: (patch: { x?: number; y?: number; z?: number }) => void;
  addMountingHole: () => void;
  removeMountingHole: (holeId: string) => void;
  patchMountingHole: (
    holeId: string,
    patch: { x?: number; y?: number; diameter?: number },
  ) => void;
  addExternalAsset: (asset: import('@/types').ExternalAsset) => void;
  removeExternalAsset: (assetId: string) => void;
  patchExternalAsset: (
    assetId: string,
    patch: Partial<import('@/types').ExternalAsset>,
  ) => void;
  addComponent: () => void;
  removeComponent: (componentId: string) => void;
  patchComponent: (
    componentId: string,
    patch: {
      kind?: ComponentKind;
      position?: Partial<{ x: number; y: number; z: number }>;
      size?: Partial<{ x: number; y: number; z: number }>;
      facing?: Facing;
      cutoutMargin?: number;
    },
  ) => void;
  addHat: (hatId: string) => void;
  removeHat: (placementId: string) => void;
  reorderHat: (placementId: string, newIndex: number) => void;
  patchHat: (placementId: string, patch: Partial<HatPlacement>) => void;
  setHatPortEnabled: (placementId: string, portId: string, enabled: boolean) => void;
  addMountingFeature: (feature: MountingFeature) => void;
  removeMountingFeature: (featureId: string) => void;
  patchMountingFeature: (featureId: string, patch: Partial<MountingFeature>) => void;
  applyMountingPreset: (presetId: 'four-corner-screw-tabs' | 'rear-vesa-100' | 'rear-vesa-75') => void;
  setDisplay: (displayId: string | null, framing?: import('@/types/display').DisplayFraming) => void;
  patchDisplay: (
    patch: Partial<import('@/types/display').DisplayPlacement>,
  ) => void;
  addFanMount: (size: import('@/types/fan').FanSize, face: import('@/types/fan').CaseFace) => void;
  removeFanMount: (id: string) => void;
  patchFanMount: (id: string, patch: Partial<import('@/types/fan').FanMount>) => void;
  addTextLabel: (label: import('@/types/textLabel').TextLabel) => void;
  removeTextLabel: (id: string) => void;
  patchTextLabel: (id: string, patch: Partial<import('@/types/textLabel').TextLabel>) => void;
}

export const useProjectStore = create<ProjectState>()(
  subscribeWithSelector(
    temporal(
      (set) => ({
        project: createDefaultProject(),
        setProject: (p) => set({ project: p }),
        patchCase: (patch) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              for (const [k, v] of Object.entries(patch) as [keyof CaseParameters, unknown][]) {
                (draft.case as Record<string, unknown>)[k as string] = v;
              }
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
        setPortEnabled: (portId, enabled) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              const p = draft.ports.find((x) => x.id === portId);
              if (p) p.enabled = enabled;
            }),
          })),
        patchPort: (portId, patch) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              const p = draft.ports.find((x) => x.id === portId);
              if (!p) return;
              if (patch.position) {
                if (typeof patch.position.x === 'number') p.position.x = patch.position.x;
                if (typeof patch.position.y === 'number') p.position.y = patch.position.y;
                if (typeof patch.position.z === 'number') p.position.z = patch.position.z;
              }
              if (typeof patch.locked === 'boolean') p.locked = patch.locked;
            }),
          })),
        setBoard: (board) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              draft.board = structuredClone(board);
            }),
          })),
        cloneBoardForEditing: () =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.board.builtin) return;
              draft.board.id = `custom-${draft.board.id}-${newId()}`;
              draft.board.name = `${draft.board.name} (custom)`;
              draft.board.builtin = false;
              delete draft.board.source;
            }),
          })),
        patchBoardPcb: (patch) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (draft.board.builtin) return;
              if (typeof patch.x === 'number') draft.board.pcb.size.x = patch.x;
              if (typeof patch.y === 'number') draft.board.pcb.size.y = patch.y;
              if (typeof patch.z === 'number') draft.board.pcb.size.z = patch.z;
            }),
          })),
        addMountingHole: () =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (draft.board.builtin) return;
              draft.board.mountingHoles.push({
                id: `h-${newId()}`,
                x: draft.board.pcb.size.x / 2,
                y: draft.board.pcb.size.y / 2,
                diameter: 2.75,
              });
            }),
          })),
        removeMountingHole: (holeId) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (draft.board.builtin) return;
              draft.board.mountingHoles = draft.board.mountingHoles.filter(
                (h) => h.id !== holeId,
              );
            }),
          })),
        patchMountingHole: (holeId, patch) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (draft.board.builtin) return;
              const h = draft.board.mountingHoles.find((m) => m.id === holeId);
              if (!h) return;
              if (typeof patch.x === 'number') h.x = patch.x;
              if (typeof patch.y === 'number') h.y = patch.y;
              if (typeof patch.diameter === 'number') h.diameter = patch.diameter;
            }),
          })),
        addExternalAsset: (asset) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              draft.externalAssets.push(asset);
            }),
          })),
        removeExternalAsset: (assetId) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              draft.externalAssets = draft.externalAssets.filter((a) => a.id !== assetId);
            }),
          })),
        patchExternalAsset: (assetId, patch) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              const a = draft.externalAssets.find((x) => x.id === assetId);
              if (!a) return;
              Object.assign(a, patch);
            }),
          })),
        addComponent: () =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (draft.board.builtin) return;
              const newComp: BoardComponent = {
                id: `c-${newId()}`,
                kind: 'custom',
                position: { x: 0, y: 0, z: draft.board.pcb.size.z },
                size: { x: 5, y: 5, z: 5 },
                facing: '+y',
                cutoutMargin: 0.5,
              };
              draft.board.components.push(newComp);
            }),
          })),
        removeComponent: (componentId) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (draft.board.builtin) return;
              draft.board.components = draft.board.components.filter(
                (c) => c.id !== componentId,
              );
              draft.ports = draft.ports.filter((p) => p.sourceComponentId !== componentId);
            }),
          })),
        patchComponent: (componentId, patch) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (draft.board.builtin) return;
              const c = draft.board.components.find((x) => x.id === componentId);
              if (!c) return;
              if (patch.kind) c.kind = patch.kind;
              if (patch.facing) c.facing = patch.facing;
              if (typeof patch.cutoutMargin === 'number') c.cutoutMargin = patch.cutoutMargin;
              if (patch.position) {
                if (typeof patch.position.x === 'number') c.position.x = patch.position.x;
                if (typeof patch.position.y === 'number') c.position.y = patch.position.y;
                if (typeof patch.position.z === 'number') c.position.z = patch.position.z;
              }
              if (patch.size) {
                if (typeof patch.size.x === 'number') c.size.x = patch.size.x;
                if (typeof patch.size.y === 'number') c.size.y = patch.size.y;
                if (typeof patch.size.z === 'number') c.size.z = patch.size.z;
              }
              const matchingPort = draft.ports.find((p) => p.sourceComponentId === componentId);
              if (matchingPort) {
                if (patch.kind) matchingPort.kind = patch.kind;
                if (patch.facing) matchingPort.facing = patch.facing;
                if (typeof patch.cutoutMargin === 'number')
                  matchingPort.cutoutMargin = patch.cutoutMargin;
                if (patch.position) Object.assign(matchingPort.position, patch.position);
                if (patch.size) Object.assign(matchingPort.size, patch.size);
              }
            }),
          })),
        addHat: (hatId) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.hats) draft.hats = [];
              if (!draft.customHats) draft.customHats = [];
              const profile =
                draft.customHats.find((h) => h.id === hatId) ?? getBuiltinHat(hatId);
              if (!profile) return;
              const placementId = `hat-${newId()}`;
              const stackIndex = draft.hats.length;
              draft.hats.push({
                id: placementId,
                hatId,
                stackIndex,
                ports: autoPortsForHat(profile, placementId),
                enabled: true,
              });
            }),
          })),
        removeHat: (placementId) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.hats) return;
              draft.hats = draft.hats.filter((h) => h.id !== placementId);
              draft.hats.forEach((h, i) => {
                h.stackIndex = i;
              });
            }),
          })),
        reorderHat: (placementId, newIndex) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.hats) return;
              const ordered = [...draft.hats].sort((a, b) => a.stackIndex - b.stackIndex);
              const idx = ordered.findIndex((h) => h.id === placementId);
              if (idx === -1) return;
              const [moved] = ordered.splice(idx, 1);
              ordered.splice(Math.max(0, Math.min(newIndex, ordered.length)), 0, moved!);
              ordered.forEach((h, i) => {
                h.stackIndex = i;
              });
              draft.hats = ordered;
            }),
          })),
        patchHat: (placementId, patch) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.hats) return;
              const h = draft.hats.find((x) => x.id === placementId);
              if (!h) return;
              if (typeof patch.enabled === 'boolean') h.enabled = patch.enabled;
              if (typeof patch.liftOverride === 'number' || patch.liftOverride === undefined)
                h.liftOverride = patch.liftOverride;
              if (patch.offsetOverride) h.offsetOverride = patch.offsetOverride;
              if (typeof patch.stackIndex === 'number') h.stackIndex = patch.stackIndex;
              if (typeof patch.mountingPositionId === 'string')
                h.mountingPositionId = patch.mountingPositionId;
            }),
          })),
        setHatPortEnabled: (placementId, portId, enabled) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.hats) return;
              const h = draft.hats.find((x) => x.id === placementId);
              if (!h) return;
              const port = h.ports.find((p) => p.id === portId);
              if (port) port.enabled = enabled;
            }),
          })),
        addMountingFeature: (feature) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.mountingFeatures) draft.mountingFeatures = [];
              draft.mountingFeatures.push(feature);
            }),
          })),
        removeMountingFeature: (featureId) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.mountingFeatures) return;
              draft.mountingFeatures = draft.mountingFeatures.filter((f) => f.id !== featureId);
            }),
          })),
        patchMountingFeature: (featureId, patch) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.mountingFeatures) return;
              const f = draft.mountingFeatures.find((x) => x.id === featureId);
              if (!f) return;
              if (typeof patch.enabled === 'boolean') f.enabled = patch.enabled;
              if (typeof patch.rotation === 'number') f.rotation = patch.rotation;
              if (patch.position) Object.assign(f.position, patch.position);
              if (patch.params) Object.assign(f.params, patch.params);
            }),
          })),
        applyMountingPreset: (presetId) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.mountingFeatures) draft.mountingFeatures = [];
              const dims = computeShellDims(
                draft.board,
                draft.case,
                draft.hats ?? [],
                () => undefined,
              );
              if (presetId === 'four-corner-screw-tabs') {
                draft.mountingFeatures.push(
                  ...fourCornerScrewTabs(dims.outerX, dims.outerY),
                );
              } else if (presetId === 'rear-vesa-100' || presetId === 'rear-vesa-75') {
                const size = presetId === 'rear-vesa-100' ? 100 : 75;
                draft.mountingFeatures.push({
                  id: `${presetId}-${newId()}`,
                  type: 'vesa-mount',
                  face: '+y',
                  position: { u: dims.outerX / 2, v: dims.outerZ / 2 },
                  rotation: 0,
                  params: { patternSize: size, holeDiameter: 5 },
                  enabled: true,
                  presetId,
                });
              }
            }),
          })),
        setDisplay: (displayId, framing = 'top-window') =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!displayId) {
                draft.display = null;
                return;
              }
              draft.display = {
                id: `display-${newId()}`,
                displayId,
                framing,
                offset: { x: 0, y: 0 },
                hostSupport: 'gpio-only',
                enabled: true,
              };
            }),
          })),
        addFanMount: (size, face) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.fanMounts) draft.fanMounts = [];
              const dims = computeShellDims(
                draft.board,
                draft.case,
                draft.hats ?? [],
                () => undefined,
              );
              const u = face === '+z' || face === '-z' ? dims.outerX / 2 : dims.outerX / 2;
              const v = face === '+z' || face === '-z' ? dims.outerY / 2 : dims.outerZ / 2;
              draft.fanMounts.push({
                id: `fan-${newId()}`,
                size,
                face,
                position: { u, v },
                grille: 'cross',
                bladeStandoff: 4,
                bossesEnabled: true,
                enabled: true,
              });
            }),
          })),
        removeFanMount: (id) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.fanMounts) return;
              draft.fanMounts = draft.fanMounts.filter((f) => f.id !== id);
            }),
          })),
        patchFanMount: (id, patch) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.fanMounts) return;
              const f = draft.fanMounts.find((x) => x.id === id);
              if (!f) return;
              if (typeof patch.enabled === 'boolean') f.enabled = patch.enabled;
              if (typeof patch.bossesEnabled === 'boolean') f.bossesEnabled = patch.bossesEnabled;
              if (patch.size) f.size = patch.size;
              if (patch.grille) f.grille = patch.grille;
              if (patch.face) f.face = patch.face;
              if (patch.position) Object.assign(f.position, patch.position);
              if (typeof patch.bladeStandoff === 'number') f.bladeStandoff = patch.bladeStandoff;
            }),
          })),
        addTextLabel: (label) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.textLabels) draft.textLabels = [];
              draft.textLabels.push(label);
            }),
          })),
        removeTextLabel: (id) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.textLabels) return;
              draft.textLabels = draft.textLabels.filter((l) => l.id !== id);
            }),
          })),
        patchTextLabel: (id, patch) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.textLabels) return;
              const l = draft.textLabels.find((x) => x.id === id);
              if (!l) return;
              if (typeof patch.enabled === 'boolean') l.enabled = patch.enabled;
              if (typeof patch.text === 'string') l.text = patch.text;
              if (typeof patch.size === 'number') l.size = patch.size;
              if (typeof patch.depth === 'number') l.depth = patch.depth;
              if (typeof patch.rotation === 'number') l.rotation = patch.rotation;
              if (patch.mode) l.mode = patch.mode;
              if (patch.face) l.face = patch.face;
              if (patch.font) l.font = patch.font;
              if (patch.weight) l.weight = patch.weight;
              if (patch.position) Object.assign(l.position, patch.position);
            }),
          })),
        patchDisplay: (patch) =>
          set((s) => ({
            project: produce(s.project, (draft) => {
              if (!draft.display) return;
              if (typeof patch.enabled === 'boolean') draft.display.enabled = patch.enabled;
              if (patch.framing) draft.display.framing = patch.framing;
              if (typeof patch.tiltAngle === 'number') draft.display.tiltAngle = patch.tiltAngle;
              if (typeof patch.hoodHeight === 'number') draft.display.hoodHeight = patch.hoodHeight;
              if (typeof patch.bezelInset === 'number') draft.display.bezelInset = patch.bezelInset;
              if (patch.offset) Object.assign(draft.display.offset, patch.offset);
              if (patch.hostSupport) draft.display.hostSupport = patch.hostSupport;
            }),
          })),
      }),
      {
        partialize: (state) => ({ project: state.project }),
        limit: 50,
      },
    ),
  ),
);

export function undoProject(): void {
  useProjectStore.temporal.getState().undo();
}

export function redoProject(): void {
  useProjectStore.temporal.getState().redo();
}

export function canUndo(): boolean {
  return useProjectStore.temporal.getState().pastStates.length > 0;
}

export function canRedo(): boolean {
  return useProjectStore.temporal.getState().futureStates.length > 0;
}

export function clearHistory(): void {
  useProjectStore.temporal.getState().clear();
}
