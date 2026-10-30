/**
 * The OpenCascade importer (#774) — the WASM CAD kernel that reads a STEP file's B-rep and
 * tessellates it into triangles.
 *
 * Only the package's own typings are declared here: it ships none, and the surface this app uses
 * is the factory and `ReadStepFile`. The result shape is the one its README documents.
 */
declare module 'occt-import-js' {
  export interface OcctMesh {
    name?: string;
    /** Positions as x,y,z triplets — three.js' own layout. */
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    /** Triangle indices, three per triangle. */
    index: { array: number[] };
  }
  export interface OcctReadResult {
    success: boolean;
    root?: { name?: string; meshes?: number[]; children?: unknown[] };
    meshes: OcctMesh[];
  }
  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: Record<string, unknown> | null): OcctReadResult;
  }
  export interface OcctFactoryOptions {
    /** Where the emscripten glue finds `occt-import-js.wasm`. */
    locateFile?: (path: string) => string;
  }
  const factory: (options?: OcctFactoryOptions) => Promise<OcctModule>;
  export default factory;
}
