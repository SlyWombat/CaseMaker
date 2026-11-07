import type { ExternalAsset } from '@/types';
import { arrayBufferToBase64, base64ToArrayBuffer } from './base64';
import { parseStl, type ParsedMesh } from './stlParser';
import { parse3MF } from './threeMfParser';
import { newId } from '@/utils/id';
import { nonFiniteMeshSentence } from './targetObject';

export async function importStlFile(file: File): Promise<ExternalAsset> {
  const buf = await file.arrayBuffer();
  // #1029 — an external asset is a USER FILE too, and a union/subtract asset builds a mesh
  // op whose vertices reach `new tl.Manifold` in the worker; one NaN or ±Infinity vertex
  // traps the whole instance there. Refused by name at import, the same sentence the door uses.
  const parsed = parseStl(buf); // validate by parsing once
  const nonFinite = nonFiniteMeshSentence(file.name, parsed);
  if (nonFinite !== null) throw new Error(nonFinite);
  return {
    id: newId('asset'),
    name: file.name,
    format: 'stl',
    data: arrayBufferToBase64(buf),
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    visibility: 'reference',
  };
}

export async function importThreeMfFile(file: File): Promise<ExternalAsset> {
  const buf = await file.arrayBuffer();
  const parsed = parse3MF(buf);
  const nonFinite = nonFiniteMeshSentence(file.name, parsed);
  if (nonFinite !== null) throw new Error(nonFinite);
  return {
    id: newId('asset'),
    name: file.name,
    format: '3mf',
    data: arrayBufferToBase64(buf),
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    visibility: 'reference',
  };
}

export async function importMeshFile(file: File): Promise<ExternalAsset> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.3mf')) return importThreeMfFile(file);
  return importStlFile(file);
}

const meshCache = new Map<string, ParsedMesh>();

export function decodeAssetMesh(asset: ExternalAsset): ParsedMesh {
  const cached = meshCache.get(asset.id);
  if (cached) return cached;
  const buf = base64ToArrayBuffer(asset.data);
  const parsed = asset.format === '3mf' ? parse3MF(buf) : parseStl(buf);
  meshCache.set(asset.id, parsed);
  return parsed;
}

export function clearAssetMeshCache(): void {
  meshCache.clear();
}
