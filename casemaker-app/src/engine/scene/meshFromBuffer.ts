import * as THREE from 'three';
import type { MeshBuffer } from '@/types';

export function bufferToGeometry(buf: MeshBuffer): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3));
  geom.setIndex(new THREE.BufferAttribute(buf.indices, 1));
  geom.computeVertexNormals();
  return geom;
}
