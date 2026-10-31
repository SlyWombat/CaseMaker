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
import { useMachineStore } from '@/store/machineStore';
import { useFirstRegistration } from '@/store/engraveRegistrationStore';
import { useEngraveReleaseStore } from '@/store/engraveReleaseStore';
import { useSimStore } from '@/store/simStore';
import { useViewportStore, isEngraveItemSelected } from '@/store/viewportStore';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { EngravePreviewLost, EngravePreviewOutline } from '@/workers/sim/engravePreview';
import type { EngravePreviewRegistrationBand } from '@/workers/sim/engraveRegistration';
import { mm } from '@/engine/cnc/engrave/depthBounds';
import { jobMachine } from '@/engine/cnc/calibration';
import { machineBedPlate } from '@/engine/cnc/bedPlate';
import { jobVise } from '@/engine/cnc/fixture';
import { BED_COLOR } from '@/engine/cnc/bedScene';
import { jobTool } from '@/engine/cnc/engrave/jobSetup';
import { PROBE_SPEC } from '@/engine/cnc/engrave/registration';
import { MACHINES } from '@/engine/cnc/machine';
import { resolveTool } from '@/engine/cnc/toolRegistry';
import { geometryFromMesh, SACRIFICIAL_COLOR, segmentGeometry } from './simGeometry';
import { fittedTool, toolPlacement } from './liveMachineTool';
import { LiveToolHead } from './LiveToolHead';
import { TouchMarkers } from './TouchMarkers';
import { floorColor, LOST_COLOR, REGISTRATION_COLOR, STOCK_COLOR, VOID_COLOR, WARNING_COLOR } from './engraveRamp';
import { hatchSegments } from './engraveHatch';
import { clampLabelBox, projectToCanvas } from './projectedLabel';
import { activateEngraveItem } from './engravePick';
import { floorsForScrub, scrubStateAt } from './engraveScrub';
import { warningOutlinesFor, type WarningRing } from './engraveWarning';
import { EngravePrimitives } from './EngravePrimitives';
import { stockGhost, statedGoalTarget } from './goalDrawing';
import { foundTransform } from './foundTransform';
import { useThree } from '@react-three/fiber';
import { rotaryMapOf, type RotaryMap } from '@/engine/cnc/rotary/wrap';
import { useRotaryViewStore } from '@/store/rotaryViewStore';
import { RotaryMapDecorations } from './RotaryMapDecorations';
import { ROTARY_MAP_NARROW_PX } from './rotaryMapView';
import { wrapMapGeometry } from './rotaryStockView';
import { RotaryGoalSurface } from './RotaryGoalSurface';

/** The same fixture grey the simulation's jaws use (#197, #204). */
const JAW_COLOR = '#4b5563';
/** #811 — the blank's outline while the stock is ghosted: pale, a step lighter than the stock. */
const STOCK_OUTLINE_COLOR = '#e8cfa1';
/** PROVISIONAL (#205): the axis marker's length as a fraction of the stock's smaller side. */
const AXIS_FRACTION = 0.2;
/**
 * #441 — the glow a SELECTED floor takes. It is added to the depth colour rather than replacing
 * it: the ramp (#170) is the floor's depth reading, and a selection that repainted the floor would
 * make "selected" and "this deep" the same visual claim. Emissive is additive, so the ramp's
 * colour still shows through while the selected item reads as lit.
 */
const SELECTED_FLOOR_GLOW = '#9adcff';

/**
 * A geometry built from a worker mesh, disposed when the mesh is replaced or on unmount. A
 * rebuild replaces the stock/floors as the user types, so without this the geometries would
 * accumulate (`renderer.info.memory.geometries` must stay bounded — #197).
 */
