import * as Comlink from 'comlink';
import { buildBinaryStl, type StlMeshInput } from './export/stlBinary';
import { buildAsciiStl } from './export/stlAscii';
import { buildThreeMf, type ThreeMfOptions } from './export/threeMf';

const api = {
  exportStlBinary(meshes: StlMeshInput[]): ArrayBuffer {
    const buf = buildBinaryStl(meshes);
    return Comlink.transfer(buf, [buf]);
  },
  exportStlAscii(meshes: StlMeshInput[]): string {
    return buildAsciiStl(meshes);
  },
  exportThreeMf(meshes: StlMeshInput[], opts: ThreeMfOptions = {}): ArrayBuffer {
    const buf = buildThreeMf(meshes, opts);
    return Comlink.transfer(buf, [buf]);
  },
};

export type ExportWorkerApi = typeof api;

Comlink.expose(api);
