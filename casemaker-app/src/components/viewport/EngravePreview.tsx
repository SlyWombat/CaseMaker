/**
 * The engrave preview's meshes (#205), rendered by `SceneMeshes` instead of the case while the
 * Engrave section is open and no simulation owns the viewport.
 *
 * Everything arrives from the sim worker in the WORK frame — origin at the stock's top-front-left
 * corner, +X right, +Y away from the operator, Z = 0 at the stock's top face, material at
 * negative Z — and the scene is Z-up, so the meshes are drawn as-is with NO transform (exactly
 * what `SimMeshes` does). Each pocket floor is coloured by its depth on a FIXED ramp so the same
 * depth reads the same everywhere; the vise jaws are translucent and never write depth (a
 * transparent mesh that wrote depth would hide the pocket behind it — issue #162). A legend lists
 * each distinct depth, and an axis marker sits at the work origin with X and Y labelled.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { useEngravePreviewStore } from '@/store/engravePreviewStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { ViseParams } from '@/types/engraveJob';
import { geometryFromMesh } from './simGeometry';
import { depthColor } from './engraveRamp';

/** The same neutral wood tone the simulation's stock uses (#197). */
const STOCK_COLOR = '#c9a26b';
/** The same fixture grey the simulation's jaws use (#197, #204). */
const JAW_COLOR = '#4b5563';
/** PROVISIONAL (#205): the axis marker's length as a fraction of the stock's smaller side. */
const AXIS_FRACTION = 0.2;

/** Where the vise numbers came from, in words (decision 28: a default is not a measurement). */
function sourceWords(source: ViseParams['source']): string {
  if (source === 'default') return 'unmeasured defaults';
  if (source === 'saved') return 'saved vise';
  return 'measured for this setup';
}

/**
 * A geometry built from a worker mesh, disposed when the mesh is replaced or on unmount. A
 * rebuild replaces the stock/floors as the user types, so without this the geometries would
 * accumulate (`renderer.info.memory.geometries` must stay bounded — #197).
 */
function useMeshGeometry(mesh: NodeMeshOutput | null): THREE.BufferGeometry | null {
  const geom = useMemo(() => (mesh ? geometryFromMesh(mesh) : null), [mesh]);
  useEffect(() => () => geom?.dispose(), [geom]);
  return geom;
}

/** One label's pocket floor, coloured by its depth. */
function Floor({ mesh, color, labelId }: { mesh: NodeMeshOutput; color: string; labelId: string }) {
  const geom = useMeshGeometry(mesh);
  if (!geom) return null;
  return (
    <mesh geometry={geom} name={`engrave-floor-${labelId}`} userData={{ engraveFloor: labelId }}>
      <meshStandardMaterial color={color} metalness={0.05} roughness={0.7} />
    </mesh>
  );
}

/** One vise jaw, drawn where the user SAID it is (un-inflated). */
function Jaw({ mesh, name }: { mesh: NodeMeshOutput; name: string }) {
  const geom = useMeshGeometry(mesh);
  if (!geom) return null;
  return (
    <mesh geometry={geom} name={name}>
      {/* depthWrite:false — a transparent mesh that writes depth hides what is inside it (#162). */}
      <meshStandardMaterial
        color={JAW_COLOR}
        transparent
        opacity={0.5}
        depthWrite={false}
        metalness={0.2}
        roughness={0.6}
      />
    </mesh>
  );
}

/** Centre of a mesh's bbox, for anchoring a jaw's source label. */
function centreOf(bbox: { min: readonly number[]; max: readonly number[] }): [number, number, number] {
  return [
    (bbox.min[0]! + bbox.max[0]!) / 2,
    (bbox.min[1]! + bbox.max[1]!) / 2,
    (bbox.min[2]! + bbox.max[2]!) / 2,
  ];
}

const AXIS_LABEL = {
  color: '#e6e6e6',
  fontSize: 11,
  fontWeight: 700,
  textShadow: '0 0 3px #000',
} as const;

