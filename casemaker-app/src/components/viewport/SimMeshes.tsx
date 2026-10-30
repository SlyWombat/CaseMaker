/**
 * The simulation's meshes (#197, `/Simulation.md` §8). Rendered by `SceneMeshes` INSTEAD of the
 * case whenever the simulation owns the viewport. Every mesh arrives from the sim worker in the
 * WORK frame — origin at the stock's top-front-left corner, +X right, +Y away from the operator,
 * Z = 0 at the stock's top face, material at negative Z — and the scene is Z-up, so they are
 * drawn as-is with NO transform (issue: "do not transform the meshes into machine coordinates").
 *
 * The sacrificial material (#213 §4) is the second body: the board/strips as cut so far, in a pale
 * grey (#9ca3af, shared with the engrave preview). It is its OWN layer (`layers.sacrificial`,
 * independent of the workholding "fixture" layer) with a matching toolbar toggle and a legend entry.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { MACHINES } from '@/engine/cnc/machine';
import { useSimStore } from '@/store/simStore';
import { useMachineStore } from '@/store/machineStore';
import { useShopDefault } from '@/store/shopDefaultsStore';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import { LiveToolHead } from './LiveToolHead';
import { toolPlacement } from './liveMachineTool';
import { TouchMarkers } from './TouchMarkers';
import { angleAtStep, turningRadians } from './rotarySimView';
import {
  cleanStockGeometry,
  drawsSacrificial,
  FIXTURE_COLOR,
  geometryFromMesh,
  PATH_COLOR,
  applyRemovedDepthColours,
  RAPID_COLOR,
  REMOVED_COLOR,
  SACRIFICIAL_COLOR,
  sacrificialMesh,
  segmentGeometry,
  splitMapPath,
  splitPath,
  toolPositionAt,
  vertexIndexAtStep,
} from './simGeometry';

const STOCK_COLOR = '#c9a26b'; // a neutral wood tone
const GOUGE_COLOR = '#ff0033';

/**
 * A geometry built from a `NodeMeshOutput`, disposed when its mesh is replaced or on unmount. A
 * scrub replaces the stock mesh many times, so without this the geometries would accumulate
 * (`renderer.info.memory.geometries` must stay bounded — #197).
 */
