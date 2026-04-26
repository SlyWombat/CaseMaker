import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import { GridFloor } from './GridFloor';
import { SceneMeshes } from './SceneMeshes';
import { ensureZUp } from '@/engine/coords';

ensureZUp();

const isE2E = import.meta.env.VITE_E2E === '1';

export function Viewport() {
  return (
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
        target={[40, 30, 10]}
        enableDamping={!isE2E}
        makeDefault
      />
      <GridFloor />
      <SceneMeshes />
    </Canvas>
  );
}
