/**
 * The simulation's meshes (#197, `/Simulation.md` §8). Rendered by `SceneMeshes` INSTEAD of the
 * case whenever the simulation owns the viewport. Every mesh arrives from the sim worker in the
 * WORK frame — origin at the stock's top-front-left corner, +X right, +Y away from the operator,
 * Z = 0 at the stock's top face, material at negative Z — and the scene is Z-up, so they are
 * drawn as-is with NO transform (issue: "do not transform the meshes into machine coordinates").
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useSimStore } from '@/store/simStore';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import { geometryFromMesh, segmentGeometry, splitPath, toolPositionAt, vertexIndexAtStep } from './simGeometry';

const STOCK_COLOR = '#c9a26b'; // a neutral wood tone
const REMOVED_COLOR = '#ff5a36';
const GOUGE_COLOR = '#ff0033';
const CUT_COLOR = '#00e0ff';
const RAPID_COLOR = '#ffd400';
const TOOL_COLOR = '#d0d4dc';
/** PROVISIONAL (#197): the drawn flute length; use the tool's stated flute length when there is one. */
const TOOL_HEIGHT_MM = 12;
const FIXTURE_COLOR = '#4b5563';

/**
 * A geometry built from a `NodeMeshOutput`, disposed when its mesh is replaced or on unmount. A
 * scrub replaces the stock mesh many times, so without this the geometries would accumulate
 * (`renderer.info.memory.geometries` must stay bounded — #197).
 */
function useMeshGeometry(mesh: NodeMeshOutput | null): THREE.BufferGeometry | null {
  const geom = useMemo(() => (mesh ? geometryFromMesh(mesh) : null), [mesh]);
  useEffect(() => () => geom?.dispose(), [geom]);
  return geom;
}

/** One `LineSegments` layer over a shared buffer, with its own drawRange and disposal. */
function LineLayer({
  data,
  start,
  count,
  color,
  opacity = 1,
  dashed = false,
}: {
  data: Float32Array;
  start: number;
  count: number;
  color: string;
  opacity?: number;
  dashed?: boolean;
}) {
  // Distances are computed inside `segmentGeometry`, at build time, so a dashed layer that later
  // becomes visible (a step back) already has them — see that helper and the #197 review.
  const geom = useMemo(() => segmentGeometry(data, dashed), [data, dashed]);
  useEffect(() => () => geom.dispose(), [geom]);
  useEffect(() => {
    geom.setDrawRange(start, count);
  }, [geom, start, count]);
  if (data.length === 0 || count <= 0) return null;
  return (
    <lineSegments geometry={geom}>
      {dashed ? (
        <lineDashedMaterial color={color} transparent={opacity < 1} opacity={opacity} dashSize={2} gapSize={1.5} />
      ) : (
        <lineBasicMaterial color={color} transparent={opacity < 1} opacity={opacity} />
      )}
    </lineSegments>
  );
}

/** One gouge solid, drawn only once the current step has reached it. */
function Gouge({ mesh }: { mesh: NodeMeshOutput }) {
  const geom = useMeshGeometry(mesh);
  if (!geom) return null;
  return (
    <mesh geometry={geom}>
      <meshStandardMaterial color={GOUGE_COLOR} metalness={0.1} roughness={0.6} />
    </mesh>
  );
}

/**
 * One fixture obstacle box (#204). Built by the session from the SAME `boxSolid` the sweep
 * checks against, so what is drawn and what is tested can never disagree; it is the
 * un-inflated box, i.e. where the user said the jaw is.
 */
function FixtureBox({ mesh, label }: { mesh: NodeMeshOutput; label: string }) {
  const geom = useMeshGeometry(mesh);
  if (!geom) return null;
  return (
    <mesh geometry={geom} name={`sim-fixture-${label}`} userData={{ fixtureLabel: label }}>
      <meshStandardMaterial color={FIXTURE_COLOR} transparent opacity={0.85} metalness={0.2} roughness={0.6} />
    </mesh>
  );
}

