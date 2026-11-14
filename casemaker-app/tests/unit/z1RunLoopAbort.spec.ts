// The abort path of `z1.mjs run`: after a Ctrl-C the tool sends `abort`, and — because an aborted
// program never ran its own vacuum-off — lines the program did not ask for. The vacuum-off is the
// vacuum's DIRECT output, `M852` (proven at the nozzle 2026-11-09), NOT `M332`: bare M331/M332 are
// spindle-following auto modes and would leave the vacuum running. This pins the line the tool sends.
//
// SIGINT is delivered as a signal on Linux and macOS only; on Windows `child.kill('SIGINT')` is
// `TerminateProcess`, so the path cannot be driven there. That skip is NAMED below, not silent.
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { RUNNING, fakeController, runHarness } from './helpers/z1RunLoopHarness';

const WINDOWS = process.platform === 'win32';

describe('z1.mjs run — after an abort the vacuum goes off with M852', () => {
  it.skipIf(WINDOWS)(
    'sends abort, then M852 and M812 (never M332), once the controller says it stopped playing [skipped on win32: SIGINT is TerminateProcess there]',
    async () => {
      const controller = await fakeController([RUNNING, RUNNING, RUNNING, RUNNING, RUNNING, RUNNING]);
      try {
        let child: ChildProcess | null = null;
        // Signal the run once it is playing and has polled the job at least once.
        const timer = setInterval(() => {
          const played = controller.seen.indexOf('play /sd/gcodes/fake.nc');
          if (child !== null && played >= 0 && controller.seen.slice(played + 1).includes('?')) {
            clearInterval(timer);
            child.kill('SIGINT');
          }
        }, 50);
        timer.unref();
        const { code, stderr, trace } = await runHarness(controller.port, [], (c) => (child = c));
        clearInterval(timer);
        expect(code, `stderr:\n${stderr}`).toBe(130);
        const abortAt = controller.seen.indexOf('abort');
        expect(abortAt, `seen: ${JSON.stringify(controller.seen)}`).toBeGreaterThan(-1);
        const vacuumOff = controller.seen.slice(abortAt + 1).filter((line) => line !== '?');
        // The vacuum-off, then the air-off (harmless when the air is already off).
        expect(vacuumOff, 'after the abort the only extra lines are the vacuum-off and the air-off').toEqual(['M852', 'M812']);
        expect(controller.seen).not.toContain('M332');
        expect(trace).toContain('> M852');
        expect(trace).toContain('> M812');
        expect(trace).not.toContain('M332');
      } finally {
        await controller.close();
      }
    },
    60_000,
  );
});