function useMeshGeometry(
  mesh: NodeMeshOutput | null,
  /** #716 — non-null wraps the map geometry onto the stock cylinder (the Stock view). */
  wrapRadius: number | null = null,
  /** #716 — a floor is painted on the stock's SKIN (its colour is its depth), not buried in it. */
  wrapLift = false,
): THREE.BufferGeometry | null {
  const geom = useMemo(() => {
    if (!mesh) return null;
    const map = geometryFromMesh(mesh);
    if (wrapRadius === null) return map;
    const wrapped = wrapMapGeometry(map, wrapRadius, wrapLift);
    map.dispose();
    return wrapped;
  }, [mesh, wrapRadius, wrapLift]);
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
 *
 * The selection is read from `viewportStore`, the same store the panel's name controls write, so
 * the two directions cannot disagree; and because it is a store value rather than component state,
 * a rebuilt preview (which replaces every floor mesh) redraws with the highlight still on.
 */
function Floor({
  mesh,
  color,
  labelId,
  wrapRadius = null,
}: {
  mesh: NodeMeshOutput;
  color: string;
  labelId: string;
  /** #716 — the Stock view wraps the same floor onto the cylinder. */
  wrapRadius?: number | null;
}) {
  const geom = useMeshGeometry(mesh, wrapRadius, wrapRadius !== null);
  const selected = useViewportStore((s) => isEngraveItemSelected(s.selection, labelId));
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
      <meshStandardMaterial
        color={color}
        emissive={selected ? SELECTED_FLOOR_GLOW : '#000000'}
        emissiveIntensity={selected ? 0.6 : 0}
        metalness={0.05}
        roughness={0.7}
      />
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

/**
 * #549 — how far above the top face a blocked item's warning outline floats, mm. The same lift the
 * void outline uses: clear of the face's own geometry and of the lost layer's sliver (0 … 0.02), so
 * a dashed ring that overlaps the stock is still read as sitting ON the face, not inside it.
 */
const WARNING_LIFT = 0.05;

/**
 * Line segments for every ring of one blocked item's design, floating just above the stock's top
 * face, dashed. The dashed material needs `computeLineDistances` on the geometry, done here exactly
 * as `segmentGeometry(…, dashed)` does.
 */
function warningGeometry(rings: readonly WarningRing[], z: number): THREE.BufferGeometry {
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
  new THREE.LineSegments(geom).computeLineDistances();
  return geom;
}

/** One blocked item's design outline, drawn dashed in the warning colour at its real position. */
function WarningOutlineLines({ labelId, rings }: { labelId: string; rings: readonly WarningRing[] }) {
  const geom = useMemo(() => warningGeometry(rings, WARNING_LIFT), [rings]);
  useEffect(() => () => geom.dispose(), [geom]);
  return (
    <lineSegments
      geometry={geom}
      name={`engrave-warning-${labelId}`}
      userData={{ engraveWarning: labelId }}
    >
      <lineDashedMaterial color={WARNING_COLOR} dashSize={1.5} gapSize={1} />
    </lineSegments>
  );
}

/**
 * #549 — the "here is where you put it" overlay: for every enabled, non-construction label, simple
 * shape or vector that the preview cut NOTHING of (out of the stock, inside the jaw-clearance
 * margin, or refused with an error finding), draw its DESIGN outline at its real position in the
 * warning colour. The clipped "what will actually cut" floors stay as they are; this is additive.
 */
function WarningOutlines() {
  const job = useEngraveJobStore((s) => s.job);
  const preview = useEngravePreviewStore((s) => s.preview);
  const floorIds = useMemo(
    () => new Set((preview?.floors ?? []).map((f) => f.labelId)),
    [preview],
  );
  const outlines = useMemo(() => warningOutlinesFor(job, floorIds), [job, floorIds]);
  if (outlines.length === 0) return null;
  return (
    <group name="engrave-warnings">
      {outlines.map((o) => (
        <WarningOutlineLines key={o.labelId} labelId={o.labelId} rings={o.rings} />
      ))}
    </group>
  );
}

/**
 * #557 — the machine's usable work area: the 200 × 200 bed plate the vise mounts on, drawn UNDER
 * the drawn vise at the vise's real machine position (the locating pins, `bedPlate.ts`), so the
 * stock and the vise read as sitting in the real machine envelope instead of floating. It is the
 * machine's own envelope from `jobMachine`, placed in the WORK frame by `machineBedPlate`.
 */
function MachineBed() {
  const job = useEngraveJobStore((s) => s.job);
  // Memoised on the job: the box changes only when the job does, so a scrub or a camera move
  // rebuilds nothing (`renderer.info.memory.geometries` must stay bounded — #197).
  const { centre, size } = useMemo(() => {
    const box = machineBedPlate(jobVise(job), job.sacrificial, jobMachine(job, null));
    return {
      centre: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2] as [number, number, number],
      size: [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]] as [number, number, number],
    };
  }, [job]);
  if (!(size[0] > 0 && size[1] > 0 && size[2] > 0)) return null;
  return (
    <mesh position={centre} name="engrave-bed-plate">
      <boxGeometry args={size} />
      <meshStandardMaterial color={BED_COLOR} metalness={0.15} roughness={0.7} />
    </mesh>
  );
}

