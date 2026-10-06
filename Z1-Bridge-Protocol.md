# The Z1 network protocol, as the bridge implements it

Status as of 2026-10-05. **Nothing here is verified against the machine.** It is a written
description of the *interoperability facts* of Makera's controller protocol, produced so the bridge
can be implemented from this document rather than with the vendor's source open beside it. The
implementation lives in `casemaker-app/src/platform/desktop/` (protocol) and
`casemaker-app/src-tauri/src/machine.rs` (transport).

## Provenance, and the licence constraint

`MakeraInc/CarveraController` is **GPL-3.0**; Case Maker is **Apache-2.0**. GPL-3.0 code cannot be
copied or adapted into this repo, and `CarveraProfiles` carries no licence at all. What follows is
limited to protocol *facts* — port numbers, byte layouts, command sequences — which are
interoperability information and fine to learn and reimplement. No code, comment or file from that
repository is copied here, and none was open while the implementation was written. The one
behavioral reading of the firmware (`MakeraInc/MakeraZ1Firmware`, also GPL-3.0) is where noted.

Three sources, in order of trust, exactly as `machine.ts` records for its numbers:

1. **The published client** (`CarveraController/src/Controller.py`, `WIFIStream.py`, `XMODEM.py`) —
   the wire format the machine speaks. A reading of a program, not of the device.
2. **The Z1 firmware config** (`MakeraZ1Firmware/src/configZ1.default`) — port numbers and the
   machine name, as shipped.
3. Our own earlier docs (`/Fabrication.md` §5.7, `/Makera-Parity.md` §14.4) — which carry
   `M482.5` → IP and `M482.4` → MAC.

Every number the implementation uses carries this provenance. **PROVISIONAL** marks a figure
read from a program and never confirmed on hardware; #208/#209's bench work is what moves it.

## 1. Two sockets

| Socket | Port | Direction | What it is |
|---|---|---|---|
| TCP | **2222** | we connect out | The command channel. All G-code, all status, and the file transfer run over this one connection. |
| UDP | **3333** | the machine sends, we listen | Discovery broadcast. We bind and listen; the machine pushes. |
| UDP | 4444 | the machine listens | Compile-time default `wifi.udp_recv_port`; unused by the published client and unused by us. |

Provenance: `configZ1.default` lines 83–85 (`wifi.tcp_port 2222`, `wifi.udp_send_port 3333`,
`wifi.udp_recv_port 4444`); `WIFIStream.py` constants `TCP_PORT = 2222`, `UDP_PORT = 3333`.
`wifi.machine_name CARVERA_AIR_01001` on the same config's line 450 is the template the discovery
name follows.

**The web build cannot do this.** No browser opens a raw TCP or UDP socket; the desktop (Tauri)
build is the only one where this code is reachable at all. The `canDriveMachine` capability in
`src/platform/capabilities.ts` is what decides.

**Windows only for development.** WSL2's NAT does not carry the LAN broadcast, so UDP discovery
must be exercised from the Windows side (`/Fabrication.md` §5.7, §8).

## 2. Discovery — UDP 3333, passive

The published client does not send a probe. It binds `0.0.0.0:3333`, waits up to **3 s**, and
collects whatever the machine(s) broadcast on the LAN and in the machine's own AP mode. The
listening window resets on each datagram received.

Each datagram is **UTF-8, comma-separated**, at most 128 bytes:

```
<name>,<ip>,<tcp-port>,<busy>
```

- field 0 — machine name, e.g. `CARVERA_AIR_01001`. Also the de-duplication key: the first
  datagram for a given name wins.
- field 1 — the machine's IP address (the address to connect to).
- field 2 — the TCP command port (`2222` in the shipped config).
- field 3 — `1` means busy, anything else means not busy.
- A datagram with **four fields or fewer** is discarded (the client requires `len(fields) > 3`).

Our parser is deliberately tolerant: it requires a non-empty name and IP, defaults the port to
2222 when the field is missing or not a number, and treats any value other than `1` as not busy.
It ignores extra trailing fields rather than rejecting the machine.

## 3. The command envelope

On the current ("new") firmware every command and every reply is a **binary frame**:

```
 +--------+------------------+------------+---------------+--------+--------+
 | 0x86 0x68 | length (2 bytes, big-endian) | type (1) | data (N bytes) | CRC16 (2 bytes, big-endian) | 0x55 0xAA |
 +--------+------------------+------------+---------------+--------+--------+
```

