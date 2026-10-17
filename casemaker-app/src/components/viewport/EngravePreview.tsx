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
 * cut it permits. §5.7's lost layer is the other amber overlay on that face: the design minus the
 * opening the cutter leaves, filled and hatched, one labelled area per item.
 *
 * The stock drawn here is whichever cumulative state the viewport's design ↔ as-cut slider selects
 * (`engraveScrub.ts`): the finished preview at its right end — the default, and the only state
 * before the slider existed — or an earlier cut depth on the way there. Floors follow the same
 * position, and the lost layer appears only at as-cut because it is a claim about the final result.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useViewportStore } from '@/store/viewportStore';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { ViseParams } from '@/types/engraveJob';
import type { EngravePreviewLost, EngravePreviewOutline } from '@/workers/sim/engravePreview';
import type { EngravePreviewRegistrationBand } from '@/workers/sim/engraveRegistration';
import { mm } from '@/engine/cnc/engrave/depthBounds';
import { geometryFromMesh, SACRIFICIAL_COLOR, segmentGeometry } from './simGeometry';
import { floorColor, LOST_COLOR, REGISTRATION_COLOR, VOID_COLOR } from './engraveRamp';
import { hatchSegments } from './engraveHatch';
import { clampLabelBox, projectToCanvas } from './projectedLabel';
import { activateEngraveItem } from './engravePick';
import { floorsForScrub, scrubStateAt } from './engraveScrub';

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

/**
 * One cut's floor, coloured by `floorColor` — the depth ramp, or the two-colour reading (#170).
 *
 * #441 — the floor is also its item's PICK TARGET. The tag is the job's own item id, the same
 * string the panel's row list keys on, so `activateEngraveItem` can select the item and open its
 * row without a parallel index. The Select-tool gate is read fresh at click time, exactly as the
 * #83 pickers do, so an orbit drag over the preview never selects. Floors that belong to traces,
 * drills, vectors and combined shapes resolve the same way: the preview emits one floor per cut,
 * and every cut carries its item's id.
 */
