/**
 * The engrave preview's meshes (#205), rendered by `SceneMeshes` instead of the case while the
 * Engrave section is open and no simulation owns the viewport.
 *
 * Everything arrives from the sim worker in the WORK frame — origin at the stock's top-front-left
 * corner, +X right, +Y away from the operator, Z = 0 at the stock's top face, material at
 * negative Z — and the scene is Z-up, so the meshes are drawn as-is with NO transform (exactly
 * what `SimMeshes` does). Each pocket floor is coloured by `floorColor` (#170): by its depth on a
 * FIXED ramp so the same depth reads the same everywhere, or — on a blank that states its colour
 * split — by which side of the split the floor lands on; the vise jaws are translucent and never write depth (a
 * transparent mesh that wrote depth would hide the pocket behind it — issue #162). The
 * sacrificial material (#213) is drawn from the same boxes the sweep tests against, in a paler
 * grey than the jaws so a strip between them reads as material and not as a third jaw. A legend
 * lists each distinct depth and the sacrificial swatch, and an axis marker sits at the work
 * origin with X and Y labelled — and every label projected from a world point is kept inside the
 * canvas whatever its anchor's projection does (#359, `projectedLabel.ts`). Each declared under-surface void (#271) is outlined in amber ON
 * the top face — the void itself is interior to solid material — and labelled with the deepest
 * cut it permits.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { ViseParams } from '@/types/engraveJob';
import { geometryFromMesh, SACRIFICIAL_COLOR } from './simGeometry';
import { floorColor, VOID_COLOR } from './engraveRamp';
import { clampLabelBox, projectToCanvas } from './projectedLabel';

/** The same neutral wood tone the simulation's stock uses (#197). */
const STOCK_COLOR = '#c9a26b';
/** The same fixture grey the simulation's jaws use (#197, #204). */
const JAW_COLOR = '#4b5563';
/** PROVISIONAL (#205): the axis marker's length as a fraction of the stock's smaller side. */
const AXIS_FRACTION = 0.2;

/**
 * Where the vise numbers came from, in words (decision 28: a default is not a measurement). The
 * shipped jaws are calipered (#208, 2026-10-15), so 'default' means "shipped, measured on the
 * reference unit" — not the unmeasured defaults these words used to name.
 */
function sourceWords(source: ViseParams['source']): string {
  if (source === 'default') return 'shipped defaults (reference unit)';
  if (source === 'saved') return 'saved vise';
  return 'measured for this setup';
}

/**
 * A geometry built from a worker mesh, disposed when the mesh is replaced or on unmount. A
 * rebuild replaces the stock/floors as the user types, so without this the geometries would
 * accumulate (`renderer.info.memory.geometries` must stay bounded — #197).
 */
function useMeshGeometry(mesh: NodeMeshOutput | null): THREE.BufferGeometry | null {
  const geom = useMemo(() => (mesh ? geometryFromMesh(mesh) : null), [mesh]);
  useEffect(() => () => geom?.dispose(), [geom]);
  return geom;
}

/** One cut's floor, coloured by `floorColor` — the depth ramp, or the two-colour reading (#170). */
function Floor({ mesh, color, labelId }: { mesh: NodeMeshOutput; color: string; labelId: string }) {
  const geom = useMeshGeometry(mesh);
  if (!geom) return null;
  return (
    <mesh geometry={geom} name={`engrave-floor-${labelId}`} userData={{ engraveFloor: labelId }}>
      <meshStandardMaterial color={color} metalness={0.05} roughness={0.7} />
    </mesh>
  );
}

/** One vise jaw, drawn where the user SAID it is (un-inflated). */
function Jaw({ mesh, name }: { mesh: NodeMeshOutput; name: string }) {
  const geom = useMeshGeometry(mesh);
  if (!geom) return null;
  return (
    <mesh geometry={geom} name={name}>
      {/* depthWrite:false — a transparent mesh that writes depth hides what is inside it (#162). */}
      <meshStandardMaterial
        color={JAW_COLOR}
        transparent
        opacity={0.5}
        depthWrite={false}
        metalness={0.2}
        roughness={0.6}
      />
    </mesh>
  );
}

/**
 * One piece of sacrificial material (#213): the board under the part or a strip beside it. Drawn
 * OPAQUE in the paler grey — the material is what the cutter is meant to reach, so it reads as
 * solid stock, unlike the translucent jaws behind it.
 */
function Sacrificial({ mesh, name, label }: { mesh: NodeMeshOutput; name: string; label: string }) {
  const geom = useMeshGeometry(mesh);
  if (!geom) return null;
  return (
    <mesh geometry={geom} name={name} userData={{ sacrificialLabel: label }}>
      <meshStandardMaterial color={SACRIFICIAL_COLOR} flatShading metalness={0.05} roughness={0.8} />
    </mesh>
  );
}

