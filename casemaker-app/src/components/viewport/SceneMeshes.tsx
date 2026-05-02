import { useMemo } from 'react';
import * as THREE from 'three';
import { useJobStore } from '@/store/jobStore';
import { useViewportStore } from '@/store/viewportStore';
import { useProjectStore } from '@/store/projectStore';
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
  const latches = useProjectStore((s) => s.project.case.latches);
  // Subscribe to the Map ref; derive ids in the body. See PartsMenu for the
  // explanation of the Zustand `?? []` selector trap.
  const nodes = useJobStore((s) => s.nodes);
  const nodeIds = Array.from(nodes.keys());
  const explodedLift = useExplodedLift();
  const showShell = viewMode !== 'lid-only';
  const showLidMesh = viewMode !== 'base-only';
  const lift = viewMode === 'exploded' ? explodedLift : 0;
  // Lateral OUTWARD shift applied to latch arms + pins in exploded view
  // so they don't appear stranded against the case wall. Per-latch direction
  // determined by the latch's wall (-y wall arms shift in -y, +y in +y, etc.).
  const lateral = viewMode === 'exploded' ? 25 : 0;

  // Build a lookup from latch id → wall direction so the per-arm / per-pin
  // node offset can shift in the latch's wall-outward direction.
  const latchWallById = new Map<string, '+x' | '-x' | '+y' | '-y'>();
  for (const l of latches ?? []) latchWallById.set(l.id, l.wall);
  const wallToOffset = (wall: '+x' | '-x' | '+y' | '-y'): [number, number] => {
    if (wall === '-x') return [-lateral, 0];
    if (wall === '+x') return [+lateral, 0];
    if (wall === '-y') return [0, -lateral];
    return [0, +lateral];
  };
  // Returns the [dx, dy, dz] offset to apply to a node in exploded view.
  // Lid + gasket: pure Z lift (lid lifts straight up).
  // Latch arms + pins: Z lift PLUS lateral pull in their wall direction.
  // Hinge pin: Z lift (rides with lid hinge knuckles).
  // Bumpers: stay attached to the case.
  function explodedOffsetFor(id: string): [number, number, number] {
    if (id === 'lid' || id === 'gasket') return [0, 0, lift];
    if (id === 'hinge-pin') return [0, 0, lift];
    if (id.startsWith('latch-arm-') || id.startsWith('latch-pin-')) {
      const latchId = id.replace(/^latch-(arm|pin)-/, '');
      const wall = latchWallById.get(latchId);
      const [dx, dy] = wall ? wallToOffset(wall) : [0, 0];
      return [dx, dy, lift];
    }
    return [0, 0, 0];
  }

  return (
    <group>
      {nodeIds.map((id) => {
        if (hiddenParts.has(id)) return null;
        if (id === 'shell' && !showShell) return null;
        if (id === 'lid' && !showLidMesh) return null;
        const color = colorForNode(id);
        const offset = explodedOffsetFor(id);
        const isLifted = (offset[0] !== 0 || offset[1] !== 0 || offset[2] !== 0);
        const opacity = id === 'shell' ? 0.55 : id === 'lid' ? 0.6 : 1;
        const mesh = <NodeMesh key={id} id={id} color={color} opacity={opacity} />;
        if (isLifted) {
          return (
            <group key={id} position={offset}>
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