- **Header** `0x8668`, big-endian on the wire, **excluded** from the CRC.
- **length** — big-endian, and it counts **type + data + CRC**, i.e. `1 + N + 2`. It does **not**
  count the header or the footer, so the frame on the wire is `length + 6` bytes
  (2 header + 2 length + `length` + 2 footer). Getting this wrong by the footer is the easiest
  way to desync the reader, so the decoder derives the total from the field and checks the footer
  at `total − 2`.
- **type** — one byte; see the table below.
- **data** — N bytes, type-specific.
- **CRC16** — big-endian, computed over `length (2) + type (1) + data (N)` — that is, everything
  between the header and the CRC.
- **footer** `0x55AA`, big-endian, **excluded** from the CRC.

### CRC16-CCITT

16-bit CRC-CCITT with polynomial `0x1021`, **initial value 0x0000**, no final XOR, big-endian on
the wire. This is the "CRC-16/CCITT-FALSE" algorithm with a zero initial value (not the 0xFFFF
that variant's name usually implies), computed over `length + type + data` as above. The
implementation and its test vectors live with the protocol code.

### Packet types

| Type | Name | Meaning |
|---|---|---|
| `0xA1` | control, single byte | One-byte command; data is exactly one byte. |
| `0xA2` | control, multi | A UTF-8 text command. **No trailing newline** is added on the new-firmware path. |
| `0xB0` | file start | A `upload <name>` / `download <name>` transfer command. A trailing newline **is** appended before framing. |
| `0xB1` | file MD5 | File-transfer handshake: the MD5 digest as ASCII hex. |
| `0xB2` | file view | File metadata: packet count and packet size. |
| `0xB3` | file data | One packet: a 4-byte big-endian sequence number, then the file bytes. |
| `0xB4` | file end | Transfer complete. |
| `0xB5` | file cancel | Abort. Sent by either side. |
| `0xB6` | file retry | Re-send the previous packet. |

### Reply types (what the machine sends)

| Type | Meaning |
|---|---|
| `0x81` | Status-query response. |
| `0x82` | Diagnostics response. |
| `0x83` | Load info. |
| `0x84` | Load finished. |
| `0x85` | Load error. |
| `0x90` | Unsolicited information, shown to the operator. |

Text replies carry UTF-8 in the frame data. Our reader decodes any frame whose type is one of
these and treats types below `0xB1` (other than the file types) as status/info to be surfaced,
not as protocol errors.

### Single-byte commands (`0xA1`)

The command characters we use:

| Byte | Char | Meaning |
|---|---|---|
| `0x3F` | `?` | Request machine status. The reply is a status frame (`0x81`). |

Others in the published client (`!`, `~`, `0x18` e-stop) are **not** used by this bridge — see §8.

### Legacy firmware

The published client branches on a firmware version flag. On **legacy** firmware the same commands
are sent as **newline-terminated UTF-8 text** with no binary envelope, and files move by classic
XMODEM-CRC (SOH `0x01`, 128-byte blocks, CRC-CCITT) instead of the framed transfer of §5. The Z1
ships with the current firmware, so the bridge targets the framed protocol. A legacy path is
documented here so a future reader knows why the branch exists, and is deliberately **not**
implemented in the first pass.

## 4. Identify — `M482.5` and `M482.4`

To confirm we are talking to *our* machine and not a neighbour's, the bridge sends two text
commands over the TCP channel as `0xA2` frames:

- **`M482.5`** → the machine's **IP address**.
- **`M482.4`** → the machine's **MAC address**.

The reply arrives as one or more text frames on the same connection. The exact reply text is
**PROVISIONAL**: `/Fabrication.md` §5.7 and `/Makera-Parity.md` §14.4 name the commands and their
meanings, but the literal reply string has not been seen on hardware. The bridge therefore does
**not** parse the reply as an exact format — it collects the text frames received in a short window
and extracts the first IPv4-shaped token for the IP and the first MAC-shaped token
(six colon- or dash-separated hex pairs) for the MAC. A reply in which neither is found is reported
as *unidentified*, never guessed.

## 5. File upload (current firmware)

Filenames are sent with spaces replaced by byte `0x01` and backslashes turned into forward slashes,
then a newline is appended and the text is framed as type `0xB0`.

The transfer is **receiver-driven**: the machine asks for each packet by sequence number; the
client answers. The client is the *sender*. Steps, in order:

1. Frame `0xB0` with `upload <name>\n`.
2. Frame `0xB1` with the file's **MD5 digest as 32 ASCII hex characters**.
3. Read frames until one of the file types arrives:
   - `0xB5` (cancel) — the machine refused or aborted the transfer. **Report it; do not retry.**
   - `0xB6` (retry) — re-send the last frame unchanged.
   - `0xB1` (MD5) — re-send the MD5 frame.
   - `0xB2` (view) — the machine wants file metadata. Reply with a **`0xB2` frame whose data is a
     4-byte big-endian packet count followed by a 2-byte big-endian packet size**. Packet size is
     **8192** on the WiFi transport (`128` on USB); packet count is `ceil(fileSize / packetSize)`.
     Reset the expected sequence to 0.
   - `0xB3` (data request) — the machine's data is a 4-byte big-endian sequence number.
     - if `seq == lastSeq`: re-send the identical previous data frame;
     - otherwise read the packet at byte offset `(seq − 1) × packetSize` (the sequence is 1-based),
       build a `0xB3` frame with a 4-byte big-endian `seq` followed by up to `packetSize` bytes of
       the file, and send it. Set `lastSeq = seq`.
   - `0xB4` (end) — the machine accepted the whole file. **Success.**
4. If **9 s** pass with no frame at all on the channel, send `0xB5` (cancel) and fail. The
   published client uses a 40 s read timeout *per frame attempt* and this 9 s inactivity cutoff;
   both are kept.

An MD5 match on a file the machine already has is answered by the machine with `0xB5` after the
MD5 step — *no transfer*. Our bridge treats a cancel at that point as "already present", which is
distinct from a refusal and is reported as such.

**Nothing reaches the machine unverified.** The bridge's upload entry point accepts only a program
that has already passed the verifier (`/Fabrication.md` §5.7, #174) and the gated action (#206).
There is no bypass: the type it takes is one the verifier alone produces, and the runtime
re-checks the report's `ok` flag before opening a socket. This is CNC-2's architecture, and it is
enforced in `machineBridge.ts`, not merely documented.

## 6. Status — `?`

Status is a single `0xA1` frame carrying `0x3F` (`?`). The machine replies with one or more `0x81`
frames whose text is the controller's status line. The bridge returns that text **verbatim** and
says so when no reply arrives, rather than inventing a machine state.

## 7. Transport interface

The protocol layer above is transport-agnostic. It runs against a five-call interface —
`udpListen`, `tcpConnect`, `tcpWrite`, `tcpRead`, `tcpClose` — implemented today by Tauri commands
in `src-tauri/src/machine.rs` (raw sockets, desktop build only). USB can follow by adding a second
implementation behind the same interface (`/Fabrication.md` §5.7: "a transport interface behind
the protocol layer so USB can follow"); nothing in the protocol layer changes.

The Rust side is deliberately **dumb**: it moves bytes and knows no framing, no CRC and no command.
All protocol logic lives in TypeScript, where it is unit-tested against the machine's replies
without a machine.

Known limitation, recorded rather than hidden: every `tcpRead`/`tcpWrite` is one IPC round-trip,
so an 8192-byte packet crosses the boundary as a byte array. First-pass `.nc` files are small; if
throughput ever matters, framing can move into Rust behind the same TypeScript interface without
touching callers.

## 8. Safety, and what is deliberately absent

- **Nothing is sent without an explicit user action.** Discovery listens passively; the connect,
  identify, upload and status calls each run only when the caller asks for them. There is no
  polling loop and no background connection.
- **No motion without a file.** Jog, DRO, MDI and the pendant are out of the first pass
  (`/Fabrication.md` §14.4 R10). This bridge can upload a verified `.nc` and report status; it
  cannot move an axis on its own.
- The single-byte e-stop byte is **not** wired: an e-stop that travels over the same socket the
  bridge is mid-transfer on is worse than useless. The physical stop is the stop.
- A machine refusal is surfaced as a refusal. The upload result has an explicit *refused* outcome
  and it is never retried automatically.

## 9. Open, and how it closes

| Question | Status | Closes when |
|---|---|---|
| `M482.5`/`M482.4` literal reply format | PROVISIONAL | First run against the machine (#209). |
| Does the Z1 ship current or legacy firmware? | Assumed current | First connect; a legacy reply that does not parse is the signal. |
| UDP 3333 broadcast reachability on Windows | Unverified | First discovery run from the Windows build. |
| Real packet acceptance / refused-file behaviour | Unverified | First upload of a real verified `.nc`. |