function useMeshGeometry(
  mesh: NodeMeshOutput | null,
  build: (m: NodeMeshOutput) => THREE.BufferGeometry = geometryFromMesh,
): THREE.BufferGeometry | null {
  const geom = useMemo(() => (mesh ? build(mesh) : null), [mesh, build]);
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
  const tool = useSimStore((s) => s.tool);
  // #716 slice 2 — Stock (the rod in the chuck) | Unroll (the same columns on the map).
  const design = useSimStore((s) => s.design);

  const lastStep = info ? info.summary.steps - 1 : -1;
  // Issue #197: on a fresh load the step is already the last one but no frame has been delivered
  // yet (the client's warm-up seek is silent), so the stock comes from the load's own `result`
  // mesh; before the first cut the frame is null and the uncut `stock` mesh is right.
  const finished = lastStep >= 0 && step >= lastStep;
  // A frame is only drawn in the design it was meshed for: a frame still in flight from before a
  // Stock | Unroll switch is not the same picture, and showing it would flash the wrong view.
  const mapView = design === 'map';
  const frameForDesign = frame !== null && (frame.design ?? 'stock') === design ? frame : null;
  // The map's arc is at the stock's own radius; the column engine reports it as `stockTopZ` (R6).
  const stockRadius = info !== null && info.summary?.rotary === true ? info.stockTopZ : null;
  const stockMesh = mapView
    ? frameForDesign?.stock ?? null
    : meshes
      ? finished
        ? meshes.result
        : frameForDesign?.stock ?? meshes.stock
      : null;
  const removalMesh = mapView ? null : finished ? meshes?.removal ?? null : frameForDesign?.removalSoFar ?? null;

  // #552 — the COLUMN (dexel) stock carries the per-column side skirts that read as a comb; the
  // exact sweeper's Manifold stock is already clean and its vertical faces (pocket walls) must be
  // kept. The column engine is the one that never emits a removal ghost, so that is the honest
  // discriminator between the two stock shapes.
  //
  // #723 R-4 review — NOT for a ROTARY stock. That cleanup is written for the FLAT box: it drops
  // every triangle whose normal has no Z component (for a rod, its two end caps) and rebuilds the
  // four sides as bbox planes (for a rod, a box 2R square with the cylinder inside it), which drew
  // the turning view as a flat-sided wedge with a sliver along the bottom. The rotary meshes are
  // already clean by construction: a curved heightfield surface, cap fans and skirt quads that
  // follow the cut — so they are used exactly as the engine made them.
  const rotary = info !== null && info.summary?.rotary === true;
  const cleanStock = meshes?.removal === null && !rotary;
  const stockGeom = useMeshGeometry(stockMesh, cleanStock ? cleanStockGeometry : geometryFromMesh);
  // #723 R-4 review — A ROTARY STOCK IS COLOURED BY THE RADIUS THE CUT TOOK, so a heightfield
  // reads as cut from a top camera (the unrolled view showed no removal at all). It is the same
  // buffer with one attribute added; a flat program's mesh is untouched.
  const rotaryStock = rotary && stockRadius !== null;
  useMemo(() => {
    if (rotaryStock && stockGeom !== null) {
      applyRemovedDepthColours(stockGeom, { map: mapView, radius: stockRadius, base: STOCK_COLOR });
    }
  }, [rotaryStock, stockGeom, mapView, stockRadius]);
  const removalGeom = useMeshGeometry(removalMesh);
  // #213 §4 — the sacrificial material as cut so far, on its OWN layer (`layers.sacrificial`).
  // Null when the job has none, so nothing is drawn; before the first frame lands the load's uncut
  // body stands in, the same warm-up fallback the stock uses above. Independent of the workholding
  // ("fixture") layer, so hiding the jaws never hides the material, and vice versa.
  const sacrificialGeom = useMeshGeometry(mapView ? null : sacrificialMesh(frameForDesign, meshes));
  const showSacrificial = drawsSacrificial(layers, sacrificialGeom !== null);

  const split = useMemo(
    () => (path ? (mapView && stockRadius !== null ? splitMapPath(path, stockRadius) : splitPath(path)) : null),
    [path, mapView, stockRadius],
  );
  const cutSegments = split ? vertexIndexAtStep(split.cutStep, step) : 0;
  const rapidSegments = split ? vertexIndexAtStep(split.rapidStep, step) : 0;

  const toolTip = path ? toolPositionAt(path, step) : null;
  // #527 §6 — the tool layer's ONE body at the live `WPos` while the machine is answering, else at
  // the scrub step. The same rule the engrave preview reads (`toolPlacement`), so the two scenes
  // cannot disagree about what "live" means. While a registration owns the machine the body is the
  // wired probe, whose tip diameter is the shop's measured `registration.tipDiameterMm` (#449).
  const machine = useMachineStore((s) => s.machine);
  const reachable = useMachineStore((s) => s.heartbeat.reachable);
  const registrationActive = useMachineStore((s) => s.registrationActive);
  const probeTip = useShopDefault('registration.tipDiameterMm').value;
  const placement = toolPlacement(
    { reachable, wpos: machine?.statusLine?.wpos ?? null },
    toolTip,
  );
  // The collet nut from the remembered machine's profile; null is NOT MEASURED, and the generic
  // stub stands in — the same degradation the fixture check makes (#191 item 4).
  const holder = machine?.profileId != null ? MACHINES[machine.profileId]?.holder ?? null : null;

  const visibleGouges = meshes ? meshes.gouges.filter((g) => step >= g.step) : [];

  // #716 slice 2 — THE TURNING STOCK (design §3.9, R11a): the stock, the removed ghost, the gouges
  // and the path turn with A(step) in ONE group; the cutter, the fixture and the touches stay. The
  // stock's bounding box is invariant under the rotation, so the camera never chases it. A flat
  // program (no A on the path) turns by 0 — its scene is exactly what it was.
  // Unroll already IS the map — the rod's turn would rotate an opened surface out of its frame.
  const turning = path && !mapView ? angleAtStep(path, step) : null;
  const turningRad = turning === null ? 0 : turningRadians(turning);

  return (
    <group>
      <group name="sim-turning" rotation={[turningRad, 0, 0]}>
        {stockGeom && (
          <mesh geometry={stockGeom} name="sim-stock">
            <meshStandardMaterial
              // The stock colour is baked into the vertices when the depth colours are on (vertex
              // colours MULTIPLY the material's), so the material is white then.
              color={rotaryStock ? '#ffffff' : STOCK_COLOR}
              vertexColors={rotaryStock}
              flatShading
              metalness={0.05}
              roughness={0.75}
            />
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
          <LineLayer data={split.cuts} start={0} count={2 * cutSegments} color={PATH_COLOR} />
        )}
        {layers.rapids && split && (
          <LineLayer data={split.rapids} start={0} count={2 * rapidSegments} color={RAPID_COLOR} dashed />
        )}
      </group>

      {!mapView && showSacrificial && sacrificialGeom && (
        // #213 §4 — the sacrificial material as cut. OPAQUE: it is stock the cutter is meant to
        // reach, not a ghost.
        <mesh geometry={sacrificialGeom} name="sim-sacrificial">
          <meshStandardMaterial color={SACRIFICIAL_COLOR} flatShading metalness={0.05} roughness={0.8} />
        </mesh>
      )}

      {!mapView && layers.tool && (
        <LiveToolHead
          at={placement?.at ?? null}
          tool={tool}
          probeTipDiameterMm={registrationActive ? probeTip : null}
          holder={holder}
          name="sim-tool"
        />
      )}

      {!mapView &&
        layers.fixture &&
        meshes?.fixture.map((f) => <FixtureBox key={f.id} mesh={f.mesh} label={f.label} />)}

      {/* #519 item 1 — the registration's touch dots, in the work frame this scene draws in. */}
      {!mapView && layers.touches && <TouchMarkers />}
    </group>
  );
}
