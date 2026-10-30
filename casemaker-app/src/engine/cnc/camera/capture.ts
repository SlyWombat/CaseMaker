/**
 * The camera capture protocol (#286) — the ORDER a stream is driven in, against a source that can
 * be a recorded capture, a fake, or the machine's own module.
 *
 * ## What the module does, and the one trap it has
 *
 * The Z1's camera is an ESP32 with its own web server: `ws://<host>:82/ws_video` is a plain
 * WebSocket, the client sends the text `start_stream`, and complete 640 × 480 baseline JPEG frames
 * follow at about 10/s until the socket closes (`Z1-Bridge-Protocol.md` §10).
 *
 * THE FIRST FRAME AFTER `start_stream` IS NOT FROM THIS SESSION. The module replays the last frame
 * it encoded for the previous client, so a naive "read N frames" returns the position the camera
 * saw BEFORE the machine moved — the defect that made #286's A6 reading meaningless (a burst at
 * one position had a first frame byte-identical to a capture 25 mm away; see the issue's
 * withdrawal). `captureFrames` discards `skip` frames (default 1) before it keeps any, and this
 * module is the one place that rule lives: a second capture loop elsewhere would not have it.
 *
 * ## Platform-agnostic on purpose
 *
 * This file imports nothing. A `CameraFrameSource` is an interface — the desktop WebSocket source,
 * the bench Node harness's source, and a test's recorded list all satisfy it — so the protocol can
 * be unit-tested with no camera, no socket and no browser, which is exactly the half of #286 that
 * does not need the machine. The WebSocket implementation is a later, bench-checked piece
 * (#767); this module owns the order, the stale-frame skip, the timeout wording and the close.
 *
 * ## What it does not do
 *
 * No detection, no stitching, no pixels parsed: a frame is bytes and an arrival index. The maths
 * that turns feature positions into a calibration is `calibrate.ts`, and it never sees this file.
 */

/** One complete frame the source handed over. */
export interface CameraFrame {
  /**
   * Arrival order from THIS source, 0-based. The first frame after `start_stream` is index 0 and
   * is normally the stale replay — `captureFrames` skips it and never returns it.
   */
  index: number;
  /** One complete JPEG, exactly as the module sent it. */
  jpeg: Uint8Array;
  /**
   * Epoch milliseconds when the SOURCE yielded it. It is the source's own clock, and the only
   * claim made of it is ordering — it says nothing about the camera's or the machine's time.
   */
  at: number;
}

/**
 * Where frames come from. Implemented by the desktop WebSocket source and by every test fake.
 *
 * `start` opens the socket and sends `start_stream`; `next` resolves null when its timeout elapses
 * with no frame (NOT an error — a slow stream is a normal answer, and `captureFrames` decides what
 * too many of them mean); `close` is idempotent and must be safe after a failed `start`.
 */
export interface CameraFrameSource {
  start(): Promise<void>;
  next(timeoutMs: number): Promise<CameraFrame | null>;
  close(): Promise<void>;
}

/** Why a capture stopped short. */
export type CameraCaptureFailure = 'timeout' | 'cancelled' | 'bad-options';

/** A refused or failed capture, with the part that matters named. */
export class CameraCaptureError extends Error {
  readonly code: CameraCaptureFailure;
  constructor(code: CameraCaptureFailure, message: string) {
    super(message);
    this.name = 'CameraCaptureError';
    this.code = code;
  }
}

export interface CaptureOptions {
  /** Frames to RETURN, after the stale ones are discarded. Must be a positive integer. */
  count: number;
  /**
   * Frames discarded before the first kept one. Default 1 — the stale replay §10 documents. A
   * caller that has already drained the stream may pass 0; the default is the safe reading.
   */
  skip?: number;
  /** Minimum wall time between two KEPT frames, ms. Default 0 (back-to-back). */
  everyMs?: number;
  /** How long to wait for one frame, ms. Default 5000. */
  timeoutMs?: number;
  /** Stop between frames when aborted; the promise rejects with code `cancelled`. */
  signal?: AbortSignal;
  /** Sleep seam, for a test that must not wait. Default `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive a source through one capture: start the stream, discard `skip` stale frames, then collect
 * `count` frames, waiting `everyMs` between them. The source is ALWAYS closed — after success, a
 * refusal, or a source that threw — and a close that itself fails does not hide the reason the
 * capture stopped.
 *
 * Refuses bad options before touching the source: a capture that would ask for zero frames or a
 * negative skip is a caller's mistake, and opening a socket to discover it wastes the stream.
 */
export async function captureFrames(source: CameraFrameSource, opts: CaptureOptions): Promise<CameraFrame[]> {
  const skip = opts.skip ?? 1;
  const everyMs = opts.everyMs ?? 0;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(opts.count) || opts.count <= 0) {
    throw new CameraCaptureError('bad-options', `count must be a positive integer, got ${opts.count}`);
  }
  if (!Number.isInteger(skip) || skip < 0) {
    throw new CameraCaptureError('bad-options', `skip must be a non-negative integer, got ${skip}`);
  }
  if (!(Number.isFinite(everyMs) && everyMs >= 0)) {
    throw new CameraCaptureError('bad-options', `everyMs must be a non-negative number, got ${everyMs}`);
  }
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new CameraCaptureError('bad-options', `timeoutMs must be positive, got ${timeoutMs}`);
  }
  const sleep = opts.sleep ?? defaultSleep;
  const signal = opts.signal;

  const checkCancelled = (kept: number): void => {
    if (signal?.aborted === true) {
      throw new CameraCaptureError('cancelled', `the capture was cancelled after ${kept} of ${opts.count} frame(s)`);
    }
  };

  try {
    await source.start();
    // The stale replay, and any other frame the caller asked to drop. A stream that goes quiet
    // while discarding is a timeout, and the sentence says which phase it stopped in.
    for (let dropped = 0; dropped < skip; dropped++) {
      checkCancelled(0);
      const stale = await source.next(timeoutMs);
      if (stale === null) {
        throw new CameraCaptureError(
          'timeout',
          `the camera sent no frame within ${timeoutMs} ms while discarding the ${skip} stale frame(s)`,
        );
      }
    }
    const kept: CameraFrame[] = [];
    while (kept.length < opts.count) {
      checkCancelled(kept.length);
      const frame = await source.next(timeoutMs);
      if (frame === null) {
        throw new CameraCaptureError(
          'timeout',
          `the camera sent no frame within ${timeoutMs} ms (${kept.length} of ${opts.count} frame(s) captured)`,
        );
      }
      kept.push(frame);
      if (kept.length < opts.count && everyMs > 0) {
        await sleep(everyMs);
      }
    }
    return kept;
  } finally {
    // The capture owns the stream it started. Close failures are swallowed: they cannot change the
    // frames already taken, and they must not mask a timeout or a cancellation above.
    try {
      await source.close();
    } catch {
      // best effort — see the file's contract in `CameraFrameSource.close`.
    }
  }
}
