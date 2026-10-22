# 04 — On-machine camera (`ws_video`)

The Z1 carries an ESP32 camera module; Studio streams it over a WebSocket and can record
time-lapses. This is a **read** — it moves nothing.

## Classes `[DECOMPILED]` (RTTI)
`VideoStreamManager` (the socket + frame pump), `VideoProcessor` (decode/annotate, via
`opencv_world4110`), `VideoOverlayWidget` + `VideoPreviewManager` (display), `TimelapsePreviewDlg`
(time-lapse review).

## Live stream protocol `[DECOMPILED]` + `[BENCH]`
- Endpoint: **`ws://<host>:82/ws_video`** (`Qt5WebSockets`). Strings present: `ws_video`.
- On connect, Studio sends the **text** message **`start_stream`** — confirmed by the log strings:
  - `"[Video] OpenCamera clicked, checked:"`
  - `"[Video] Connected, sending start_stream. peer:"`
  - `"[Video] sendTextMessage(start_stream) returned:"`
- The module then pushes **binary** frames, each a complete baseline **JPEG ~640×480, ~16 KB, ~10
  fps** `[BENCH]` until the socket closes.
- **First frame is stale** `[BENCH]`: `start_stream` replays the last frame encoded for the
  previous client; discard ~3–4 frames before trusting one (`tools/z1/camera.mjs` uses `skip`).
- `"Camera ToHome"` `[DECOMPILED]` — a control that moves the view/head to a camera-home pose.

## Time-lapse `[DECOMPILED]`
The time-lapse is **recorded server-side on the camera module, keyed to a G-code job's file path**,
and **replayed afterward** — it is NOT a live client-side frame pull (that is `start_stream`, below,
which starves under machine load). Studio reviews it with a JSON **`vpreview`** protocol over the
same `ws://<host>:82/ws_video` socket (`FUN_140d05...` onConnected sender; `FUN_140d08...`-ish reply
parser at targets-decompiled.c:6580-6760, decoded 2026-10-21):

**Client → module (requests), all `{"ns":"vpreview", "cmd":…, "seq":…}`:**
- `open`  — adds **`path`** = the job's G-code path on the module's SD card. Opens the stored
  time-lapse for that job. (`seq` 1)
- `play`  — adds **`from_frame`** (int) and **`session_id`** (from the open reply). Streams stored
  frames from that index. (`seq` 2)
- `pause` — halts playback at the current frame.
- `resume`— re-opens after a socket drop without re-seeking (`seq` 4; sent when prior state was 3).

**Module → client (replies), matched on `rsp`, carrying `err` + `session_id`:**
- `rsp:"open"` → **`total_frames`**, **`width`**, **`height`**.
- `rsp:"meta"` → **`total_frames`**, **`frame_period_us`** (double), **`duration_ms`**,
  **`first_frame_index`**. Studio then auto-issues a `play` from `first_frame_index`
  ("Preempted resume, seek to frame:" debug line).
- `rsp:"play"` → "Play response received, resume streaming"; binary JPEG frames follow as in the live
  path.

So: to pull a smooth time-lapse of an **actual cut job**, run it from a file on the module, then
`open {path}` → read `meta` → `play {from_frame:0}` and collect the JPEGs. The UI side is
`widget_GCodesTimelapse` / `tableView_3Timelapse` — a table of jobs, each with its stored clip,
reviewed in `TimelapsePreviewDlg`. A **registration probe is not a saved job**, so it has no
module-side time-lapse; for probe-time frames use the live path with reconnect-on-drop (below).

## For Case Maker
`tools/z1/camera.mjs` already implements the live path (WebSocket :82, `start_stream`, skip stale,
JPEG frames) — this module confirms it against the vendor source. The camera can stall when the
machine is busy (observed); it is independent of the :2222 command channel.

## Decompiled confirmation (2026-10-20) `[DECOMPILED]`
- URL template built verbatim: **`ws://%1:82/ws_video`** (`%1` = machine IP) — `FUN_140a93f20`
  (the "Open Camera" handler). Port **82**, path **`/ws_video`**. Matches our `camera.mjs` exactly.
- On the WebSocket `connected` signal, `FUN_140d09370` calls
  `QWebSocket::sendTextMessage("start_stream")` — the stream is pull-started by that one text frame,
  **with no parameters** (no resolution/quality argument in the call). Debug line: `[Video]
  Connected, sending start_stream`.
- So resolution/quality are **fixed server-side** on the module, not negotiated by the client
  (consistent with the bench 640×480 JPEG observation).

## Live-stream resilience `[DECOMPILED]`
The live `start_stream` view **drops under machine load and Studio auto-reconnects** — not an error
to abort on. Debug strings: `"[Video] stream dropped unexpectedly. Reconnecting in 2 seconds... gen:"`
and `"[Video] 10s elapsed but NO frame received."`. `tools/z1/camera.mjs` instead fails hard at the
first ~8 s gap, which is why a probe-long capture dies after ~4 frames. To grab frames through a
probe, mirror Studio: on drop, reopen the socket, resend `start_stream`, skip ~3 stale frames, repeat.

## PENDING
- The **record** trigger: what tells the module to START a time-lapse for a job (cadence, and where
  the frames are stored on the module). The *replay* protocol is now decoded (above); the capture
  side is still a `VideoStreamManager` timer dispatched indirectly, not reachable from a string
  anchor. Likely auto-armed when a job file starts running.
</content>
