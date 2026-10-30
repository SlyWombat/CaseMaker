// The machine bridge's transports: raw sockets and USB serial, desktop-only (#255, #775).
//
// This module is deliberately DUMB. It knows no framing, no CRC and no command — those live in
// `casemaker-app/src/platform/desktop/protocol.ts`, where they are unit-tested against scripted
// replies with no machine present. Here there are only the transport calls
// (`Z1-Bridge-Protocol.md` §7): listen for a UDP broadcast, and open / write / read / close a
// connection. #775 adds USB serial as a SECOND connection kind behind the same registry and the
// same write/read/close commands — the protocol layer above cannot tell the two apart, which is
// exactly the point: the framing is unchanged.
//
// Serial is Windows-only because the installer ships Windows-only (#403). `serialport` is a
// target-scoped dependency; an unwrapped build (Linux/macOS) still compiles this file, with both
// serial commands answering a plain refusal. The transport itself (the registry, the read/write
// loops and their tests) is portable, so `cargo test` on any host exercises the fake port.
//
// The web build cannot reach any of this: no browser opens a raw socket, and the TypeScript side
// only calls these through the `canDriveMachine` guard (#181).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{watch, Mutex};
use tokio::time::{timeout, Duration, Instant};

/// A TCP connection, split so a read and a write never wait on each other (#299).
///
/// The halves have their OWN locks, and the registry lock (below) is held only to find or remove an
/// entry — never across an `await` on the socket. Before this, `machine_tcp_read` held the single
/// registry lock for its whole timeout: an upload waiting nine seconds for a packet request blocked
/// every other call on every connection, including the `machine_tcp_close` that was meant to abort it.
struct TcpConn {
    reader: Mutex<OwnedReadHalf>,
    writer: Mutex<OwnedWriteHalf>,
    /// Flipped to `true` by `close`. A read in progress selects on it, so closing ends the read now
    /// instead of after its timeout. A `watch` rather than a `Notify`: a read that begins after the
    /// close still sees `true`, where a notification would have been missed.
    closed: watch::Sender<bool>,
}

/// How long one blocking serial read or write may wait before its worker re-checks whether the
/// connection was closed. The caller's own timeout is served by looping; this slice only bounds how
/// long `close` takes to end a call already parked in the OS. Short enough to keep #299's promise
/// (close ends a read now, not after its timeout), long enough not to spin.
const SERIAL_SLICE: Duration = Duration::from_millis(50);

/// One serial port's blocking I/O, behind the same read/write/close registry as a TCP socket.
///
/// A trait rather than a direct `serialport` handle for one reason: a unit test cannot open a COM
/// port, and the registry's promises (#299: close ends a pending read; a write does not wait on a
/// read) are about the registry, not the hardware. `FakeSerial` in the tests is a two-way pipe that
/// honours the same contract.
trait SerialIo: Send + 'static {
    /// Read up to `buf.len()` bytes, waiting at most `timeout` for the first byte. A timeout is
    /// reported as `ErrorKind::TimedOut`, the way `serialport` reports it.
    fn read(&mut self, buf: &mut [u8], timeout: Duration) -> std::io::Result<usize>;
    /// Write at most `data.len()` bytes, waiting at most `timeout`. A short write is legal; the
    /// caller continues with the remainder.
    fn write(&mut self, data: &[u8], timeout: Duration) -> std::io::Result<usize>;
}

/// A serial connection (#775). The blocking calls run on tokio's blocking pool; `closed`/`interrupt`
/// give it the same close semantics as a socket.
struct SerialConn {
    reader: Arc<std::sync::Mutex<Box<dyn SerialIo>>>,
    writer: Arc<std::sync::Mutex<Box<dyn SerialIo>>>,
    closed: watch::Sender<bool>,
    /// Set by `close`. The blocking worker checks it between slices, so a call parked in the OS
    /// returns within `SERIAL_SLICE` and its port clone is dropped promptly — a COM port held open
    /// by an abandoned read would keep the next connection out.
    interrupt: Arc<AtomicBool>,
}

