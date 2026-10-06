// The Node MachineTransport — a bench-side implementation of the same five calls
// `src-tauri/src/machine.rs` provides to the desktop build (Z1-Bridge-Protocol.md §7).
//
// It exists so the protocol can be exercised at the machine without building the Tauri app. It is
// deliberately dumb in exactly the way the Rust side is dumb: it moves bytes and knows no framing,
// no CRC and no command. Everything above it — including every decision about what is safe to
// send — is the real `src/platform/desktop/protocol.ts`, not a copy of it.
//
// WINDOWS ONLY, in practice. WSL2 does not deliver the machine's UDP 3333 broadcast to a listener
// inside the VM, `networkingMode=Mirrored` included (observed 2026-10-06: 0 datagrams in 45 s under
// WSL while ~3/s arrived on the Windows side). TCP 2222 is reachable from either side. Run this
// from Windows Node, where `casemaker-app/node_modules` is also built.

import dgram from 'node:dgram';
import net from 'node:net';

/** The five-call seam of Z1-Bridge-Protocol.md §7, over node:dgram and node:net. */
export function createNodeTransport() {
  /** @type {Map<number, {sock: net.Socket, chunks: Buffer[], ended: boolean, waiters: Set<() => void>}>} */
  const conns = new Map();
  let nextId = 1;

  /** Concatenate buffered chunks up to `max` bytes, leaving the remainder buffered. */
  function take(c, max) {
    let total = 0;
    let n = 0;
    while (n < c.chunks.length && total + c.chunks[n].length <= max) {
      total += c.chunks[n].length;
      n++;
    }
    if (n === 0 && c.chunks.length > 0) {
      // A single chunk larger than `max`: split it rather than returning nothing forever.
      const head = c.chunks[0].subarray(0, max);
      c.chunks[0] = c.chunks[0].subarray(max);
      return new Uint8Array(head);
    }
    const parts = c.chunks.splice(0, n);
    return new Uint8Array(Buffer.concat(parts, total));
  }

  function wake(c) {
    for (const w of [...c.waiters]) w();
  }

  function require_(conn) {
    const c = conns.get(conn);
    if (c === undefined) throw new Error(`unknown connection ${conn}`);
    return c;
  }

  return {
    /** Bind UDP `port`, collect datagram payloads as UTF-8 strings for `windowMs`, then close. */
    async udpListen(port, windowMs) {
      return await new Promise((resolve, reject) => {
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        const lines = [];
        let done = false;
        const finish = (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try {
            sock.close();
          } catch {
            /* already closed */
          }
          if (err) reject(err);
          else resolve(lines);
        };
        const timer = setTimeout(() => finish(null), windowMs);
        sock.on('message', (buf) => lines.push(buf.toString('utf8')));
        sock.on('error', (err) => finish(err));
        sock.bind(port, '0.0.0.0');
      });
    },

    /** Open the command connection. Resolves to a connection id; nothing is sent. */
    async tcpConnect(host, port, timeoutMs) {
      return await new Promise((resolve, reject) => {
        const sock = net.connect({ host, port });
        sock.setNoDelay(true);
        const c = { sock, chunks: [], ended: false, waiters: new Set() };
        const onConnect = () => {
          sock.off('error', onFail);
          // `setTimeout` is an *inactivity* timeout, not a connect deadline: it survives the
          // connection and re-arms on every quiet stretch. Left armed, it destroys the socket under
          // any reply that takes longer than the connect timeout — which is exactly what happened to
          // the first `cat` on 2026-10-06, and it reports itself as "closed by peer", pointing at
          // the machine rather than at this line. Disarm it here; `tcpRead` carries its own budget.
          sock.setTimeout(0);
          sock.on('data', (buf) => {
            c.chunks.push(buf);
            wake(c);
          });
          const onEnd = () => {
            c.ended = true;
            wake(c);
          };
          sock.on('end', onEnd);
          sock.on('close', onEnd);
          const id = nextId++;
          conns.set(id, c);
          resolve(id);
        };
        const onFail = (err) => {
          sock.destroy();
          reject(err);
        };
        sock.setTimeout(timeoutMs, () => onFail(new Error(`tcpConnect ${host}:${port} timed out after ${timeoutMs} ms`)));
        sock.once('connect', onConnect);
        sock.once('error', onFail);
      });
    },

    async tcpWrite(conn, data) {
      const c = require_(conn);
      await new Promise((resolve, reject) => {
        c.sock.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
      });
    },

    /**
     * The bytes available within `timeoutMs`, or an empty array on timeout. Rejects if the peer
     * closed — so a caller can tell "nothing yet" from "gone", which is the whole point of the
     * distinction in §7.
     */
    async tcpRead(conn, max, timeoutMs) {
      const c = require_(conn);
      if (c.chunks.length > 0) return take(c, max);
      if (c.ended) throw new Error(`connection ${conn} closed by peer`);
      return await new Promise((resolve, reject) => {
        let settled = false;
        const waiter = () => {
          if (settled || c.chunks.length === 0) return;
          settled = true;
          clearTimeout(timer);
          c.waiters.delete(waiter);
          resolve(take(c, max));
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          c.waiters.delete(waiter);
          if (c.ended) reject(new Error(`connection ${conn} closed by peer`));
          else resolve(new Uint8Array(0));
        }, timeoutMs);
        c.waiters.add(waiter);
      });
    },

    async tcpClose(conn) {
      const c = conns.get(conn);
      if (c === undefined) return;
      conns.delete(conn);
      c.waiters.clear();
      c.sock.destroy();
    },
  };
}
