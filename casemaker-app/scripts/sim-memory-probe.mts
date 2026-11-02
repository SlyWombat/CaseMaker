/**
 * #881 / #902 — THE CLI for the one CDP heap probe (`cdpHeap.mts`).
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/sim-memory-probe.mts \
 *     --cdp ws://127.0.0.1:9333/devtools/browser/<id> [--interval 500] [--timeout 2000] [--seconds 60]
 *
 * `--cdp` takes either the browser WebSocket URL or the `http://host:port` of a
 * `--remote-debugging-port` endpoint (it asks `/json/version` for the socket). One JSON line is
 * printed per sample — the whole `HeapSample`, targets included — so a shell or a test can keep
 * the stream and diff it. `--seconds 0` (the default) runs until SIGINT/SIGTERM.
 *
 * Every CDP call is raced against `--timeout`; a worker that died reads as a null heap instead
 * of hanging the stream. See `cdpHeap.mts` for the gpd-dave lessons this bakes in.
 */

import { cdpWebSocketUrl, sampleHeaps, type HeapSample } from './cdpHeap.mts';

interface Args {
  cdp: string | null;
  intervalMs: number;
  timeoutMs: number;
  seconds: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { cdp: null, intervalMs: 500, timeoutMs: 2000, seconds: 0 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) break;
    if (flag === '--cdp') {
      args.cdp = value;
      i++;
    } else if (flag === '--interval') {
      args.intervalMs = Number(value);
      i++;
    } else if (flag === '--timeout') {
      args.timeoutMs = Number(value);
      i++;
    } else if (flag === '--seconds') {
      args.seconds = Number(value);
      i++;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cdp === null) {
    console.error(
      'usage: sim-memory-probe.mts --cdp <ws-url | http://host:port> [--interval 500] [--timeout 2000] [--seconds 60]',
    );
    process.exitCode = 2;
    return;
  }
  const cdpUrl = args.cdp.startsWith('ws://') || args.cdp.startsWith('wss://')
    ? args.cdp
    : await cdpWebSocketUrl(args.cdp, args.timeoutMs);

  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const started = Date.now();
  while (!stopped) {
    let sample: HeapSample;
    try {
      sample = await sampleHeaps({ cdpUrl, timeoutMs: args.timeoutMs });
    } catch (error) {
      // The endpoint closed: one line saying so, then out; the caller diffs the stream.
      console.log(JSON.stringify({ at: Date.now(), page: null, targets: [], workers: [], error: error instanceof Error ? error.message : String(error) }));
      break;
    }
    console.log(JSON.stringify(sample));
    if (args.seconds > 0 && (Date.now() - started) / 1000 >= args.seconds) break;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, args.intervalMs)));
  }
}

await main();