export function SimMeshes() {
  const meshes = useSimStore((s) => s.meshes);
  const frame = useSimStore((s) => s.frame);
  const step = useSimStore((s) => s.step);
  const path = useSimStore((s) => s.path);
  const layers = useSimStore((s) => s.layers);
  const info = useSimStore((s) => s.info);

  const lastStep = info ? info.summary.steps - 1 : -1;
  // Issue #197: on a fresh load the step is already the last one but no frame has been delivered
  // yet (the client's warm-up seek is silent), so the stock comes from the load's own `result`
  // mesh; before the first cut the frame is null and the uncut `stock` mesh is right.
  const finished = lastStep >= 0 && step >= lastStep;
  const stockMesh = meshes ? (finished ? meshes.result : frame?.stock ?? meshes.stock) : null;
  const removalMesh = finished ? meshes?.removal ?? null : frame?.removalSoFar ?? null;

  const stockGeom = useMeshGeometry(stockMesh);
  const removalGeom = useMeshGeometry(removalMesh);

  const split = useMemo(() => (path ? splitPath(path) : null), [path]);
  const cutSegments = split ? vertexIndexAtStep(split.cutStep, step) : 0;
  const rapidSegments = split ? vertexIndexAtStep(split.rapidStep, step) : 0;
  const cutTotal = split ? split.cutStep.length : 0;
  const rapidTotal = split ? split.rapidStep.length : 0;

  const tool = path ? toolPositionAt(path, step) : null;
  const radius = info?.radius ?? 0;
  const toolGeom = useMemo(
    () => (radius > 0 ? new THREE.CylinderGeometry(radius, radius, TOOL_HEIGHT_MM, 24) : null),
    [radius],
  );
  useEffect(() => () => toolGeom?.dispose(), [toolGeom]);

  const visibleGouges = meshes ? meshes.gouges.filter((g) => step >= g.step) : [];

  return (
    <group>
      {stockGeom && (
        <mesh geometry={stockGeom} name="sim-stock">
          <meshStandardMaterial color={STOCK_COLOR} flatShading metalness={0.05} roughness={0.75} />
        </mesh>
      )}

      {layers.removed && removalGeom && (
        <mesh geometry={removalGeom} name="sim-removed">
          {/* depthWrite:false is not optional — a transparent mesh that writes depth hides
              everything inside it (issue #162; /Simulation.md §8). */}
          <meshStandardMaterial color={REMOVED_COLOR} transparent opacity={0.25} depthWrite={false} metalness={0.05} roughness={0.8} />
        </mesh>
      )}

      {visibleGouges.map((g) => (
        <Gouge key={`${g.step}-${g.line}`} mesh={g.mesh} />
      ))}

      {layers.path && split && (
        <>
          <LineLayer data={split.cuts} start={0} count={2 * cutSegments} color={CUT_COLOR} />
          <LineLayer data={split.cuts} start={2 * cutSegments} count={2 * (cutTotal - cutSegments)} color={CUT_COLOR} opacity={0.25} />
        </>
      )}
      {layers.rapids && split && (
        <>
          <LineLayer data={split.rapids} start={0} count={2 * rapidSegments} color={RAPID_COLOR} dashed />
          <LineLayer data={split.rapids} start={2 * rapidSegments} count={2 * (rapidTotal - rapidSegments)} color={RAPID_COLOR} opacity={0.25} dashed />
        </>
      )}

      {layers.tool && tool && toolGeom && (
        // CylinderGeometry's axis is +Y; rotate about X so it points up the world's +Z, and lift
        // its centre by half the height so its BASE sits on the tool tip.
        <mesh geometry={toolGeom} position={[tool[0], tool[1], tool[2] + TOOL_HEIGHT_MM / 2]} rotation={[Math.PI / 2, 0, 0]} name="sim-tool">
          <meshStandardMaterial color={TOOL_COLOR} transparent opacity={0.9} metalness={0.3} roughness={0.4} />
        </mesh>
      )}

      {layers.fixture &&
        meshes?.fixture.map((f) => <FixtureBox key={f.id} mesh={f.mesh} label={f.label} />)}
    </group>
  );
}
