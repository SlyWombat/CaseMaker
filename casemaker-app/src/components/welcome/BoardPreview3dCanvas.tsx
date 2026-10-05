import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { Center, OrbitControls, useGLTF } from '@react-three/drei';

/**
 * #130 — the actual 3D render for the board rail's optional GLB preview.
 *
 * Deliberately split out of `BoardPreview3d.tsx` so the welcome screen's main
 * chunk does not drag in `three` / `@react-three/fiber` / `@react-three/drei`:
 * the wrapper `lazy()`-loads this module only when a board carries a GLB and
 * the runtime has a WebGL context. No board ships a GLB yet (see
 * `src/docs/board-assets.md` — every candidate licence is still pending), so
 * this path is unexercised in the app today; it is here for when one lands.
 */

function GltfModel({ url }: { url: string }) {
  // useGLTF suspends until the model is parsed and caches it by URL, so
  // re-selecting the same board does not re-download.
  const { scene } = useGLTF(url);
  return <primitive object={scene} />;
}

export function BoardPreview3dCanvas({ url }: { url: string }) {
  return (
    <Canvas
      camera={{ position: [0, 0, 80], fov: 45 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      style={{ width: '100%', height: '100%' }}
    >
      <ambientLight intensity={1.15} />
      <directionalLight position={[30, 40, 60]} intensity={1.5} />
      <directionalLight position={[-30, -20, -40]} intensity={0.5} />
      <Suspense fallback={null}>
        <Center>
          <GltfModel url={url} />
        </Center>
      </Suspense>
      {/* Slow idle spin so the preview reads as 3D without user input;
          drag to orbit, wheel to zoom. */}
      <OrbitControls autoRotate autoRotateSpeed={0.8} enablePan={false} />
    </Canvas>
  );
}
