/**
 * #1123 items 36/38 — THE LIVE VIEW of a running machine.
 *
 * Phase 1 (this module): while the machine is busy or a probe owns it, the viewport shows the
 * UNCUT blank, the design's extents and the live tool/probe at the controller's WPos — never the
 * finished simulation's swept stock and never its program path (the bench mistook the yellow
 * plunge line for a cut). The simulation stays loaded; on idle the previous scene returns.
 * Phase 2 (the material removed so far, driven by the controller's reported line) is #1141.
 *
 * The readout states POSITIONS, never a verdict: the tool centre being 0.216 mm in from the
 * design's extents says nothing about whether the cutter is cutting the design (it often is — the
 * bench case was the lip's round-over). The extents are the DESIGN'S BOUNDING BOX, named as such.
 */
import { useEngraveReleaseStore, type ReleasePhase } from '@/store/engraveReleaseStore';
import { useMachineStore } from '@/store/machineStore';
import type { EngravePreview } from '@/workers/sim/engravePreview';

export type SceneChoice = 'sim' | 'engrave' | 'case';

/**
 * Which scene the viewport draws. A LIVE machine in the CNC section takes the viewport from a
 * loaded simulation (the finished part would lie about the material under the cutter); the
 * simulation keeps it everywhere else, including when the operator is deliberately in Simulate.
 */
export function sceneFor(simActive: boolean, engraveActive: boolean, live: boolean): SceneChoice {
  if (simActive && !(live && engraveActive)) return 'sim';
  return engraveActive ? 'engrave' : 'case';
}

/**
 * The release phases in which the machine is being worked (a program is uploading/starting/running,
 * or a #1146 walk file is playing).
 */
export const LIVE_RELEASE_PHASES: readonly ReleasePhase[] = ['uploading', 'starting', 'running', 'airwalk', 'cleaning'];

/** Live = the heartbeat says busy, a registration owns the machine, or a release is working it. */
export function liveMachineFor(
  busy: boolean | null | undefined,
  registrationActive: boolean,
  phases: readonly ReleasePhase[],
): boolean {
  return registrationActive || busy === true || phases.some((phase) => LIVE_RELEASE_PHASES.includes(phase));
}

/** The live flag from the stores, for the non-reactive camera controllers. */
export function liveFromStores(): boolean {
  const machine = useMachineStore.getState();
  const releases = useEngraveReleaseStore.getState();
  return liveMachineFor(
    machine.machine?.busy ?? null,
    machine.registrationActive,
    Object.values(releases.records).map((record) => record.phase),
  );
}

/** The live flag, reactive, for the scene chooser and its legends. */
export function useLiveMachine(): boolean {
  const busy = useMachineStore((s) => s.machine?.busy ?? null);
  const registrationActive = useMachineStore((s) => s.registrationActive);
  const releaseLive = useEngraveReleaseStore((s) =>
    Object.values(s.records).some((record) => LIVE_RELEASE_PHASES.includes(record.phase)),
  );
  return liveMachineFor(busy, registrationActive, releaseLive ? ['running'] : []);
}

/** The design's extents in the work frame: the union of the preview's cut floors' boxes. */
export interface DesignExtents {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function designExtents(preview: EngravePreview | null): DesignExtents | null {
  if (preview === null || preview.floors.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const floor of preview.floors) {
    const { min, max } = floor.mesh.bbox;
    minX = Math.min(minX, min[0]);
    maxX = Math.max(maxX, max[0]);
    minY = Math.min(minY, min[1]);
    maxY = Math.max(maxY, max[1]);
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

const n = (value: number): string => value.toFixed(3);

/**
 * The live readout: the tool centre, the design's extents, and the tool's distance from the
 * NEAREST extent — positions only, in the operator's words. Null until the heartbeat states a
 * whole X/Y; the extents are omitted (never invented) when the preview has no cut to bound.
 */
export function liveEdgeWords(
  wpos: { x: number | null; y: number | null; z: number | null } | null,
  extents: DesignExtents | null,
): string | null {
  if (wpos === null || wpos.x === null || wpos.y === null) return null;
  const base = `tool centre X ${n(wpos.x)}, Y ${n(wpos.y)}`;
  if (extents === null) return base;

  const x = wpos.x;
  const y = wpos.y;
  const xEdge =
    x < extents.minX
      ? { d: extents.minX - x, words: "left of the design's left edge" }
      : x > extents.maxX
        ? { d: x - extents.maxX, words: "right of the design's right edge" }
        : x - extents.minX <= extents.maxX - x
          ? { d: x - extents.minX, words: "right of the design's left edge" }
          : { d: extents.maxX - x, words: "left of the design's right edge" };
  const yEdge =
    y < extents.minY
      ? { d: extents.minY - y, words: "past the design's Y-min edge" }
      : y > extents.maxY
        ? { d: y - extents.maxY, words: "past the design's Y-max edge" }
        : y - extents.minY <= extents.maxY - y
          ? { d: y - extents.minY, words: "from the design's Y-min edge" }
          : { d: extents.maxY - y, words: "from the design's Y-max edge" };
  const edge = xEdge.d <= yEdge.d ? xEdge : yEdge;
  return (
    `${base} · the design's extents (bounding box) span X ${n(extents.minX)}–${n(extents.maxX)}, ` +
    `Y ${n(extents.minY)}–${n(extents.maxY)}: the tool centre is ${n(edge.d)} mm ${edge.words}`
  );
}
