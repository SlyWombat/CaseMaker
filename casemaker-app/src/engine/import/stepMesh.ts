/**
 * STEP (ISO 10303) → mesh, through the OpenCascade CAD kernel (#774, reversing R-12/R-13 for
 * PART B-REP import).
 *
 * The app's whole mesh pipeline is triangle soups: a goal is a heightfield sampled from a mesh, a
 * stock is a prism read out of one, the viewport draws the same. A STEP file is not a mesh — it is
 * a B-rep — so this module is the one translation, at the import door: the kernel reads the
 * surfaces, tessellates them, and the result is written as the binary STL the app already stores
 * for every imported part. Downstream nothing learns a second format: `targetObjectMesh`,
 * `meshAsStock`, the heightfields and the viewport all read an STL.
 *
 * THE KERNEL IS LAZY. `occt-import-js` is a ~9 MB WebAssembly build of OpenCascade; a job that
 * never opens a STEP must not download it. Both the glue and the wasm URL are dynamic imports
 * here, so they land in a chunk of their own, fetched the first time a STEP is picked (and cached
 * by the browser after that).
 *
 * UNITS. The kernel's `linearUnit` defaults to millimetres and is the OUTPUT unit: a file written
 * in inches converts on the way in. Nothing in the app has to know the file's own unit.
 *
 * ASSEMBLIES ARE MERGED. A STEP file may carry several parts; the kernel returns one mesh per
 * body. The import concatenates them into one triangle soup and reports how many bodies it read —
 * the caller can say so. A goal surfaces the merged top; a stock is then judged by `meshAsStock`
 * like any other mesh, which refuses a multi-body outline unless it really is one prism.
 */

import type { ParsedMesh } from './stlParser';
import { buildBinaryStl } from '@/workers/export/stlBinary';

/** The file extensions a STEP may wear. */
export const STEP_EXTENSIONS = ['.step', '.stp'];

export function isStepFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.step') || lower.endsWith('.stp');
}

export interface StepMesh {
  /** The merged triangle mesh, in mm. */
  mesh: ParsedMesh;
  /** How many bodies the kernel found; 1 for a single solid. */
  parts: number;
}

export interface StepMeshRead extends StepMesh {
  /**
   * The binary STL the job stores instead of the STEP bytes — the same triangles in the format
   * every reader in the app already knows. See the module note for why.
   */
  stl: ArrayBuffer;
}

type Kernel = import('occt-import-js').OcctModule;

/**
 * True when running under Node (vitest, a headless script) rather than a browser bundle. The
 * emscripten glue has its own two branches: Node reads the wasm with `fs` from the package's own
 * directory, a browser must be told where the asset went when Vite emitted it.
 */
function runningInNode(): boolean {
  const g = globalThis as { process?: { versions?: { node?: string } } };
  return typeof g.process?.versions?.node === 'string';
}

let kernel: Promise<Kernel> | null = null;

async function loadKernel(): Promise<Kernel> {
  if (kernel === null) {
    kernel = (async () => {
      const [{ default: factory }, { default: wasmUrl }] = await Promise.all([
        import('occt-import-js'),
        import('occt-import-js/dist/occt-import-js.wasm?url'),
      ]);
      return factory(runningInNode() ? undefined : { locateFile: () => wasmUrl });
    })();
    // A failed load is not cached: a transient network error must not poison every later import.
    kernel.catch(() => {
      kernel = null;
    });
  }
  return kernel;
}

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Read a STEP file and return the merged mesh. Never returns a malformed result; every refusal is
 * an `Error` whose message is a sentence the importer shows after the file's own name.
 */
export async function stepToMesh(bytes: ArrayBuffer): Promise<StepMesh> {
  let occt: Kernel;
  try {
    occt = await loadKernel();
  } catch (e) {
    throw new Error(`the STEP reader could not be loaded (${why(e)})`, { cause: e });
  }

  let result: import('occt-import-js').OcctReadResult;
  try {
    // `null` params keep the kernel's own defaults: bounding-box-ratio linear deflection and a
    // 0.3 rad angular deflection, which is the tolerance its examples use and is finer than the
    // app's own heightfield sampling needs at every pitch it offers.
    result = occt.ReadStepFile(new Uint8Array(bytes), null);
  } catch (e) {
    throw new Error(`the CAD kernel could not read the file as STEP data (${why(e)})`, { cause: e });
  }
  if (!result.success) throw new Error('the CAD kernel rejected the file as STEP data');
  const meshes = (result.meshes ?? []).filter((m) => (m.index?.array.length ?? 0) >= 3);
  if (meshes.length === 0) throw new Error('the file holds no surfaces to mesh');

  // One typed array for the whole file: count first, then fill. Each body's indices are offset by
  // the vertices already copied, so the merged mesh indexes its own array.
  let vertexCount = 0;
  let indexCount = 0;
  for (const m of meshes) {
    vertexCount += Math.floor(m.attributes.position.array.length / 3);
    indexCount += m.index.array.length;
  }
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let vBase = 0;
  let iBase = 0;
  for (const m of meshes) {
    const position = m.attributes.position.array;
    const count = Math.floor(position.length / 3);
    for (let i = 0; i < position.length; i++) {
      const value = position[i] as number;
      positions[vBase * 3 + i] = value;
      const axis = i % 3;
      if (axis === 0) {
        if (value < minX) minX = value;
        if (value > maxX) maxX = value;
      } else if (axis === 1) {
        if (value < minY) minY = value;
        if (value > maxY) maxY = value;
      } else {
        if (value < minZ) minZ = value;
        if (value > maxZ) maxZ = value;
      }
    }
    const index = m.index.array;
    for (let i = 0; i < index.length; i++) indices[iBase + i] = vBase + (index[i] as number);
    vBase += count;
    iBase += index.length;
  }

  const mesh: ParsedMesh = {
    positions,
    indices,
    triangleCount: Math.floor(indices.length / 3),
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
  return { mesh, parts: meshes.length };
}

/**
 * The same read, plus the binary STL the goal door stores. The stock door takes {@link stepToMesh}
 * alone — it keeps a size, never the bytes — so it does not pay for a file it would throw away.
 */
export async function stepToStl(bytes: ArrayBuffer): Promise<StepMeshRead> {
  const read = await stepToMesh(bytes);
  return { ...read, stl: buildBinaryStl([read.mesh]) };
}
