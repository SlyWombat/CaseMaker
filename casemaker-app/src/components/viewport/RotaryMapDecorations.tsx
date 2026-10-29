/**
 * #716 — THE MAP'S DECORATIONS (design `rotary-flow.md` §3.7, R-UI-5).
 *
 * The preview already draws the rotary stock as the map — X along from the jaws, Y the arc at the
 * surface — because the CAM authors there (`engravePreview`'s stock is the map; the dowel's bounds
 * are 0…85 × 0…62.832). This component adds only what makes that map readable: the around ruler
 * every quarter turn in mm and degrees, the along ruler, the seam at 0° where A homes, the jaws'
 * and tailstock's bands with their provenance.
 *
 * Every number comes from `rotaryMapView` (which comes from `wrap.ts`), never a second
 * circumference or a guessed band. The decorations are a view: they draw nothing into the job, the
 * CAM or the run, and the seam's VALUE is a display convention in this slice (§3.7).
 *
 * #716 review — a phone showed the labels colliding ("seam · 0°" printed over the tailstock,
 * "80"/"85" over each other, the 0° tick over the jaws). Two things follow. The bottom rows move
 * apart on a narrow canvas (bands closest to the map, the along ruler below them), and a label
 * whose measured box would still touch a higher-priority one is not drawn — the greedy choice lives
 * in `rotaryMapLabels`, the measuring and projecting here. The Depth panel is dealt with by the
 * camera (`EngravePreview`'s `RotaryViewCamera` frames the map inside the free area beside it), so
 * a surviving label has no panel to clear.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, JSX, Ref } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { RotaryMap } from '@/engine/cnc/rotary/wrap';
import { hiddenMapLabels, type MapLabelRect } from './rotaryMapLabels';
import {
  ROTARY_MAP_NARROW_PX,
  rotaryAlongTicks,
  rotaryBands,
  rotaryNum,
  rotaryRulerTicks,
  rotarySeamLabels,
} from './rotaryMapView';

const LABEL: CSSProperties = {
  font: '600 10px ui-monospace, SFMono-Regular, Menlo, monospace',
  color: '#e6edf5',
  background: 'rgba(17, 24, 32, 0.78)',
  padding: '1px 4px',
  borderRadius: 3,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  userSelect: 'none',
};
const SEAM_COLOR = '#f0d79b';
const BAND_COLOR = '#f0b4ad';
/** The decoration plane, just above the map's surface so nothing z-fights with it. */
const MAP_Z = 0.05;

/**
 * The label rows, in map millimetres below the map's bottom edge. On a narrow canvas the bands and
 * the along ruler take separate rows so their boxes cannot meet; on a wide one the bands clear the
 * 0° ruler tick by more than a label's height (−4 mm is ~21 px at the desktop map's scale), which
 * is what keeps BOTH the ruler's end value and the jaws' keep-out on screen.
 */
const BAND_ROW_Y = -4;
const ALONG_ROW_Y = -8;
const NARROW_BAND_ROW_Y = -7;
const NARROW_ALONG_ROW_Y = -13;

/**
 * The priorities the greedy layout keeps when two boxes collide (`rotaryMapLabels`): a band's
 * millimetres first (it is a machine keep-out), then the rulers' END values, then the interior
 * ticks, and the seam last — its 0°/360° repeat the ruler's ends and the dashed line still draws it.
 */
const PRIORITY_BAND = 5;
const PRIORITY_ALONG_END = 10;
const PRIORITY_RULER = 20;
const PRIORITY_ALONG = 30;
const PRIORITY_SEAM = 40;
/** One pixel of slack absorbs the fractional widths `offsetWidth` rounds away. */
const LABEL_COLLISION_PAD = 1;

/** One label the map may draw: its words, its anchor in map millimetres, and its priority. */
interface MapLabelSpec {
  id: string;
  testId: string;
  text: string;
  at: [number, number];
  priority: number;
  color?: string;
  title?: string;
}

/** A dashed-line geometry from segment pairs; distances are computed for the dashed material. */
function dashedSegments(points: readonly [number, number, number][]): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(points.flat(), 3));
  new THREE.LineSegments(geom).computeLineDistances();
  return geom;
}

