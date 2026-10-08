// The machine bridge's transport: raw sockets, desktop-only (#255).
//
// This module is deliberately DUMB. It knows no framing, no CRC and no command — those live in
// `casemaker-app/src/platform/desktop/protocol.ts`, where they are unit-tested against scripted
// replies with no machine present. Here there are only the five calls of the transport interface
// (`Z1-Bridge-Protocol.md` §7): listen for a UDP broadcast, and open / write / read / close a TCP
// connection. USB can follow by adding a second transport, not by changing the protocol.
//
// The web build cannot reach any of this: no browser opens a raw socket, and the TypeScript side
// only calls these through the `canDriveMachine` guard (#181).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{watch, Mutex};
use tokio::time::{timeout, Duration, Instant};

/// One open connection, split so a read and a write never wait on each other (#299).
///
/// The halves have their OWN locks, and the registry lock (below) is held only to find or remove an
/// entry — never across an `await` on the socket. Before this, `machine_tcp_read` held the single
/// registry lock for its whole timeout: an upload waiting nine seconds for a packet request blocked
/// every other call on every connection, including the `machine_tcp_close` that was meant to abort it.
struct Conn {
    reader: Mutex<OwnedReadHalf>,
    writer: Mutex<OwnedWriteHalf>,
    /// Flipped to `true` by `close`. A read in progress selects on it, so closing ends the read now
    /// instead of after its timeout. A `watch` rather than a `Notify`: a read that begins after the
    /// close still sees `true`, where a notification would have been missed.
    closed: watch::Sender<bool>,
}

/// Live TCP connections, keyed by an id handed to the TypeScript side. One per explicit action.
#[derive(Default)]
pub struct MachineTransport {
    conns: Mutex<HashMap<u64, Arc<Conn>>>,
    next_id: AtomicU64,
}

impl MachineTransport {
    /// Take ownership of a connected stream and return its id.
    async fn adopt(&self, stream: TcpStream) -> u64 {
        let (r, w) = stream.into_split();
        let (closed, _) = watch::channel(false);
        let conn = Arc::new(Conn { reader: Mutex::new(r), writer: Mutex::new(w), closed });
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.conns.lock().await.insert(id, conn);
        id
    }

    /// Find a connection. The registry lock is released before the caller touches the socket.
    async fn get(&self, conn: u64) -> Result<Arc<Conn>, String> {
        self.conns
            .lock()
            .await
            .get(&conn)
            .cloned()
            .ok_or_else(|| format!("unknown connection {conn}"))
    }

    async fn write(&self, conn: u64, data: &[u8]) -> Result<(), String> {
        let c = self.get(conn).await?;
        let mut w = c.writer.lock().await;
        w.write_all(data).await.map_err(|e| format!("write failed: {e}"))?;
        w.flush().await.map_err(|e| format!("flush failed: {e}"))?;
        Ok(())
    }

    async fn read(&self, conn: u64, max: usize, timeout_ms: u64) -> Result<Vec<u8>, String> {
        let c = self.get(conn).await?;
        let mut closed = c.closed.subscribe();
        let mut r = c.reader.lock().await;
        let mut buf = vec![0u8; max.max(1)];
        tokio::select! {
            // `wait_for` checks the current value first, so a close that already happened wins.
            _ = closed.wait_for(|v| *v) => Err("the connection was closed".to_string()),
            read = timeout(Duration::from_millis(timeout_ms.max(1)), r.read(&mut buf)) => match read {
                Ok(Ok(0)) => Err("the machine closed the connection".to_string()),
                Ok(Ok(n)) => {
                    buf.truncate(n);
                    Ok(buf)
                }
                Ok(Err(e)) => Err(format!("read failed: {e}")),
                Err(_) => Ok(Vec::new()), // no data within the timeout
            },
        }
    }

    async fn close(&self, conn: u64) {
        // Remove first, so no new call can find it; then wake any read that is already waiting.
        let removed = self.conns.lock().await.remove(&conn);
        if let Some(c) = removed {
            let _ = c.closed.send(true);
        }
    }
}

/// Listen on `0.0.0.0:port` for `window_ms` and return each datagram as a UTF-8 string.
///
/// Discovery is passive: the machine broadcasts, we listen (`Z1-Bridge-Protocol.md` §2). Nothing
/// is sent. The window resets only in the sense that we keep listening until the deadline; each
/// datagram is collected. A port already bound (for example by Makera Studio) is reported clearly
/// rather than mistaken for "no machines found".
#[tauri::command(rename_all = "snake_case")]
pub async fn machine_udp_listen(port: u16, window_ms: u64) -> Result<Vec<String>, String> {
    let socket = UdpSocket::bind(("0.0.0.0", port)).await.map_err(|e| {
        format!("could not bind UDP {port} for discovery: {e} (another program, such as Makera Studio, may be using it)")
    })?;

    let deadline = Instant::now() + Duration::from_millis(window_ms);
    let mut out: Vec<String> = Vec::new();
    let mut buf = [0u8; 256];
    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        match timeout(deadline - now, socket.recv_from(&mut buf)).await {
            Ok(Ok((n, _addr))) => {
                if let Ok(text) = std::str::from_utf8(&buf[..n]) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        out.push(trimmed.to_string());
                    }
                }
            }
            Ok(Err(e)) => return Err(format!("discovery receive failed: {e}")),
            Err(_) => break, // the window elapsed
        }
    }
    Ok(out)
}

