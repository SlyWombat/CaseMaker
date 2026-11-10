// #1137 — a STUB pool worker: the real entry builds a Manifold instance per thread (seconds and
// hundreds of MB), which is the wrong thing to pay for in a plumbing test. This one speaks the
// same protocol — `{ready}`, then one reply per `{id, plan}` — and fabricates a positional
// evaluation from the plan, so the pool's queueing, ordering and death handling are what the test
// measures.
import { parentPort, workerData } from 'node:worker_threads';

const mode = workerData?.mode ?? 'ok';
const delayMs = workerData?.delayMs ?? 0;

parentPort.postMessage({ ready: true });

parentPort.on('message', (msg) => {
  if (mode === 'crash') {
    process.exit(7);
    return;
  }
  setTimeout(() => {
    parentPort.postMessage({
      id: msg.id,
      ok: true,
      evaluation: {
        ok: true,
        refusal: null,
        items: [],
        seconds: msg.plan.cutters.length * 10,
        toolChanges: 0,
        risk: { reachMarginMm: null, holderClearanceMm: null, chipLoadRatio: null },
      },
    });
  }, delayMs);
});
