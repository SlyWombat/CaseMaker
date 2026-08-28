import { useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { GridFloor } from './GridFloor';
import { SceneMeshes } from './SceneMeshes';
import { ViewportToolbar } from './ViewportToolbar';
import { ensureZUp } from '@/engine/coords';
import { useViewportStore, type ViewportCameraMode } from '@/store/viewportStore';
import { useJobStore } from '@/store/jobStore';
import { isAssembledNodeId } from '@/engine/exporters/parts';

ensureZUp();

const isE2E = import.meta.env.VITE_E2E === '1';

const DEFAULT_TARGET: [number, number, number] = [40, 30, 10];

const CAMERA_VIEWS: Record<ViewportCameraMode, { position: [number, number, number]; target: [number, number, number] }> = {
  perspective: { position: [120, -160, 90], target: DEFAULT_TARGET },
  top: { position: [40, 30, 200], target: DEFAULT_TARGET },
  front: { position: [40, -200, 30], target: DEFAULT_TARGET },
  side: { position: [200, 30, 30], target: DEFAULT_TARGET },
};

/**
 * Issue #138 — each preset as a DIRECTION rather than a fixed position.
 *
 * The old table was tuned for a palm-sized board case, so on a 252x250x280 mm
 * rack every preset landed inside the geometry: "Top" showed the middle of a
 * shelf. Distance now comes from the scene's own bounding box, exactly as
 * AutoFrame computes it, so a preset frames whatever is actually loaded.
 */
const VIEW_DIRS: Record<ViewportCameraMode, [number, number, number]> = {
  perspective: [0.5, -1, 0.55],
  top: [0, 0, 1],
  front: [0, -1, 0],
  side: [1, 0, 0],
};

/**
 * The world is z-up and so is the camera — but looking straight DOWN the z
 * axis makes up parallel to the view direction, and lookAt degenerates to an
 * arbitrary roll. That is the second half of why "Top" behaved oddly: not just
 * too close, but pointing at nothing in particular. Give the top view +y as
 * its up instead, so the model's front edge sits at the bottom of the screen.
 */
const VIEW_UP: Record<ViewportCameraMode, [number, number, number]> = {
  perspective: [0, 0, 1],
  top: [0, 1, 0],
  front: [0, 0, 1],
  side: [0, 0, 1],
};

/** Centre + diagonal of everything currently in the scene, or null if empty. */
function sceneBounds(
  nodes: Map<string, { stats: { bbox: { min: number[]; max: number[] } } }>,
): { center: THREE.Vector3; diag: number } | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const [id, n] of nodes.entries()) {
    if (isAssembledNodeId(id)) continue; // same geometry as the parts it fuses
    for (let a = 0; a < 3; a++) {
      if (n.stats.bbox.min[a]! < min[a]!) min[a] = n.stats.bbox.min[a]!;
      if (n.stats.bbox.max[a]! > max[a]!) max[a] = n.stats.bbox.max[a]!;
    }
  }
  if (!Number.isFinite(min[0]!)) return null;
  const diag = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  if (diag <= 0) return null;
  return {
    center: new THREE.Vector3(
      (min[0]! + max[0]!) / 2,
      (min[1]! + max[1]!) / 2,
      (min[2]! + max[2]!) / 2,
    ),
    diag,
  };
}

/** How far back a perspective camera must sit to frame `diag` with margin. */
function framingDistance(camera: THREE.PerspectiveCamera, diag: number): number {
  const fov = (camera.fov * Math.PI) / 180;
  return ((diag / 2) / Math.tan(fov / 2)) * 1.15;
}

/**
 * Issue #86 — when the viewport store's cameraMode changes, snap the
 * PerspectiveCamera + OrbitControls target to the canonical view. This
 * runs inside the Canvas so it has access to useThree().
 */
