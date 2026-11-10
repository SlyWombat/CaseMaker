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
 * It also plays the CARD's own two commands (#886): `ls -e -s <dir>` answers the seeded listing in
 * the Controller's `name size YYYYMMDDHHMMSS` form and ends with LOAD_FINISH, and `rm <path> -e`
 * removes the named entry and answers `ok` — or the shell's `rm: cannot remove` line, which the
 * app must read as a refusal. The Files panel is e2e-able against it without a card in the slot.
 *
 * Testing surface only: nothing here ships.
 */
import type { Page } from '@playwright/test';

const FRAME_HEADER = 0x8668;
const FRAME_FOOTER = 0x55aa;
/** A reply frame: a type ≥ 0x80 is text the console reads (the controller's own answer types). */
const PTYPE_REPLY = 0x83;
/** The controller's LOAD_FINISH: the answer to `ls`/`rm` is over (#886). */
const PTYPE_LOAD_FINISH = 0x84;
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

/** #827 — a round feature the fake can be probed against (a bore or a boss). */
export interface FakeFeature {
  kind: 'bore' | 'boss';
  radiusMm: number;
  /** The feature's centre, in the SAME frame the app's moves are sent in (G54 assumed 0). */
  centre: { x: number; y: number };
  /** The face's machine Z (the top touch reads it). */
  topZ: number;
}

/** #607 — the bench's 4th-axis chuck: a cylinder about an axis parallel to X, in the YZ plane. */
export interface FakeChuck {
  /** The axis line's Y, machine Y. */
  axisY: number;
  /** The axis line's height, machine Z. */
  axisZ: number;
  /** The chuck body's radius, mm. */
  radiusMm: number;
}

/** The 3D probe's measured effective ball radius, mm — the sideways-boss convention's offset. */
const PROBE_R = 0.875;

/** #886 — one entry of the seeded card listing, in the Controller's own three fields. */
export interface FakeSdFile {
  name: string;
  size: number;
  /** `YYYYMMDDHHMMSS`; absent means the epoch stamp a card with no clock reports. */
  stamp?: string;
  directory?: boolean;
}

export interface FakeConsoleOptions {
  /** Status polls from `play` to 100 %. Smaller finishes faster. Default 12. */
  steps?: number;
  /** #886 — what the card holds; `ls -e -s` answers this, `rm` takes an entry away. */
  files?: readonly FakeSdFile[];
  /**
   * #1169 — the controller parks in its `Tool` state when the run reaches this line, waiting for
   * `M490.2` (the third `T:` field names the tool). The line/percent freeze until Continue.
   */
  toolWaitAtLine?: number;
  /** #1169 — the controller raises an alarm when the run reaches this line: the reply carries
   *  `ALARM:` and the run ends. */
  alarmAtLine?: number;
  /**
   * #1170 — where an idle machine reports its head. Default `[0,0,0]`; `[-1,-1,-1]` is the
   * controller's HOMED rest, which `readMachineRest` reads as homed. A test that exercises the
   * flip card's arrival (home before the light) needs the fake to say it is already home.
   */
  idleMpos?: readonly [number, number, number];
}

/**
 * #1173A — the four states the machine page is judged in. `run` holds a steady 42 % program (no
 * auto-finish, so a spec can assert the running state at leisure); `alarm` answers the controller's
 * own alarm words; `silent` refuses the connection itself, which is what the heartbeat reads as a
 * missed poll.
 */
export type FakeConsolePhase = 'idle' | 'run' | 'alarm' | 'silent';

/** #826 — the bench's own diagnostic line: probe open, cover closed, no limit, e-stop released. */
export const DIAGNOSE_IDLE =
  '{S:0,10000,0,0,20,22|L:0,0|V:1,26|F:0,0|G:1,0,0,0,0|T:0|C:1|E:0,0,0,0,0,1,1,0|P:0,0|I:0|RSSI:-40}';

/** #826 — the same line with the stylus held: the probe input reads 1. */
export const DIAGNOSE_TOUCHED =
  '{S:0,10000,0,0,20,22|L:0,0|V:1,26|F:0,0|G:1,0,0,0,0|T:0|C:1|E:0,0,0,0,0,1,1,0|P:1,0|I:0|RSSI:-41}';

