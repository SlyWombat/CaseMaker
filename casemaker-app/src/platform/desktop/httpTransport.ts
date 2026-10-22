// The HTTP-backed MachineTransport (#571).
//
// The twin of `transport.ts`: the same five dumb calls (`Z1-Bridge-Protocol.md` §7), but reaching
// the sockets through the embedded HTTP server's `/api/v1/machine/*` endpoints instead of Tauri IPC.
// This is what a LAN browser served the SPA by `casemaker --bind-all` uses — it has no Tauri runtime,
// so `transport.ts`'s `invoke` would throw; the server (on the LAN with the controller) owns the
// socket and this talks to it.
//
// Same-origin, `application/json`: that is exactly the request shape `guard.rs` allows, so a page
// this server served passes and a page on another site cannot forge it. Relative URLs keep it on
// whatever origin the SPA was loaded from. No framing, no protocol — those live in `protocol.ts`.

import type { MachineTransport, UdpDatagram } from './protocol';

async function machinePost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // A network-level failure (server gone, origin unreachable) — give the protocol layer a message
    // in the same shape as a returned error, not a bare TypeError.
    throw new Error(`could not reach the machine service at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 204) return undefined as T; // write / close answer with no body
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg = json && typeof json === 'object' && 'error' in json ? String((json as { error: unknown }).error) : `machine request ${path} failed: ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

/** The concrete transport for a browser: raw sockets via the server's HTTP machine API. */
export const httpTransport: MachineTransport = {
  async udpListen(port, windowMs): Promise<UdpDatagram[]> {
    return machinePost<UdpDatagram[]>('/api/v1/machine/udp/listen', { port, window_ms: windowMs });
  },
  async tcpConnect(host, port, timeoutMs): Promise<number> {
    const r = await machinePost<{ conn: number }>('/api/v1/machine/tcp/connect', { host, port, timeout_ms: timeoutMs });
    return r.conn;
  },
  async tcpWrite(conn, data): Promise<void> {
    await machinePost<void>('/api/v1/machine/tcp/write', { conn, data: Array.from(data) });
  },
  async tcpRead(conn, max, timeoutMs): Promise<Uint8Array> {
    const r = await machinePost<{ bytes: number[] }>('/api/v1/machine/tcp/read', { conn, max, timeout_ms: timeoutMs });
    return Uint8Array.from(r.bytes);
  },
  async tcpClose(conn): Promise<void> {
    await machinePost<void>('/api/v1/machine/tcp/close', { conn });
  },
};
