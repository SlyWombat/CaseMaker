// #286 — the capture protocol against a recorded/fake source. No camera, no socket, no browser:
// the source is an interface, and the thing under test is the ORDER (start → drop the stale replay
// → keep N → close) and the words a short capture stops with.

import { describe, expect, it } from 'vitest';
import {
  CameraCaptureError,
  captureFrames,
  type CameraFrame,
  type CameraFrameSource,
} from '@/engine/cnc/camera/capture';

const jpeg = (n: number): Uint8Array => new Uint8Array([n, n + 1, n + 2]);

/** A source that yields a scripted list; `null` is "no frame within the timeout". */
function scripted(frames: ReadonlyArray<Uint8Array | null>, opts: {
  startThrows?: boolean;
  closeThrows?: boolean;
} = {}): CameraFrameSource & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    async start() {
      calls.push('start');
      if (opts.startThrows === true) throw new Error('the socket refused');
    },
    async next(): Promise<CameraFrame | null> {
      calls.push('next');
      const frame = frames[index];
      index++;
      if (frame === null || frame === undefined) return null;
      return { index: index - 1, jpeg: frame, at: index - 1 };
    },
    async close() {
      calls.push('close');
      if (opts.closeThrows === true) throw new Error('the socket was already gone');
    },
  };
}

describe('#286 camera capture — the protocol', () => {
  it('discards the stale replay first: the first frame back is NOT the first frame kept', async () => {
    const source = scripted([jpeg(0), jpeg(1), jpeg(2), jpeg(3), jpeg(4)]);
    const frames = await captureFrames(source, { count: 3 });
    expect(frames.map((f) => f.index)).toEqual([1, 2, 3]);
    expect(frames.map((f) => f.jpeg[0])).toEqual([1, 2, 3]);
    expect(source.calls[0]).toBe('start');
    expect(source.calls[source.calls.length - 1]).toBe('close');
  });

  it('skip: 0 keeps the first frame — a caller that already drained the stream says so', async () => {
    const source = scripted([jpeg(0), jpeg(1)]);
    const frames = await captureFrames(source, { count: 2, skip: 0 });
    expect(frames.map((f) => f.index)).toEqual([0, 1]);
  });

  it('waits everyMs between KEPT frames only, not after the last', async () => {
    const source = scripted([jpeg(0), jpeg(1), jpeg(2), jpeg(3)]);
    const sleeps: number[] = [];
    await captureFrames(source, {
      count: 3,
      everyMs: 250,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([250, 250]);
  });

  it('a stream that goes quiet names how many frames it managed', async () => {
    // One frame is dropped as stale, two are kept, then the stream goes quiet.
    const source = scripted([jpeg(0), jpeg(1), jpeg(2), null]);
    const failure = await captureFrames(source, { count: 3, timeoutMs: 25 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CameraCaptureError);
    expect((failure as CameraCaptureError).code).toBe('timeout');
    expect((failure as CameraCaptureError).message).toContain('2 of 3');
    expect(source.calls).toContain('close');
  });

  it('a stream that goes quiet while dropping the stale frame says that phase', async () => {
    const source = scripted([null]);
    const failure = await captureFrames(source, { count: 1, timeoutMs: 25 }).catch((e: unknown) => e);
    expect((failure as CameraCaptureError).code).toBe('timeout');
    expect((failure as CameraCaptureError).message).toMatch(/discarding the 1 stale frame/);
  });

  it('an abort between frames stops the capture and still closes the source', async () => {
    const controller = new AbortController();
    const source = scripted([jpeg(0), jpeg(1), jpeg(2)]);
    const failure = await captureFrames(source, {
      count: 3,
      everyMs: 1,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    }).catch((e: unknown) => e);
    expect((failure as CameraCaptureError).code).toBe('cancelled');
    expect((failure as CameraCaptureError).message).toContain('1 of 3');
    expect(source.calls).toContain('close');
  });

  it('a bad count is refused BEFORE the source is touched', async () => {
    const source = scripted([jpeg(0)]);
    for (const count of [0, -1, 1.5]) {
      const failure = await captureFrames(source, { count }).catch((e: unknown) => e);
      expect((failure as CameraCaptureError).code).toBe('bad-options');
    }
    expect(source.calls).toEqual([]);
  });

  it('a failed start still attempts a close, and does not mask the start’s error', async () => {
    const source = scripted([jpeg(0)], { startThrows: true });
    await expect(captureFrames(source, { count: 1 })).rejects.toThrow(/socket refused/);
    expect(source.calls).toContain('close');
  });

  it('a close that fails does not turn a good capture into a failure', async () => {
    const source = scripted([jpeg(0), jpeg(1)], { closeThrows: true });
    const frames = await captureFrames(source, { count: 1 });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.jpeg[0]).toBe(1);
  });
});