export interface FakeConsole {
  /** Every line the app wrote, in order (`?` for a status poll). */
  lines(): string[];
  /**
   * #1179 B — a Z offset applied to the touch at the nth DISTINCT probe point (in the order the
   * points are first probed), mm: a hidden floor under one candidate, or a chip standing on it.
   * The boss feature's top is the base reading; an absent index reads 0.
   */
  setProbeOffsets(offsetsMm: readonly number[]): void;
  /** #826 — the `diagnose` answer from now on; a spec flips it to prove the monitor follows changes. */
  setDiagnose(line: string): void;
  /** #827 — the round feature the probe touches from now on (a spec seeds it after the app starts). */
  setFeature(feature: FakeFeature): void;
  /** #607 — the chuck the rotary tap touches from now on. */
  setChuck(chuck: FakeChuck): void;
  /** #886 — what the card holds NOW, after any deletes the app sent. */
  files(): FakeSdFile[];
  /** #1173A — what the controller answers from now on (and whether it answers at all). */
  setPhase(phase: FakeConsolePhase): void;
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
  // #1173A — the machine page's four states, forced by a spec. `idle` lets the scripted program
  // phase above run as before; the other three override the answer outright.
  let forced: FakeConsolePhase = 'idle';
  let percent = 0;
  let line = 0;
  let elapsed = 0;
  // #1169 — the firmware's Tool wait and an alarm, seeded by a spec.
  let toolContinued = false;
  let alarmed = false;
  let diagnoseLine = DIAGNOSE_IDLE;
  // #827 — the round feature the centre routine is run against; null until a spec seeds it.
  let feature: FakeFeature | null = null;
  // #607 — the rotary module's chuck, when a spec seeds one.
  let chuck: FakeChuck | null = null;
  // #886 — the card's own listing, seeded by the spec and changed by its deletes.
  let files: FakeSdFile[] = [...(opts.files ?? [])];
  // #1179 B — per-probe-point Z offsets (the nth distinct XY the probe touches).
  let probeOffsets: readonly number[] = [];
  const probePoints = new Map<string, number>();
  const probeOffsetAt = (x: number, y: number): number => {
    const key = `${x.toFixed(2)},${y.toFixed(2)}`;
    if (!probePoints.has(key)) probePoints.set(key, probePoints.size);
    return probeOffsets[probePoints.get(key)!] ?? 0;
  };
  const pos = { x: 0, y: 0, z: -3 };
  let mode: 'G90' | 'G91' = 'G90';
  const dist = (x: number, y: number): number =>
    feature === null ? Number.POSITIVE_INFINITY : Math.hypot(x - feature.centre.x, y - feature.centre.y);
  const trigger = (): number => (feature === null ? 0 : feature.kind === 'bore' ? feature.radiusMm - 0.875 : feature.radiusMm + 0.875);
  const materialAt = (x: number, y: number): boolean =>
    feature === null ? false : feature.kind === 'bore' ? dist(x, y) > feature.radiusMm : dist(x, y) <= feature.radiusMm;
  /** #607 — the chuck's crown at this machine Y, or null beside the body (`Zc + sqrt(R² − dy²)`). */
  const chuckTopAt = (y: number): number | null => {
    if (chuck === null) return null;
    const dy = y - chuck.axisY;
    if (Math.abs(dy) >= chuck.radiusMm) return null;
    return chuck.axisZ + Math.sqrt(chuck.radiusMm * chuck.radiusMm - dy * dy);
  };

  const statusLine = (): string => {
    // #1173A — the forced states, in the controller's own shapes. `run` is a steady 42 % so the
    // page can be inspected without the program finishing underneath the assertion.
    if (forced === 'run') return '<Run|MPos:-12.000,-8.000,-2.000|WPos:0,0,0|P:12,42,17>';
    if (forced === 'alarm') return '<Alarm|MPos:0,0,0|WPos:0,0,0>\r\nALARM: Probe fail';
    // #1169 — the scripted run's own events, only while the scripted program is running (a forced
    // phase above is a spec's static answer, not a program). The Tool wait freezes the run where it
    // stands until M490.2; the alarm ends it and the reply carries ALARM: from then on.
    if (forced === 'idle' && phase === 'running' && opts.alarmAtLine !== undefined && line >= opts.alarmAtLine) {
      alarmed = true;
      phase = 'stopped';
    }
    if (forced === 'idle' && phase === 'running' && opts.toolWaitAtLine !== undefined && line >= opts.toolWaitAtLine && !toolContinued) {
      return `<Tool|MPos:0,0,0|WPos:0,0,0|P:${line},${percent},${elapsed}|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0|T:0,0,1>`;
    }
    if (phase === 'running') {
      percent = Math.min(100, percent + Math.max(1, Math.ceil(100 / steps)));
      line += 1;
      elapsed += 1;
      if (percent >= 100) phase = 'done';
    }
    const state = phase === 'running' ? 'Run' : phase === 'paused' ? 'Hold' : 'Idle';
    const progress = phase === 'idle' || phase === 'stopped' ? '' : `|P:${line},${phase === 'done' ? 100 : percent},${elapsed}`;
    const [mx, my, mz] = opts.idleMpos ?? [0, 0, 0];
    const mpos = `${mx.toFixed(3)},${my.toFixed(3)},${mz.toFixed(3)}`;
    return `<${state}|MPos:${mpos}|WPos:0,0,0${progress}|S:0.0,10000.0,100.0,0,25.8,24.0,0,0,0,0>`;
  };

