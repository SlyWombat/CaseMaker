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
import { isAssembledNodeId } from '@/engine/exporters/parts';

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
  // Rack assembly: structural frame blue-grey, accessories differentiated
  // so the stacked faceplates read as separate parts.
  if (id.startsWith('rack-side-')) return '#88a4cc';
  if (id === 'rack-top' || id === 'rack-bottom') return '#a8b8d0';
  if (id.startsWith('rack-keystone-')) return '#c0a060';
  if (id.startsWith('rack-shelf-')) return '#8fb0a0';
  if (id.startsWith('rack-cable-tray-')) return '#b09080';
  if (id.startsWith('rack-blank-')) return '#9aa8c0';
  if (id.startsWith('rack-wall-')) return '#d4af37';
  return '#9a9aa8';
}

export function SceneMeshes() {
  const viewMode = useViewportStore((s) => s.viewMode);
  const hiddenParts = useViewportStore((s) => s.hiddenParts);
  const latches = useProjectStore((s) => s.project.case.latches);
  // A rack has no host PCB. The rack archetype replaces the case/lid pipeline
  // entirely, but a project still carries a board, so the placeholder PCB and
  // its HATs kept rendering — a green board sitting inside the rack, part of
  // nothing and printed by nothing.
  const rackMode = useProjectStore((s) => s.project.case.rack?.enabled === true);
  // Subscribe to the Map ref; derive ids in the body. See PartsMenu for the
  // explanation of the Zustand `?? []` selector trap.
  const nodes = useJobStore((s) => s.nodes);
  // The assembled one-piece exports are alternatives to the separate parts,
  // made of the same geometry — rendering them would z-fight the whole rack.
  const nodeIds = Array.from(nodes.keys()).filter((id) => !isAssembledNodeId(id));
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
    // Nothing moves unless we are actually exploded.
    //
    // This guard is load-bearing: the rack accessory and wall-part branches
    // below add CONSTANTS (-15, +35) on top of `lateral`, which is 0 in every
    // other view. Without it those constants displaced parts in the assembled
    // view too — accessories were drawn 15 mm proud of the frame, so they
    // appeared to hang out the front and their screw holes sat 15 mm ahead of
    // the side panels'. The geometry was right the whole time; only the
    // picture was wrong, which made it a hard thing to trust a measurement on.
    if (viewMode !== 'exploded') return [0, 0, 0];
    if (id === 'lid' || id === 'gasket') return [0, 0, lift];
    if (id === 'hinge-pin') return [0, 0, lift];
    // Rack assembly: sides pull apart laterally, top/bottom split
    // vertically, accessories slide forward out of the frame.
    if (id === 'rack-side-left') return [-lateral, 0, 0];
    if (id === 'rack-side-right') return [+lateral, 0, 0];
    if (id === 'rack-top') return [0, 0, lift];
    if (id === 'rack-bottom') return [0, 0, -lift / 2];
    // Wall parts pull well clear toward the wall side so the sides' cleat
    // hooks — and the strips they seat on — read as separate pieces.
    if (id === 'rack-wall-cleat' || id === 'rack-wall-spacer') return [0, lateral + 35, 0];
    if (id.startsWith('rack-')) return [0, -lateral - 15, 0];
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
      {showShell && !rackMode && <BoardPlaceholderMesh />}
      {showShell && !rackMode && <HatPlaceholderMeshes />}
      <ExternalAssetMeshes />
      <PortMarkers />
    </group>
  );
}
