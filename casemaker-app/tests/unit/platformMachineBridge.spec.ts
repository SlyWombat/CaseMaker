// #255 — the machine bridge's public surface: the verified-only gate and the four actions.
//
// `@tauri-apps/api/core` is mocked because these tests never touch a socket; the transport is
// injected. That injection is the USB seam too, so the same tests cover the shape a second
// transport must satisfy.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
  asVerifiedProgram,
  DESKTOP_ONLY_MARKER,
  discover,
  identify,
  status,
  uploadVerifiedProgram,
  type VerifiedProgram,
} from '@/platform/desktop/machineBridge';
import {
  encodeFrame,
  PTYPE_FILE_DATA,
  PTYPE_FILE_END,
  PTYPE_FILE_VIEW,
  u32be,
  utf8,
  type MachineTransport,
} from '@/platform/desktop/protocol';
import type { VerifyReport } from '@/engine/cnc/verify';

const EMPTY = new Uint8Array(0);
const CONTENT = new Uint8Array([1, 2, 3]);

const okReport: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [0, 0, 0] } },
};

const badReport: VerifyReport = {
  ok: false,
  findings: [{ severity: 'error', code: 'cut-too-deep', line: 3, message: 'a cutting move is too deep' }],
  stats: { lines: 1, cuttingMoves: 1, deepestZ: -5, bbox: { min: [0, 0, -5], max: [1, 1, 0] } },
};

class FakeTransport implements MachineTransport {
  writes: Uint8Array[] = [];
  reads: Uint8Array[] = [];
  udpLines: string[] = [];
  connects = 0;
  closed: number[] = [];
  listenPort: number | null = null;

  queueRead(...chunks: Uint8Array[]): void {
    this.reads.push(...chunks);
  }
  async udpListen(port: number, _windowMs: number): Promise<string[]> {
    this.listenPort = port;
    return this.udpLines;
  }
  async tcpConnect(_host: string, _port: number, _timeoutMs: number): Promise<number> {
    this.connects++;
    return 1;
  }
  async tcpWrite(_conn: number, data: Uint8Array): Promise<void> {
    this.writes.push(data);
  }
  async tcpRead(_conn: number, _max: number, _timeoutMs: number): Promise<Uint8Array> {
    return this.reads.shift() ?? EMPTY;
  }
  async tcpClose(conn: number): Promise<void> {
    this.closed.push(conn);
  }
}

describe('#255 machine bridge — the desktop boundary', () => {
  it('keeps the marker the platform-gate check greps for', () => {
    expect(DESKTOP_ONLY_MARKER).toBe('casemaker-desktop-bridge-v1');
  });
});

describe('#255 machine bridge — verified-only gate', () => {
  it('produces a VerifiedProgram only for an ok .nc report', () => {
    expect(asVerifiedProgram('badge.nc', CONTENT, okReport)).not.toBeNull();
    expect(asVerifiedProgram('badge.nc', CONTENT, badReport)).toBeNull();
    expect(asVerifiedProgram('badge.txt', CONTENT, okReport)).toBeNull();
  });

  it('refuses a report with an error finding even if the ok flag says otherwise', () => {
    const lying: VerifyReport = { ...okReport, findings: badReport.findings };
    expect(asVerifiedProgram('badge.nc', CONTENT, lying)).toBeNull();
  });

  it('refuses an unverified program at upload time without opening a socket', async () => {
    // Structurally a VerifiedProgram — the runtime re-check is what refuses it.
    const forged: VerifiedProgram = { filename: 'badge.nc', content: CONTENT, report: badReport };
    const transport = new FakeTransport();
    const outcome = await uploadVerifiedProgram({ host: '10.0.0.1' }, forged, { transport });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toMatch(/verifier/i);
    expect(transport.connects).toBe(0);
  });

  it('refuses a non-.nc program at upload time without opening a socket', async () => {
    const forged: VerifiedProgram = { filename: 'badge.txt', content: CONTENT, report: okReport };
    const transport = new FakeTransport();
    const outcome = await uploadVerifiedProgram({ host: '10.0.0.1' }, forged, { transport });
    expect(outcome.ok).toBe(false);
    expect(transport.connects).toBe(0);
  });
});

describe('#255 machine bridge — actions', () => {
  it('uploads a verified program and closes the connection afterwards', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(PTYPE_FILE_VIEW, EMPTY),
      encodeFrame(PTYPE_FILE_DATA, u32be(1)),
      encodeFrame(PTYPE_FILE_END, EMPTY),
    );
    const program = asVerifiedProgram('badge.nc', CONTENT, okReport);
    expect(program).not.toBeNull();
    if (program === null) throw new Error('expected a verified program');

    const outcome = await uploadVerifiedProgram({ host: '10.0.0.1', port: 2222 }, program, {
      transport,
      packetSize: 8,
    });
    expect(outcome).toEqual({ ok: true, bytes: 3, packets: 1, alreadyPresent: false });
    expect(transport.connects).toBe(1);
    expect(transport.closed).toEqual([1]);
  });

  it('discovers on UDP 3333 by default', async () => {
    const transport = new FakeTransport();
    transport.udpLines = ['Z1,10.0.0.5,2222,0'];
    const found = await discover({ transport });
    expect(found.map((m) => m.name)).toEqual(['Z1']);
    expect(transport.listenPort).toBe(3333);
  });

  it('identifies a machine and closes the connection', async () => {
    const transport = new FakeTransport();
    transport.queueRead(
      encodeFrame(0x90, utf8('192.168.10.16')),
      EMPTY,
      encodeFrame(0x90, utf8('AA:BB:CC:DD:EE:FF')),
      EMPTY,
    );
    const identity = await identify({ host: '192.168.10.16' }, { transport });
    expect(identity.ip).toBe('192.168.10.16');
    expect(identity.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(transport.closed).toEqual([1]);
  });

  it('reads status and closes the connection', async () => {
    const transport = new FakeTransport();
    transport.queueRead(encodeFrame(0x81, utf8('<Idle|MPos:0,0,0>')));
    const machineStatus = await status({ host: '10.0.0.1' }, { transport });
    expect(machineStatus.ok).toBe(true);
    expect(machineStatus.text).toContain('Idle');
    expect(transport.closed).toEqual([1]);
  });
});