  const replyFor = (text: string): number[] => {
    const lineText = text.trim();
    if (lineText === '?') {
      const body = statusLine();
      // #1169 — the alarm the controller reports between lines, in the firmware's own form.
      return frame(PTYPE_REPLY, alarmed ? `ALARM: Emergency stop\r\n${body}\r\n` : `${body}\r\n`);
    }
    // #1169 — Continue: the Tool wait resumes and the line is recorded for the spec.
    if (lineText === 'M490.2') {
      toolContinued = true;
      return frame(PTYPE_REPLY, 'ok\r\n');
    }
    // #1169 — the recovery's two presses: Unlock clears the alarm (a later `?` no longer says it),
    // Home answers ok. Both are recorded for the spec.
    if (lineText === '$X') {
      alarmed = false;
      return frame(PTYPE_REPLY, 'ok\r\n');
    }
    if (lineText === '$H') return frame(PTYPE_REPLY, 'ok\r\n');
    // #826 — the diagnostic read the heartbeat sends alongside `?`.
    if (lineText === 'diagnose') return frame(PTYPE_REPLY, `${diagnoseLine}\r\n`);
    // #827 — the probe session's lines, against the seeded feature.
    if (lineText === 'M119') return frame(PTYPE_REPLY, 'X_max:0 Y_max:0 Z_max:0 Probe: 0\r\n');
    if (lineText === 'M491') return frame(PTYPE_REPLY, '[PRB:0,0,-80.000:1]\r\nok\r\n');
    if (lineText === 'G90' || lineText === 'G91') {
      mode = lineText;
      return frame(PTYPE_REPLY, 'ok\r\n');
    }
    let m = /^G53 G0 Z(-?[\d.]+)$/.exec(lineText);
    if (m) {
      pos.z = Number(m[1]);
      return frame(PTYPE_REPLY, 'ok\r\n');
    }
    m = /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(lineText);
    if (m) {
      pos.x = Number(m[1]);
      pos.y = Number(m[2]);
      return frame(PTYPE_REPLY, 'ok\r\n');
    }
    // #607 — the rotary tap moves in G53 machine coordinates.
    m = /^G53 G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(lineText);
    if (m) {
      pos.x = Number(m[1]);
      pos.y = Number(m[2]);
      return frame(PTYPE_REPLY, 'ok\r\n');
    }
    if (lineText.startsWith('G38.5 ')) {
      if (mode !== 'G91') return frame(PTYPE_REPLY, 'error:release in absolute mode\r\n');
      const r = /^G38\.5 ([XYZ])(-?[\d.]+)/.exec(lineText);
      if (r !== null) {
        const axis = r[1]!.toLowerCase() as 'x' | 'y' | 'z';
        pos[axis] += Number(r[2]!);
      }
      return frame(PTYPE_REPLY, 'ok\r\n');
    }
    m = /^G38\.3 Z-([\d.]+) F[\d.]+$/.exec(lineText);
    if (m) {
      if (mode !== 'G91') return frame(PTYPE_REPLY, 'error:probe in absolute mode\r\n');
      const target = pos.z - Number(m[1]);
      // #607 — a seeded chuck's crown at this Y, if the descent reaches it.
      if (chuck !== null) {
        const crown = chuckTopAt(pos.y);
        if (crown !== null && crown >= target && crown <= pos.z) {
          pos.z = crown;
          return frame(PTYPE_REPLY, `[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${crown.toFixed(3)}:1]\r\nok\r\n`);
        }
        pos.z = target;
        return frame(PTYPE_REPLY, `[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\r\nok\r\n`);
      }
      if (feature !== null && materialAt(pos.x, pos.y)) {
        const hitZ = feature.topZ + probeOffsetAt(pos.x, pos.y);
        if (hitZ >= target && hitZ <= pos.z) {
          pos.z = hitZ;
          return frame(PTYPE_REPLY, `[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${hitZ.toFixed(3)}:1]\r\nok\r\n`);
        }
      }
      pos.z = target;
      return frame(PTYPE_REPLY, `[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\r\nok\r\n`);
    }
    m = /^G38\.3 ([XY])(-?[\d.]+) F[\d.]+$/.exec(lineText);
    if (m) {
      if (mode !== 'G91') return frame(PTYPE_REPLY, 'error:probe in absolute mode\r\n');
      const axis = m[1] === 'X' ? 'x' : 'y';
      const travel = Number(m[2]);
      const along = axis === 'x' ? pos.x : pos.y;
      // #607 — a seeded chuck: the ±Y chord pair at this machine Z meets the body one probe radius
      // outside each face (the app's sideways-boss convention). X touches beside it find nothing.
      if (chuck !== null) {
        let edge: number | undefined;
        if (axis === 'y') {
          const dz = pos.z - chuck.axisZ;
          if (Math.abs(dz) <= chuck.radiusMm) {
            const h = Math.sqrt(chuck.radiusMm * chuck.radiusMm - dz * dz) + PROBE_R;
            const candidates = [chuck.axisY - h, chuck.axisY + h].sort((a, b) => (travel < 0 ? b - a : a - b));
            edge = candidates.find((c) => (travel < 0 ? c <= along && c >= along + travel : c >= along && c <= along + travel));
          }
        }
        if (edge === undefined) {
          if (axis === 'x') pos.x += travel;
          else pos.y += travel;
          return frame(PTYPE_REPLY, `[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}:0]\r\nok\r\n`);
        }
        if (axis === 'x') pos.x = edge;
        else pos.y = edge;
        return frame(PTYPE_REPLY, `[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}:1]\r\nok\r\n`);
      }
      const otherOffset = (axis === 'x' ? pos.y : pos.x) - (axis === 'x' ? feature!.centre.y : feature!.centre.x);
      const sq = trigger() * trigger() - otherOffset * otherOffset;
      const centreAlong = axis === 'x' ? feature!.centre.x : feature!.centre.y;
      let hit: number | undefined;
      if (sq >= 0) {
        const half = Math.sqrt(sq);
        const candidates = [centreAlong - half, centreAlong + half].sort((a, b) => (travel < 0 ? b - a : a - b));
        hit = candidates.find((c) => (travel < 0 ? c <= along && c >= along + travel : c >= along && c <= along + travel));
      }
      if (hit === undefined) {
        if (axis === 'x') pos.x += travel;
        else pos.y += travel;
        return frame(PTYPE_REPLY, `[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}:0]\r\nok\r\n`);
      }
      if (axis === 'x') pos.x = hit;
      else pos.y = hit;
      return frame(PTYPE_REPLY, `[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}:1]\r\nok\r\n`);
    }
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
    // #886 — the card's own two commands. `ls -e -s <dir>` answers the seeded listing in the
    // Controller's `name size stamp` form and ends with LOAD_FINISH; `rm <path> -e` takes the
    // named entry away. Both are the shapes `protocol.ts` parses.
    if (lineText.startsWith('ls -e -s ')) {
      const lines = files.map(
        (f) => `${f.name}${f.directory === true ? '/' : ''} ${f.size} ${f.stamp ?? '19800101000000'}`,
      );
      return [...frame(PTYPE_REPLY, lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`), ...frame(PTYPE_LOAD_FINISH, '')];
    }
    m = /^rm (.+) -e$/.exec(lineText);
    if (m !== null) {
      // A path arrives with the Controller's escaping, where 0x01 is a space; the name is the
      // last segment (`/sd/gcodes/<name>`), and removing a file the card does not hold answers
      // the shell's own refusal, which the app must not read as a delete.
      const path = m[1]!.replaceAll('\u0001', ' ');
      const name = path.slice(path.lastIndexOf('/') + 1);
      const held = files.some((f) => f.name === name);
      files = files.filter((f) => f.name !== name);
      return [
        ...frame(PTYPE_REPLY, held ? 'ok\r\n' : 'rm: cannot remove: no such file\r\n'),
        ...frame(PTYPE_LOAD_FINISH, ''),
      ];
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
      // #1173A — a machine that has gone quiet: the page's own connection attempt is refused, which
      // the heartbeat catches as a missed poll (it never reaches the frame layer).
      if (forced === 'silent') {
        return route.fulfill({ status: 503, json: { error: 'connection refused' } });
      }
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

  return {
    lines: () => [...seen],
    setProbeOffsets: (offsets: readonly number[]) => (probeOffsets = [...offsets]),
    setDiagnose: (next: string) => (diagnoseLine = next),
    setFeature: (next: FakeFeature) => (feature = next),
    setChuck: (next: FakeChuck) => (chuck = next),
    files: () => [...files],
    setPhase: (next: FakeConsolePhase) => {
      forced = next;
      // Returning to idle clears the scripted program too, so a spec can start a fresh run.
      if (next === 'idle') {
        phase = 'idle';
        percent = 0;
        line = 0;
        elapsed = 0;
      }
    },
  };
}