function Floor({ mesh, color, labelId }: { mesh: NodeMeshOutput; color: string; labelId: string }) {
  const geom = useMeshGeometry(mesh);
  if (!geom) return null;
  return (
    <mesh
      geometry={geom}
      name={`engrave-floor-${labelId}`}
      userData={{ engraveFloor: labelId }}
      onClick={(e) => {
        const { activeTool } = useViewportStore.getState();
        if (activeTool !== 'select') return;
        if (!activateEngraveItem(e.object)) return;
        e.stopPropagation();
      }}
    >
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

/**
 * How far above its own level a V-carve outline floats, mm. The floor is a mesh whose top face
 * sits exactly at `depth`; without the lift the outline would z-fight with it, and the surface
 * outline with the stock's top face.
 */
const OUTLINE_LIFT = 0.02;

/**
 * The three V-carve levels (#221): the opening at the top face, the colour plane where the
 * design is correct, and the floor the tip leaves. Distinct hues because the POINT of drawing
 * them together is to see how far each one sits from the design.
 */
const OUTLINE_COLOR: Record<EngravePreviewOutline['level'], string> = {
  surface: '#f5a524',
  plane: '#4cc3ff',
  floor: '#8bd450',
};

/** One V-carve outline: every ring drawn as line segments at its own depth. */
function Outline({ labelId, level, depth, rings }: EngravePreviewOutline) {
  const z = -depth + OUTLINE_LIFT;
  const geom = useMemo(() => voidGeometry(rings, z), [rings, z]);
  useEffect(() => () => geom.dispose(), [geom]);
  return (
    <lineSegments
      geometry={geom}
      name={`engrave-${level}-outline-${labelId}`}
      userData={{ engraveOutline: level, labelId }}
    >
      <lineBasicMaterial color={OUTLINE_COLOR[level]} />
    </lineSegments>
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

/** The lost layer's hatch spacing and angle, mm and degrees — the drawing's own choice, not a job value. */
const LOST_HATCH_PITCH_MM = 0.6;
const LOST_HATCH_ANGLE_DEG = 45;
/**
 * The worker's lost sliver stands 20 µm on the face (`LOST_THICKNESS_MM` in `engravePreview.ts`,
 * which cannot be imported here without pulling the worker's wasm graph into the app bundle). The
 * hatch rides just above its top face so the lines are not z-fighting the fill they describe.
 */
const LOST_SLIVER_TOP_MM = 0.02;
const LOST_HATCH_LIFT_MM = LOST_SLIVER_TOP_MM + 0.01;

/** `4.2 mm²` — the same precision the run sheet prints an area at (`restSettings.mm2`). */
function lostAreaWords(area: number): string {
  return `${Number(area.toFixed(2))} mm²`;
}

const LOST_LABEL = {
  fontSize: 10,
  color: LOST_COLOR,
  background: 'rgba(20,25,30,0.7)',
  borderRadius: 3,
  padding: '1px 4px',
  whiteSpace: 'nowrap',
} as const;

/**
 * §5.7 — one item's LOST LAYER: the design the cutter's opening does not reach, drawn ON the top
 * face in amber. The fill says where the face is not cut; the hatch says it is an absence rather
 * than another floor; the label gives the area the legend totals. Both the fill and the hatch come
 * from the worker's `design − as-cut` contours — there is no second measurement here.
 *
 * Like a floor, the region is a PICK TARGET for its item (#441): clicking the loss opens the row
 * of the item whose design it is.
 */
function Lost({ item }: { item: EngravePreviewLost }) {
  const geom = useMeshGeometry(item.mesh);
  const hatch = useMemo(() => {
    const spans = hatchSegments(item.polygons, LOST_HATCH_PITCH_MM, LOST_HATCH_ANGLE_DEG);
    if (spans.length === 0) return null;
    const points = new Float32Array(spans.length * 6);
    spans.forEach(([a, b], i) => {
      const o = i * 6;
      points[o] = a[0];
      points[o + 1] = a[1];
      points[o + 2] = LOST_HATCH_LIFT_MM;
      points[o + 3] = b[0];
      points[o + 4] = b[1];
      points[o + 5] = LOST_HATCH_LIFT_MM;
    });
    return segmentGeometry(points, false);
  }, [item.polygons]);
  useEffect(() => () => hatch?.dispose(), [hatch]);

  if (!geom) return null;
  const centre = centreOf(item.mesh.bbox);
  return (
    <>
      <mesh
        geometry={geom}
        name={`engrave-lost-${item.labelId}`}
        userData={{ engraveLost: item.labelId }}
        onClick={(e) => {
          const { activeTool } = useViewportStore.getState();
          if (activeTool !== 'select') return;
          if (!activateEngraveItem(e.object)) return;
          e.stopPropagation();
        }}
      >
        {/* depthWrite:false, like the jaws and the removal body (#162): a transparent overlay that
            wrote depth would hide the face it is annotating. */}
        <meshStandardMaterial color={LOST_COLOR} transparent opacity={0.28} depthWrite={false} metalness={0.05} roughness={0.85} />
      </mesh>
      {hatch && (
        <lineSegments geometry={hatch} name={`engrave-lost-hatch-${item.labelId}`}>
          <lineBasicMaterial color={LOST_COLOR} />
        </lineSegments>
      )}
      <ProjectedLabel
        position={[centre[0], centre[1], LOST_HATCH_LIFT_MM]}
        testId={`engrave-lost-label-${item.labelId}`}
        style={LOST_LABEL}
      >
        lost: {lostAreaWords(item.area)}
      </ProjectedLabel>
    </>
  );
}

/**
 * How high above the top face the registration strip floats, mm. Above the lost layer's sliver
 * and its hatch (0.02 and 0.03), so a band crossing a lost region is still read as the band.
 */
const REGISTRATION_LIFT_MM = 0.05;
/** The strip's own thickness, mm — enough to draw, never enough to read as stock. */
const REGISTRATION_THICKNESS_MM = 0.01;

const REGISTRATION_LABEL = {
  fontSize: 10,
  color: REGISTRATION_COLOR,
  background: 'rgba(20,25,30,0.7)',
  borderRadius: 3,
  padding: '1px 4px',
  whiteSpace: 'nowrap',
} as const;

/**
 * §5.4/§5.7 — one strip of the registration band: the stock may sit this far either side of the
 * edge the setup was registered against. The worker hands over the strip's own rectangle, so this
 * component only draws it: a stock edge's strip runs the full side, a reference feature's strip
 * follows one of its walls, and only the first strip of a feature carries the label.
 *
 * It is an annotation, so it writes no depth (like the jaws and the lost layer, #162) and takes
 * no pointer events.
 */
function RegistrationBand({ band }: { band: EngravePreviewRegistrationBand }) {
  const [x0, y0] = band.min;
  const [x1, y1] = band.max;
  const width = x1 - x0;
  const depth = y1 - y0;
  if (!(width > 0 && depth > 0)) return null;
  return (
    <>
      <mesh
        position={[(x0 + x1) / 2, (y0 + y1) / 2, REGISTRATION_LIFT_MM]}
        name={`engrave-registration-${band.id}`}
        userData={{ engraveRegistration: band.id }}
      >
        <boxGeometry args={[width, depth, REGISTRATION_THICKNESS_MM]} />
        <meshBasicMaterial color={REGISTRATION_COLOR} transparent opacity={0.22} depthWrite={false} />
      </mesh>
      {band.label !== null && band.labelAt !== null && (
        <ProjectedLabel
          position={[band.labelAt[0], band.labelAt[1], REGISTRATION_LIFT_MM]}
          testId={`engrave-registration-label-${band.id}`}
          style={REGISTRATION_LABEL}
        >
          registration: {band.label} ±{mm(band.uncertainty)} mm
        </ProjectedLabel>
      )}
    </>
  );
}

export function EngravePreview() {
  const preview = useEngravePreviewStore((s) => s.preview);
  // §5.7 — the design ↔ as-cut slider's position. `null` (the store's default and its state after
  // every rebuild) means the finished preview, which is what this component drew before the slider.
  const scrubStage = useEngravePreviewStore((s) => s.scrubStage);
  const stock = useEngraveJobStore((s) => s.job.stock);
  const vise = useEngraveJobStore((s) => s.job.workholding.vise);
  const minFloor = useEngraveJobStore((s) => s.job.minFloor);

  // Hooks run before the early return; the geometry is null until the first preview lands, and it
  // is replaced (with its old geometry disposed) whenever the slider settles on another stage.
  const scrub = preview ? scrubStateAt(preview, scrubStage) : null;
  const stockGeom = useMeshGeometry(scrub?.mesh ?? null);
  // The ramp's upper bound: what this stock will allow at all (#205). The distinct-depth list the
  // legend used to build lives with the legend now (#349).
  const maxDepth = stock.thickness - minFloor;

  if (!preview || !scrub || !stockGeom) return null;

  const axisLen = Math.max(8, Math.min(Math.min(stock.length, stock.width) * AXIS_FRACTION, 25));
  const fixedJaw = preview.fixture[0];
  // A floor belongs to a cut that has happened. Drawing a deep floor over a stock state that has
  // not cut there yet would show a surface inside solid material; at the as-cut end this is every
  // floor, exactly as before the slider.
  const floors = floorsForScrub(preview.floors, scrub);

  return (
    <group>
      <mesh geometry={stockGeom} name="engrave-stock">
        <meshStandardMaterial color={STOCK_COLOR} flatShading metalness={0.05} roughness={0.75} />
      </mesh>

      {preview.sacrificial.map((s) => (
        <Sacrificial key={s.id} mesh={s.mesh} name={`engrave-${s.id}`} label={s.label} />
      ))}

      {floors.map((f) => (
        <Floor
          key={f.labelId}
          mesh={f.mesh}
          labelId={f.labelId}
          color={floorColor(f.depth, maxDepth, preview.colourBoundaryDepth)}
        />
      ))}

      {/* §5.7 — the design the cut does not reach. Drawn after the floors so the amber is never
          hidden by a floor at the same XY; the lost region is on the top face, which is above
          every floor anyway.

          Only at the as-cut end: the lost layer is the FINAL difference between the design and what
          the cutter leaves, and painting it over a part-way state would call every not-yet-cut
          glyph "lost". Scrub back and the claim is withheld with the geometry. */}
      {scrub.atCut &&
        preview.lost.map((l) => <Lost key={l.labelId} item={l} />)}

      {preview.outlines.map((o) => (
        <Outline key={`${o.labelId}:${o.level}`} {...o} />
      ))}

      {preview.voids.map((v) => (
        <Void key={v.id} id={v.id} rings={v.rings} name={v.name} membrane={v.membrane} limit={v.limit} />
      ))}

      {/* §5.4 — where the stock may sit relative to what the setup was registered against. Drawn
          at every slider position: it is a fact about the mount, not about how deep the cut is. */}
      {preview.registration.map((band) => (
        <RegistrationBand key={band.id} band={band} />
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
