/**
 * #816 — A FAKE MACHINE CONSOLE FOR THE BROWSER.
 *
 * The app's console reaches the machine through the LAN bridge's HTTP machine API when no Tauri
 * runtime is present (`platform/desktop/httpTransport.ts`): connect / write / read / close on
 * `/api/v1/machine/tcp/*`, carrying the controller's FRAME protocol (`protocol.ts`: header 0x8668,
 * length, type, data, CRC-16/CCITT, footer 0x55aa; replies are types ≥ 0x80).
 *
 * This fixture serves that API in the page and plays a small program: `?` polls answer with a
 * status line whose `P:line,percent,elapsed` advances, `play` starts the program, `suspend` and
 * `resume` hold and release it, `abort` stops it, and everything else gets `ok`. The run panel
 * therefore reaches its running, paused and finished states with NO hardware — which is what makes
 * the #801 controls and the #806 Done card e2e-screenshot-able.
 *
 * Testing surface only: nothing here ships.
 */
import type { Page } from '@playwright/test';

const FRAME_HEADER = 0x8668;
const FRAME_FOOTER = 0x55aa;
/** A reply frame: a type ≥ 0x80 is text the console reads (the controller's own answer types). */
const PTYPE_REPLY = 0x83;
const PTYPE_CTRL_SINGLE = 0xa1;

const UTF8 = new TextDecoder();
const ENCODE = new TextEncoder();

function crc16(data: readonly number[]): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= (byte & 0xff) << 8;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

/** One frame, as `protocol.ts`'s `encodeFrame` writes it. */
function frame(type: number, text: string): number[] {
  const data = [...ENCODE.encode(text)];
  const length = 1 + data.length + 2;
  const crc = crc16([(length >>> 8) & 0xff, length & 0xff, type & 0xff, ...data]);
  return [
    (FRAME_HEADER >>> 8) & 0xff,
    FRAME_HEADER & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    type & 0xff,
    ...data,
    (crc >>> 8) & 0xff,
    crc & 0xff,
    (FRAME_FOOTER >>> 8) & 0xff,
    FRAME_FOOTER & 0xff,
  ];
}

/** Complete frames in one write; a partial tail is kept for the connection's next write. */
function framesIn(buffer: number[]): { type: number; text: string }[] {
  const out: { type: number; text: string }[] = [];
  let at = 0;
  while (buffer.length - at >= 6) {
    if (((buffer[at]! << 8) | buffer[at + 1]!) !== FRAME_HEADER) {
      at += 1;
      continue;
    }
    const length = (buffer[at + 2]! << 8) | buffer[at + 3]!;
    const total = 2 + length + 2;
    if (buffer.length - at < total) break;
    const type = buffer[at + 4]!;
    const data = buffer.slice(at + 5, at + 5 + length - 3);
    out.push({ type, text: UTF8.decode(Uint8Array.from(data)) });
    at += total;
  }
  buffer.splice(0, at);
  return out;
}

export interface FakeConsoleOptions {
  /** Status polls from `play` to 100 %. Smaller finishes faster. Default 12. */
  steps?: number;
}

export interface FakeConsole {
  /** Every line the app wrote, in order (`?` for a status poll). */
  lines(): string[];
}

/**
 * Serve `/api/v1/machine/tcp/*` with a scripted controller and hold the session in `conns`.
 * Call it before `cm.ready()`; the route stays for the page's lifetime.
 */
export async function installFakeConsole(page: Page, opts: FakeConsoleOptions = {}): Promise<FakeConsole> {
  const steps = opts.steps ?? 12;
  const seen: string[] = [];
  const conns = new Map<number, { out: number[]; in: number[] }>();
  let nextConn = 1;
  let phase: 'idle' | 'running' | 'paused' | 'stopped' | 'done' = 'idle';
  let percent = 0;
  let line = 0;
  let elapsed = 0;

  const statusLine = (): string => {
    if (phase === 'running') {
      percent = Math.min(100, percent + Math.max(1, Math.ceil(100 / steps)));
      line += 1;
      elapsed += 1;
      if (percent >= 100) phase = 'done';
    }
    const state = phase === 'running' ? 'Run' : phase === 'paused' ? 'Hold' : 'Idle';
    const progress = phase === 'idle' || phase === 'stopped' ? '' : `|P:${line},${phase === 'done' ? 100 : percent},${elapsed}`;
    return `<${state}|MPos:0,0,0|WPos:0,0,0${progress}|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>`;
  };

  const replyFor = (text: string): number[] => {
    const lineText = text.trim();
    if (lineText === '?') return frame(PTYPE_REPLY, `${statusLine()}\r\n`);
    if (lineText.startsWith('play ')) {
      phase = 'running';
      percent = 0;
      line = 0;
      elapsed = 0;
      return frame(PTYPE_REPLY, 'ok\r\n');
    }
    if (lineText === 'suspend') {
      if (phase === 'running') phase = 'paused';
      return frame(PTYPE_REPLY, 'ok\r\n');
    }
    if (lineText === 'resume') {
      if (phase === 'paused') phase = 'running';
      return frame(PTYPE_REPLY, 'ok\r\n');
    }
    if (lineText === 'abort') {
      phase = 'stopped';
      return frame(PTYPE_REPLY, 'ok\r\n');
    }
    return frame(PTYPE_REPLY, 'ok\r\n');
  };

  await page.route('**/api/v1/machine/**', async (route) => {
    const url = route.request().url();
    const tail = url.split('/api/v1/machine/')[1]?.split('?')[0] ?? '';
    const body = (route.request().postDataJSON() ?? {}) as {
      conn?: number;
      data?: number[];
    };
    if (tail === 'tcp/connect') {
      const conn = nextConn++;
      conns.set(conn, { out: [], in: [] });
      return route.fulfill({ json: { conn } });
    }
    if (tail === 'tcp/write') {
      const session = body.conn === undefined ? undefined : conns.get(body.conn);
      if (session !== undefined) {
        session.in.push(...(body.data ?? []));
        for (const { type, text } of framesIn(session.in)) {
          const lineText = type === PTYPE_CTRL_SINGLE ? '?' : text;
          seen.push(lineText.trim());
          session.out.push(...replyFor(lineText));
        }
      }
      return route.fulfill({ status: 204, body: '' });
    }
    if (tail === 'tcp/read') {
      const session = body.conn === undefined ? undefined : conns.get(body.conn);
      if (session === undefined || session.out.length === 0) {
        // The client's read window: an empty answer is "nothing yet", not an error.
        await new Promise((resolve) => setTimeout(resolve, 40));
        return route.fulfill({ json: { bytes: [] } });
      }
      const bytes = session.out.splice(0, session.out.length);
      return route.fulfill({ json: { bytes } });
    }
    if (tail === 'tcp/close') {
      if (body.conn !== undefined) conns.delete(body.conn);
      return route.fulfill({ status: 204, body: '' });
    }
    if (tail === 'udp/listen') return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });

  return { lines: () => [...seen] };
}
