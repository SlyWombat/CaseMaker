/**
 * #511 — the bed scene, drawn by the existing three.js stack, in MACHINE coordinates.
 *
 * This is the one picture `docs/design/bed-profiles.md` §4 names — the Machines card's picture now,
 * the wizard's right-hand pane (S3) and the mounting step's picture (S4) later. One component, three
 * callers: each passes the machine whose ACTIVE bed profile it draws.
 *
 * The geometry is `engine/cnc/bedScene.ts` (pure); this component only renders its boxes and
 * datums. Solid boxes (measured/vendor/default) are drawn opaque; dashed boxes (unmeasured,
 * "provisional") are drawn translucent with a dashed edge outline and a label, so a provisional
 * figure can never be read as a measurement.
 *
 * A self-contained `<Canvas>` on purpose: the bed is in machine coordinates (X/Y in [-200, 0],
 * Z down negative), a different frame from the case/sim/engrave scenes, so it is its own little
 * viewport rather than a layer inside the main one. With no WebGL (jsdom, some headless builds) it
 * renders a plain fallback instead of crashing.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { MachineRecord } from '@/platform/locationClient';
import { resolvedMachineById } from '@/engine/cnc/calibration';
import { bedScene, type BedSceneBox, type BedSceneDatum } from '@/engine/cnc/bedScene';

/** True when the browser can give this a WebGL context (false in jsdom and headless tests). */
function webglAvailable(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null || canvas.getContext('webgl') !== null;
  } catch {
    return false;
  }
}

/** One box: an opaque body, or (dashed) a translucent body with a dashed edge outline. */
function Box({ b }: { b: BedSceneBox }) {
  const dx = b.max[0]! - b.min[0]!;
  const dy = b.max[1]! - b.min[1]!;
  const dz = b.max[2]! - b.min[2]!;
  if (!(dx > 0 && dy > 0 && dz > 0)) return null;
  const centre: [number, number, number] = [
    (b.min[0]! + b.max[0]!) / 2,
    (b.min[1]! + b.max[1]!) / 2,
    (b.min[2]! + b.max[2]!) / 2,
  ];
  return (
    <group>
      <mesh position={centre} name={`bed-${b.id}`}>
        <boxGeometry args={[dx, dy, dz]} />
        <meshStandardMaterial
          color={b.color}
          transparent={b.kind === 'dashed'}
          opacity={b.kind === 'dashed' ? 0.18 : 1}
          depthWrite={b.kind === 'solid'}
          metalness={0.15}
          roughness={0.7}
        />
      </mesh>
      {b.kind === 'dashed' && <DashedEdges min={b.min} max={b.max} color={b.color} />}
    </group>
  );
}

/** The 12 edges of a box, dashed — the "provisional" outline. */
function DashedEdges({
  min,
  max,
  color,
}: {
  min: [number, number, number];
  max: [number, number, number];
  color: string;
}) {
  const geometry = useMemo(() => {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const verts: number[] = [];
    const seg = (a: number[], c: number[]) => verts.push(...a, ...c);
    // 12 edges of the box.
    seg([x0, y0, z0], [x1, y0, z0]);
    seg([x0, y1, z0], [x1, y1, z0]);
    seg([x0, y0, z1], [x1, y0, z1]);
    seg([x0, y1, z1], [x1, y1, z1]);
    seg([x0, y0, z0], [x0, y1, z0]);
    seg([x1, y0, z0], [x1, y1, z0]);
    seg([x0, y0, z1], [x0, y1, z1]);
    seg([x1, y0, z1], [x1, y1, z1]);
    seg([x0, y0, z0], [x0, y0, z1]);
    seg([x1, y0, z0], [x1, y0, z1]);
    seg([x0, y1, z0], [x0, y1, z1]);
    seg([x1, y1, z0], [x1, y1, z1]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    new THREE.LineSegments(g).computeLineDistances();
    return g;
  }, [min, max]);
  return (
    <lineSegments geometry={geometry} name="bed-dashed-edges">
      <lineDashedMaterial color={color} dashSize={2} gapSize={1.5} />
    </lineSegments>
  );
}

/** A datum or a provisional note, as a small non-interactive label. */
function Label({ position, color, children }: { position: [number, number, number]; color: string; children: string }) {
  return (
    <Html position={position} center style={{ pointerEvents: 'none' }} zIndexRange={[0, 0]}>
      <span style={{ fontSize: 9, color, background: 'rgba(15,18,22,0.72)', borderRadius: 3, padding: '1px 4px', whiteSpace: 'nowrap' }}>
        {children}
      </span>
    </Html>
  );
}

/** A box's annotation ("top not measured", "provisional") at its centre. */
function boxLabel(b: BedSceneBox): string | null {
  return b.label ?? null;
}

function datumLabelPosition(d: BedSceneDatum): [number, number, number] {
  return d.position;
}

/**
 * The active bed as a picture. `machine` is the location's machine record; the active profile and
 * the fixture records are resolved here (and the mill is resolved against the machine's own
 * calibration read), so the picture and the checks always agree.
 */
export function BedScene({ machine }: { machine: MachineRecord }) {
  const mill = resolvedMachineById(machine.profileId ?? 'Z1', machine.calibration);
  const profile = machine.bedProfiles?.find((p) => p.id === machine.activeBedProfileId) ?? null;
  const fixtures = machine.bedFixtures ?? [];

  const scene = useMemo(
    () => (mill !== undefined && profile !== null ? bedScene({ mill, fixtures, profile }) : null),
    [mill, fixtures, profile],
  );

  const hasWebgl = useMemo(() => webglAvailable(), []);
  if (!hasWebgl) {
    return (
      <div className="hint" data-testid="bed-scene-no-webgl">
        the bed picture needs WebGL — the summary above is the same numbers.
      </div>
    );
  }
  if (!scene) return null;

  const { min, max } = scene.bbox;
  const centre: [number, number, number] = [
    (min[0]! + max[0]!) / 2,
    (min[1]! + max[1]!) / 2,
    (min[2]! + max[2]!) / 2,
  ];
  const diag = Math.max(1, Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!));
  const distance = diag * 1.35;
  const dir: [number, number, number] = [0.5, -1, 0.55];
  const len = Math.hypot(...dir);
  const cameraPos: [number, number, number] = [
    centre[0] + (dir[0]! / len) * distance,
    centre[1] + (dir[1]! / len) * distance,
    centre[2] + (dir[2]! / len) * distance,
  ];

  return (
    <div data-testid="bed-scene">
      <Canvas
        camera={{ position: cameraPos, fov: 45, up: [0, 0, 1] }}
        gl={{ antialias: true }}
        onCreated={({ camera }) => camera.lookAt(...centre)}
        style={{ width: '100%', height: 220, background: 'transparent' }}
      >
        <ambientLight intensity={0.65} />
        <directionalLight position={[100, -100, 200]} intensity={0.8} />
        <directionalLight position={[-100, 100, 100]} intensity={0.35} />
        {scene.boxes.map((b) => (
          <Box key={b.id} b={b} />
        ))}
        {scene.boxes.map((b) => {
          const label = boxLabel(b);
          if (label === null) return null;
          return (
            <Label
              key={`${b.id}-label`}
              position={[
                (b.min[0]! + b.max[0]!) / 2,
                (b.min[1]! + b.max[1]!) / 2,
                b.max[2]! + 1,
              ]}
              color={b.color}
            >
              {label}
            </Label>
          );
        })}
        {scene.datums.map((d) => (
          <Label key={d.id} position={datumLabelPosition(d)} color="#30a46c">
            {d.label}
          </Label>
        ))}
      </Canvas>
    </div>
  );
}
