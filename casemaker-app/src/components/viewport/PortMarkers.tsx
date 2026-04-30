import { useMemo, useCallback, useEffect, useState, useRef } from 'react';
import { PivotControls, Html } from '@react-three/drei';
import * as THREE from 'three';
import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import type { PortPlacement } from '@/types';
import {
  axisLockForFacing,
  snapToGrid,
  defaultGridStep,
  nudgeVectorsForFacing,
  portBounds,
  clampPortPosition,
} from '@/engine/portConstraints';

interface MarkerInfo {
  port: PortPlacement;
  worldX: number;
  worldY: number;
  worldZ: number;
}

export function PortMarkers() {
  const ports = useProjectStore((s) => s.project.ports);
  const board = useProjectStore((s) => s.project.board);
  const caseParams = useProjectStore((s) => s.project.case);
  const selectedId = useViewportStore((s) => s.selectedPortId);
  const select = useViewportStore((s) => s.selectPort);
  const setSelection = useViewportStore((s) => s.setSelection);
  const patchPort = useProjectStore((s) => s.patchPort);

  const markers = useMemo<MarkerInfo[]>(() => {
    const { wallThickness: wall, internalClearance: cl, floorThickness: floor } = caseParams;
    return ports.map((p) => ({
      port: p,
      worldX: wall + cl + p.position.x + p.size.x / 2,
      worldY: wall + cl + p.position.y + p.size.y / 2,
      worldZ: floor + p.position.z + p.size.z / 2,
    }));
  }, [ports, caseParams]);

  const dragStart = useRef<{ x: number; y: number; z: number } | null>(null);
  const [delta, setDelta] = useState<{ x: number; y: number; z: number } | null>(null);

  const selectedMarker = markers.find((m) => m.port.id === selectedId);
  const lock = axisLockForFacing(selectedMarker?.port.facing);
  const grid = defaultGridStep();

  const onDragStart = useCallback(() => {
    if (!selectedMarker) return;
    dragStart.current = { ...selectedMarker.port.position };
    setDelta({ x: 0, y: 0, z: 0 });
  }, [selectedMarker]);

  const onDragEnd = useCallback(() => {
    dragStart.current = null;
    setDelta(null);
  }, []);

  const onDrag = useCallback(
    (m4: THREE.Matrix4) => {
      if (!selectedMarker || !dragStart.current) return;
      const t = new THREE.Vector3();
      t.setFromMatrixPosition(m4);
      const start = dragStart.current;
      const raw = {
        x: lock.lockX ? start.x : snapToGrid(start.x + t.x, grid),
        y: lock.lockY ? start.y : snapToGrid(start.y + t.y, grid),
        z: lock.lockZ ? start.z : snapToGrid(start.z + t.z, grid),
      };
      const clamped = clampPortPosition(raw, portBounds(board, selectedMarker.port));
      patchPort(selectedMarker.port.id, { position: clamped });
      setDelta({
        x: clamped.x - start.x,
        y: clamped.y - start.y,
        z: clamped.z - start.z,
      });
    },
    [selectedMarker, board, lock, grid, patchPort],
  );

  useEffect(() => {
    if (!selectedMarker) return;
    const nudge = nudgeVectorsForFacing(selectedMarker.port.facing);
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const vec = nudge[e.key as keyof typeof nudge];
      if (!vec || !selectedMarker) return;
      e.preventDefault();
      const step = e.shiftKey ? 1 : 0.1;
      const port = selectedMarker.port;
      const next = {
        x: port.position.x + vec[0] * step,
        y: port.position.y + vec[1] * step,
        z: port.position.z + vec[2] * step,
      };
      const clamped = clampPortPosition(next, portBounds(board, port));
      patchPort(port.id, { position: clamped });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedMarker, board, patchPort]);

  return (
    <group>
      {markers.map((m) => {
        const isSelected = m.port.id === selectedId;
        return (
          <group key={m.port.id} position={[m.worldX, m.worldY, m.worldZ]}>
            <mesh
              onClick={(e) => {
                e.stopPropagation();
                // Issue #94 — clicking a port marker in the 3D viewport
                // selects the port AND opens the right-rail detail editor
                // via the unified selection model.
                select(m.port.id);
                setSelection({ kind: 'port', portId: m.port.id });
              }}
              userData={{ portId: m.port.id }}
              name={`port-marker-${m.port.id}`}
            >
              <sphereGeometry args={[1.2, 12, 12]} />
              <meshStandardMaterial
                color={isSelected ? '#ffd267' : m.port.enabled ? '#67c0ff' : '#666'}
                emissive={isSelected ? '#aa6600' : '#000'}
                emissiveIntensity={isSelected ? 0.6 : 0}
              />
            </mesh>
            {isSelected && (
              <>
                <PivotControls
                  anchor={[0, 0, 0]}
                  depthTest={false}
                  lineWidth={2}
                  scale={20}
                  fixed
                  disableRotations
                  activeAxes={[!lock.lockX, !lock.lockY, !lock.lockZ]}
                  onDragStart={onDragStart}
                  onDrag={onDrag}
                  onDragEnd={onDragEnd}
                />
                {delta && (
                  <Html position={[0, 0, 8]} center distanceFactor={120} zIndexRange={[100, 0]}>
                    <div className="port-delta-readout" data-testid="port-delta-readout">
                      Δx {fmt(delta.x)}  Δy {fmt(delta.y)}  Δz {fmt(delta.z)}
                    </div>
                  </Html>
                )}
              </>
            )}
          </group>
        );
      })}
    </group>
  );
}

function fmt(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}
