/**
 * #530 — THE MACHINE'S OWN CAMERA, as a browser stream.
 *
 * WHAT THE MODULE DOES, observed at the bench (`tools/z1/camera.mjs`, 2026-10-08): the ESP32 on the
 * Z1 serves `ws://<host>:82/ws_video`; the client sends the text `start_stream` once connected and
 * the module pushes complete baseline JPEGs (640 × 480, ~16 KB, ~10/s). Two facts shape this port:
 *
 *  - THE FIRST FRAMES ARE STALE. After `start_stream` the module replays the last frame it encoded
 *    for a PREVIOUS client, so the first `skip` frames (3, the harness's own) are discarded on
 *    every (re)connect before any is shown.
 *  - IT STALLS UNDER LOAD. A probe starves it to a few frames and then it simply stops sending —
 *    the socket stays open. So the socket is not the signal: a frame arrives or it does not, and
 *    silence for {@link STALL_MS} is answered by closing and reopening, which is what the harness's
 *    2 s reconnect does. `frameAgeWords` is what tells the operator how old the picture is while
 *    that happens.
 *
 * It is a READ: it moves nothing and writes nothing on the machine. The socket is opened only while
 * the panel is showing and not paused, and closed on pause and on unmount — a socket left open
 * costs the module a client and, under load, the stream everyone else is watching.
 */

/** One frame as it arrives: the JPEG and when it was received (ms, the caller's clock). */
export interface CameraFrame {
  jpeg: Blob;
  at: number;
}

export type CameraState = 'connecting' | 'live' | 'reconnecting' | 'stopped';

