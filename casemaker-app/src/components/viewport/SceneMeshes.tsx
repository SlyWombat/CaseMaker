import { useMemo } from 'react';
import * as THREE from 'three';
import { useJobStore } from '@/store/jobStore';
import { useViewportStore } from '@/store/viewportStore';
import { bufferToGeometry } from '@/engine/scene/meshFromBuffer';
import { ExternalAssetMeshes } from './ExternalAssetMeshes';
import { PortMarkers } from './PortMarkers';
import { BoardPlaceholderMesh } from './BoardPlaceholderMesh';
import { HatPlaceholderMeshes } from './HatPlaceholderMeshes';

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

/**
 * Issue #91 — exploded-lift formula. Targets a 2 mm gap between the deepest
 * lid-attached protrusion (snap arm tip, lid post tip, etc.) and the
 * shell's top surface. Reads bboxes from the worker output, so the gap is
 * always large enough for the actual geometry. Fallback to 8 mm when stats
 * aren't available yet (first frame, before the worker reports).
 */
function useExplodedLift(): number {
  const shell = useJobStore((s) => s.nodes.get('shell'));
  const lid = useJobStore((s) => s.nodes.get('lid'));
  if (!shell || !lid) return 8;
  const shellTopZ = shell.stats.bbox.max[2];
  const lidBottomZ = lid.stats.bbox.min[2];
  // Required lift to put lidBottomZ + lift >= shellTopZ + 2.
  return Math.max(shellTopZ + 2 - lidBottomZ, 6);
}

/** Issue #120 — color a node by its category. Shell + lid keep the existing
 *  blue palette; gasket renders amber-ish (TPU); fasteners gold; bumpers
 *  flex-grey. */
function colorForNode(id: string): string {
  if (id === 'shell') return '#88a4cc';
  if (id === 'lid') return '#a8b8d0';
  if (id === 'gasket') return '#d4af37';
  if (id === 'hinge-pin') return '#c0a060';
  if (id.startsWith('latch-arm-')) return '#b09080';
  if (id.startsWith('bumper-')) return '#7a7a82';
  return '#9a9aa8';
}

export function SceneMeshes() {
  const viewMode = useViewportStore((s) => s.viewMode);
  const hiddenParts = useViewportStore((s) => s.hiddenParts);
  // Subscribe to the Map ref; derive ids in the body. See PartsMenu for the
  // explanation of the Zustand `?? []` selector trap.
  const nodes = useJobStore((s) => s.nodes);
  const nodeIds = Array.from(nodes.keys());
  const explodedLift = useExplodedLift();
  // Issue #91 — view-mode dispatch:
  //   complete  : lid at assembled Z (no lift)
  //   exploded  : dynamic lift to clear deepest lid feature
  //   base-only : lid hidden
  //   lid-only  : shell hidden, lid at assembled Z
  const showShell = viewMode !== 'lid-only';
  const showLidMesh = viewMode !== 'base-only';
  const lift = viewMode === 'exploded' ? explodedLift : 0;
  // Issue #120 — render EVERY top-level node, not just shell+lid. Apply
  // exploded-lift to lid + lid-attached parts; case-attached extras stay
  // at z=0. Hide nodes flagged in viewportStore.hiddenParts.
  const lidAttached = (id: string): boolean =>
    id === 'lid' || id === 'gasket' || id.startsWith('latch-arm-');
  return (
    <group>
      {nodeIds.map((id) => {
        if (hiddenParts.has(id)) return null;
        if (id === 'shell' && !showShell) return null;
        if (id === 'lid' && !showLidMesh) return null;
        const color = colorForNode(id);
        const isLifted = lidAttached(id) && lift > 0;
        const opacity = id === 'shell' ? 0.55 : id === 'lid' ? 0.6 : 1;
        const mesh = <NodeMesh key={id} id={id} color={color} opacity={opacity} />;
        if (isLifted) {
          return (
            <group key={id} position={[0, 0, lift]}>
              {mesh}
            </group>
          );
        }
        return mesh;
      })}
      {showShell && <BoardPlaceholderMesh />}
      {showShell && <HatPlaceholderMeshes />}
      <ExternalAssetMeshes />
      <PortMarkers />
    </group>
  );
}
