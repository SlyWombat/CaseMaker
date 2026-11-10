/**
 * The shared in-memory transport for the machine protocol specs (#1180 D).
 *
 * `MachineTransport` is the five dumb calls the bridge makes (`Z1-Bridge-Protocol.md` §7). Three
 * specs each retyped the same recording shell — bytes written, chunks waiting to be read, connect
 * and close counts, decoded console lines. `QueueTransport` is that shell; a spec extends it and
 * overrides only what its machine does differently (a scripted reply per line, a connect timeout to
 * record, a broadcast to answer).
 *
 * `SpyTransport` is the "nothing may reach the socket" shape: it counts connects and answers
 * nothing.
 */

import type { MachineTransport, UdpDatagram } from '@/platform/desktop/protocol';

const EMPTY = new Uint8Array();
const FRAME_HEADER_BYTES = 5;
const FRAME_FOOTER_BYTES = 4;

export class QueueTransport implements MachineTransport {
  /** Every write, verbatim. */
  writes: Uint8Array[] = [];
  /** Chunks a read may return, in order; an exhausted queue answers empty. */
  reads: Uint8Array[] = [];
  connects = 0;
  closed: number[] = [];

  /** Queue bytes the next reads return, in order (no relation to a write). */
  queue(...chunks: Uint8Array[]): void {
    this.reads.push(...chunks);
  }

  async udpListen(_port: number, _windowMs: number): Promise<UdpDatagram[]> {
    return [];
  }

  async tcpConnect(_host: string, _port: number, _timeoutMs: number): Promise<number> {
    this.connects += 1;
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

  /** Every console line written, decoded past the frame's 5-byte header and 4-byte footer. */
  lines(): string[] {
    return this.writes.map((w) =>
      new TextDecoder().decode(w.subarray(FRAME_HEADER_BYTES, w.length - FRAME_FOOTER_BYTES)),
    );
  }
}

/** Counts connect attempts and refuses to carry anything — for "nothing may open a socket". */
export class SpyTransport extends QueueTransport {
  override async tcpWrite(): Promise<void> {}
  override async tcpRead(): Promise<Uint8Array> {
    return EMPTY;
  }
}
