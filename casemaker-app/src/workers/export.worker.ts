import * as Comlink from 'comlink';
import { buildBinaryStl, type StlMeshInput } from './export/stlBinary';
import { buildThreeMf } from './export/threeMf';

const api = {
  exportStl(meshes: StlMeshInput[]): ArrayBuffer {
    const buf = buildBinaryStl(meshes);
    return Comlink.transfer(buf, [buf]);
  },
  exportThreeMf(meshes: StlMeshInput[]): ArrayBuffer {
    const buf = buildThreeMf(meshes);
    return Comlink.transfer(buf, [buf]);
  },
};

export type ExportWorkerApi = typeof api;

Comlink.expose(api);
