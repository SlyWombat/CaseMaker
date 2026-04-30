import { useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { GridFloor } from './GridFloor';
import { SceneMeshes } from './SceneMeshes';
import { ViewportToolbar } from './ViewportToolbar';
import { ensureZUp } from '@/engine/coords';
import { useViewportStore, type ViewportCameraMode } from '@/store/viewportStore';

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
    const view = CAMERA_VIEWS[cameraMode];
    camera.position.set(...view.position);
    if (controls && controls.target) {
      controls.target.set(...view.target);
      controls.update?.();
    }
    camera.lookAt(...view.target);
    lastApplied.current = cameraMode;
  }, [cameraMode, camera, controls]);
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
        <GridFloor />
        <SceneMeshes />
      </Canvas>
    </div>
  );
}
