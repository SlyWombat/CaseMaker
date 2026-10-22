// The machine's camera, over its own WebSocket (#286, found 2026-10-08).
//
// OBSERVED on the Z1 at 192.168.10.43 with the machine on and Studio NOT connected:
//   - an ESP32 camera module on the machine serves `ws://<host>:82/ws_video`;
//   - the client sends the text message `start_stream` once connected (what Studio sends);
//   - the module then pushes BINARY frames, each one a complete baseline JPEG, 640 x 480,
//     ~16 KB, at roughly 10 per second, until the socket closes;
//   - port 80 on the same module serves a leftover demo web page ("Tank"); port 81 is refused.
//   - THE FIRST FRAME IS STALE: on `start_stream` the module replays the last frame it encoded for the
//     previous client (seen 2026-10-08 — a burst's first frame was byte-identical to a capture taken
//     before a 25 mm bed move; the third showed the move; a later capture with ONE frame skipped was
//     still stale, a six-frame burst was live from its second). `captureFrames` therefore discards
//     `skip` frames (default 3) before counting: a single-frame capture is the FOURTH off the wire.
// Two capture modes, matching what Studio actually does (docs/reverse/makera-studio/04-camera.md):
//   - LIVE: the `start_stream` push above. It STALLS when the machine is busy (a probe starves it
//     after ~4 frames). Studio survives this by RECONNECTING ("stream dropped unexpectedly.
//     Reconnecting in 2 seconds") — `captureFrames({ reconnect: true })` does the same, so a capture
//     spanning a probe keeps producing frames instead of dying at the first gap.
//   - TIME-LAPSE: the module RECORDS a job's frames itself (keyed to the G-code file's path on its
//     SD card) and replays them on demand. `replayTimelapse` speaks that JSON `vpreview` protocol:
//     `{ns:"vpreview",cmd:"open",seq,path}` -> reply `rsp:"open"` (total_frames,width,height) and
//     `rsp:"meta"` (frame_period_us,duration_ms,first_frame_index) -> `{cmd:"play",from_frame,
//     session_id}` streams the stored JPEGs. Protocol decoded from the vendor binary
//     (targets-decompiled.c:6470-6760), so the field shapes are [DECODED], not yet [BENCH]-proven.
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
 * LIVE capture. Take `count` frames from the camera, `everyMs` apart (0 = consecutive), calling
 * `onFrame` with each JPEG as a Buffer.
 *
 * Default (one-shot): resolves at `count`; rejects on a socket error or if no frame arrives within
 * `firstFrameMs` — a stall is a failure, as before.
 *
 * With `reconnect: true`: a stall (no frame within `idleMs`) or a dropped socket is NOT fatal — it
 * reopens after `reconnectPauseMs` and keeps going, the way Studio does, until `count` is reached or
 * the overall `maxMs` deadline passes. Reaching `maxMs` resolves with whatever was collected (it is a
 * time-boxed capture, not a failure). `onEvent(msg)` reports reconnects. Resolves with
 * `{ url, frames, reconnects }`.
 */