/**
 * #716 — THE ROTARY VIEW'S OWN FRAMING. The generic Top preset frames the scene's bounds, and an
 * engrave preview's bounds include the 200 mm bed plate, which leaves an 85 × 62.8 mm map a small
 * patch in the middle. Here the map is framed as the map (straight down, X right, around up) and
 * the wrapped stock as a rod (a perspective three-quarter view), once per job and per switch — a
 * later orbit is the operator's, not yanked back on every rebuild.
 *
 * #716 review — on a phone the Depth panel sits over the canvas's top-right corner and covered the
 * map's top edge and the seam's 360° label. A narrow canvas is therefore framed inside the free
 * area: the larger of the strip below the panel and the column beside it, measured from the DOM.
 * The map's own label margins (taller on a narrow canvas, where its rows move apart) keep the
 * projected words inside the same rectangle.
 */
const MAP_MARGIN_W_MM = 20;
const MAP_MARGIN_H_MM = 12;
/** A narrow canvas has two label rows below the map, so its bottom margin is taller. */
const MAP_MARGIN_H_NARROW_MM = 18;
/** The same 15% air the generic presets keep around what they frame. */
const MAP_FIT = 1.15;
/** Clearance, px, between the framed map and the Depth panel or the canvas edge. */
const MAP_LEGEND_PAD_PX = 8;

interface CanvasBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The Depth panel's box in canvas pixels — the region a narrow map must not sit under. */
function legendCanvasBox(canvas: HTMLCanvasElement): CanvasBox | null {
  const el = document.querySelector('[data-testid="engrave-preview-legend"]');
  if (el === null) return null;
  const c = canvas.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return {
    left: r.left - c.left,
    top: r.top - c.top,
    right: r.right - c.left,
    bottom: r.bottom - c.top,
  };
}

