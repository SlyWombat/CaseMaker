import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { useJobStore } from '@/store/jobStore';

interface PartThumbnailProps {
  partId: string;
  size: number;
  /** Tint for the rendered material (rigid vs flex parts). */
  color?: string;
}

/** Renders a small isometric preview of a top-level BuildPlan node into an
 *  offscreen Three.js canvas, then displays the resulting PNG. Re-renders
 *  whenever the underlying mesh buffer changes (the engine swaps it on
 *  every recompile) so the thumbnail tracks live geometry edits. */
export function PartThumbnail({ partId, size, color = '#9ca3af' }: PartThumbnailProps) {
  const node = useJobStore((s) => s.nodes.get(partId));
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    // No node: nothing to render. `src` is deliberately NOT cleared here —
    // clearing it synchronously in an effect costs a second render pass
    // (react-hooks/set-state-in-effect). The render guard below treats a
    // missing node as "show the placeholder" regardless of any stale src.
    if (!node) return;
    let cancelled = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let geo: THREE.BufferGeometry | null = null;
    let mat: THREE.MeshStandardMaterial | null = null;
    try {
      geo = new THREE.BufferGeometry();
      // Clone the typed arrays — the underlying buffer might be shared with
      // the live mesh in the viewport (which is still using it for render).
      geo.setAttribute('position', new THREE.BufferAttribute(node.buffer.positions.slice(), 3));
      geo.setIndex(new THREE.BufferAttribute(node.buffer.indices.slice(), 1));
      // Center the geometry at the origin so the camera + lighting setup
      // can be a fixed pose (the part's actual world position is irrelevant
      // for a thumbnail). Compute bounding box for centering AND extent.
      geo.computeBoundingBox();
      const bbox = geo.boundingBox;
      if (!bbox) return;
      const center = new THREE.Vector3();
      bbox.getCenter(center);
      const sizeVec = new THREE.Vector3();
      bbox.getSize(sizeVec);
      const maxExtent = Math.max(sizeVec.x, sizeVec.y, sizeVec.z);
      if (maxExtent === 0) return;
      // Translate the position attribute in-place so the part centroid sits
      // at the origin.
      const positions = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < positions.count; i++) {
        positions.setXYZ(
          i,
          positions.getX(i) - center.x,
          positions.getY(i) - center.y,
          positions.getZ(i) - center.z,
        );
      }
      positions.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const sphere = geo.boundingSphere;
      if (!sphere || sphere.radius === 0) return;

      const canvas = document.createElement('canvas');
      canvas.width = size * 2; // 2× for retina-sharp downscale
      canvas.height = size * 2;
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setClearColor(0x14181c, 1); // matches modal background
      renderer.setSize(size * 2, size * 2, false);
      const scene = new THREE.Scene();
      mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.08 });
      const mesh = new THREE.Mesh(geo, mat);
      scene.add(mesh);
      // Lights placed RELATIVE to the bounding sphere — proportional to
      // the part's size — so a 5 mm pin and a 200 mm shell light the same.
      scene.add(new THREE.AmbientLight(0xffffff, 0.55));
      const r = sphere.radius;
      const key = new THREE.DirectionalLight(0xffffff, 0.95);
      key.position.set(r * 3, -r * 2, r * 4);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xb6c7d4, 0.35);
      fill.position.set(-r * 2, r * 3, -r * 1);
      scene.add(fill);
      // Camera framed isometric. Z is up in project world coords.
      const fov = 32;
      const dist = (sphere.radius / Math.sin((fov / 2) * Math.PI / 180)) * 1.18;
      const camera = new THREE.PerspectiveCamera(fov, 1, Math.max(0.01, sphere.radius * 0.02), sphere.radius * 50);
      camera.position.set(dist * 0.78, -dist * 0.78, dist * 0.5);
      camera.up.set(0, 0, 1);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      if (cancelled) return;
      // Publishing the result of an imperative offscreen WebGL render. There
      // is no render-phase equivalent — the PNG cannot be derived from props
      // or state, it has to be rasterised first. Scoped disable rather than a
      // file-wide one so any *other* setState added to this effect still errors.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSrc(canvas.toDataURL('image/png'));
    } catch (err) {
      // WebGL not available or render failed — leave src null and the
      // placeholder square shows.
      console.warn(`PartThumbnail render failed for ${partId}`, err);
      setSrc(null);
    }
    return () => {
      cancelled = true;
      if (renderer) renderer.dispose();
      if (geo) geo.dispose();
      if (mat) mat.dispose();
    };
  }, [node, partId, size, color]);

  const placeholderStyle: React.CSSProperties = {
    width: size,
    height: size,
    background: '#1f2530',
    border: '1px solid #2a2f36',
    borderRadius: 3,
    display: 'inline-block',
  };
  if (!node || !src) return <div aria-hidden style={placeholderStyle} />;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ display: 'block', borderRadius: 3, border: '1px solid #2a2f36' }}
    />
  );
}