export interface CameraStreamOptions {
  /** `cameraStreamUrl` builds it from the machine's profile — see {@link CameraSite}. */
  url: string;
  onFrame: (frame: CameraFrame) => void;
  onState?: (state: CameraState, detail?: string) => void;
  /** Frames discarded after EVERY (re)connect — the module replays its previous client's last. */
  skip?: number;
  /** How long to wait before reopening after a close, an error or a stall. */
  reconnectMs?: number;
  /** Silence after which the stream is treated as stalled and reopened. */
  stallMs?: number;
  now?: () => number;
  /** The clock, the socket and the timers are seams, so the reconnect and skip rules have a spec. */
  WebSocketImpl?: typeof WebSocket;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export interface CameraStreamHandle {
  /** Close the socket and stop reconnecting. */
  stop: () => void;
}

/** The machine and the camera its profile names — the two facts a stream URL is built from. */
export interface CameraSite {
  host: string;
  camera: { port: number; path: string };
}

/**
 * The stream's URL for a machine whose camera is opened DIRECTLY — the desktop shell's webview,
 * which can reach the machine's own LAN address.
 */
export function directCameraUrl(site: CameraSite): string {
  return `ws://${site.host}:${site.camera.port}${site.camera.path}`;
}

/**
 * The stream's URL through the embedded server — the LAN browser's path, since a page served by
 * `casemaker --bind-all` cannot open a raw socket and the server (on the LAN with the machine) can.
 * Same origin as the page, so the same provenance rules as `/api/v1/machine/*` apply to it; the
 * server's route forwards `/ws_video` and takes no path from the page.
 */
export function proxiedCameraUrl(pageOrigin: string, site: CameraSite): string {
  const origin = new URL(pageOrigin);
  const scheme = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams({ host: site.host, port: String(site.camera.port) });
  return `${scheme}//${origin.host}/api/v1/machine/camera?${query.toString()}`;
}

/**
 * The URL the panel opens, or null when there is nothing to open:
 *
 *  - no machine, or a profile with no camera → null (the entry points do not render at all);
 *  - the desktop shell (`isTauri`) → the machine directly;
 *  - the same bundle served to a LAN browser by the embedded server → the server's proxy.
 *
 * The runtime probe is the one `machineBridge.defaultTransport` uses (#571), and for the same
 * reason: the desktop BUILD runs in two places, and only the webview has the Tauri runtime.
 */
export function cameraStreamUrl(opts: {
  site: CameraSite | null;
  tauri?: boolean;
  pageOrigin?: string;
}): string | null {
  if (opts.site === null) return null;
  const tauri = opts.tauri ?? (globalThis as { isTauri?: unknown }).isTauri === true;
  if (tauri) return directCameraUrl(opts.site);
  const pageOrigin = opts.pageOrigin ?? (typeof location === 'undefined' ? null : location.origin);
  return pageOrigin === null ? null : proxiedCameraUrl(pageOrigin, opts.site);
}

/**
 * "last frame N s ago", in the operator's words — the answer to "is this live?" that a frozen image
 * cannot give. Under a second reads "just now"; no frame at all says so.
 */
export function frameAgeWords(lastFrameAt: number | null, now: number): string {
  if (lastFrameAt === null) return 'no frame yet';
  const seconds = Math.max(0, Math.floor((now - lastFrameAt) / 1000));
  return seconds < 1 ? 'last frame just now' : `last frame ${seconds} s ago`;
}

/**
 * Is the picture older than the stream can explain? The module pushes ~10 frames a second, so a
 * frame older than {@link STALE_FRAME_MS} means the stream has stalled (under a probe, typically)
 * or the socket has gone — and the panel says so beside the age.
 */
export const STALE_FRAME_MS = 3000;

export function cameraStale(lastFrameAt: number | null, now: number): boolean {
  return lastFrameAt !== null && now - lastFrameAt > STALE_FRAME_MS;
}

/** The silence that closes and reopens the socket — longer than a slow frame, shorter than patience. */
export const STALL_MS = 4000;

/**
 * The name a saved frame gets: the machine it came from and the moment it was taken, so a folder of
 * them reads as a timeline. Anything in the host that is not filename-safe becomes a dash.
 */
export function frameFileName(host: string, at: number): string {
  const safeHost = host.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'machine';
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `camera-${safeHost}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
}

/** The word the module expects once connected (Studio sends the same). */
const START_WORD = 'start_stream';

export function startCameraStream(opts: CameraStreamOptions): CameraStreamHandle {
  const skip = opts.skip ?? 3;
  const reconnectMs = opts.reconnectMs ?? 2000;
  const stallMs = opts.stallMs ?? STALL_MS;
  const now = opts.now ?? (() => Date.now());
  const Impl = opts.WebSocketImpl ?? (typeof WebSocket === 'undefined' ? null : WebSocket);
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));

  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let running = true;

  const state = (s: CameraState, detail?: string): void => opts.onState?.(s, detail);

  const clearTimerOf = (t: ReturnType<typeof setTimeout> | null): null => {
    if (t !== null) clearTimer(t);
    return null;
  };
  const disarmStall = (): void => {
    stallTimer = clearTimerOf(stallTimer);
  };

  const closeSocket = (): void => {
    disarmStall();
    const ws = socket;
    socket = null;
    if (ws === null) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // already closed
    }
  };

  const scheduleReconnect = (why: string): void => {
    if (!running) return;
    state('reconnecting', why);
    reconnectTimer = clearTimerOf(reconnectTimer);
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, reconnectMs);
  };

  /** A silent stream is a stalled one: close it and let the reconnect timer open a fresh socket. */
  const armStall = (): void => {
    disarmStall();
    if (!running) return;
    stallTimer = setTimer(() => {
      stallTimer = null;
      if (!running) return;
      closeSocket();
      scheduleReconnect('the stream stalled');
    }, stallMs);
  };

  function connect(): void {
    if (!running) return;
    if (Impl === null) {
      state('stopped', 'this build has no WebSocket');
      return;
    }
    reconnectTimer = clearTimerOf(reconnectTimer);
    state('connecting');
    let seen = 0;
    let ws: WebSocket;
    try {
      ws = new Impl(opts.url);
    } catch (e) {
      scheduleReconnect(e instanceof Error ? e.message : String(e));
      return;
    }
    socket = ws;
    ws.binaryType = 'blob';
    ws.onopen = () => {
      if (socket !== ws) return;
      try {
        ws.send(START_WORD);
      } catch {
        // the close handler below reconnects
      }
      armStall();
    };
    ws.onmessage = (event: MessageEvent) => {
      if (socket !== ws) return;
      // The module pushes BINARY JPEGs and nothing else on this socket; a text frame is not a picture.
      if (typeof event.data === 'string') return;
      armStall();
      seen += 1;
      if (seen <= skip) return;
      if (seen === skip + 1) state('live');
      opts.onFrame({ jpeg: event.data as Blob, at: now() });
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      disarmStall();
      scheduleReconnect('the stream closed');
    };
    ws.onerror = () => {
      if (socket !== ws) return;
      closeSocket();
      scheduleReconnect('the stream errored');
    };
  }

  connect();

  return {
    stop: () => {
      running = false;
      reconnectTimer = clearTimerOf(reconnectTimer);
      closeSocket();
      state('stopped');
    },
  };
}