/**
 * The under-surface voids (#271) are drawn as an OUTLINE on the top face, never as a solid at the
 * void's ceiling: the ceiling is interior to solid material, so a body drawn there would be
 * inside the stock mesh and invisible. What matters to the eye is where on the face the void
 * lies — the region a label must be placed clear of — and how deep a cut may go there.
 *
 * The amber is the same warning tone the panel's findings use, because that is what the outline
 * means: cut over it and the job is warned, cut too deep over it and the verifier refuses.
 */
/** How far above the top face the outline floats, mm — clear of the surface's own geometry. */
const VOID_LIFT = 0.05;

/** Line segments for every ring of one void, floating just above the stock's top face. */
function voidGeometry(rings: readonly (readonly [number, number][])[], z: number): THREE.BufferGeometry {
  const pts: number[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      pts.push(a[0], a[1], z, b[0], b[1], z);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geom;
}

/** Where a void's label hangs: the mean of its outer ring's points. */
function ringCentre(ring: readonly (readonly [number, number][])[]): [number, number] | null {
  const pts = ring[0];
  if (!pts || pts.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

/** One declared void: its footprint outlined on the face, with what it leaves above it. */
function Void({
  id,
  rings,
  name,
  membrane,
  limit,
}: {
  id: string;
  rings: [number, number][][];
  name: string;
  membrane: number;
  limit: number;
}) {
  const geom = useMemo(() => voidGeometry(rings, VOID_LIFT), [rings]);
  useEffect(() => () => geom.dispose(), [geom]);
  const centre = ringCentre(rings);
  const words = limit <= 0 ? 'no cut keeps the floor' : `≤ ${limit.toFixed(2)} mm deep`;
  return (
    <>
      <lineSegments geometry={geom} name={`engrave-void-outline-${id}`} userData={{ engraveVoid: id }}>
        <lineBasicMaterial color={VOID_COLOR} />
      </lineSegments>
      {centre && (
        <ProjectedLabel
          position={[centre[0], centre[1], VOID_LIFT]}
          testId={`engrave-void-label-${id}`}
          style={{
            fontSize: 10,
            color: VOID_COLOR,
            background: 'rgba(20,25,30,0.7)',
            borderRadius: 3,
            padding: '1px 4px',
            whiteSpace: 'nowrap',
          }}
        >
          void: {name || 'unnamed'} · {words}
          {limit > 0 ? '' : ` (${membrane.toFixed(2)} mm left)`}
        </ProjectedLabel>
      )}
    </>
  );
}

/** Centre of a mesh's bbox, for anchoring a jaw's source label. */
function centreOf(bbox: { min: readonly number[]; max: readonly number[] }): [number, number, number] {
  return [
    (bbox.min[0]! + bbox.max[0]!) / 2,
    (bbox.min[1]! + bbox.max[1]!) / 2,
    (bbox.min[2]! + bbox.max[2]!) / 2,
  ];
}

const AXIS_LABEL = {
  color: '#e6e6e6',
  fontSize: 11,
  fontWeight: 700,
  textShadow: '0 0 3px #000',
} as const;

/**
 * #229 — every label here is read-only, so the drei `Html` wrapper must never take pointer
 * events. A non-`transform` `Html` renders an inner div sized to the canvas with
 * `pointer-events:auto` (drei's `pointerEvents` prop only applies in the transform branch), and
 * `fullscreen` makes that div cover the whole viewport at the toolbar's own z-index — so the
 * legend was swallowing the Top/Fit/zoom clicks. `style` reaches that wrapper, the prop does not.
 */
const NON_INTERACTIVE = { pointerEvents: 'none' } as const;

/**
 * #348 — the stacking. drei's `Html` defaults `zIndexRange` to `[16777271, 0]` and writes the
 * interpolated number onto the wrapper div it appends beside the canvas, which is why these
 * labels printed through the setup flow and the wizard: no dialog can out-stack four orders of
 * magnitude. A label projected from a scene position is an ANNOTATION, not a layer, so it takes
 * the bottom — `[0, 0]` is below the whole `--cm-z-*` scale in `src/styles/tokens.css`, and
 * deliberately not a member of it. The consequence, and it is the intended one: where a label
 * lands under the toolbar, a panel or the transport bar, the chrome is what you see.
 */
const LABEL_Z: [number, number] = [0, 0];

/**
 * #359 — a label anchored to a world point whose BOX stays inside the canvas.
 *
 * `center` puts the box's middle on the anchor's projected position, so a label whose anchor lands
 * near the canvas edge is half off it — and the wrapper is canvas-sized, so it is clipped
 * mid-word. `clampLabelBox` moves the projection inward by exactly what the box needs; drei calls
 * `calculatePosition` on every frame, and the clamp is applied there rather than in a React state
 * update, so following the camera stays as cheap as it was.
 *
 * The box's own size is read inside `calculatePosition` rather than cached from an effect, and not
 * by preference: drei renders an `Html`'s children through a `ReactDOM.createRoot` of its own on a
 * div beside the canvas, and that root commits AFTER the effects of the component that rendered
 * the `Html`. A ref held here is therefore still null when a layout effect runs, and — with
 * nothing re-rendering afterwards — it stays null: measured at 1024 × 700, caching it that way
 * clamped every label against a zero-size box, which moved the axis labels by the pad and left the
 * 133 px jaw label exactly where it was. `calculatePosition` runs every frame, from a point where
 * the DOM has settled, so it is the first place the span's real size exists at all. The read is a
 * layout lookup, not a re-layout — nothing invalidates layout between frames — and it keeps the
 * clamp honest through a font load or a change of words, which a cached size would not.
 */
function ProjectedLabel({
  position,
  testId,
  style,
  children,
}: {
  position: [number, number, number];
  testId: string;
  style: CSSProperties;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLSpanElement>(null);
  return (
    <Html
      position={position}
      center
      style={NON_INTERACTIVE}
      zIndexRange={LABEL_Z}
      calculatePosition={(el, camera, size) => {
        const [x, y] = projectToCanvas(el, camera, size);
        const box = boxRef.current;
        return clampLabelBox(
          x,
          y,
          box ? { width: box.offsetWidth, height: box.offsetHeight } : { width: 0, height: 0 },
          size,
        );
      }}
    >
      <span ref={boxRef} data-testid={testId} style={style}>
        {children}
      </span>
    </Html>
  );
}

export function EngravePreview() {
  const preview = useEngravePreviewStore((s) => s.preview);
  const stock = useEngraveJobStore((s) => s.job.stock);
  const vise = useEngraveJobStore((s) => s.job.workholding.vise);
  const minFloor = useEngraveJobStore((s) => s.job.minFloor);

  // Hooks run before the early return; the geometry is null until the first preview lands.
  const stockGeom = useMeshGeometry(preview?.stock ?? null);
  // The ramp's upper bound: what this stock will allow at all (#205). The distinct-depth list the
  // legend used to build lives with the legend now (#349).
  const maxDepth = stock.thickness - minFloor;

  if (!preview || !stockGeom) return null;

  const axisLen = Math.max(8, Math.min(Math.min(stock.length, stock.width) * AXIS_FRACTION, 25));
  const fixedJaw = preview.fixture[0];

  return (
    <group>
      <mesh geometry={stockGeom} name="engrave-stock">
        <meshStandardMaterial color={STOCK_COLOR} flatShading metalness={0.05} roughness={0.75} />
      </mesh>

      {preview.sacrificial.map((s) => (
        <Sacrificial key={s.id} mesh={s.mesh} name={`engrave-${s.id}`} label={s.label} />
      ))}

      {preview.floors.map((f) => (
        <Floor
          key={f.labelId}
          mesh={f.mesh}
          labelId={f.labelId}
          color={floorColor(f.depth, maxDepth, preview.colourBoundaryDepth)}
        />
      ))}

      {preview.voids.map((v) => (
        <Void key={v.id} id={v.id} rings={v.rings} name={v.name} membrane={v.membrane} limit={v.limit} />
      ))}

      {preview.fixture.map((jaw) => (
        <Jaw key={jaw.id} mesh={jaw.mesh} name={`engrave-${jaw.id}`} />
      ))}

      {/* The work origin: the stock's top-front-left corner, with X and Y labelled. */}
      <group name="engrave-axes">
        <mesh position={[axisLen / 2, 0, 0]}>
          <boxGeometry args={[axisLen, 0.4, 0.4]} />
          <meshBasicMaterial color="#e5484d" />
        </mesh>
        <mesh position={[0, axisLen / 2, 0]}>
          <boxGeometry args={[0.4, axisLen, 0.4]} />
          <meshBasicMaterial color="#30a46c" />
        </mesh>
        <ProjectedLabel position={[axisLen, 0, 0]} testId="engrave-axis-x" style={AXIS_LABEL}>
          X
        </ProjectedLabel>
        <ProjectedLabel position={[0, axisLen, 0]} testId="engrave-axis-y" style={AXIS_LABEL}>
          Y
        </ProjectedLabel>
      </group>

      {fixedJaw && (
        <ProjectedLabel
          position={centreOf(fixedJaw.mesh.bbox)}
          testId="engrave-jaw-source"
          style={{
            fontSize: 10,
            color: '#c8d3de',
            background: 'rgba(20,25,30,0.7)',
            borderRadius: 3,
            padding: '1px 4px',
            whiteSpace: 'nowrap',
          }}
        >
          vise: {sourceWords(vise.source)}
        </ProjectedLabel>
      )}

    </group>
  );
}
