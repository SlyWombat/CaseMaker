// #1151 Phase 2 — the rank pool's STUB worker, for the plumbing spec. The real entry
// (rankPoolWorker.ts) builds a Manifold toplevel and plans a candidate; this one answers from the
// candidate key alone, so the pool's fan-out, positioning, failure and cancel paths are provable
// without a whole model.
import { parentPort, workerData } from 'node:worker_threads';

const key = String(workerData?.candidateKey ?? '');
if (key === 'refuse') {
  parentPort.postMessage({ ok: false, error: 'the fake rank worker refused this candidate' });
} else if (key === 'crash') {
  throw new Error('the fake rank worker crashed');
} else {
  parentPort.postMessage({
    ok: true,
    metric: { kind: 'measured', leftover: key.length / 100, cycle: key.length, deepestMm: 1 },
  });
}