/// A live connection: a TCP socket (#255) or a serial port (#775). Everything above sees one id
/// space and one read/write/close surface, which is what lets the protocol layer stay unchanged.
enum Conn {
    Tcp(TcpConn),
    Serial(SerialConn),
}

impl Conn {
    fn closed_flag(&self) -> &watch::Sender<bool> {
        match self {
            Conn::Tcp(c) => &c.closed,
            Conn::Serial(c) => &c.closed,
        }
    }
}

/// Live connections, keyed by an id handed to the TypeScript side. One per explicit action.
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
        self.insert(Arc::new(Conn::Tcp(TcpConn {
            reader: Mutex::new(r),
            writer: Mutex::new(w),
            closed,
        })))
        .await
    }

    /// Take ownership of an open serial port and return its id. The two handles refer to the same
    /// port — one for reading, one for writing — so a pending read cannot block a write (#299).
    async fn adopt_serial(&self, reader: Box<dyn SerialIo>, writer: Box<dyn SerialIo>) -> u64 {
        let (closed, _) = watch::channel(false);
        self.insert(Arc::new(Conn::Serial(SerialConn {
            reader: Arc::new(std::sync::Mutex::new(reader)),
            writer: Arc::new(std::sync::Mutex::new(writer)),
            closed,
            interrupt: Arc::new(AtomicBool::new(false)),
        })))
        .await
    }

    async fn insert(&self, conn: Arc<Conn>) -> u64 {
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

    /// Connect to a controller's command channel and return a connection id. Shared by the Tauri
    /// command (`machine_tcp_connect`) and the HTTP machine API (`machine_api.rs`) so the desktop
    /// webview and a LAN browser reach the SAME sockets through one piece of code.
    pub async fn connect(&self, host: &str, port: u16, timeout_ms: u64) -> Result<u64, String> {
        let connect = TcpStream::connect((host, port));
        let stream = timeout(Duration::from_millis(timeout_ms.max(1)), connect)
            .await
            .map_err(|_| format!("connecting to {host}:{port} timed out after {timeout_ms} ms"))?
            .map_err(|e| format!("could not connect to {host}:{port}: {e}"))?;
        // Small framed commands and their replies: Nagle would add latency for no benefit.
        stream.set_nodelay(true).map_err(|e| format!("could not configure the connection: {e}"))?;
        Ok(self.adopt(stream).await)
    }

    /// Open a serial port and return a connection id for the same write/read/close calls (#775).
    ///
    /// The port is opened and cloned on the blocking pool because `serialport` is a blocking API
    /// and this is an async runtime. 8N1 and no flow control are its defaults; the Z1's USB CDC
    /// link is a byte pipe that ignores the baud rate, but Windows still requires one, so it is a
    /// parameter rather than a compiled constant.
    #[cfg(windows)]
    pub async fn connect_serial(&self, port: &str, baud: u32, timeout_ms: u64) -> Result<u64, String> {
        let name = port.to_string();
        let timeout = Duration::from_millis(timeout_ms.max(1));
        let (reader, writer) =
            tokio::task::spawn_blocking(move || -> Result<(Box<dyn SerialIo>, Box<dyn SerialIo>), String> {
                let reader = serialport::new(&name, baud)
                    .timeout(timeout)
                    .open()
                    .map_err(|e| format!("could not open {name}: {e}"))?;
                let writer =
                    reader.try_clone().map_err(|e| format!("could not open a writer on {name}: {e}"))?;
                Ok((
                    Box::new(RealSerial(reader)) as Box<dyn SerialIo>,
                    Box::new(RealSerial(writer)) as Box<dyn SerialIo>,
                ))
            })
            .await
            .map_err(|e| format!("opening {port} failed: {e}"))??;
        Ok(self.adopt_serial(reader, writer).await)
    }

    /// Serial is Windows-only because the desktop installer is (#403). Everywhere else the command
    /// exists and says so, rather than disappearing from the interface and leaving a caller to
    /// wonder whether the port or the build was wrong.
    #[cfg(not(windows))]
    pub async fn connect_serial(&self, _port: &str, _baud: u32, _timeout_ms: u64) -> Result<u64, String> {
        Err("USB serial is available only in the Windows desktop build".to_string())
    }

    pub async fn write(&self, conn: u64, data: &[u8]) -> Result<(), String> {
        let c = self.get(conn).await?;
        match &*c {
            Conn::Tcp(t) => {
                let mut w = t.writer.lock().await;
                w.write_all(data).await.map_err(|e| format!("write failed: {e}"))?;
                w.flush().await.map_err(|e| format!("flush failed: {e}"))?;
                Ok(())
            }
            Conn::Serial(s) => write_serial(s, data).await,
        }
    }

    pub async fn read(&self, conn: u64, max: usize, timeout_ms: u64) -> Result<Vec<u8>, String> {
        let c = self.get(conn).await?;
        match &*c {
            Conn::Tcp(t) => read_tcp(t, max, timeout_ms).await,
            Conn::Serial(s) => read_serial(s, max, timeout_ms).await,
        }
    }

    pub async fn close(&self, conn: u64) {
        // Remove first, so no new call can find it; then wake any read that is already waiting.
        let removed = self.conns.lock().await.remove(&conn);
        if let Some(c) = removed {
            if let Conn::Serial(s) = &*c {
                // The blocking worker cannot watch the async flag; it gets its own.
                s.interrupt.store(true, Ordering::SeqCst);
            }
            let _ = c.closed_flag().send(true);
        }
    }
}

