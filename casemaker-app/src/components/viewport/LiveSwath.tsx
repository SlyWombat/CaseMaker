/**
 * #1141 phase 2a — THE CUT SWATH: what the running program has already cut, drawn on the live blank.
 *
 * The lines are the app's own: `buildSwathIndex` compiles the active program's text (the file the
 * controller is playing), `swathStep` advances it with the run watch's reported `P:` line, and the
 * WPos cap is always on — never past the segment holding the live tip. Nothing here polls: the line
 * and the tip arrive on the run watch's and the heartbeat's existing 2 s ticks; this component only
 * appends the new cutting moves' ribbon to a preallocated buffer (no worker, no mesh boolean).
 *
 * WHY THE RIBBON LIES ON THE TOP FACE. The live scene's blank is the OPAQUE uncut stock; a ribbon at
 * the cut's own Z would be inside solid material and invisible. The overlay is therefore the cut's
 * FOOTPRINT on the blank's top face (lifted {@link SWATH_LIFT_MM}): the areas the program has
 * machined so far, darkening the material as the machine reaches them.
 */
import { useEffect, useMemo, useRef, type JSX } from 'react';
import * as THREE from 'three';
import { useShallow } from 'zustand/react/shallow';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { useMachineStore } from '@/store/machineStore';
import { useMachineRunStore } from '@/store/machineRunStore';
import { buildSwathIndex, swathQuads, swathStep } from '@/engine/cnc/engrave/liveSwath';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import { cuttingDiameter } from '@/engine/cnc/tool';
import { STOCK_COLOR } from './engraveRamp';

/** The overlay's plane above the blank's top face (work z = 0), mm. */
export const SWATH_LIFT_MM = 0.05;

export function LiveSwath({ machineKey }: { machineKey: string | null }): JSX.Element | null {
  // The program the machine is playing: the release's active file — the very text it uploaded.
  const release = useEngraveReleaseStore((s) => (machineKey === null ? null : (s.records[machineKey] ?? null)));
  const file =
    release === null || release.active === null
      ? null
      : (release.files.find((f) => f.index === release.active) ?? null);
  const nc = file?.nc ?? null;
  const index = useMemo(() => (nc === null ? null : buildSwathIndex(nc)), [nc]);

  // The run watch's own `P:` line for this machine (#1123-42's source; the same 2 s poll).
  const reportedLine = useMachineRunStore((s) => (machineKey === null ? null : (s.runs[machineKey]?.progress?.line ?? null)));
  // The live tip, work frame: the heartbeat's own parsed WPos.
  // #1141 — `useShallow`: this selector builds a `{x,y,z}` object, and zustand v5 + React 19 read
  // the store through `useSyncExternalStore`, whose snapshot must be STABLE between store changes.
  // Without it every render produced a new snapshot ("The result of getSnapshot should be cached"),
  // and the first machine-store tick during a run — setRegistrationActive, the 2 s heartbeat —
  // re-rendered forever ("Maximum update depth exceeded") in dev and production alike.
  const wpos = useMachineStore(
    useShallow((s) => {
      const p = s.machine?.statusLine?.wpos ?? null;
      return p !== null && p.x !== null && p.y !== null && p.z !== null ? { x: p.x, y: p.y, z: p.z } : null;
    }),
  );
  const toolKey = file?.toolKey ?? null;
  const radius = useMemo(() => {
    const tool = toolKey === null ? null : resolveTool(toolKey);
    const diameter = tool === null ? null : cuttingDiameter(tool);
    return diameter === null ? null : diameter / 2;
  }, [toolKey]);

  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const attribute = new THREE.BufferAttribute(new Float32Array(0), 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', attribute);
    g.setDrawRange(0, 0);
    return g;
  }, []);
  useEffect(() => () => geom.dispose(), [geom]);

  const state = useRef<{ line: number | null; count: number; capacity: number }>({ line: null, count: 0, capacity: 0 });
  // A different program is a different cut: the old path's swath goes with it.
  useEffect(() => {
    state.current = { line: null, count: 0, capacity: 0 };
    geom.setDrawRange(0, 0);
  }, [index, geom]);

  useEffect(() => {
    if (index === null || radius === null) return;
    const step = swathStep(state.current.line, reportedLine, wpos, index);
    if (step.kind === 'hold') return;
    if (step.reset) {
      state.current = { ...state.current, line: null, count: 0 };
      geom.setDrawRange(0, 0);
    }
    const quads = swathQuads(index, state.current.line, step.throughLine, radius, SWATH_LIFT_MM);
    appendQuads(geom, state.current, quads);
    state.current.line = step.throughLine;
  }, [index, radius, reportedLine, wpos?.x, wpos?.y, wpos?.z, geom]); // eslint-disable-line react-hooks/exhaustive-deps -- wpos is a fresh object each tick; its axes are the dependencies

  if (index === null || radius === null) return null;
  return (
    // frustumCulled is off: the buffer grows as the cut does, and a stale bounding sphere would
    // cull the whole overlay once the new vertices left it.
    <mesh geometry={geom} name="engrave-live-swath" frustumCulled={false} renderOrder={2}>
      <meshStandardMaterial
        color={new THREE.Color(STOCK_COLOR).multiplyScalar(0.55)}
        transparent
        opacity={0.85}
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-2}
        metalness={0.05}
        roughness={0.8}
      />
    </mesh>
  );
}

/** Append this tick's triangles, growing the buffer by doubling; one range update per tick. */
function appendQuads(
  geom: THREE.BufferGeometry,
  state: { count: number; capacity: number },
  quads: Float32Array,
): void {
  if (quads.length === 0) return;
  let attribute = geom.getAttribute('position') as THREE.BufferAttribute;
  const needed = state.count + quads.length;
  if (needed > state.capacity) {
    const capacity = Math.max(needed, Math.max(4096, state.capacity * 2));
    const grown = new Float32Array(capacity);
    grown.set(attribute.array as Float32Array);
    attribute = new THREE.BufferAttribute(grown, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', attribute);
    state.capacity = capacity;
  }
  (attribute.array as Float32Array).set(quads, state.count);
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(state.count, quads.length);
  attribute.needsUpdate = true;
  state.count = needed;
  geom.setDrawRange(0, state.count / 3);
}
