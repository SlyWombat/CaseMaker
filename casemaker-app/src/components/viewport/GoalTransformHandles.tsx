/**
 * #831 — THE GOAL'S ON-CANVAS HANDLES: a compass at the mesh's centre while it is selected or its row is open.
 * Three rings turn it about the stock's X, Y and Z axes; two arrows move it in X and Y. A ring
 * snaps to 15° and an arrow to whole millimetres; hold Shift for a free turn or move. Both write
 * the same fields the panel does (`rotation`/`rotationX`/`rotationY` through `turnAboutAxis`, and
 * `position`), and the first write of a drag remembers the placement it replaced, so the panel's
 * Undo and Ctrl+Z put it back.
 *
 * Hand-rolled rather than drei's `PivotControls`: that gizmo snaps a ring to 10° while Shift is
 * held and cannot show the X/Y arrows without its Z arrow, the opposite of what this needs.
 *
 * The handles are drawn without depth testing, so they read through the ghosted stock and the
 * part, like the cut-away bodies beside them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { rememberGoalPlacement } from '@/store/goalTransformUndo';
import { targetTurns, type TargetTurns } from '@/engine/cnc/engrave/targetScale';
import { turnsPatch, turnAboutAxis } from '@/engine/cnc/engrave/goalOrientation';
import type { EngraveTargetObject } from '@/types/engraveJob';
import {
  ACTIVE_COLOUR,
  AXIS_COLOUR,
  BASIS,
  bandPx,
  coarsePointer,
  handleFrame,
  handleOffset,
  inScaleBand,
  MOVE_SNAP_MM,
  RENDER_ORDER,
  RING_ROTATION,
  ROTATE_MAJOR_DEG,
  ROTATE_TICK_DEG,
  setGoalHandleCentreProbe,
  setGoalHandleDragActive,
  setGoalHandleProbe,
  snapRingAngle,
  UNIT,
  type Axis,
} from './goalHandleFrame';

interface Drag {
  kind: 'ring' | 'arrow';
  axis: Axis;
  centre: THREE.Vector3;
  startTurns: TargetTurns;
  startPos: { x: number; y: number; z: number };
  /** Ring: the last in-plane angle (rad) and the unwrapped sum since the press. */
  lastAngle: number;
  sumAngle: number;
  /** Arrow: the line parameter at the press. */
  t0: number;
  wrote: boolean;
  shown: number;
}

const plane = new THREE.Plane();
const hit = new THREE.Vector3();

function ringAngle(ray: THREE.Ray, axis: Axis, centre: THREE.Vector3): number | null {
  plane.setFromNormalAndCoplanarPoint(UNIT[axis], centre);
  if (ray.intersectPlane(plane, hit) === null) return null;
  const v = hit.clone().sub(centre);
  const [e1, e2] = BASIS[axis];
  return Math.atan2(v.dot(e2), v.dot(e1));
}

/** The parameter along the line `centre + t·axis` closest to the ray. */
function lineParam(ray: THREE.Ray, axis: Axis, centre: THREE.Vector3): number | null {
  const d = UNIT[axis];
  const w0 = centre.clone().sub(ray.origin);
  const b = d.dot(ray.direction);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-6) return null;
  // Minimise |centre + t·d − (o + s·r)|: t = (b·(w0·r) − (w0·d)) / (1 − b²).
  return (b * w0.dot(ray.direction) - w0.dot(d)) / denom;
}