/// Read from a TCP half, waiting up to `timeout_ms` for bytes.
async fn read_tcp(c: &TcpConn, max: usize, timeout_ms: u64) -> Result<Vec<u8>, String> {
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

/// Read from a serial port. The OS call blocks, so it runs on the blocking pool in `SERIAL_SLICE`
/// steps until bytes arrive, the caller's window elapses, or the connection is closed — the same
/// three answers `read_tcp` gives, in the same order of preference.
async fn read_serial(c: &SerialConn, max: usize, timeout_ms: u64) -> Result<Vec<u8>, String> {
    let mut closed = c.closed.subscribe();
    let reader = Arc::clone(&c.reader);
    let interrupt = Arc::clone(&c.interrupt);
    let total = Duration::from_millis(timeout_ms.max(1));
    let task = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
        let started = std::time::Instant::now();
        let mut buf = vec![0u8; max.max(1)];
        loop {
            if interrupt.load(Ordering::SeqCst) {
                // The close's own select arm is what answers the caller; this only releases the
                // port clone promptly.
                return Ok(Vec::new());
            }
            let left = match total.checked_sub(started.elapsed()) {
                Some(left) if !left.is_zero() => left,
                _ => return Ok(Vec::new()), // the caller's window elapsed
            };
            let mut port = reader.lock().unwrap_or_else(|e| e.into_inner());
            match port.read(&mut buf, left.min(SERIAL_SLICE)) {
                Ok(0) => {}
                Ok(n) => {
                    buf.truncate(n);
                    return Ok(buf);
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => return Err(e),
            }
        }
    });
    tokio::select! {
        _ = closed.wait_for(|v| *v) => Err("the connection was closed".to_string()),
        joined = task => match joined {
            Ok(Ok(bytes)) => Ok(bytes),
            Ok(Err(e)) => Err(format!("read failed: {e}")),
            Err(e) => Err(format!("serial read failed: {e}")),
        },
    }
}

/// Write every byte to a serial port, on the blocking pool in `SERIAL_SLICE` steps so a close is
/// noticed rather than waiting out a write the OS has parked.
async fn write_serial(c: &SerialConn, data: &[u8]) -> Result<(), String> {
    let writer = Arc::clone(&c.writer);
    let interrupt = Arc::clone(&c.interrupt);
    let data = data.to_vec();
    let task = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut port = writer.lock().unwrap_or_else(|e| e.into_inner());
        let mut written = 0;
        while written < data.len() {
            if interrupt.load(Ordering::SeqCst) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "the connection was closed",
                ));
            }
            match port.write(&data[written..], SERIAL_SLICE) {
                Ok(0) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::WriteZero,
                        "the serial port accepted no bytes",
                    ))
                }
                Ok(n) => written += n,
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    });
    match task.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(format!("write failed: {e}")),
        Err(e) => Err(format!("serial write failed: {e}")),
    }
}