/// Connect to a controller's command channel and return a connection id for the other calls.
#[tauri::command(rename_all = "snake_case")]
pub async fn machine_tcp_connect(
    state: State<'_, MachineTransport>,
    host: String,
    port: u16,
    timeout_ms: u64,
) -> Result<u64, String> {
    let connect = TcpStream::connect((host.as_str(), port));
    let stream = timeout(Duration::from_millis(timeout_ms.max(1)), connect)
        .await
        .map_err(|_| format!("connecting to {host}:{port} timed out after {timeout_ms} ms"))?
        .map_err(|e| format!("could not connect to {host}:{port}: {e}"))?;
    // Small framed commands and their replies: Nagle would add latency for no benefit.
    stream.set_nodelay(true).map_err(|e| format!("could not configure the connection: {e}"))?;

    Ok(state.adopt(stream).await)
}

/// Write bytes to an open connection.
#[tauri::command(rename_all = "snake_case")]
pub async fn machine_tcp_write(
    state: State<'_, MachineTransport>,
    conn: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    state.write(conn, &data).await
}

/// Read up to `max` bytes, waiting up to `timeout_ms`.
///
/// An empty vector means "nothing arrived in time" — the caller must distinguish that from the
/// connection closing, which is an error. This is the whole reason the call returns bytes instead
/// of a higher-level frame.
#[tauri::command(rename_all = "snake_case")]
pub async fn machine_tcp_read(
    state: State<'_, MachineTransport>,
    conn: u64,
    max: usize,
    timeout_ms: u64,
) -> Result<Vec<u8>, String> {
    state.read(conn, max, timeout_ms).await
}

/// Close and forget a connection.
#[tauri::command(rename_all = "snake_case")]
pub async fn machine_tcp_close(state: State<'_, MachineTransport>, conn: u64) -> Result<(), String> {
    state.close(conn).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// A connected pair: the transport holds the client end, the test holds the server end.
    async fn pair(t: &MachineTransport) -> (u64, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (client, server) = tokio::join!(TcpStream::connect(addr), listener.accept());
        (t.adopt(client.unwrap()).await, server.unwrap().0)
    }

    // #299: closing a connection ends a read that is waiting on it, now — not after its timeout.
    #[tokio::test]
    async fn close_ends_a_pending_read_at_once() {
        let t = Arc::new(MachineTransport::default());
        let (id, _server) = pair(&t).await;

        let reader = {
            let t = t.clone();
            tokio::spawn(async move { t.read(id, 64, 9_000).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await; // let the read start waiting

        let started = Instant::now();
        t.close(id).await;
        let outcome = timeout(Duration::from_secs(2), reader).await.expect("the read did not end").unwrap();

        assert!(outcome.is_err(), "a closed connection is an error, not an empty read");
        assert!(started.elapsed() < Duration::from_secs(1), "close waited out the read's timeout");
    }

    // #299: a read in progress does not hold anything another connection needs.
    #[tokio::test]
    async fn a_pending_read_does_not_block_another_connection() {
        let t = Arc::new(MachineTransport::default());
        let (slow, _slow_server) = pair(&t).await;
        let (other, mut other_server) = pair(&t).await;

        let _pending = {
            let t = t.clone();
            tokio::spawn(async move { t.read(slow, 64, 9_000).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;

        let started = Instant::now();
        t.write(other, b"ping").await.unwrap();
        let mut got = [0u8; 4];
        timeout(Duration::from_secs(1), other_server.read_exact(&mut got)).await.unwrap().unwrap();
        assert_eq!(&got, b"ping");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    // #299: nor does it block a write on the SAME connection — an upload writes while it waits.
    #[tokio::test]
    async fn a_pending_read_does_not_block_a_write_on_the_same_connection() {
        let t = Arc::new(MachineTransport::default());
        let (id, mut server) = pair(&t).await;

        let _pending = {
            let t = t.clone();
            tokio::spawn(async move { t.read(id, 64, 9_000).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;

        t.write(id, b"data").await.unwrap();
        let mut got = [0u8; 4];
        timeout(Duration::from_secs(1), server.read_exact(&mut got)).await.unwrap().unwrap();
        assert_eq!(&got, b"data");
    }

    #[tokio::test]
    async fn reads_what_arrives_and_reports_silence_as_empty() {
        let t = MachineTransport::default();
        let (id, mut server) = pair(&t).await;

        assert_eq!(t.read(id, 64, 50).await.unwrap(), Vec::<u8>::new());
        server.write_all(b"hello").await.unwrap();
        assert_eq!(t.read(id, 64, 1_000).await.unwrap(), b"hello".to_vec());
        drop(server);
        assert!(t.read(id, 64, 1_000).await.unwrap_err().contains("closed the connection"));
    }

    #[tokio::test]
    async fn a_closed_or_unknown_connection_is_an_error() {
        let t = MachineTransport::default();
        let (id, _server) = pair(&t).await;
        t.close(id).await;
        assert!(t.read(id, 64, 50).await.unwrap_err().contains("unknown connection"));
        assert!(t.write(id, b"x").await.unwrap_err().contains("unknown connection"));
        t.close(id).await; // closing twice is not an error
    }
}
