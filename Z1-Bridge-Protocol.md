# The Z1 network protocol, as the bridge implements it

Status as of 2026-10-06. It is a written description of the *interoperability facts* of Makera's
controller protocol, produced so the bridge can be implemented from this document rather than with
the vendor's source open beside it. The implementation lives in
`casemaker-app/src/platform/desktop/` (protocol) and `casemaker-app/src-tauri/src/machine.rs`
(transport).

**First contact was made on 2026-10-06** against a real machine (`Makera_Z1_010290`, firmware
speaking the framed protocol) through `casemaker-app/tools/z1/` — a Node implementation of the same
transport seam, driving this same `protocol.ts`. Discovery, §4 identify and §6 status are now
**OBSERVED**; the rest of this document is still unverified, and each section says which it is.

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
`wifi.machine_name CARVERA_AIR_01001` on the same config's line 450 was taken to be the template
the discovery name follows. **OBSERVED 2026-10-06: it is not.** The machine broadcasts
`Makera_Z1_010290`, so the shipped template does not describe the name a Z1 actually announces —
the real form is `Makera_Z1_<serial>`. Ports 2222/3333 are as documented.

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
<name>,<ip>,<tcp-port>,<busy>,<state>
```

- field 0 — machine name, e.g. `Makera_Z1_010290`. Also the de-duplication key: the first
  datagram for a given name wins.
- field 1 — the machine's IP address (the address to connect to).
- field 2 — the TCP command port (`2222` in the shipped config).
- field 3 — `1` means busy, anything else means not busy.
- field 4 — **a textual state**, present on the real machine and undocumented until first contact.
- A datagram with **four fields or fewer** is discarded (the client requires `len(fields) > 3`).

**OBSERVED 2026-10-06 — the real datagram has five fields, not four:**

```
Makera_Z1_010290,192.168.10.43,2222,0,Idle
```

Field 4 carried `Idle` while the machine sat untouched and `busy` was `0`. The two agree, but field
4 is a *string* where field 3 is a flag, and no other state value has been seen — so what the
vocabulary is, and whether the two ever disagree, is open (#275). It is recorded here as observed,
not explained. Our parser ignores trailing fields rather than rejecting the machine, so it read
this datagram correctly as shipped; only this description was wrong.

**OBSERVED:** the machine broadcasts continuously at roughly **3 per second**. The listening window
is therefore bounded by the listener, not by the machine — the published client's 3 s wait was
never sizing a one-shot announcement, and is ample.

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

**OBSERVED 2026-10-06 — one text frame per command, `STA param[<n>]:<value>` with a trailing
newline:**

```
M482.5  ->  "STA param[5]:192.168.10.43\n"
M482.4  ->  "STA param[4]:E0-72-A1-CF-6F-EC\n"
```

Both values matched the host the bridge had connected to (the same MAC `e0:72:a1:cf:6f:ec` as the
ARP entry), which is the whole point of the exchange. The MAC is **uppercase, dash-separated** on
the wire; our extractor normalises it to lowercase colon form as documented. The tolerant
extraction above was kept rather than replaced with an exact parse: it read these replies correctly
without having been written for them, and a fixed format would only be more brittle.

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

### Reading a file back — the console `cat`

Read from the Z1 firmware's own console command table
(`src/modules/utils/simpleshell/SimpleShell.cpp`), 2026-10-06. **Not yet run on the machine.**

The controller's shell exposes **`cat`**, and its own `help` prints the form: `cat file [limit] [-e]
[-d 10]` — filename first, then an optional count of lines. It opens the file, streams it to the
requesting stream in fixed-size chunks, and stops once it has emitted `limit` newlines if a limit was
given. A missing file prints `File not found: <name>`.

A console line is sent as a **`0xA2`** frame carrying the text — the same envelope §4's `M482.5`
uses, already observed answered on this machine (B0). So a file is read with one frame and no
handshake at all.

**Why not the `0xB0` transfer.** Studio sends `download /sd/config.txt` on every connect (bench item
B5), so a framed download command plainly exists — but it is **not** served by the main board: in the
firmware read here, `upload` and `download` are commented out of the shell's command table and
`Player::download_command` has an empty body. The framed download is therefore answered by the ESP32
link module, **whose firmware Makera does not publish**. Its reply sequence is not documented
anywhere we can read, and §5 describes only the direction where the *client* is the sender. A
receiver-side handshake would be invented, not derived. `cat` is the direction we can justify from
source, and it returns exactly the bytes we want.

**Safety.** A read, and nothing else: no motion, no write, no G-code, and it is the only console
command the bridge sends other than §4's two identify queries and §6's `?`. The bridge constrains the
**path** it will send to a plain absolute path (`/`, letters, digits, `.`, `_`, `-`), so a caller
cannot smuggle a second word or a second command into the line — the shell splits on whitespace, and
a space is not in that set.

**Observed 2026-10-06 — and `cat` does not work on this machine.** `cat /sd/config.txt` answers
`File not found: /sd/config.txt`, through the bridge and typed by hand into Studio alike, and the same
for `/sd/config`, `/sd`, `/sd/gcodes` and `/local/config.txt`. The framing is not at fault: the manual
attempt in Studio returns the identical message. **The file is not at fault either** — `md5sum
/sd/config.txt` returned `00ceac76d7a4930bac754795b388f34b` for the same path, and `config-get sd <key>`
reads values out of it. So `cat` alone fails, on a file two other commands read, and the published
source (where `cat` and `md5sum` reduce to the same string and the same `fopen`) does not explain it.
**Left unexplained rather than guessed at** — see §9.

### Reading a configuration key — `config-get`

**Run on the machine, 2026-10-06. This is the configuration channel that works.**

`config-get` takes a key and an optional source. Both call sites are a `0xA2` console frame, one line,
no handshake, exactly like `cat`.

| Sent | Reply | Meaning |
| --- | --- | --- |
| `config-get <key>` | `cached: <key> is set to <value>` | the **effective** value |
| `config-get <key>` | `cached: <key> is not in config` | not in the merged cache |
| `config-get <source> <key>` | `<source>: <key> is set to <value>` | that one source's value |
| `config-get <source> <key>` | `<source>: <key> is not in config` | that source does not carry it |
| `config-get <source> <key>` | *nothing at all* | **no source by that name** |

Three properties of this command are load-bearing, and each was established by running it rather than
by reading the firmware:

1. **Silence means "no such source", not "busy".** The firmware's loop over its configuration sources
   has no `else` branch (`Configurator::config_get_command`), so a name it does not carry produces no
   output whatsoever — not an error line. Observed identically for `firm` and for a deliberately bogus
   name. A timeout here is a permanent answer and retrying will not change it. This is the opposite of
   `config-set`, which *does* print `<source> source does not exist`; the asymmetry is the vendor's.
2. **Only `sd` answers on this machine.** `firm` behaves exactly like an unknown source, so the
   compiled-in defaults are not reachable over this channel.
3. **`sd` is an override file, not the configuration.** `/sd/config.txt` holds the keys the vendor
   chose to set; a key missing from it is not unset, it is simply not overridden there. Every other
   value on the machine comes from the firmware's compiled-in defaults, which we cannot read.

**The two forms are not interchangeable, and on this machine only the named source answers.** The
effective-value form looks like the better default — it needs no knowledge of which file a key lives
in — but it answered `is not in config` for keys `config-get sd` reads correctly, so the merged cache
is not populated for the shell on this build. The bridge's reader exposes both; the bench harness
sends `sd` unless told otherwise.

**Safety.** A read, and nothing else — `config-get` never `config-set`. Nothing in this repo may
change a value on the machine. As with a read path, the bridge constrains the **key** (and the source)
to a fixed alphabet rather than escaping it, so a caller cannot smuggle a second word into the line.

### The framed download, as the Studio client does it

Read out of `MakeraStudio.exe` (2026-10-06). Studio is a native Qt/C++ binary, not Electron, so its
transfer code is legible as strings and log format lines. This is what the **client** does. **None of
it has been observed on the wire** — the machine's half is still inferred from what the client
expects — so it is a derived sequence, not a measured one. The bridge implements none of it, and
should not until the machine's replies have been seen.

- **It is not XMODEM.** Studio's class is named `XMODEM` and it logs `Cancelling XMODEM modem
  directly`, but there is no SOH/STX, no 128/1024-byte block and no ACK/NAK. `CHECK_FOOTER: invalid
  frame end, expected 0x55AA, got 0x…` puts the blocks in the same `0x8668`/`0x55AA` envelope as
  every other frame (§3). "XMODEM" here means stop-and-wait blocks with a per-block retry. Do not
  reach for an XMODEM library.
- Framing states: `WAIT_HEADER` → `READ_LENGTH` → `READ_DATA` → `CHECK_FOOTER`.
- Message types: `FILE_VIEW`, `FILE_DATA`, `FILE_MD5`, `FILE_END`, and a bare `RETRY`.
- It is started by a console line, **`download <remote path>`** — Studio's own vocabulary matches
  ours: its download writes `localFileTmp` and then promotes it to `localFile`, and its
  `upload <path>` is the PC-to-card direction (`upload /sd/firmware.bin`).
- **The sender sends the view.** `VIEW sent, total packets=`, `DATA received before VIEW,
  calculating file info and sending VIEW`, `Device re-requested VIEW, resending VIEW data
  (packetno=`. A view carries the file's shape — packet count and packet size (`Invalid total_packet
  count`, `packet_size=`) — and goes out when the first data request arrives if it has not already.
- **The receiver drives.** It asks for a block by sequence number and writes that request to the
  stream (`recv: stream write failed at seq=`). Sequence numbers are 1-based; a request for `seq <= 0`
  is refused (`Device requested invalid seq <= 0`).
- **`RETRY` is the peer's "I did not get that."** `recv: device sent RETRY, resending last request`
  on the receive side, `Received RETRY, resending last command` on the send side. A duplicate request
  for the same sequence is answered the same way.
- **Completion is chatty, and gives up.** After the last packet the sender sends `FILE_END`; if the
  peer keeps asking, it re-sends up to three times — `sent FILE_END 3 times without device
  confirmation`, `… after completion, device keeps requesting data` — and then fails. A send that
  hears nothing for 9 s aborts (`send: no response for 9s, aborting`).
- **The machine can abort or interrupt mid-transfer**: `recv: transmission canceled by machine`,
  `recv: alarm info received during transfer`. A cancel is reported, never retried.
- **MD5 short-circuits the whole transfer.** `The file's MD5 comparison is successful. No need to
  download the file.` — the client hashes the remote file first, using the same `md5sum` the console
  answers, and skips a transfer whose result it already has.
- The receive state machine is `WAIT_FILE_VIEW → READ_FILE_DATA` and `WAIT_MD5 → WAIT_FILE_VIEW`, so
  one session carries a view, its data, an MD5, and then possibly another file. `Ignoring command <
  FILE_MD5` while sending, and `Received MD5 echo from device (acknowledgment), ignoring`, say an
  echoed MD5 is an acknowledgement and not a request.
- **Payloads can be compressed.** A bundled `QuickLZCLI.exe` and `quicklz_progress_%1.tmp` sit on the
  transfer path, and `ftype == lz`, `Type_download_lz`, `the machine is decompress the nc file!` and
  `RemoteDecompressing…` say the machine will take a QuickLZ blob and decompress it. Whether a `.nc`
  sent by §5's raw upload matches what this machine expects for that file type is **unverified** —
  see §9.

**Why this still does not unlock a download path.** It answers the question §9 used to leave open,
but only for the half that was never the obstacle: knowing what the client expects is not the same as
knowing what the machine emits, and a receiver written against an unobserved sender is exactly the
invention §9's rule forbids. It would also buy nothing now — the config question it was wanted for was
answered by `config-get sd <key>`, and `/sd/config.txt` is the file that is *missing* the compiled-in
defaults, not the file that holds them.

## 6. Status — `?`

Status is a single `0xA1` frame carrying `0x3F` (`?`). The machine replies with one or more `0x81`
frames whose text is the controller's status line. The bridge returns that text **verbatim** and
says so when no reply arrives, rather than inventing a machine state.

**OBSERVED 2026-10-06 — one frame, one line, standard Marlin-style fields:**

```
<Idle|MPos:-1.0000,-1.0000,-1.0000,0.0000,0.0000|WPos:147.4000,123.8000,57.6325,0.0000,0.0000|F:0.0,2000.0,100.0|S:0.0,10000.0,100.0,0,20.9,22.5,0,0,0,0|T:6,-17.696,-1|L:0, 0, 0, 0.0,100.0|C:3,1,0,1|E:0,0,0,684,7610|OTA:0,0>
```

Read as observations, not as a specification: the frame arrived as type `0x81`, `MPos` is
**negative** while idle (consistent with `Z1.envelope`'s −200…0 / −100…0 convention, §B4 of
`docs/bench/2026-10-bench-day-1.md`), `F` and `S` carry three values each, and `T:6,-17.696,-1`
appears to carry an active tool number and an offset. **No field of this line is parsed by the
bridge** — it is surfaced verbatim, and that is exactly why it can be recorded here without a
parser being invented for it.

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
  (`/Fabrication.md` §14.4 R10). This bridge can upload a verified `.nc`, report status, read a file
  off the card and read the machine's own configuration; it cannot move an axis on its own. Each read
  (§5) is a console command, not an MDI box: the caller passes a **path** or a **key**, the bridge
  builds the one command itself and refuses anything outside a plain path's or a plain key's alphabet.
  The distinction matters — a free-text console box would be the MDI the rule forbids, arriving by the
  side door, whereas a checked parameter cannot become a second command.
- The single-byte e-stop byte is **not** wired: an e-stop that travels over the same socket the
  bridge is mid-transfer on is worse than useless. The physical stop is the stop.
- A machine refusal is surfaced as a refusal. The upload result has an explicit *refused* outcome
  and it is never retried automatically.

## 9. Open, and how it closes

| Question | Status | Closes when |
|---|---|---|
| `M482.5`/`M482.4` literal reply format | **OBSERVED 2026-10-06** — `STA param[<n>]:<value>` (§4) | **closed** |
| Does the Z1 ship current or legacy firmware? | **OBSERVED 2026-10-06 — current.** The framed protocol of §3/§5 was spoken and answered; a legacy machine would have needed newline-terminated text. | **closed** |
| UDP 3333 broadcast reachability on Windows | **OBSERVED 2026-10-06 — Windows yes, WSL no.** ~3 datagrams/s arrived in a Windows-side listener; 0 arrived in a WSL listener over 45 s, with `networkingMode=Mirrored` set. The constraint is not NAT, and mirrored networking does not lift it. | **closed** |
| What field 4 of the discovery datagram means | **OBSERVED once** (`Idle`); vocabulary unknown | More states, or the field disagreeing with `busy`. See #275. |
| Real packet acceptance / refused-file behaviour | Unverified | First upload of a real verified `.nc`. |
| Reading a file back with the console `cat` (§5) | **RUN 2026-10-06 — the mechanism works, `cat` does not.** The framing is right: the same command typed into Studio returns the same `File not found`, so the reply was read correctly. `md5sum /sd/config.txt` then returned a hash (`00ceac76d7a4930bac754795b388f34b`) for the identical path, which rules out both "the file is not there" and "the shell cannot open files". **So `cat` alone fails, on a file `md5sum` and `config-get` both read.** In the published source the two commands reduce to the same string and the same `fopen`, so this build's `cat` is not the published `cat`. | Someone reads the running build, or a captured exchange shows what the machine does with the command. **Unresolved on purpose**: the published source cannot explain it, and an explanation invented past the source is worth less than none. Not blocking — nothing in the product needs file *contents* from the console. |
| `config-get`'s effective-value form (§5) | **RUN 2026-10-06 — the one-argument form answers, but with an empty cache.** Every key tried came back `cached: <key> is not in config`, including keys `config-get sd` reads correctly, so the merged cache is not populated for the shell on this build. | Not blocking: the named-source form is the one the bridge uses. Revisit only if reading a key that exists solely in the firmware's compiled-in defaults becomes necessary — which, per the row below, it may. |
| Reading the firmware's compiled-in defaults | **BLOCKED 2026-10-06, and still blocked 2026-10-07.** The `firm` source is registered unconditionally in `Config.cpp` but is answered with silence on this machine, so the compiled-in defaults are unreachable over `config-get`. A key absent from `/sd/config.txt` — `alpha_steps_per_mm`, `alpha_min_endstop`, `alpha_max_travel`, the homing rates — cannot be read at all. | Either the vendor's `/sd/config.txt` is obtained whole (see the `cat` row), or the values are measured at the machine instead of read. |
| Which keys are actually in `/sd/config.txt` | **ANSWERED 2026-10-07 — by sweeping, not by reading the file.** All 237 keys the firmware's shipped `configZ1.default` names were asked for one at a time: **72 answer, 162 answer `not in config`, 0 fail any other way** (`wifi.*` skipped on purpose). The full record is `docs/bench/2026-10-07-config-sweep.json`. | **closed** — and it retires the claim that `alpha_*`/`beta_*`/`gamma_*` are wholesale unreadable: `alpha_max_rate`, `beta_max_rate` and `gamma_max_rate` all answer. The split is per key, not per group. |
| Why Studio's `download /sd/config.txt` works though the main board's `download` is a stub | **HALF-ANSWERED 2026-10-06.** The client side is no longer a mystery: `MakeraStudio.exe` is native Qt/C++, and its transfer code reads as a stop-and-wait block protocol inside the same `0x8668`/`0x55AA` envelope — messages `FILE_VIEW`/`FILE_DATA`/`FILE_MD5`/`FILE_END`/`RETRY`, receiver-driven by sequence number, `FILE_END` retried three times then abandoned, a 9 s send-side abort, and an MD5 pre-check that skips the transfer outright. The whole sequence is in §5. | **The machine's half is still inferred from the client's expectations, never observed**, so a receive path stays unwritten — which is now a choice rather than a gap: the config question this row was opened for was answered by `config-get sd <key>` (§5). Closes if a capture of a real download shows what the machine emits. |
| Whether §5's raw upload matches what the machine wants for a `.nc` | **UNVERIFIED 2026-10-06.** Studio's transfer path carries QuickLZ (`QuickLZCLI.exe`, `ftype == lz`, `the machine is decompress the nc file!`), so at least one direction moves `.nc` payloads compressed. §5 sends the file raw. | The first real upload of a verified `.nc` — the same event that closes the row above it. If the machine refuses a raw upload, this is why. |
| How the machine acknowledges a console command | **OBSERVED INDIRECTLY 2026-10-07.** Makera's own client renders every command it sends followed by a bare **`ok`**, and a completed multi-step macro as **`Done ATC`**; a probe trigger comes back as **`[PRB:x,y,z:1]`**. Read from the client's MDI log, **not from the wire** — the command half is certain (the client sent it), the reply half is one level removed. The dialect and the codes are in `/Z1-Firmware-Dialect.md` §11. | A wire capture. Not blocking: nothing in the bridge parses a reply it has not seen, and `?` status (§6) is the reply the bridge actually depends on. |
| Whether the bridge must model the **accessory modes** at all | **OPEN 2026-10-07.** The machine carries a mode family — `M331`, `M331.1`, `M331.2`, `M331.4`, `M951` — controlling bed cleaning, blowing, static removal, an "extend out" mode and camera time-lapse (`/Z1-Firmware-Dialect.md` §11.3). `machine.ts` models the Z1's only accessory as **air (`M7`/`M9`)**, and **no `M7` or `M9` appeared in the traffic read.** | Deciding whether the bridge reproduces these modes or leaves them to the machine's own client. Note this is *not* on the first pass: `§8` keeps the bridge to "upload a verified `.nc` and report status". The row exists so the gap is written down rather than discovered later. |
