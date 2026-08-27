import * as Comlink from 'comlink';
import type { GeometryWorkerApi, BuildOutputWire } from '@/workers/geometry.worker';
import type { ExportWorkerApi } from '@/workers/export.worker';
import type { StlMeshInput } from '@/workers/export/stlBinary';
import { transferListForPlan } from '@/engine/compiler/buildPlan';

let geomWorker: Worker | null = null;
let geomApi: Comlink.Remote<GeometryWorkerApi> | null = null;
let exportWorker: Worker | null = null;
let exportApi: Comlink.Remote<ExportWorkerApi> | null = null;

function getGeomApi(): Comlink.Remote<GeometryWorkerApi> {
  if (!geomApi) {
    geomWorker = new Worker(new URL('../../workers/geometry.worker.ts', import.meta.url), {
      type: 'module',
      name: 'geometry',
    });
    geomApi = Comlink.wrap<GeometryWorkerApi>(geomWorker);
  }
  return geomApi;
}

function getExportApi(): Comlink.Remote<ExportWorkerApi> {
  if (!exportApi) {
    exportWorker = new Worker(new URL('../../workers/export.worker.ts', import.meta.url), {
      type: 'module',
      name: 'export',
    });
    exportApi = Comlink.wrap<ExportWorkerApi>(exportWorker);
  }
  return exportApi;
}

export async function buildGeometry(
  plan: import('@/engine/compiler/buildPlan').BuildPlan,
  generation: number,
): Promise<BuildOutputWire | null> {
  const buffers = transferListForPlan(plan);
  if (buffers.length === 0) {
    return getGeomApi().build(plan, generation);
  }
  return getGeomApi().build(Comlink.transfer(plan, buffers), generation);
}

export async function setWorkerGeneration(generation: number): Promise<void> {
  await getGeomApi().setGeneration(generation);
}

export async function exportStlBinary(meshes: StlMeshInput[]): Promise<ArrayBuffer> {
  return getExportApi().exportStlBinary(meshes);
}

export async function exportStlAscii(meshes: StlMeshInput[]): Promise<string> {
  return getExportApi().exportStlAscii(meshes);
}

export async function exportThreeMf(meshes: StlMeshInput[]): Promise<ArrayBuffer> {
  return getExportApi().exportThreeMf(meshes);
}