export function EngravePreview() {
  const preview = useEngravePreviewStore((s) => s.preview);
  const stock = useEngraveJobStore((s) => s.job.stock);
  const vise = useEngraveJobStore((s) => s.job.workholding.vise);
  const minFloor = useEngraveJobStore((s) => s.job.minFloor);

  // Hooks run before the early return; the geometry is null until the first preview lands.
  const stockGeom = useMeshGeometry(preview?.stock ?? null);
  // Distinct depths, shallowest first, for the legend and the ramp.
  const depths = useMemo(() => {
    if (!preview) return [];
    return [...new Set(preview.floors.map((f) => f.depth))].sort((a, b) => a - b);
  }, [preview]);
  const maxDepth = stock.thickness - minFloor;

  if (!preview || !stockGeom) return null;

  const axisLen = Math.max(8, Math.min(Math.min(stock.length, stock.width) * AXIS_FRACTION, 25));
  const fixedJaw = preview.fixture[0];

  return (
    <group>
      <mesh geometry={stockGeom} name="engrave-stock">
        <meshStandardMaterial color={STOCK_COLOR} flatShading metalness={0.05} roughness={0.75} />
      </mesh>

      {preview.floors.map((f) => (
        <Floor key={f.labelId} mesh={f.mesh} labelId={f.labelId} color={depthColor(f.depth, maxDepth)} />
      ))}

      {preview.fixture.map((jaw) => (
        <Jaw key={jaw.id} mesh={jaw.mesh} name={`engrave-${jaw.id}`} />
      ))}

      {/* The work origin: the stock's top-front-left corner, with X and Y labelled. */}
      <group name="engrave-axes">
        <mesh position={[axisLen / 2, 0, 0]}>
          <boxGeometry args={[axisLen, 0.4, 0.4]} />
          <meshBasicMaterial color="#e5484d" />
        </mesh>
        <mesh position={[0, axisLen / 2, 0]}>
          <boxGeometry args={[0.4, axisLen, 0.4]} />
          <meshBasicMaterial color="#30a46c" />
        </mesh>
        <Html position={[axisLen, 0, 0]} center>
          <span data-testid="engrave-axis-x" style={AXIS_LABEL}>
            X
          </span>
        </Html>
        <Html position={[0, axisLen, 0]} center>
          <span data-testid="engrave-axis-y" style={AXIS_LABEL}>
            Y
          </span>
        </Html>
      </group>

      {fixedJaw && (
        <Html position={centreOf(fixedJaw.mesh.bbox)} center>
          <span
            data-testid="engrave-jaw-source"
            style={{
              fontSize: 10,
              color: '#c8d3de',
              background: 'rgba(20,25,30,0.7)',
              borderRadius: 3,
              padding: '1px 4px',
              whiteSpace: 'nowrap',
            }}
          >
            vise: {sourceWords(vise.source)}
          </span>
        </Html>
      )}

      {/* Screen-fixed legend: each distinct depth and the colour the floors use for it. */}
      <Html fullscreen zIndexRange={[8, 0]}>
        <div
          data-testid="engrave-preview-legend"
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'rgba(20,25,30,0.82)',
            border: '1px solid #2a2f36',
            borderRadius: 4,
            padding: '6px 8px',
            color: '#d1d5db',
            fontSize: 11,
            lineHeight: 1.6,
            pointerEvents: 'none',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Depth</div>
          {depths.length === 0 ? (
            <div style={{ color: '#9aa4b0' }}>nothing cut</div>
          ) : (
            depths.map((d) => (
              <div key={d} data-testid={`engrave-legend-${d}`} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    background: depthColor(d, maxDepth),
                    border: '1px solid #00000055',
                    display: 'inline-block',
                  }}
                />
                {d.toFixed(1)} mm
              </div>
            ))
          )}
        </div>
      </Html>
    </group>
  );
}