function RotaryViewCamera({ map, mode }: { map: RotaryMap; mode: 'map' | 'stock' }): null {
  const { camera, controls, gl, size } = useThree() as {
    camera: THREE.PerspectiveCamera;
    controls: { target: THREE.Vector3; update?: () => void } | null;
    gl: { domElement: HTMLCanvasElement };
    size: { width: number; height: number };
  };
  // Wait for the preview: the preview's arrival is also when `AutoFrame` frames the scene, and this
  // effect must run after it so the map is not left framed by the bed.
  const previewReady = useEngravePreviewStore((s) => (s.preview === null ? 0 : 1));
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (previewReady === 0) return;
    const key = `${map.stickout}:${map.radius}:${mode}:${size.width}x${size.height}`;
    if (applied.current === key) return;
    const narrow = size.width < ROTARY_MAP_NARROW_PX;
    let tries = 0;
    let next: number | null = null;
    const apply = (): void => {
      // A narrow map is framed around the Depth panel, so the panel's box must exist. It commits
      // beside the canvas AFTER this component's effects on the preview's first frame; wait a few
      // frames for it rather than frame the map under a panel that is about to appear.
      const legend = mode === 'map' && narrow ? legendCanvasBox(gl.domElement) : null;
      if (mode === 'map' && narrow && legend === null && tries < 20) {
        tries += 1;
        next = requestAnimationFrame(apply);
        return;
      }
      applied.current = key;
      const fov = (camera.fov * Math.PI) / 180;
      const tan = Math.tan(fov / 2);
      const aspect = camera.aspect > 0 ? camera.aspect : 1;
      const centre =
        mode === 'map'
          ? new THREE.Vector3(map.stickout / 2, map.circumference / 2, 0)
          : new THREE.Vector3(map.stickout / 2, 0, -map.radius);
      const up: [number, number, number] = mode === 'map' ? [0, 1, 0] : [0, 0, 1];
      const dir =
        mode === 'map'
          ? new THREE.Vector3(0, 0, 1)
          : new THREE.Vector3(0.55, -1, 0.6).normalize();
      const focus = centre.clone();
      let distance: number;
      if (mode === 'map') {
        // Fit BOTH axes: a phone's narrow aspect makes the horizontal field much smaller than the
        // vertical, and a vertical-only fit cut the map's along axis off at 390 px. The margin
        // covers the rulers and band labels, which stand outside the stock.
        const halfW = map.stickout / 2 + MAP_MARGIN_W_MM;
        const halfH = map.circumference / 2 + (narrow ? MAP_MARGIN_H_NARROW_MM : MAP_MARGIN_H_MM);
        // The free area: the whole canvas on a wide screen; on a narrow one, the larger of what is
        // below the Depth panel and what is left of it. Framing inside it keeps the map — and the
        // labels the collision layout keeps — clear of the panel.
        let target: CanvasBox = { left: 0, top: 0, right: size.width, bottom: size.height };
        if (narrow && legend !== null) {
          const below: CanvasBox = {
            left: MAP_LEGEND_PAD_PX,
            top: legend.bottom + MAP_LEGEND_PAD_PX,
            right: size.width - MAP_LEGEND_PAD_PX,
            bottom: size.height - MAP_LEGEND_PAD_PX,
          };
          const beside: CanvasBox = {
            left: MAP_LEGEND_PAD_PX,
            top: MAP_LEGEND_PAD_PX,
            right: legend.left - MAP_LEGEND_PAD_PX,
            bottom: size.height - MAP_LEGEND_PAD_PX,
          };
          const scaleOf = (box: CanvasBox): number =>
            Math.min((box.right - box.left) / (2 * halfW), (box.bottom - box.top) / (2 * halfH));
          const candidates = [below, beside].filter(
            (box) => box.right - box.left >= 80 && box.bottom - box.top >= 80,
          );
          if (candidates.length > 0) {
            target = candidates.reduce((a, b) => (scaleOf(b) > scaleOf(a) ? b : a));
          }
        }
        const scale =
          Math.min(
            (target.right - target.left) / (2 * halfW),
            (target.bottom - target.top) / (2 * halfH),
          ) / MAP_FIT;
        distance = size.height / 2 / (tan * scale);
        // The map's centre projects to the canvas centre; shift the look-at point by the target
        // rect's offset so the CONTENT, not the canvas, is what the free area centres.
        const dx = (target.left + target.right) / 2 - size.width / 2;
        const dy = (target.top + target.bottom) / 2 - size.height / 2;
        focus.x -= dx / scale;
        focus.y += dy / scale;
      } else {
        const halfW = map.stickout / 2 + 10;
        const halfH = map.radius / 2 + 4;
        distance = Math.max(halfW / (tan * aspect), halfH / tan) * 1.15;
      }
      camera.up.set(...up);
      camera.position.copy(focus.clone().add(dir.multiplyScalar(distance)));
      if (controls?.target) {
        controls.target.copy(focus);
        controls.update?.();
      }
      camera.lookAt(focus);
    };
    apply();
    return () => {
      if (next !== null) cancelAnimationFrame(next);
    };
  }, [map, mode, previewReady, camera, controls, gl, size.width, size.height]);
  return null;
}

/**
 * #811 — the blank's CRISP outline. With the stock ghosted so a goal reads through it, the
 * silhouette would otherwise dissolve; the blank's edges stay as lines. The bbox of the drawn
 * stock mesh IS the blank — a cut changes the surface, never the outside — so this is one box's
 * edges whatever state the design ↔ as-cut slider is showing.
 */
function StockOutline({ geom }: { geom: THREE.BufferGeometry }) {
  const edges = useMemo(() => {
    if (geom.boundingBox === null) geom.computeBoundingBox();
    const box = geom.boundingBox;
    if (box === null) return null;
    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);
    const boxGeom = new THREE.BoxGeometry(size.x, size.y, size.z);
    const out = new THREE.EdgesGeometry(boxGeom);
    boxGeom.dispose();
    out.translate(centre.x, centre.y, centre.z);
    return out;
  }, [geom]);
  useEffect(() => () => edges?.dispose(), [edges]);
  if (edges === null) return null;
  return (
    <lineSegments geometry={edges} name="engrave-stock-outline">
      <lineBasicMaterial color={STOCK_OUTLINE_COLOR} />
    </lineSegments>
  );
}

