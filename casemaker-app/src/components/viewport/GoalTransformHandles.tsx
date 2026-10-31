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
import { snapDeg, turnAboutAxis, turnsPatch } from '@/engine/cnc/engrave/goalOrientation';
import type { EngraveTargetObject } from '@/types/engraveJob';
import {
  ACTIVE_COLOUR,
  AXIS_COLOUR,
  BASIS,
  handleFrame,
  handleOffset,
  MOVE_SNAP_MM,
  RENDER_ORDER,
  RING_ROTATION,
  ROTATE_SNAP_DEG,
  setGoalHandleProbe,
  UNIT,
  type Axis,
} from './goalHandleFrame';

interface Drag {
  kind: 'ring' | 'arrow';
  axis: Axis;
  centre: THREE.Vector3;
  startTurns: TargetTurns;
  startPos: { x: number; y: number };
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
    return () => setGoalHandleProbe(null);
  }, [camera, gl, cx, cy, cz, radius]);

  // The orbit control must not turn the view while a handle is dragged (read at event time).
  const setControls = (enabled: boolean): void => {
    const c = get().controls as unknown as { enabled?: boolean } | null;
    if (c && 'enabled' in c) c.enabled = enabled;
  };

  const down = (kind: 'ring' | 'arrow', axis: Axis) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const start =
      kind === 'ring' ? ringAngle(e.ray, axis, centre) : lineParam(e.ray, axis, centre);
    if (start === null) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setControls(false);
    drag.current = {
      kind,
      axis,
      centre: centre.clone(),
      startTurns: targetTurns(target),
      startPos: { x: target.position.x, y: target.position.y },
      lastAngle: start,
      sumAngle: 0,
      t0: start,
      wrote: false,
      shown: 0,
    };
    setActive({ kind, axis, text: kind === 'ring' ? `${axis.toUpperCase()} 0°` : `Δ${axis.toUpperCase()} 0 mm` });
  };

  const move = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    if (d === null) return;
    e.stopPropagation();
    const free = e.shiftKey;
    let value: number;
    if (d.kind === 'ring') {
      const a = ringAngle(e.ray, d.axis, d.centre);
      if (a === null) return;
      let step = a - d.lastAngle;
      if (step > Math.PI) step -= 2 * Math.PI;
      if (step < -Math.PI) step += 2 * Math.PI;
      d.sumAngle += step;
      d.lastAngle = a;
      const deg = (d.sumAngle * 180) / Math.PI;
      value = free ? Math.round(deg * 10) / 10 : snapDeg(deg, ROTATE_SNAP_DEG);
    } else {
      const t = lineParam(e.ray, d.axis, d.centre);
      if (t === null) return;
      const raw = (d.axis === 'x' ? d.startPos.x : d.startPos.y) + (t - d.t0);
      const snapped = free ? Math.round(raw * 100) / 100 : Math.round(raw / MOVE_SNAP_MM) * MOVE_SNAP_MM;
      value = snapped - (d.axis === 'x' ? d.startPos.x : d.startPos.y);
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
      const base = d.axis === 'x' ? d.startPos.x : d.startPos.y;
      updateTargetObject({ position: { [d.axis]: Number((base + value).toFixed(3)) } });
      setActive({
        kind: 'arrow',
        axis: d.axis,
        text: `Δ${d.axis.toUpperCase()} ${value > 0 ? '+' : ''}${Number(value.toFixed(2))} mm`,
      });
    }
  };

  const up = (e: ThreeEvent<PointerEvent>) => {
    if (drag.current === null) return;
    e.stopPropagation();
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    drag.current = null;
    setControls(true);
    setActive(null);
  };
  useEffect(() => () => setControls(true), []); // eslint-disable-line react-hooks/exhaustive-deps

  const tube = Math.max(0.35, radius * 0.02);
  const pickTube = Math.max(1, radius * 0.05);
  const ringGeom = useMemo(() => new THREE.TorusGeometry(radius, tube, 8, 96), [radius, tube]);
  const ringPick = useMemo(() => new THREE.TorusGeometry(radius, pickTube, 6, 64), [radius, pickTube]);
  useEffect(() => () => ringGeom.dispose(), [ringGeom]);
  useEffect(() => () => ringPick.dispose(), [ringPick]);
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
          <mesh geometry={ringPick} {...handlers('ring', axis)}>
            {pickMat}
          </mesh>
        </group>
      ))}
      {(['x', 'y'] as const).map((axis) => (
        <group key={`arrow-${axis}`} rotation={axis === 'x' ? [0, 0, -Math.PI / 2] : [0, 0, 0]}>
          {/* A cylinder stands along local +Y; the X arrow is the Y arrow turned a quarter about Z. */}
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
        <Html position={[0, 0, radius * 1.15]} center zIndexRange={[0, 0]}>
          <div className="port-delta-readout" data-testid="engrave-goal-handle-readout">
            {active.text}
          </div>
        </Html>
      )}
    </group>
  );
}