export function GoalTransformHandles({ target, mold }: { target: EngraveTargetObject; mold: boolean }) {
  const updateTargetObject = useEngraveJobStore((s) => s.updateTargetObject);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const get = useThree((s) => s.get);
  const { centre, radius } = handleFrame(target, mold);
  const drag = useRef<Drag | null>(null);
  const [active, setActive] = useState<{ kind: 'ring' | 'arrow'; axis: Axis; text: string } | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  // The test surface's probe: the client pixel of a point on a handle, for the current frame.
  const { x: cx, y: cy, z: cz } = centre;
  useEffect(() => {
    const c = new THREE.Vector3(cx, cy, cz);
    setGoalHandleProbe((kind, axis, value) => {
      const p = c.clone().add(handleOffset(kind, axis, value, radius)).project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
    });
    // #876 — the centre too: the scale band is measured from it, so a spec can move the pointer
    // radially in and out of the band.
    setGoalHandleCentreProbe(() => {
      const p = c.clone().project(camera);
      const rect = gl.domElement.getBoundingClientRect();
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
    });
    return () => {
      setGoalHandleProbe(null);
      setGoalHandleCentreProbe(null);
    };
  }, [camera, gl, cx, cy, cz, radius]);

  // The orbit control must not turn the view while a handle is dragged (read at event time).
  const setControls = (enabled: boolean): void => {
    const c = get().controls as unknown as { enabled?: boolean } | null;
    if (c && 'enabled' in c) c.enabled = enabled;
  };

  /**
   * #876 — IS THE POINTER INSIDE THIS RING'S SCALE BAND? Measured in SCREEN pixels, at the
   * pointer's own radial direction (the projected ring is an ellipse, so one radius does not fit
   * every point on it). A finger gets the 44 px band; a mouse 24 px.
   */
  const pointerInBand = (clientX: number, clientY: number, d: Drag, a: number): boolean => {
    const rect = gl.domElement.getBoundingClientRect();
    const project = (v: THREE.Vector3): { x: number; y: number } => {
      const p = v.clone().project(camera);
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
    };
    const c = project(d.centre);
    const [e1, e2] = BASIS[d.axis];
    const rim = d.centre
      .clone()
      .add(e1.clone().multiplyScalar(Math.cos(a) * radius))
      .add(e2.clone().multiplyScalar(Math.sin(a) * radius));
    const r = project(rim);
    const ringPx = Math.hypot(r.x - c.x, r.y - c.y);
    const pointerPx = Math.hypot(clientX - c.x, clientY - c.y);
    return inScaleBand(pointerPx, ringPx, bandPx(coarsePointer()));
  };

  /** The drag's whole body, shared by the handle's own events and the window capture below. */
  const applyMove = (ray: THREE.Ray, clientX: number, clientY: number, shiftKey: boolean): void => {
    const d = drag.current;
    if (d === null) return;
    let value: number;
    if (d.kind === 'ring') {
      const a = ringAngle(ray, d.axis, d.centre);
      if (a === null) return;
      let step = a - d.lastAngle;
      if (step > Math.PI) step -= 2 * Math.PI;
      if (step < -Math.PI) step += 2 * Math.PI;
      d.sumAngle += step;
      d.lastAngle = a;
      const deg = (d.sumAngle * 180) / Math.PI;
      // #876 — the zone model replaces the old 15°/Shift rule: the hand's radius picks.
      value = snapRingAngle(deg, pointerInBand(clientX, clientY, d, a));
    } else {
      const free = shiftKey;
      const t = lineParam(ray, d.axis, d.centre);
      if (t === null) return;
      const base = d.axis === 'x' ? d.startPos.x : d.axis === 'y' ? d.startPos.y : d.startPos.z;
      const raw = base + (t - d.t0);
      const snapped = free ? Math.round(raw * 100) / 100 : Math.round(raw / MOVE_SNAP_MM) * MOVE_SNAP_MM;
      value = snapped - base;
    }
    if (value === d.shown) return;
    d.shown = value;
    if (!d.wrote) {
      rememberGoalPlacement();
      d.wrote = true;
    }
    if (d.kind === 'ring') {
      updateTargetObject(turnsPatch(turnAboutAxis(d.startTurns, d.axis, value)));
      setActive({ kind: 'ring', axis: d.axis, text: `${d.axis.toUpperCase()} ${value > 0 ? '+' : ''}${Number(value.toFixed(1))}°` });
    } else {
      const base = d.axis === 'x' ? d.startPos.x : d.axis === 'y' ? d.startPos.y : d.startPos.z;
      updateTargetObject({ position: { [d.axis]: Number((base + value).toFixed(3)) } });
      setActive({
        kind: 'arrow',
        axis: d.axis,
        text: `Δ${d.axis.toUpperCase()} ${value > 0 ? '+' : ''}${Number(value.toFixed(2))} mm`,
      });
    }
  };

  const move = (e: ThreeEvent<PointerEvent>): void => {
    if (drag.current === null) return;
    e.stopPropagation();
    applyMove(e.ray, e.nativeEvent.clientX, e.nativeEvent.clientY, e.nativeEvent.shiftKey);
  };

  // #876 — THE DRAG IS CAPTURED BY THE WINDOW. A drag is where the hand is, not where the handle
  // is: the pointer leaves a millimetre-wide ring almost at once (and integer mouse pixels can
  // miss it), and the ring used to stop updating the moment it did. From the press to the release,
  // moves anywhere on the page are raycast with the same camera and fed to the same body.
  const capture = useRef<(() => void) | null>(null);
  const finish = (): void => {
    if (drag.current === null) return;
    drag.current = null;
    capture.current?.();
    capture.current = null;
    // #876 — the camera may reframe again now the hand is off the handle.
    setGoalHandleDragActive(false);
    setControls(true);
    setActive(null);
  };
  const captureWindow = (): void => {
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const onMove = (ev: PointerEvent): void => {
      const rect = gl.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      applyMove(raycaster.ray, ev.clientX, ev.clientY, ev.shiftKey);
    };
    const onUp = (): void => finish();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    capture.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  };

  const down = (kind: 'ring' | 'arrow', axis: Axis) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const start =
      kind === 'ring' ? ringAngle(e.ray, axis, centre) : lineParam(e.ray, axis, centre);
    if (start === null) return;
    setControls(false);
    drag.current = {
      kind,
      axis,
      centre: centre.clone(),
      startTurns: targetTurns(target),
      startPos: { x: target.position.x, y: target.position.y, z: target.position.z },
      lastAngle: start,
      sumAngle: 0,
      t0: start,
      wrote: false,
      shown: 0,
    };
    setActive({ kind, axis, text: kind === 'ring' ? `${axis.toUpperCase()} 0°` : `Δ${axis.toUpperCase()} 0 mm` });
    // #876 — keep AutoFrame off the camera while the pointer is held on a handle.
    setGoalHandleDragActive(true);
    captureWindow();
  };

  const up = (e: ThreeEvent<PointerEvent>): void => {
    if (drag.current === null) return;
    e.stopPropagation();
    finish();
  };
  useEffect(
    () => () => {
      // Leaving the scene mid-drag ends it cleanly and never strands the orbit control off.
      finish();
      setControls(true);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // #876 — a finger needs a wider line than a cursor, and BOTH need more than a hairline: the pick
  // tubes are sized off the compass radius (16 % / 25 %, at least 4 / 6 mm) because a millimetre
  // tube on a zoomed-out compass projects to a pixel or two, and integer mouse pixels then fall
  // beside it — the ring is ungrabbable, and a drag silently stops updating.
  const coarse = coarsePointer();
  const tube = Math.max(coarse ? 0.5 : 0.35, radius * 0.02);
  const pickTube = Math.max(coarse ? 6 : 4, radius * (coarse ? 0.25 : 0.16));
  const ringGeom = useMemo(() => new THREE.TorusGeometry(radius, tube, 8, 96), [radius, tube]);
  const ringPick = useMemo(() => new THREE.TorusGeometry(radius, pickTube, 6, 64), [radius, pickTube]);
  // #876 — the graduated scale: a tick every 5°, longer every 15°, and long radial lines every 45°.
  const scaleGeom = useMemo(() => {
    const verts: number[] = [];
    for (let deg = 0; deg < 360; deg += ROTATE_TICK_DEG) {
      const len = deg % ROTATE_MAJOR_DEG === 0 ? radius * 0.45 : deg % 15 === 0 ? radius * 0.16 : radius * 0.07;
      const a = (deg * Math.PI) / 180;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      verts.push(ux * radius, uy * radius, 0, ux * (radius - len), uy * (radius - len), 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    return g;
  }, [radius]);
  useEffect(() => () => ringGeom.dispose(), [ringGeom]);
  useEffect(() => () => ringPick.dispose(), [ringPick]);
  useEffect(() => () => scaleGeom.dispose(), [scaleGeom]);
  const arrowLen = radius * 1.35;

  const colour = (key: string, axis: Axis): string =>
    (active !== null && `${active.kind}-${active.axis}` === key) || hover === key ? ACTIVE_COLOUR : AXIS_COLOUR[axis];
  const handlers = (kind: 'ring' | 'arrow', axis: Axis) => ({
    onPointerDown: down(kind, axis),
    onPointerMove: move,
    onPointerUp: up,
    onPointerCancel: up,
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      setHover(`${kind}-${axis}`);
    },
    onPointerOut: () => setHover(null),
  });
  const mat = (c: string) => (
    <meshBasicMaterial color={c} depthTest={false} depthWrite={false} transparent opacity={0.95} />
  );
  const pickMat = <meshBasicMaterial visible={false} />;

  return (
    <group name="engrave-goal-handles" position={[centre.x, centre.y, centre.z]}>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <group key={`ring-${axis}`} rotation={RING_ROTATION[axis]}>
          <mesh geometry={ringGeom} renderOrder={RENDER_ORDER} name={`engrave-goal-ring-${axis}`}>
            {mat(colour(`ring-${axis}`, axis))}
          </mesh>
          {/* #876 — the graduated scale, inside the ring line; the hand's distance from the
              centre picks free / ticked / locked, and the ticks are what it tracks. */}
          <lineSegments geometry={scaleGeom} renderOrder={RENDER_ORDER} name={`engrave-goal-scale-${axis}`}>
            <lineBasicMaterial color={AXIS_COLOUR[axis]} depthTest={false} depthWrite={false} transparent opacity={0.6} />
          </lineSegments>
          <mesh geometry={ringPick} {...handlers('ring', axis)}>
            {pickMat}
          </mesh>
        </group>
      ))}
      {/* #876 — THREE arrows: X and Y across the stock, Z for depth in it (a mould's cavity opens
          at the stock top, so its Z is not a placement and the Z arrow is not drawn for one). */}
      {(['x', 'y', 'z'] as const)
        .filter((axis) => axis !== 'z' || !mold)
        .map((axis) => (
        <group
          key={`arrow-${axis}`}
          rotation={axis === 'x' ? [0, 0, -Math.PI / 2] : axis === 'z' ? [Math.PI / 2, 0, 0] : [0, 0, 0]}
        >
          {/* A cylinder stands along local +Y; X is a quarter about Z, Z a quarter about X. */}
          <mesh position={[0, arrowLen / 2, 0]} renderOrder={RENDER_ORDER} name={`engrave-goal-arrow-${axis}`}>
            <cylinderGeometry args={[tube, tube, arrowLen, 8]} />
            {mat(colour(`arrow-${axis}`, axis))}
          </mesh>
          <mesh position={[0, arrowLen + tube * 4, 0]} renderOrder={RENDER_ORDER}>
            <coneGeometry args={[tube * 3.5, tube * 8, 16]} />
            {mat(colour(`arrow-${axis}`, axis))}
          </mesh>
          <mesh position={[0, (arrowLen + tube * 8) / 2, 0]} {...handlers('arrow', axis)}>
            <cylinderGeometry args={[pickTube, pickTube, arrowLen + tube * 8, 8]} />
            {pickMat}
          </mesh>
        </group>
      ))}
      {active !== null && (
        // #876 — the wrapper is transparent to the pointer too: drei's <Html> box sits over the
        // compass and would otherwise swallow the moves that drag the ring beneath it.
        <Html position={[0, 0, radius * 1.15]} center zIndexRange={[0, 0]} style={{ pointerEvents: 'none' }}>
          <div className="port-delta-readout" data-testid="engrave-goal-handle-readout">
            {active.text}
          </div>
        </Html>
      )}
    </group>
  );
}
