import type { Project, MeshNode, MeshStats } from '@/types';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
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
    const plan = compileProject(project);
    const result = await buildGeometry(plan, myGen);
    if (!result || myGen !== currentGeneration) return;
    const nodes: MeshNode[] = result.nodes.map((n) => ({
      id: n.id,
      buffer: { positions: n.positions, indices: n.indices },
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