export function captureFrames({
  host, port = CAMERA_PORT, count = 1, everyMs = 0, skip = 3, firstFrameMs = 8000, onFrame,
  reconnect = false, idleMs = firstFrameMs, maxMs = Infinity, reconnectPauseMs = 2000, onEvent = () => {},
}) {
  return new Promise((resolve, reject) => {
    const url = `ws://${host}:${port}${CAMERA_PATH}`;
    let taken = 0;
    let lastAt = -Infinity;
    let reconnects = 0;
    let done = false;
    let gen = 0; // bumped to invalidate a superseded connection's late events/timers
    let deadline = null;
    let currentWs = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      if (deadline) clearTimeout(deadline);
      try { currentWs?.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve({ url, frames: taken, reconnects });
    };
    if (maxMs !== Infinity) {
      // In reconnect mode the deadline is a normal, successful end; one-shot keeps the old rejection.
      deadline = setTimeout(() => finish(reconnect || taken > 0 ? null : new Error(`no frames from ${url} within ${maxMs} ms`)), maxMs);
    }
    const connect = () => {
      if (done) return;
      const myGen = ++gen;
      let seen = 0;
      const ws = new WebSocket(url);
      currentWs = ws;
      ws.binaryType = 'arraybuffer';
      let idle = null;
      const armIdle = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => retry(`no frame within ${idleMs} ms`), idleMs);
      };
      const retry = (why) => {
        if (done || myGen !== gen) return; // already finished or superseded by a newer connection
        gen++; // invalidate any further events from THIS socket
        if (idle) clearTimeout(idle);
        try { ws.close(); } catch { /* already closed */ }
        if (!reconnect) { finish(new Error(`${why} on ${url}`)); return; }
        reconnects++;
        onEvent(`${why} — reconnecting in ${reconnectPauseMs} ms (#${reconnects})`);
        setTimeout(connect, reconnectPauseMs);
      };
      armIdle();
      ws.addEventListener('open', () => { try { ws.send(CAMERA_START); } catch { /* close will follow */ } });
      ws.addEventListener('error', () => retry('WebSocket error'));
      ws.addEventListener('close', (ev) => retry(`socket closed (code ${ev.code})`));
      ws.addEventListener('message', (ev) => {
        if (done || myGen !== gen) return;
        if (typeof ev.data === 'string') return; // playback/state chatter, not a frame
        if (seen++ < skip) return; // the replayed last frame of the previous client — not the present
        armIdle(); // a frame arrived: reset the stall watchdog
        const now = Date.now();
        if (now - lastAt < everyMs) return;
        const jpeg = Buffer.from(ev.data);
        if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return; // not a JPEG start — skip rather than save garbage
        lastAt = now;
        taken++;
        onFrame(jpeg, taken);
        if (taken >= count) finish(null);
      });
    };
    connect();
  });
}

/**
 * TIME-LAPSE replay. Pull the frames the module RECORDED for one job (by its G-code `path` on the
 * module's SD card) over the `vpreview` JSON protocol, calling `onFrame(jpeg, n, meta)` with each
 * stored JPEG. Resolves with `{ url, frames, total, frame_period_us, ... }` once `total_frames` are
 * received or `maxMs` passes. Protocol is [DECODED] from the vendor binary — verify at the bench.
 */
export function replayTimelapse({ host, port = CAMERA_PORT, path, onFrame, fromFrame = null, maxMs = 120000, onEvent = () => {} }) {
  return new Promise((resolve, reject) => {
    const url = `ws://${host}:${port}${CAMERA_PATH}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    let done = false;
    let taken = 0;
    let total = null;
    let period = null;
    let sessionId = null;
    const meta = {};
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve({ url, frames: taken, total, frame_period_us: period, ...meta });
    };
    const timer = setTimeout(() => finish(taken > 0 ? null : new Error(`timelapse: no frames within ${maxMs} ms for ${path}`)), maxMs);
    const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* close will follow */ } };
    ws.addEventListener('open', () => { onEvent(`open -> vpreview open ${path}`); send({ ns: 'vpreview', cmd: 'open', seq: 1, path }); });
    ws.addEventListener('error', () => finish(new Error(`WebSocket error on ${url} (is the machine on?)`)));
    ws.addEventListener('close', (ev) => finish(done ? null : (taken > 0 ? null : new Error(`timelapse socket closed (code ${ev.code}) before any frame`))));
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (typeof msg.err === 'number' && msg.err !== 0) { finish(new Error(`timelapse err ${msg.err} (rsp:${msg.rsp ?? '?'}) for ${path}`)); return; }
        if (msg.session_id) sessionId = msg.session_id;
        if (msg.rsp === 'open') {
          total = msg.total_frames ?? total;
          meta.width = msg.width; meta.height = msg.height;
          onEvent(`open: total_frames=${total} ${msg.width}x${msg.height}`);
        } else if (msg.rsp === 'meta') {
          total = msg.total_frames ?? total;
          period = msg.frame_period_us ?? period;
          meta.duration_ms = msg.duration_ms;
          meta.first_frame_index = msg.first_frame_index;
          onEvent(`meta: total=${total} frame_period_us=${period} duration_ms=${msg.duration_ms}`);
          send({ ns: 'vpreview', cmd: 'play', seq: 2, from_frame: fromFrame ?? msg.first_frame_index ?? 0, session_id: sessionId });
        } else if (msg.rsp === 'play') {
          onEvent('play ack — frames follow');
        }
        return;
      }
      const jpeg = Buffer.from(ev.data);
      if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return;
      taken++;
      onFrame(jpeg, taken, { total, frame_period_us: period });
      if (total != null && taken >= total) finish(null);
    });
  });
}

/** Save a frame to disk, making the directory if needed. */
export function saveFrame(path, jpeg) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jpeg);
}
