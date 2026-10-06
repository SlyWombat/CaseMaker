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

use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::time::{timeout, Duration, Instant};

/// Live TCP connections, keyed by an id handed to the TypeScript side. One per explicit action.
#[derive(Default)]
pub struct MachineTransport {
    conns: tokio::sync::Mutex<HashMap<u64, TcpStream>>,
    next_id: AtomicU64,
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

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.conns.lock().await.insert(id, stream);
    Ok(id)
}

/// Write bytes to an open connection.
#[tauri::command(rename_all = "snake_case")]
pub async fn machine_tcp_write(
    state: State<'_, MachineTransport>,
    conn: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut conns = state.conns.lock().await;
    let stream = conns
        .get_mut(&conn)
        .ok_or_else(|| format!("unknown connection {conn}"))?;
    stream
        .write_all(&data)
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    stream.flush().await.map_err(|e| format!("flush failed: {e}"))?;
    Ok(())
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
    let mut conns = state.conns.lock().await;
    let stream = conns
        .get_mut(&conn)
        .ok_or_else(|| format!("unknown connection {conn}"))?;
    let mut buf = vec![0u8; max.max(1)];
    match timeout(Duration::from_millis(timeout_ms.max(1)), stream.read(&mut buf)).await {
        Ok(Ok(0)) => Err("the machine closed the connection".to_string()),
        Ok(Ok(n)) => {
            buf.truncate(n);
            Ok(buf)
        }
        Ok(Err(e)) => Err(format!("read failed: {e}")),
        Err(_) => Ok(Vec::new()), // no data within the timeout
    }
}

/// Close and forget a connection.
#[tauri::command(rename_all = "snake_case")]
pub async fn machine_tcp_close(state: State<'_, MachineTransport>, conn: u64) -> Result<(), String> {
    state.conns.lock().await.remove(&conn);
    Ok(())
}