/// The real Windows serial port (#775). `serialport` is a blocking `Read + Write` handle; the
/// registry above decides when and on which thread it is called.
#[cfg(windows)]
struct RealSerial(Box<dyn serialport::SerialPort>);

#[cfg(windows)]
impl SerialIo for RealSerial {
    fn read(&mut self, buf: &mut [u8], timeout: Duration) -> std::io::Result<usize> {
        use std::io::Read as _;
        self.0.set_timeout(timeout).map_err(std::io::Error::other)?;
        self.0.read(buf)
    }

    fn write(&mut self, data: &[u8], timeout: Duration) -> std::io::Result<usize> {
        use std::io::Write as _;
        self.0.set_timeout(timeout).map_err(std::io::Error::other)?;
        self.0.write(data)
    }
}

/// One discovery datagram as received (#275): its text, and when this listener took it off the
/// socket, in Unix epoch milliseconds.
///
/// The datagram carries no time of its own, so receipt is the only time there is to report. It orders
/// the datagrams of one window — and so dates a field-4 state change — and says nothing about the
/// controller's clock.
#[derive(Debug, Clone, Serialize)]
pub struct UdpDatagram {
    pub at: i64,
    pub text: String,
}

/// Now, as Unix epoch milliseconds. A clock set before 1970 reads as 0 rather than panicking: this is
/// a timestamp on an observation line, not a reason to fail a discovery.
fn epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One discovery datagram AND the address it came from (#661).
///
/// The peer is a fact of the socket, not of the payload, so it travels beside the datagram rather
/// than inside it: the client's JSON is `{at, text}` and must not grow a field a parser could be
/// surprised by. The server uses it to vouch for a machine it has heard but not yet recorded.
pub struct HeardDatagram {
    pub datagram: UdpDatagram,
    /// The sender's address as the socket saw it — for the Z1, its LAN address on the broadcast.
    pub peer: std::net::SocketAddr,
}

/// Listen on `0.0.0.0:port` for `window_ms` and return each datagram with the time it arrived.
///
/// Discovery is passive: the machine broadcasts, we listen (`Z1-Bridge-Protocol.md` §2). Nothing
/// is sent. The window resets only in the sense that we keep listening until the deadline; each
/// datagram is collected. A port already bound (for example by Makera Studio) is reported clearly
/// rather than mistaken for "no machines found".
#[tauri::command(rename_all = "snake_case")]
pub async fn machine_udp_listen(port: u16, window_ms: u64) -> Result<Vec<UdpDatagram>, String> {
    udp_listen(port, window_ms).await
}

/// The discovery listen, shared by the Tauri command and the HTTP machine API (`machine_api.rs`).
pub async fn udp_listen(port: u16, window_ms: u64) -> Result<Vec<UdpDatagram>, String> {
    Ok(udp_listen_with_peers(port, window_ms)
        .await?
        .into_iter()
        .map(|heard| heard.datagram)
        .collect())
}

/// The same listen, keeping who sent each datagram (#661). The HTTP API records those senders for a
/// few minutes; the desktop command has no use for an address it could reach anyway.
pub async fn udp_listen_with_peers(port: u16, window_ms: u64) -> Result<Vec<HeardDatagram>, String> {
    let socket = UdpSocket::bind(("0.0.0.0", port)).await.map_err(|e| {
        format!("could not bind UDP {port} for discovery: {e} (another program, such as Makera Studio, may be using it)")
    })?;

    let deadline = Instant::now() + Duration::from_millis(window_ms);
    let mut out: Vec<HeardDatagram> = Vec::new();
    let mut buf = [0u8; 256];
    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        match timeout(deadline - now, socket.recv_from(&mut buf)).await {
            Ok(Ok((n, addr))) => {
                // Stamped here, the moment the socket handed the bytes over and before any decoding:
                // the time belongs to arrival, not to how long it took to read the text (#275).
                let at = epoch_millis();
                if let Ok(text) = std::str::from_utf8(&buf[..n]) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        out.push(HeardDatagram {
                            datagram: UdpDatagram { at, text: trimmed.to_string() },
                            peer: addr,
                        });
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
    state.connect(&host, port, timeout_ms).await
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

/// One serial port as the system lists it (#775). `label` is the port's own descriptor when the
/// system offers one ("USB-SERIAL CH340"); empty when it does not, so a bare `COM4` stands alone.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortSummary {
    pub port_name: String,
    pub label: String,
    /// True for a USB-attached port. The Z1's cable is one; a Bluetooth serial pair is not, and
    /// the picker says which it is rather than making the operator guess.
    pub usb: bool,
}

/// List this machine's serial ports. Reached only from the desktop webview (the TypeScript side
/// hides the picker where there is no such command); a port that cannot be described still appears
/// by name — a person looking for the Z1's cable must be able to pick it.
#[tauri::command(rename_all = "snake_case")]
pub async fn machine_serial_list() -> Result<Vec<SerialPortSummary>, String> {
    serial_list().await
}

#[cfg(windows)]
pub async fn serial_list() -> Result<Vec<SerialPortSummary>, String> {
    let ports = tokio::task::spawn_blocking(serialport::available_ports)
        .await
        .map_err(|e| format!("listing serial ports failed: {e}"))?
        .map_err(|e| format!("listing serial ports failed: {e}"))?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let (label, usb) = match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => {
                    let mut parts: Vec<String> = Vec::new();
                    if let Some(m) = &info.manufacturer {
                        parts.push(m.clone());
                    }
                    if let Some(product) = &info.product {
                        parts.push(product.clone());
                    }
                    (parts.join(" ").trim().to_string(), true)
                }
                _ => (String::new(), false),
            };
            SerialPortSummary { port_name: p.port_name, label, usb }
        })
        .collect())
}

