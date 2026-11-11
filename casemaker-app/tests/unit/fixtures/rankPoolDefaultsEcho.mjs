// #1237 — a rank worker that reports the shop defaults the seam sent it. The real rank worker
// installs `workerData.defaults` into the live source before planning; this fixture proves the
// channel carries them, so that install cannot be fed null.
import { parentPort, workerData } from 'node:worker_threads';

const task = workerData;
parentPort.postMessage({ ok: true, metric: { kind: 'noStamp', defaultsSeen: task.defaults ?? null } });
