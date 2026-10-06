import type { Project, MeshNode, MeshStats } from '@/types';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { ensureFontsLoaded, fontKeysForLabels } from '@/engine/fonts/registry';
import { buildGeometry, setWorkerGeneration } from './workerClient';
import { useJobStore } from '@/store/jobStore';

let currentGeneration = 0;
let debounceMs = 200;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let pendingResolvers: Array<() => void> = [];

export function setDebounce(ms: number): void {
  debounceMs = Math.max(0, ms);
}

export function getDebounce(): number {
  return debounceMs;
}

export function getGeneration(): number {
  return currentGeneration;
}

function nextGeneration(): number {
  currentGeneration += 1;
  return currentGeneration;
}

async function dispatch(project: Project, myGen: number): Promise<void> {
  if (myGen !== currentGeneration) return;
  const job = useJobStore.getState();
  job.setStatus('rebuilding');
  await setWorkerGeneration(myGen);
  try {
    // Issue #180 — the bundled faces are static assets now, fetched on first use. Load exactly
    // the keys this project's enabled labels typeset with BEFORE the synchronous compile; a
    // project with no text labels passes `[]` and fetches nothing.
    await ensureFontsLoaded(fontKeysForLabels(project.textLabels, project.customFonts ?? []));
    if (myGen !== currentGeneration) return;
    const plan = compileProject(project);
    const result = await buildGeometry(plan, myGen);
    if (!result || myGen !== currentGeneration) return;
    // Issue #168 — the slicer assignment travels with the part. The worker
    // ships geometry only, so take it from the plan being built (the worker
    // walks `plan.nodes` in order and echoes each id back, but matching on the
    // id is what makes that an implementation detail rather than a contract).
    const materialById = new Map(
      plan.nodes.filter((n) => n.material).map((n) => [n.id, n.material!] as const),
    );
    const nodes: MeshNode[] = result.nodes.map((n) => ({
      id: n.id,
      buffer: { positions: n.positions, indices: n.indices },
      material: materialById.get(n.id),
      stats: {
        vertexCount: n.vertexCount,
        triangleCount: n.triangleCount,
        bbox: n.bbox,
        // Issue #83 — propagate Manifold.decompose() count so the UI can
        // warn when a node has loose pieces.
        componentCount: n.componentCount,
      },
    }));
    const combined: MeshStats = {
      vertexCount: result.combinedVertexCount,
      triangleCount: result.combinedTriangleCount,
      bbox: result.combinedBBox,
    };
    job.applyResult(myGen, nodes, combined, result.durationMs, result.diag, {
      placementReport: plan.placementReport,
      smartCutoutDecisions: plan.smartCutoutDecisions,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useJobStore.getState().setStatus('error', message);
  }
}

export function schedule(project: Project): void {
  const myGen = nextGeneration();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    inflight = dispatch(project, myGen).finally(() => {
      inflight = null;
      const resolvers = pendingResolvers;
      pendingResolvers = [];
      resolvers.forEach((r) => r());
    });
  }, debounceMs);
}

export function scheduleImmediate(project: Project): Promise<void> {
  const myGen = nextGeneration();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  inflight = dispatch(project, myGen).finally(() => {
    inflight = null;
    const resolvers = pendingResolvers;
    pendingResolvers = [];
    resolvers.forEach((r) => r());
  });
  return inflight;
}

export function waitForIdle(): Promise<void> {
  if (!timer && !inflight) return Promise.resolve();
  return new Promise((resolve) => {
    pendingResolvers.push(resolve);
  });
}
