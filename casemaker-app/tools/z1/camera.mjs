// The machine's camera, over its own WebSocket (#286, found 2026-10-08).
//
// OBSERVED on the Z1 at 192.168.10.43 with the machine on and Studio NOT connected:
//   - an ESP32 camera module on the machine serves `ws://<host>:82/ws_video`;
//   - the client sends the text message `start_stream` once connected (what Studio sends);
//   - the module then pushes BINARY frames, each one a complete baseline JPEG, 640 x 480,
//     ~16 KB, at roughly 10 per second, until the socket closes;
//   - port 80 on the same module serves a leftover demo web page ("Tank"); port 81 is refused.
// Studio's strings also show text messages for time-lapse PLAYBACK (`total_frames`,
// `frame_period_us`, `from_frame`); those are not used here.
//
// This is a READ: it moves nothing and writes nothing on the machine. It does not go through
// `transport.node.mjs` because the camera is not on the command channel — it is its own server on
// its own port, and the Tauri webview could open the same socket directly without a raw-socket
// bridge at all (noted on #286).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CAMERA_PORT = 82;
export const CAMERA_PATH = '/ws_video';
export const CAMERA_START = 'start_stream';

/**
 * Take `count` frames from the camera, `everyMs` apart (0 = consecutive), calling `onFrame` with
 * each JPEG as a Buffer. Resolves when the count is reached; rejects on a socket error or when no
 * frame arrives within `firstFrameMs`.
 */
export function captureFrames({ host, port = CAMERA_PORT, count = 1, everyMs = 0, firstFrameMs = 8000, onFrame }) {
  return new Promise((resolve, reject) => {
    const url = `ws://${host}:${port}${CAMERA_PATH}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let taken = 0;
    let lastAt = -Infinity;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve({ url, frames: taken });
    };
    const timer = setTimeout(() => finish(new Error(`no frame from ${url} within ${firstFrameMs} ms`)), firstFrameMs);
    ws.addEventListener('open', () => ws.send(CAMERA_START));
    ws.addEventListener('error', () => finish(new Error(`WebSocket error on ${url} (is the machine on? port ${port} only answers once it has booted)`)));
    ws.addEventListener('close', (ev) => finish(done ? null : new Error(`camera socket closed before ${count} frame(s): code ${ev.code}`)));
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') return; // a text message is playback/state chatter, not a frame
      const now = Date.now();
      if (now - lastAt < everyMs) return;
      const jpeg = Buffer.from(ev.data);
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return; // not a JPEG start — skip rather than save garbage
      lastAt = now;
      taken++;
      onFrame(jpeg, taken);
      if (taken >= count) finish(null);
    });
  });
}

/** Save a frame to disk, making the directory if needed. */
export function saveFrame(path, jpeg) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jpeg);
}
