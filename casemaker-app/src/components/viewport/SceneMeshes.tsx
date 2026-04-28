import { useMemo } from 'react';
import * as THREE from 'three';
import { useJobStore } from '@/store/jobStore';
import { useViewportStore } from '@/store/viewportStore';
import { bufferToGeometry } from '@/engine/scene/meshFromBuffer';
import { ExternalAssetMeshes } from './ExternalAssetMeshes';
import { PortMarkers } from './PortMarkers';
import { BoardPlaceholderMesh } from './BoardPlaceholderMesh';

interface NodeMeshProps {
  id: string;
  color: string;
  opacity?: number;
}

function NodeMesh({ id, color, opacity = 1 }: NodeMeshProps) {
  const node = useJobStore((s) => s.nodes.get(id));
  const geometry = useMemo<THREE.BufferGeometry | null>(
    () => (node ? bufferToGeometry(node.buffer) : null),
    [node],
  );
  if (!geometry) return null;
  return (
    <mesh geometry={geometry} name={id} userData={{ id }}>
      <meshStandardMaterial
        color={color}
        transparent={opacity < 1}
        opacity={opacity}
        metalness={0.1}
        roughness={0.7}
      />
    </mesh>
  );
}

export function SceneMeshes() {
  const showLid = useViewportStore((s) => s.showLid);
  return (
    <group>
      <NodeMesh id="shell" color="#88a4cc" opacity={0.55} />
      {showLid && <NodeMesh id="lid" color="#a8b8d0" opacity={0.6} />}
      <BoardPlaceholderMesh />
      <ExternalAssetMeshes />
      <PortMarkers />
    </group>
  );
}
