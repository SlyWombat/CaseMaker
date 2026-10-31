/**
 * The 3D primitives and the target object in the engrave preview (#435).
 *
 * A primitive is a CUT-AWAY: a pocket-shaped volume inside the stock. The stock mesh is opaque and
 * is drawn by `EngravePreview`, so a volume inside it would be invisible under normal depth
 * testing. The primitive bodies therefore draw without writing or testing depth, with a high
 * `renderOrder`, which makes them read as ghosted negatives through the blank — the standard
 * cut-preview convention. They are not part of the stock mesh and never touch the CAM: this file
 * only draws the item model, exactly like the panel row does.
 *
 * A REFERENCE target is drawn with ordinary depth testing: it sits against the stock, not in it,
 * so it is opaque enough to read and is still hidden by anything in front of it. Its bbox centre
 * is placed at the row's X/Y and its TOP at the row's Z (Z0 is the stock top), which is the
 * placement contract in `EngraveTargetObject`; the frame comes from `targetPlacement`.
 *
 * #811 — A GOAL is drawn from the PREVIEW WORKER's volumes instead (`preview.goal`), not from the
 * job's raw mesh: the part standing proud with the cleared blank around it (item), or the cavity a
 * mold leaves. That is what lets the picture and the CAM describe one part — the worker builds
 * them from the same parsed mesh, the same placed frame and (for the mold) the same blank the cut
 * is clipped to. The raw drawing above remains the fallback for a goal whose triangles are not a
 * closed solid or whose bytes have not arrived.
 *
 * Every drawn item is a pick target in the Select tool, like a floor (#441): clicking one opens
 * its row. The tags are `engravePrimitive` and `engraveTarget`, read by `engravePick.ts`.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useViewportStore, isEngraveItemSelected } from '@/store/viewportStore';
import { targetObjectMesh } from '@/engine/import/targetObject';
import { targetPlacement } from '@/engine/cnc/engrave/targetScale';
import { isMold } from '@/engine/cnc/cam/surface3d';
import type { EngravePrimitive, EngraveTargetObject } from '@/types/engraveJob';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { EngravePreviewGoal } from '@/workers/sim/engravePreview';
import { activateEngraveItem } from './engravePick';
import { geometryFromMesh, REMOVED_COLOR } from './simGeometry';
import { STOCK_COLOR } from './engraveRamp';

/** The cut-away volume's colour: warm red, distinct from the stock's wood and the floor ramp. */
const CUT_COLOR = '#e0685f';
/** A reference part's colour: cool grey-blue, so it never reads as stock or as a cut. */
const TARGET_COLOR = '#8aa2bd';
/** A selected primitive glows with the same cyan a selected floor uses (#441). */
const SELECTED_GLOW = '#9adcff';
const CUT_OPACITY = 0.32;
const TARGET_OPACITY = 0.5;
/**
 * #811 — the removed volume's opacity: the same 0.25 the simulation's removal ghost uses, so "this
 * is the material the program takes away" reads the same on Design and on Simulate.
 */
const REMOVED_OPACITY = 0.25;
const SEGMENTS = 48;

const DEG = Math.PI / 180;

/** The orientation that turns a Z-opening body into an X- or Y-opening one (refused, but drawn). */
function axisRotation(primitive: EngravePrimitive): [number, number, number] {
  if ((primitive.axis ?? 'z') === 'x') return [0, Math.PI / 2, 0];
  if ((primitive.axis ?? 'z') === 'y') return [-Math.PI / 2, 0, 0];
  return [0, 0, 0];
}

interface BuiltPrimitive {
  body: THREE.BufferGeometry;
  /** A sphere cap is open at its floor; the disc closes it so the negative reads as a volume. */
  floor: THREE.BufferGeometry | null;
}

/**
 * The primitive as a solid whose TOP FACE is at local Z = 0 and whose floor is at −depth, matching
 * the job's work frame. Every shape is built along +Z then translated down, so the placement group
 * only has to carry X/Y and the rotations.
 */