function SeamLines({ map }: { map: RotaryMap }): JSX.Element {
  const geom = useMemo(
    () =>
      dashedSegments([
        [0, 0, MAP_Z],
        [map.stickout, 0, MAP_Z],
        [0, map.circumference, MAP_Z],
        [map.stickout, map.circumference, MAP_Z],
      ]),
    [map],
  );
  useEffect(() => () => geom.dispose(), [geom]);
  return (
    <lineSegments geometry={geom} name="rotary-map-seam">
      <lineDashedMaterial color={SEAM_COLOR} dashSize={2} gapSize={1.5} />
    </lineSegments>
  );
}

/** One end band: a translucent face plus a hatch, both confined to its along-axis millimetres. */
function Band({
  from,
  to,
  circumference,
  id,
}: {
  from: number;
  to: number;
  circumference: number;
  id: string;
}): JSX.Element {
  const width = Math.max(0, to - from);
  const hatch = useMemo(() => {
    const pts: [number, number, number][] = [];
    const step = 2;
    for (let x = from; x <= to + 1e-9; x += step) {
      pts.push([x, 0, MAP_Z + 0.01], [x, circumference, MAP_Z + 0.01]);
    }
    return dashedSegments(pts);
  }, [from, to, circumference]);
  useEffect(() => () => hatch.dispose(), [hatch]);
  if (width <= 0) return <group />;
  return (
    <group name={`rotary-band-${id}`}>
      <mesh position={[(from + to) / 2, circumference / 2, MAP_Z]} name={`rotary-band-face-${id}`}>
        <planeGeometry args={[width, circumference]} />
        <meshBasicMaterial color={BAND_COLOR} transparent opacity={0.14} depthWrite={false} />
      </mesh>
      <lineSegments geometry={hatch}>
        <lineBasicMaterial color={BAND_COLOR} transparent opacity={0.55} />
      </lineSegments>
    </group>
  );
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Measures the labels, projects their anchors with the live camera, and keeps the ones that fit.
 *
 * The sizes come from the DOM rather than an estimate: the words' widths ARE the collision. drei
 * renders a label's children through its own React root a frame after this component, so a size can
 * be missing on the first frames — the hook simply waits, then lays out.
 *
 * `data-rotary-map-settled` is written on the canvas once a layout has been applied. It is the e2e
 * contract: a check must not measure during the one frame where every label is still drawn.
 */
function useMapLabelLayout(specs: readonly MapLabelSpec[]): {
  hidden: ReadonlySet<string>;
  refFor: (id: string) => Ref<HTMLSpanElement>;
} {
  const { camera, size, scene, gl } = useThree();
  const sizes = useRef(new Map<string, { width: number; height: number }>());
  const refs = useRef(new Map<string, (el: HTMLSpanElement | null) => void>());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [settled, setSettled] = useState(false);
  const lastSignature = useRef('');

  const refFor = useCallback((id: string) => {
    let fn = refs.current.get(id);
    if (fn === undefined) {
      fn = (el: HTMLSpanElement | null): void => {
        if (el === null) return;
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        if (width > 0 && height > 0) sizes.current.set(id, { width, height });
      };
      refs.current.set(id, fn);
    }
    return fn;
  }, []);

  useFrame(() => {
    if (!specs.every((s) => sizes.current.has(s.id))) return;
    camera.updateMatrixWorld();
    // The decorations live inside `EngravePreview`'s found-position group; an Html anchor's world
    // point is its map coordinate through that group, exactly as the drawn mesh is.
    const group = scene.getObjectByName('engrave-found');
    if (group) group.updateWorldMatrix(true, false);
    const point = new THREE.Vector3();
    const rects: MapLabelRect[] = specs.map((spec) => {
      point.set(spec.at[0], spec.at[1], MAP_Z);
      if (group) point.applyMatrix4(group.matrixWorld);
      point.project(camera);
      const measured = sizes.current.get(spec.id)!;
      return {
        id: spec.id,
        priority: spec.priority,
        cx: point.x * (size.width / 2) + size.width / 2,
        cy: -(point.y * (size.height / 2)) + size.height / 2,
        width: measured.width,
        height: measured.height,
      };
    });
    // Integer pixels: a sub-pixel camera drift cannot churn the layout every frame.
    const signature = rects
      .map((r) => `${r.id}:${Math.round(r.cx)},${Math.round(r.cy)}:${size.width}x${size.height}`)
      .join('|');
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;
    const next = hiddenMapLabels(rects, LABEL_COLLISION_PAD);
    setHidden((prev) => (sameSet(prev, next) ? prev : next));
    setSettled(true);
  });

  useEffect(() => {
    if (!settled) return;
    gl.domElement.setAttribute('data-rotary-map-settled', '1');
    return () => gl.domElement.removeAttribute('data-rotary-map-settled');
  }, [settled, gl]);

  return { hidden, refFor };
}

export function RotaryMapDecorations({ map }: { map: RotaryMap }): JSX.Element {
  const canvasWidth = useThree((s) => s.size.width);
  const narrow = canvasWidth < ROTARY_MAP_NARROW_PX;
  const bandRowY = narrow ? NARROW_BAND_ROW_Y : BAND_ROW_Y;
  const alongRowY = narrow ? NARROW_ALONG_ROW_Y : ALONG_ROW_Y;

  const specs = useMemo(() => {
    const ruler = rotaryRulerTicks(map);
    const along = rotaryAlongTicks(map);
    const bands = rotaryBands(map);
    const seam = rotarySeamLabels();
    const out: MapLabelSpec[] = [];
    // The around ruler: mm at the surface, with the degrees beside it, every quarter turn.
    for (const tick of ruler) {
      out.push({
        id: `ruler-${tick.deg}`,
        testId: `rotary-ruler-${tick.deg}`,
        text: tick.label,
        at: [-6, tick.arc],
        priority: PRIORITY_RULER,
      });
    }
    // The along ruler: X in millimetres from the jaws. The two END values are what a ruler must
    // keep, so they outrank the interior ticks when the last one crowds its neighbour.
    along.forEach((x, i) => {
      out.push({
        id: `along-${x}`,
        testId: `rotary-along-${x}`,
        text: rotaryNum(x),
        at: [x, alongRowY],
        priority: i === 0 || i === along.length - 1 ? PRIORITY_ALONG_END : PRIORITY_ALONG,
      });
    });
    // The seam: where A homes, drawn as a line even when these words are dropped. The map's y = 0
    // edge is the seam A homes on (0°); y = circumference is the same seam after one turn (360°).
    out.push({
      id: 'seam-top',
      testId: 'rotary-seam-top',
      text: seam.top,
      at: [map.stickout * 0.7, bandRowY],
      priority: PRIORITY_SEAM,
      color: SEAM_COLOR,
    });
    out.push({
      id: 'seam-bottom',
      testId: 'rotary-seam-bottom',
      text: seam.bottom,
      at: [map.stickout * 0.7, map.circumference + 2.4],
      priority: PRIORITY_SEAM,
      color: SEAM_COLOR,
    });
    // The bands' names and millimetres, with their provenance on hover.
    for (const band of bands) {
      out.push({
        id: `band-${band.id}`,
        testId: `rotary-band-label-${band.id}`,
        text: band.label,
        at: [(band.from + band.to) / 2, bandRowY],
        priority: PRIORITY_BAND,
        title: band.provenance,
      });
    }
    return out;
  }, [map, alongRowY, bandRowY]);

  const { hidden, refFor } = useMapLabelLayout(specs);

  return (
    <group name="rotary-map-decorations">
      <SeamLines map={map} />
      {rotaryBands(map).map((band) => (
        <Band
          key={band.id}
          from={band.from}
          to={band.to}
          circumference={map.circumference}
          id={band.id}
        />
      ))}
      {specs.map((spec) =>
        hidden.has(spec.id) ? null : (
          <Html
            key={spec.id}
            position={[spec.at[0], spec.at[1], MAP_Z]}
            center
            // #348/#716 review — an annotation takes the BOTTOM of the stacking scale: without
            // this drei's default z-index prints the map's words through dialogs and the wizard.
            zIndexRange={[0, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <span
              ref={refFor(spec.id)}
              style={spec.color === undefined ? LABEL : { ...LABEL, color: spec.color }}
              title={spec.title}
              data-testid={spec.testId}
              data-rotary-label="1"
            >
              {spec.text}
            </span>
          </Html>
        ),
      )}
    </group>
  );
}
