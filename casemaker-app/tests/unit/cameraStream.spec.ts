// #530 — the machine's camera stream, against a fake socket and a fake clock.
//
// The rules pinned here are the ones the bench taught (Z1-Bridge-Protocol §10, tools/z1/camera.mjs):
// the module replays its PREVIOUS client's last frame when `start_stream` arrives, so the first
// three frames of every (re)connect are discarded; a stalled module stops sending without closing
// the socket, so silence is answered by reopening rather than by waiting; and a stream nobody is
// watching is closed. Also the words the pane uses for the frame's age — the one reading a frozen
// picture cannot give.

import { describe, expect, it } from 'vitest';

import {
  cameraStale,
  cameraStreamUrl,
  directCameraUrl,
  frameAgeWords,
  frameFileName,
  proxiedCameraUrl,
  startCameraStream,
  STALE_FRAME_MS,
  type CameraState,
} from '@/platform/cameraStream';

const SITE = { host: '192.0.2.10', camera: { port: 82, path: '/ws_video' } };

/** The smallest socket the stream uses, with the browser's face on it. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  binaryType = '';
  sent: unknown[] = [];
  closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.();
  }
  frame(data: unknown = { jpeg: 1 }): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  text(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  serverClose(): void {
    this.onclose?.();
  }
}

/** A clock and a timer queue in one, so the reconnect and stall rules run without wall time. */
function fakeTime() {
  let clock = 0;
  let next = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  return {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, at: clock + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (t: ReturnType<typeof setTimeout>) => {
      pending.delete(t as unknown as number);
    },
    advance(ms: number): void {
      const target = clock + ms;
      for (;;) {
        let due: [number, { fn: () => void; at: number }] | null = null;
        for (const entry of pending) {
          if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
        }
        if (due === null) break;
        pending.delete(due[0]);
        clock = due[1].at;
        due[1].fn();
      }
      clock = target;
    },
  };
}

function stream(over: { skip?: number; reconnectMs?: number; stallMs?: number } = {}) {
  FakeSocket.all = [];
  const time = fakeTime();
  const frames: number[] = [];
  const states: CameraState[] = [];
  let at = 0;
  const handle = startCameraStream({
    url: directCameraUrl(SITE),
    skip: over.skip,
    reconnectMs: over.reconnectMs,
    stallMs: over.stallMs,
    now: () => {
      at += 1;
      return at;
    },
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    onFrame: () => frames.push(frames.length + 1),
    onState: (s) => states.push(s),
  });
  return { handle, time, frames, states };
}

describe('#530 the camera stream', () => {
  it('asks for the stream on open, and shows the fourth frame — the first three are the replay', () => {
    const s = stream();
    const ws = FakeSocket.all[0]!;
    expect(ws.url).toBe('ws://192.0.2.10:82/ws_video');
    ws.open();
    expect(ws.sent).toEqual(['start_stream']);
    for (let i = 0; i < 4; i += 1) ws.frame();
    expect(s.frames).toHaveLength(1);
    expect(s.states).toContain('live');
  });

  it('throws the replay away again after every reconnect', () => {
    const s = stream();
    const first = FakeSocket.all[0]!;
    first.open();
    for (let i = 0; i < 4; i += 1) first.frame();
    expect(s.frames).toHaveLength(1);

    first.serverClose();
    s.time.advance(2000);
    const second = FakeSocket.all[1]!;
    second.open();
    expect(second.sent).toEqual(['start_stream']);
    // Two frames are not enough: they are the previous client's last picture and a repeat of it.
    second.frame();
    second.frame();
    expect(s.frames).toHaveLength(1);
    second.frame();
    second.frame();
    expect(s.frames).toHaveLength(2);
  });

  it('reopens after a stall: silence closes the socket rather than waiting on it', () => {
    const s = stream();
    const ws = FakeSocket.all[0]!;
    ws.open();
    for (let i = 0; i < 4; i += 1) ws.frame();
    expect(s.frames).toHaveLength(1);

    // Four seconds with no frame: the module has stalled under load, the socket still says open.
    s.time.advance(4000);
    expect(ws.closed).toBe(true);
    s.time.advance(2000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(s.states).toContain('reconnecting');
  });

  it('a frame resets the silence, so a slow stream is not reopened under it', () => {
    const s = stream();
    const ws = FakeSocket.all[0]!;
    ws.open();
    s.time.advance(3000);
    ws.frame();
    s.time.advance(3000);
    expect(ws.closed).toBe(false);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('ignores text: the module pushes binary JPEGs and nothing else on this socket', () => {
    const s = stream({ skip: 0 });
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.text('<Idle|MPos:0,0,0>');
    expect(s.frames).toHaveLength(0);
    ws.frame();
    expect(s.frames).toHaveLength(1);
  });

  it('stop closes the socket and does not reconnect', () => {
    const s = stream();
    const ws = FakeSocket.all[0]!;
    ws.open();
    s.handle.stop();
    expect(ws.closed).toBe(true);
    s.time.advance(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('#530 the frame’s age', () => {
  it('reads as the operator’s answer to “is this live?”', () => {
    expect(frameAgeWords(null, 1000)).toBe('no frame yet');
    expect(frameAgeWords(1000, 1000)).toBe('last frame just now');
    expect(frameAgeWords(1000, 1999)).toBe('last frame just now');
    // Under a second is "just now"; one whole second is said as one.
    expect(frameAgeWords(1000, 2000)).toBe('last frame 1 s ago');
    expect(frameAgeWords(1000, 2999)).toBe('last frame 1 s ago');
    expect(frameAgeWords(1000, 12_400)).toBe('last frame 11 s ago');
  });

  it('calls a frame stale only once the stream has had longer than it ever takes', () => {
    expect(cameraStale(null, 10_000)).toBe(false);
    expect(cameraStale(1000, 1000 + STALE_FRAME_MS)).toBe(false);
    expect(cameraStale(1000, 1000 + STALE_FRAME_MS + 1)).toBe(true);
  });
});

describe('#530 where the stream comes from', () => {
  it('goes to the machine directly inside the desktop shell', () => {
    expect(directCameraUrl(SITE)).toBe('ws://192.0.2.10:82/ws_video');
    expect(cameraStreamUrl({ site: SITE, tauri: true })).toBe('ws://192.0.2.10:82/ws_video');
  });

  it('goes through the embedded server from a LAN browser, on the page’s own origin', () => {
    expect(cameraStreamUrl({ site: SITE, tauri: false, pageOrigin: 'http://192.168.10.38:8000' })).toBe(
      'ws://192.168.10.38:8000/api/v1/machine/camera?host=192.0.2.10&port=82',
    );
    // An https page keeps the same origin with wss; the camera path stays the server’s fact.
    expect(proxiedCameraUrl('https://example.test', SITE)).toBe(
      'wss://example.test/api/v1/machine/camera?host=192.0.2.10&port=82',
    );
  });

  it('has nothing to open without a machine or without a camera', () => {
    expect(cameraStreamUrl({ site: null, tauri: true })).toBeNull();
  });
});

describe('#530 the saved frame’s name', () => {
  it('names the machine and the moment, filename-safe', () => {
    const at = new Date(2026, 9, 25, 10, 15, 9).getTime();
    expect(frameFileName('192.168.10.43', at)).toBe('camera-192.168.10.43-20261025-101509.jpg');
    expect(frameFileName('bench:pc/one', at)).toBe('camera-bench-pc-one-20261025-101509.jpg');
  });
});