function CameraModeController() {
  const cameraMode = useViewportStore((s) => s.cameraMode);
  const { camera, controls } = useThree() as {
    camera: THREE.PerspectiveCamera;
    controls: { target: THREE.Vector3; update?: () => void } | null;
  };
  const lastApplied = useRef<ViewportCameraMode | null>(null);
  useEffect(() => {
    // Skip the initial mount — the camera/controls already have their
    // defaults from the JSX, so re-applying perspective on first render
    // would just kick anyone who'd persisted a different mode back to
    // their saved choice without ill effect. Always apply on every
    // change after that.
    if (lastApplied.current === cameraMode) return;
    // Read the scene non-reactively: this must fire when the MODE changes, not
    // every time geometry recompiles, or it would yank the camera back mid-orbit.
    const bounds = sceneBounds(useJobStore.getState().nodes);
    camera.up.set(...VIEW_UP[cameraMode]);
    if (bounds) {
      const dir = new THREE.Vector3(...VIEW_DIRS[cameraMode]).normalize();
      camera.position.copy(
        bounds.center.clone().add(dir.multiplyScalar(framingDistance(camera, bounds.diag))),
      );
      if (controls && controls.target) {
        controls.target.copy(bounds.center);
        controls.update?.();
      }
      camera.lookAt(bounds.center);
    } else {
      // Nothing compiled yet — fall back to the fixed table.
      const view = CAMERA_VIEWS[cameraMode];
      camera.position.set(...view.position);
      if (controls && controls.target) {
        controls.target.set(...view.target);
        controls.update?.();
      }
      camera.lookAt(...view.target);
    }
    lastApplied.current = cameraMode;
  }, [cameraMode, camera, controls]);
  return null;
}

/**
 * Auto-frame the camera when the scene's overall size changes substantially
 * (loading a template, switching archetype, a big resize). The default
 * camera comfortably frames a ~150 mm board case; a 280 mm rack or the
 * 200 mm box fills the screen edge-to-edge. Deliberately does NOT re-frame
 * on small size changes so it never fights the user's own orbiting.
 */
function AutoFrame() {
  const nodes = useJobStore((s) => s.nodes);
  const { camera, controls } = useThree() as {
    camera: THREE.PerspectiveCamera;
    controls: { target: THREE.Vector3; update?: () => void } | null;
  };
  const lastDiag = useRef(0);
  useEffect(() => {
    // Same bbox and same framing maths the presets use (issue #138), so the
    // two can never drift into disagreeing about where the model is.
    const bounds = sceneBounds(nodes);
    if (!bounds) return;
    const { center, diag } = bounds;
    // Re-frame only on a substantial size change (>35% either way).
    if (lastDiag.current > 0 && diag < lastDiag.current * 1.35 && diag > lastDiag.current / 1.35) {
      return;
    }
    lastDiag.current = diag;
    // Keep the canonical perspective direction; just move out far enough.
    const dir = new THREE.Vector3(...VIEW_DIRS.perspective).normalize();
    camera.position.copy(center.clone().add(dir.multiplyScalar(framingDistance(camera, diag))));
    if (controls && controls.target) {
      controls.target.copy(center);
      controls.update?.();
    }
    camera.lookAt(center);
  }, [nodes, camera, controls]);
  return null;
}

export function Viewport() {
  return (
    <div className="viewport-wrapper">
      <ViewportToolbar />
      <Canvas
        gl={{ antialias: !isE2E, preserveDrawingBuffer: true }}
        dpr={isE2E ? 1 : window.devicePixelRatio}
        flat={isE2E}
        onCreated={({ scene }) => {
          scene.up = new THREE.Vector3(0, 0, 1);
        }}
        // Issue #83 — clicking empty canvas (no scene object hit) clears
        // any active selection. Only fires while the Select tool is on so
        // we don't fight Orbit/Pan tool drag-clicks.
        onPointerMissed={() => {
          const { activeTool, setSelection } = useViewportStore.getState();
          if (activeTool === 'select') setSelection(null);
        }}
        data-testid="viewport-canvas"
      >
        <PerspectiveCamera makeDefault position={[120, -160, 90]} fov={45} up={[0, 0, 1]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[100, -100, 200]} intensity={0.8} />
        <directionalLight position={[-100, 100, 100]} intensity={0.3} />
        <OrbitControls
          target={DEFAULT_TARGET}
          enableDamping={!isE2E}
          makeDefault
        />
        <CameraModeController />
        <AutoFrame />
        <GridFloor />
        <SceneMeshes />
      </Canvas>
    </div>
  );
}
