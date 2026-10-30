// The Tauri-backed MachineTransport (Z1-Bridge-Protocol.md §7).
//
// DESKTOP ONLY — reached only through `machineBridge.ts` under the `canDriveMachine` guard. The
// `@tauri-apps/api` import belongs here and nowhere else: importing it at this boundary is what
// keeps the whole dependency out of the web bundle (#181).
//
// This module is deliberately dumb. It moves bytes and nothing else: no framing, no CRC, no
// command. All of that is in `protocol.ts`, where it is unit-tested. The Rust side
// (`src-tauri/src/machine.rs`) is the same kind of dumb: it owns sockets, not the protocol.

import { invoke } from '@tauri-apps/api/core';
import type { MachineTransport, SerialPortSummary, UdpDatagram } from './protocol';

/** The concrete transport: raw sockets and USB serial via the desktop shell's Tauri commands. */
export const tauriTransport: MachineTransport = {
  // The Rust side stamps each datagram as it takes it off the socket, so the arrival time is a
  // fact about receipt and not about how long the reply took to cross the IPC boundary (#275).
  async udpListen(port, windowMs): Promise<UdpDatagram[]> {
    return invoke<UdpDatagram[]>('machine_udp_listen', { port, window_ms: windowMs });
  },
  async tcpConnect(host, port, timeoutMs): Promise<number> {
    return invoke<number>('machine_tcp_connect', { host, port, timeout_ms: timeoutMs });
  },
  async tcpWrite(conn, data): Promise<void> {
    await invoke('machine_tcp_write', { conn, data: Array.from(data) });
  },
  async tcpRead(conn, max, timeoutMs): Promise<Uint8Array> {
    const bytes = await invoke<number[]>('machine_tcp_read', { conn, max, timeout_ms: timeoutMs });
    return Uint8Array.from(bytes);
  },
  async tcpClose(conn): Promise<void> {
    await invoke('machine_tcp_close', { conn });
  },
  // #775 — USB serial. These two commands exist only in the Windows desktop shell (the Rust side
  // answers a plain refusal elsewhere); the HTTP transport deliberately has neither, which is how
  // a LAN browser is kept from offering a port picker.
  async serialList(): Promise<SerialPortSummary[]> {
    return invoke<SerialPortSummary[]>('machine_serial_list');
  },
  async serialConnect(port, baud, timeoutMs): Promise<number> {
    return invoke<number>('machine_serial_connect', { port, baud, timeout_ms: timeoutMs });
  },
};