#[cfg(not(windows))]
pub async fn serial_list() -> Result<Vec<SerialPortSummary>, String> {
    Err("USB serial is available only in the Windows desktop build".to_string())
}

/// Open a serial port and return a connection id for the SAME write/read/close calls as a socket.
///
/// This is the second transport the module header anticipated: nothing above it changes. The
/// identify/status/console/upload protocol runs over it byte-for-byte as it does over TCP 2222.
#[tauri::command(rename_all = "snake_case")]
pub async fn machine_serial_connect(
    state: State<'_, MachineTransport>,
    port: String,
    baud: u32,
    timeout_ms: u64,
) -> Result<u64, String> {
    state.connect_serial(&port, baud, timeout_ms).await
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

    // ---------------------------------------------------------------------------------------
    // #775 — the serial connection, against a fake port. There is no COM port in a unit test, and
    // the promises here are the REGISTRY's (one id space, silence as empty, close ends a parked
    // read, a read does not block a write) rather than any driver's.
    // ---------------------------------------------------------------------------------------

    /// A serial port that is two in-memory buffers. Both handles share them, as two handles to one
    /// real port do; reads honour the timeout the way `serialport` reports it.
    #[derive(Default)]
    struct FakeSerial {
        input: Arc<std::sync::Mutex<std::collections::VecDeque<u8>>>,
        output: Arc<std::sync::Mutex<Vec<u8>>>,
    }

    impl FakeSerial {
        fn handle(&self) -> FakeSerial {
            FakeSerial { input: Arc::clone(&self.input), output: Arc::clone(&self.output) }
        }

        fn feed(&self, bytes: &[u8]) {
            self.input.lock().unwrap().extend(bytes.iter().copied());
        }

        fn written(&self) -> Vec<u8> {
            self.output.lock().unwrap().clone()
        }
    }

    impl SerialIo for FakeSerial {
        fn read(&mut self, buf: &mut [u8], timeout: Duration) -> std::io::Result<usize> {
            let deadline = std::time::Instant::now() + timeout;
            loop {
                {
                    let mut q = self.input.lock().unwrap();
                    if !q.is_empty() {
                        let n = q.len().min(buf.len());
                        for (i, b) in q.drain(..n).enumerate() {
                            buf[i] = b;
                        }
                        return Ok(n);
                    }
                }
                if std::time::Instant::now() >= deadline {
                    return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "no bytes"));
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        }

        fn write(&mut self, data: &[u8], _timeout: Duration) -> std::io::Result<usize> {
            self.output.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
    }

    /// Adopt one fake port into the transport with a reader and a writer handle, as
    /// `connect_serial` does with `try_clone`.
    async fn serial_pair(t: &MachineTransport, port: &FakeSerial) -> u64 {
        t.adopt_serial(Box::new(port.handle()), Box::new(port.handle())).await
    }

    #[tokio::test]
    async fn serial_lines_round_trip_through_the_same_registry() {
        let t = MachineTransport::default();
        let port = FakeSerial::default();
        let id = serial_pair(&t, &port).await;

        t.write(id, b"M482.5\n").await.unwrap();
        assert_eq!(port.written(), b"M482.5\n");

        port.feed(b"ok\n");
        assert_eq!(t.read(id, 64, 1_000).await.unwrap(), b"ok\n".to_vec());
    }

    // The protocol layer tells "not yet" from "gone" by these two shapes; a serial port must answer
    // the first exactly as a socket does.
    #[tokio::test]
    async fn a_silent_serial_port_reads_as_empty() {
        let t = MachineTransport::default();
        let port = FakeSerial::default();
        let id = serial_pair(&t, &port).await;
        assert_eq!(t.read(id, 64, 50).await.unwrap(), Vec::<u8>::new());
    }

    #[tokio::test]
    async fn close_ends_a_pending_serial_read_at_once() {
        let t = Arc::new(MachineTransport::default());
        let port = FakeSerial::default();
        let id = serial_pair(&t, &port).await;

        let reader = {
            let t = Arc::clone(&t);
            tokio::spawn(async move { t.read(id, 64, 9_000).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await; // let the read park

        let started = Instant::now();
        t.close(id).await;
        let outcome = timeout(Duration::from_secs(2), reader).await.expect("the read did not end").unwrap();

        assert!(outcome.is_err(), "a closed connection is an error, not an empty read");
        assert!(started.elapsed() < Duration::from_secs(1), "close waited out the read's timeout");
    }

    // #299's third promise on the new transport: an upload writes while another side waits.
    #[tokio::test]
    async fn a_pending_serial_read_does_not_block_a_write() {
        let t = Arc::new(MachineTransport::default());
        let port = FakeSerial::default();
        let id = serial_pair(&t, &port).await;

        let _pending = {
            let t = Arc::clone(&t);
            tokio::spawn(async move { t.read(id, 64, 9_000).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;

        let started = Instant::now();
        t.write(id, b"packet").await.unwrap();
        assert_eq!(port.written(), b"packet");
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn a_closed_serial_connection_is_an_error() {
        let t = MachineTransport::default();
        let port = FakeSerial::default();
        let id = serial_pair(&t, &port).await;
        t.close(id).await;
        assert!(t.read(id, 64, 50).await.unwrap_err().contains("unknown connection"));
        assert!(t.write(id, b"x").await.unwrap_err().contains("unknown connection"));
        t.close(id).await; // closing twice is not an error
    }

    // #275: the reply's field names ARE the contract with the TypeScript side, which reads `{ at,
    // text }` (`UdpDatagram` in `protocol.ts`). A discovery needs a machine on the LAN, so this is
    // the one part of that seam a test can hold.
    #[test]
    fn a_datagram_serialises_to_the_names_the_typescript_reads() {
        let json = serde_json::to_string(&UdpDatagram {
            at: 1_700_000_000_000,
            text: "Makera_Z1_010290,192.168.10.43,2222,0,Idle".to_string(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"at":1700000000000,"text":"Makera_Z1_010290,192.168.10.43,2222,0,Idle"}"#
        );
    }

    // #275: epoch MILLISECONDS, because the TypeScript side compares this against `Date.now()`. A
    // seconds figure would arrive as a plausible-looking 1970 date rather than as an error.
    #[test]
    fn the_arrival_time_is_epoch_milliseconds() {
        // 2023-11-14 in millis (1.70e12). The same instant in seconds (1.70e9) fails, by three orders.
        assert!(epoch_millis() > 1_700_000_000_000);
    }
}