function primitiveGeometry(primitive: EngravePrimitive): BuiltPrimitive {
  if (primitive.kind === 'box') {
    const body = new THREE.BoxGeometry(primitive.width, primitive.height, primitive.depth);
    body.translate(0, 0, -primitive.depth / 2);
    return { body, floor: null };
  }
  if (primitive.kind === 'cylinder') {
    const body = new THREE.CylinderGeometry(primitive.diameter / 2, primitive.diameter / 2, primitive.depth, SEGMENTS);
    // A CylinderGeometry runs along Y; +π/2 about X puts its +Y end at +Z (the top face).
    body.rotateX(Math.PI / 2);
    body.translate(0, 0, -primitive.depth / 2);
    return { body, floor: null };
  }
  if (primitive.kind === 'cone') {
    // radiusTop is the narrow end (+Y, which becomes +Z): the wide base sits on the top face.
    const body = new THREE.CylinderGeometry(primitive.tipDiameter / 2, primitive.diameter / 2, primitive.depth, SEGMENTS);
    body.rotateX(Math.PI / 2);
    body.translate(0, 0, -primitive.depth / 2);
    return { body, floor: null };
  }

  // A spherical cap. The schema already says depth ≤ diameter; clamp again so a hand-edited
  // document cannot make acos() meaningless and draw a bogus body.
  const radius = primitive.diameter / 2;
  const depth = Math.min(primitive.depth, primitive.diameter);
  const thetaMax = Math.acos(Math.max(-1, Math.min(1, (radius - depth) / radius)));
  const body = new THREE.SphereGeometry(radius, SEGMENTS, SEGMENTS / 2, 0, Math.PI * 2, 0, thetaMax);
  body.rotateX(Math.PI / 2);
  // The pole (the cap's crown) is at +radius; put the crown on the top face.
  body.translate(0, 0, -radius);
  const rim = Math.sqrt(Math.max(0, radius * radius - (radius - depth) * (radius - depth)));
  const floor = rim > 0 ? new THREE.CircleGeometry(rim, SEGMENTS) : null;
  return { body, floor };
}

/** One primitive's ghosted cut volume, selectable in the Select tool. */
function PrimitiveBody({ primitive }: { primitive: EngravePrimitive }) {
  const built = useMemo(() => primitiveGeometry(primitive), [primitive]);
  useEffect(
    () => () => {
      built.body.dispose();
      built.floor?.dispose();
    },
    [built],
  );
  const selected = useViewportStore((s) => isEngraveItemSelected(s.selection, primitive.id));
  const [ax, ay, az] = axisRotation(primitive);

  return (
    <group position={[primitive.position.x, primitive.position.y, 0]} rotation={[ax, ay, az]}>
      <group rotation={[0, 0, primitive.rotation * DEG]}>
        <mesh
          geometry={built.body}
          name={`engrave-primitive-${primitive.id}`}
          userData={{ engravePrimitive: primitive.id }}
          renderOrder={4}
          onClick={(e) => {
            const { activeTool } = useViewportStore.getState();
            if (activeTool !== 'select') return;
            if (!activateEngraveItem(e.object)) return;
            e.stopPropagation();
          }}
        >
          <meshStandardMaterial
            color={CUT_COLOR}
            emissive={selected ? SELECTED_GLOW : '#000000'}
            emissiveIntensity={selected ? 0.7 : 0}
            transparent
            opacity={CUT_OPACITY}
            // The volume is INSIDE the opaque stock; without this it would never be seen.
            depthTest={false}
            depthWrite={false}
            metalness={0.05}
            roughness={0.8}
            side={THREE.DoubleSide}
          />
        </mesh>
        {built.floor !== null && (
          <mesh
            geometry={built.floor}
            position={[0, 0, -Math.min(primitive.depth, primitive.kind === 'sphere' ? primitive.diameter : primitive.depth)]}
            renderOrder={4}
          >
            <meshStandardMaterial
              color={CUT_COLOR}
              transparent
              opacity={CUT_OPACITY}
              depthTest={false}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        )}
      </group>
    </group>
  );
}

/** The embedded reference part, placed by bbox centre in X/Y and top at `position.z`. */
function TargetObjectMesh({ target }: { target: EngraveTargetObject }) {
  // The three fields the decode reads, so a placement edit does not rebuild a large mesh.
  const { sha256, format, data } = target;
  const geom = useMemo(() => {
    try {
      const parsed = targetObjectMesh({ sha256, format, data });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(parsed.positions, 3));
      g.setIndex(new THREE.BufferAttribute(parsed.indices, 1));
      g.computeVertexNormals();
      // Local origin at the bbox centre in X/Y and at its TOP in Z, so the row's placement is
      // the mesh's position with no second offset in the component.
      const cx = (parsed.bbox.min[0] + parsed.bbox.max[0]) / 2;
      const cy = (parsed.bbox.min[1] + parsed.bbox.max[1]) / 2;
      g.translate(-cx, -cy, -parsed.bbox.max[2]);
      return g;
    } catch {
      // A malformed embedded document draws nothing rather than taking the viewport down.
      return null;
    }
  }, [sha256, format, data]);
  useEffect(() => () => geom?.dispose(), [geom]);
  const selected = useViewportStore((s) => isEngraveItemSelected(s.selection, target.id));
  // #721 — a MOLD draws the part as its cavity: the heightfield turns the sampled part over about
  // its X axis at the stock top, which in the placed frame is the same as composing its turn with
  // Rx(π) and anchoring the turned bbox's own centre; #723 part 2 generalises that to X/Y turns.
  // #811 — the frame itself lives in `targetPlacement`, shared with the preview worker's removed
  // volume so the two pictures cannot place the part differently.
  const mold = isMold(target) && (target.role ?? 'reference') === 'goal';
  const placement = targetPlacement(target, mold ? 'mold' : 'item');
  if (geom === null) return null;

  return (
    <group position={[placement.at.x, placement.at.y, placement.at.z]}>
      <group
        rotation={[placement.turns.x * DEG, placement.turns.y * DEG, placement.turns.z * DEG]}
        scale={[placement.scale.x, placement.scale.y, placement.scale.z]}
      >
        <mesh
          geometry={geom}
          name={`engrave-target-${target.id}`}
          userData={{ engraveTarget: target.id }}
          onClick={(e) => {
            const { activeTool } = useViewportStore.getState();
            if (activeTool !== 'select') return;
            if (!activateEngraveItem(e.object)) return;
            e.stopPropagation();
          }}
        >
          <meshStandardMaterial
            color={TARGET_COLOR}
            emissive={selected ? SELECTED_GLOW : '#000000'}
            emissiveIntensity={selected ? 0.6 : 0}
            transparent
            opacity={TARGET_OPACITY}
            depthWrite={false}
            metalness={0.1}
            roughness={0.7}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}

