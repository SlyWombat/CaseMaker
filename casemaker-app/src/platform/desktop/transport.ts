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
import type { MachineTransport } from './protocol';

/** The concrete transport: raw sockets via the desktop shell's Tauri commands. */
export const tauriTransport: MachineTransport = {
  async udpListen(port, windowMs): Promise<string[]> {
    return invoke<string[]>('machine_udp_listen', { port, window_ms: windowMs });
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
};