export function EngravePreview() {
  const preview = useEngravePreviewStore((s) => s.preview);
  // §5.7 — the design ↔ as-cut slider's position. `null` (the store's default and its state after
  // every rebuild) means the finished preview, which is what this component drew before the slider.
  const scrubStage = useEngravePreviewStore((s) => s.scrubStage);
  const stock = useEngraveJobStore((s) => s.job.stock);
  const minFloor = useEngraveJobStore((s) => s.job.minFloor);
  // #604 — the found position: the registration's offset/rotation move the drawn stock (and the
  // design on it) so the viewport shows where the blank actually sits, not where the plan assumed.
  const job = useEngraveJobStore((s) => s.job);
  // #716 — the rotary view. `map` (the default) draws the stock's surface unrolled, exactly as the
  // CAM authors it; `stock` wraps the SAME meshes onto the cylinder. A flat job is always `null`
  // here and takes every branch as it did before this slice.
  const designView = useRotaryViewStore((s) => s.design);
  const rotary = useMemo(() => rotaryMapOf(job), [job]);
  const wrapRadius = rotary !== null && designView === 'stock' ? rotary.radius : null;
  // #723 R-3 — a goal on a rod is drawn from its radial field (both views), and the flat-framed
  // mesh the primitives layer would draw at `position.z` is not this job's picture: on a rod the
  // radius IS the height, and `position.z` is ignored.
  //
  // #808 — GHOSTING FOLLOWS THE JOB, NOT THE BYTES. `rotaryGoalTarget` is null until #720's blob
  // store re-attaches the mesh, and a sheet ghosted from that answer stayed OPAQUE on the render
  // before it — hiding the part once it arrived behind an opaque sheet's depth (the #723 R-4
  // e2e's 1-in-3 blank map: the goal mesh was in the scene, visible, and never drew a pixel).
  // The job stating a goal is what the ghosting is for, and that is known without the bytes.
  // #811 — the same rule now ghosts FLAT stock too: a stated goal lies in or under the blank's
  // top face, and an opaque sheet hides it exactly as it hid the rotary relief.
  const statedGoal = statedGoalTarget(job) !== null;
  const rotaryGoal = rotary !== null && statedGoal;
  const ghost = stockGhost(statedGoal);
  const machine = useMachineStore((s) => s.machine);
  const target = machine === null ? null : { host: machine.host, port: machine.port };
  const machineKey = machine === null ? null : `${machine.host}:${machine.port}`;
  const registration = useFirstRegistration(job.id, target);
  const found = registration === null ? null : { offset: registration.outcome.offset, rotationDeg: registration.outcome.rotationDeg };
  const transform = foundTransform(found);

  // #527 §6 — the machine layer's body, at the live WPos (`toolPlacement`), under the same `tool`
  // toggle the simulation's head uses. This scene has no scrub step — no program is simulated here —
  // so with no machine answering there is no position and nothing is drawn.
  const reachable = useMachineStore((s) => s.heartbeat.reachable);
  const registrationActive = useMachineStore((s) => s.registrationActive);
  const toolLayer = useSimStore((s) => s.layers.tool);
  const touchesLayer = useSimStore((s) => s.layers.touches);
  const placement = toolPlacement({ reachable, wpos: machine?.statusLine?.wpos ?? null }, null);
  const holder = machine?.profileId != null ? MACHINES[machine.profileId]?.holder ?? null : null;
  // The cutter the machine has NOW (#527): a release's current program once the bit change is
  // confirmed, else the job's own. The probe is the body while a registration owns the machine,
  // at the tip the APPROVED plan carries (the 3D probe's differs — #525).
  const release = useEngraveReleaseStore((s) => (machineKey === null ? null : s.records[machineKey] ?? null));
  // Memoized on the JOB and the release, not rebuilt per render: `jobTool` materialises a fresh
  // `Tool`, and a new identity would rebuild the body's geometry every heartbeat tick.
  const cutter = useMemo(() => fittedTool(job, jobTool(job), release, resolveTool), [job, release]);
  // #525 — the plan's probe may carry no measured tip (an unmeasured instrument; the planner refuses
  // such a plan, so a recorded one has values); the labelled fallback stands in for the drawing.
  const probeTip = job.setups?.[0]?.registration?.plan.probe?.tip?.diameterMm ?? PROBE_SPEC.tipDiameter;

  // Hooks run before the early return; the geometry is null until the first preview lands, and it
  // is replaced (with its old geometry disposed) whenever the slider settles on another stage.
  const scrub = preview ? scrubStateAt(preview, scrubStage) : null;
  // The MAP stock geometry is built for both views: the Stock view uses the same scrub state's
  // existence to know there is a body to draw, and replaces the coarse wrapped prism with a
  // cylinder (a wrapped rectangular prism has four corners around, not a round rod).
  const stockGeom = useMeshGeometry(scrub?.mesh ?? null);
  // The ramp's upper bound: what this stock will allow at all (#205). The distinct-depth list the
  // legend used to build lives with the legend now (#349).
  const maxDepth = stock.thickness - minFloor;

  if (!preview || !scrub || !stockGeom) return null;

  const axisLen = Math.max(8, Math.min(Math.min(stock.length, stock.width) * AXIS_FRACTION, 25));
  // A floor belongs to a cut that has happened. Drawing a deep floor over a stock state that has
  // not cut there yet would show a surface inside solid material; at the as-cut end this is every
  // floor, exactly as before the slider.
  const floors = floorsForScrub(preview.floors, scrub);

  return (
    <group>
      {rotary !== null && <RotaryViewCamera map={rotary} mode={designView} />}
      <group name="engrave-found" position={transform.position} rotation={transform.rotation}>
        {wrapRadius !== null && rotary !== null ? (
          <>
            <mesh
              position={[rotary.stickout / 2, 0, -rotary.radius]}
              rotation={[0, 0, Math.PI / 2]}
              name="engrave-stock-cylinder"
            >
              <cylinderGeometry args={[rotary.radius, rotary.radius, rotary.stickout, 96]} />
              {/* #723 R-3 — the relief's surface sits INSIDE the rod (r = R + z, z ≤ 0). With a
                  goal drawn, the stock is GHOSTED so the part reads through it; without one it is
                  the solid rod it has always been. */}
              <meshStandardMaterial
                color={STOCK_COLOR}
                metalness={0.05}
                roughness={0.75}
                transparent={ghost.transparent}
                opacity={ghost.opacity}
                depthWrite={ghost.depthWrite}
              />
            </mesh>
          </>
        ) : (
          <mesh geometry={stockGeom} name="engrave-stock">
            {/* #723 R-3 / #811 — the stock surface is ghosted while a goal is drawn: on a rod the
                relief lies BELOW it (z = r − R ≤ 0), and on flat stock the goal lies in or under
                the top face. Opaque otherwise, as it has always been. */}
            <meshStandardMaterial
              color={STOCK_COLOR}
              flatShading
              metalness={0.05}
              roughness={0.75}
              transparent={ghost.transparent}
              opacity={ghost.opacity}
              depthWrite={ghost.depthWrite}
            />
          </mesh>
        )}

        {/* #811 — a ghosted stock loses its silhouette; the blank's edges stay drawn crisply so
            the operator can still read where the stock is. Flat stock only: the rotary views have
            their own seam and rulers. */}
        {rotary === null && ghost.transparent && <StockOutline geom={stockGeom} />}

      {/* #716 — the Stock view draws only what wraps: the stock, its floors and the seam. The flat
          overlays below are map-frame drawings (or a vise a rotary job does not sit in); leaving
          them at z = 0 over a turned cylinder would describe a machine the job is not on. */}
      {wrapRadius === null &&
        rotary === null &&
        preview.sacrificial.map((s) => (
          <Sacrificial key={s.id} mesh={s.mesh} name={`engrave-${s.id}`} label={s.label} />
        ))}

      {rotary !== null && (
        <RotaryGoalSurface job={job} rotary={rotary} wrapRadius={wrapRadius} />
      )}

      {floors.map((f) => (
        <Floor
          key={f.labelId}
          mesh={f.mesh}
          labelId={f.labelId}
          wrapRadius={wrapRadius}
          color={floorColor(f.depth, maxDepth, preview.colourBoundaryDepth)}
        />
      ))}

      {/* #435 — the 3D primitives and the reference object. They are drawn from the JOB, not from
          the worker's preview: a refused shape (a sphere, a side-opening primitive) has no floor,
          and drawing it anyway is how its row and its by-name refusal remain visible together. */}
      {wrapRadius === null && !rotaryGoal && <EngravePrimitives />}

      {/* §5.7 — the design the cut does not reach. Drawn after the floors so the amber is never
          hidden by a floor at the same XY; the lost region is on the top face, which is above
          every floor anyway.

          Only at the as-cut end: the lost layer is the FINAL difference between the design and what
          the cutter leaves, and painting it over a part-way state would call every not-yet-cut
          glyph "lost". Scrub back and the claim is withheld with the geometry. */}
      {wrapRadius === null &&
        scrub.atCut &&
        preview.lost.map((l) => <Lost key={l.labelId} item={l} />)}

      {wrapRadius === null &&
        preview.outlines.map((o) => <Outline key={`${o.labelId}:${o.level}`} {...o} />)}

      {wrapRadius === null &&
        rotary === null &&
        preview.voids.map((v) => (
          <Void key={v.id} id={v.id} rings={v.rings} name={v.name} membrane={v.membrane} limit={v.limit} />
        ))}

      {/* §5.4 — where the stock may sit relative to what the setup was registered against. Drawn
          at every slider position: it is a fact about the mount, not about how deep the cut is. */}
      {wrapRadius === null &&
        rotary === null &&
        preview.registration.map((band) => <RegistrationBand key={band.id} band={band} />)}

      {/* #557 — the machine's bed plate, drawn under the vise so the setup reads as seated in the
          real machine envelope rather than floating. A rotary job is not on the vise: the map is
          the stock's own surface, so neither the plate nor the jaws is drawn (#716). */}
      {wrapRadius === null && rotary === null && <MachineBed />}

      {wrapRadius === null &&
        rotary === null &&
        preview.fixture.map((jaw) => <Jaw key={jaw.id} mesh={jaw.mesh} name={`engrave-${jaw.id}`} />)}

      {/* #549 — blocked items' design outlines, drawn after the floors and fixture so they read
          over the clipped preview as the "here is where you put it" overlay. */}
      {wrapRadius === null && <WarningOutlines />}

      {/* The work origin: the stock's top-front-left corner, with X and Y labelled. */}
      {rotary === null && (
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
      )}

      {/* #519 item 1 — the registration's touch dots. INSIDE the found group (#604) on purpose: the
          touches are where the probe met the stock, so they move with the stock the viewport draws
          at its found position, not with the plan frame. */}
      {wrapRadius === null && touchesLayer && <TouchMarkers />}

      {/* #716 — the map's own decorations: the around and along rulers, the seam and the two end
          bands. Map view only: they are how the unrolled surface is read, and the wrapped stock
          carries the seam below. */}
      {rotary !== null && wrapRadius === null && <RotaryMapDecorations map={rotary} />}

      {/* The seam on the wrapped stock: the top line where the map's two edges meet, A = 0. */}
      {wrapRadius !== null && rotary !== null && (
        <mesh position={[rotary.stickout / 2, 0, 0.04]} name="rotary-stock-seam">
          <boxGeometry args={[rotary.stickout, 0.5, 0.1]} />
          <meshBasicMaterial color="#f0d79b" />
        </mesh>
      )}

      </group>
      {/* #527 §6 — the machine layer's body at the live WPos, in the PLAN frame: #604 draws the
          stock at the found offset, and what the written G54 carries is that translation — never
          the skew — so the tool takes the offset and not the rotation. */}
      {toolLayer && (
        <group position={[transform.position[0], transform.position[1], 0]}>
          <LiveToolHead
            at={placement?.at ?? null}
            tool={cutter}
            probeTipDiameterMm={registrationActive ? probeTip : null}
            holder={holder}
            name="engrave-tool"
          />
        </group>
      )}
      {found !== null && (
        <Html position={[stock.length / 2, stock.width / 2, 2]}>
          <div className="engrave-found-badge" data-testid="engrave-found-badge">
            found: X {found.offset.x} mm · Y {found.offset.y} mm
            {found.rotationDeg === null ? '' : ` · ${found.rotationDeg}°`}
          </div>
        </Html>
      )}
    </group>
  );
}