/** A geometry built from a worker mesh, disposed when the mesh is replaced or on unmount (#197). */
function useMeshOutputGeometry(mesh: NodeMeshOutput | null): THREE.BufferGeometry | null {
  const geom = useMemo(() => (mesh === null ? null : geometryFromMesh(mesh)), [mesh]);
  useEffect(() => () => geom?.dispose(), [geom]);
  return geom;
}

/**
 * #811 — THE GOAL AS THE JOB MAKES IT. The preview worker builds the volumes (`preview.goal`), so
 * this component only chooses materials:
 *
 *  - `item`: the part as placed, OPAQUE in the stock's material colour — it is the piece that is
 *    left standing — with the rest of the blank (the volume the program clears) as the translucent
 *    removed overlay, so the operator sees the part inside the material it comes out of.
 *  - `mold`: the cavity alone, in the removed colour: a hole the shape of the part, inside the
 *    ghosted stock (which `EngravePreview` draws translucent whenever a goal is stated).
 *
 * Both meshes are pick targets for the target row, exactly like the raw mesh they replace.
 */
function GoalVolumes({ target, goal }: { target: EngraveTargetObject; goal: EngravePreviewGoal }) {
  const partGeom = useMeshOutputGeometry(goal.part);
  const removedGeom = useMeshOutputGeometry(goal.removed);
  const selected = useViewportStore((s) => isEngraveItemSelected(s.selection, target.id));
  const onPick = (e: { object: THREE.Object3D; stopPropagation: () => void }) => {
    const { activeTool } = useViewportStore.getState();
    if (activeTool !== 'select') return;
    if (!activateEngraveItem(e.object)) return;
    e.stopPropagation();
  };

  return (
    <group name="engrave-goal">
      {partGeom !== null && (
        <mesh
          geometry={partGeom}
          name={`engrave-target-${target.id}`}
          userData={{ engraveTarget: target.id }}
          onClick={onPick}
        >
          <meshStandardMaterial
            color={STOCK_COLOR}
            emissive={selected ? SELECTED_GLOW : '#000000'}
            emissiveIntensity={selected ? 0.6 : 0}
            metalness={0.05}
            roughness={0.75}
          />
        </mesh>
      )}
      {removedGeom !== null && (
        <mesh
          geometry={removedGeom}
          name={partGeom === null ? `engrave-target-${target.id}` : `engrave-goal-removed-${target.id}`}
          userData={{ engraveTarget: target.id }}
          onClick={onPick}
          renderOrder={3}
        >
          <meshStandardMaterial
            color={REMOVED_COLOR}
            transparent
            opacity={REMOVED_OPACITY}
            depthWrite={false}
            metalness={0.05}
            roughness={0.8}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
    </group>
  );
}

/** #435 — every enabled primitive and the target object, or nothing when the job has neither. */
export function EngravePrimitives() {
  const primitives = useEngraveJobStore((s) => s.job.primitives);
  const target = useEngraveJobStore((s) => s.job.targetObject);
  // #811 — the goal's drawing is compiled by the preview worker; a stated goal with no compiled
  // volume (a picture, missing bytes, an open mesh) falls back to the pre-#811 drawing.
  const goal = useEngravePreviewStore((s) => s.preview?.goal ?? null);
  const enabled = (primitives ?? []).filter((p) => p.enabled);
  const goalTarget =
    target !== undefined && target.enabled && (target.role ?? 'reference') === 'goal';

  if (enabled.length === 0 && (target === undefined || !target.enabled)) return null;

  return (
    <group name="engrave-3d">
      {target !== undefined &&
        target.enabled &&
        (goalTarget && goal !== null ? (
          <GoalVolumes target={target} goal={goal} />
        ) : (
          <TargetObjectMesh target={target} />
        ))}
      {enabled.map((primitive) => (
        <PrimitiveBody key={primitive.id} primitive={primitive} />
      ))}
    </group>
  );
}
