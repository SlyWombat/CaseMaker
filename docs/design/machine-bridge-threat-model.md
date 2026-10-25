# The embedded server's machine surface — threat model

Status: current as of #660 (2026-10-25). Code: `src-tauri/src/guard.rs`, `machine_api.rs`,
`camera_api.rs`, `machine_profiles.rs`.

## The surface

The desktop build runs an embedded HTTP server that serves the same SPA to a LAN browser
(`casemaker --bind-all`). Two parts of that server open connections on the page's behalf:

- `/api/v1/machine/*` — the #571 bridge: `tcp/connect`, `tcp/write`, `tcp/read`, `tcp/close`,
  `udp/listen`. The server owns the sockets; the browser has none.
- `/api/v1/machine/camera` — the #530 camera proxy: a WebSocket to the machine's ESP32 camera
  module, forwarded frame for frame.

The Tauri desktop path (`invoke`) is same-process IPC and is not part of this surface.

## Two questions, in this order

**1. Is the request from the page this server served?** (`guard.rs`.) Writes under `/api/v1` must
name this server in `Host` (same port), may not state an `Origin` other than that page's, and must
declare a body as `application/json`. The camera upgrade asks the first two explicitly, because it
is a GET. A `GET` is otherwise not judged — reads are the LAN's by decision 33.

**2. Is the target one of the house's owns?** (`machine_profiles.rs`.) `location.json` is the list
of machines that exist and the address each was recorded at; a machine profile names the ports its
services listen on (`Z1`: 2222 command, 82 camera, 3333 discovery). A request is honoured only when
its host is a record's address **and** its port is one that machine's profile serves. The camera
route accepts only the profile's camera port; the UDP listen binds only a profile's discovery port.

Question 2 exists because question 1 cannot answer it. `Host` and `Origin` are headers any LAN
client can write with `curl`, so the guard bounds what a *browser* can be tricked into doing, not
what a program can ask for. Before #660 the server was a relay: a client on the LAN could have it
connect to any address it could reach and move bytes through it, the Z1's command port included.

## The discovery vouch (#661)

A machine the house has not recorded yet has no address question 2 can check — and the wizard's
first check is exactly the step that turns discovery into a record. So the server's own UDP
discovery listen vouches for what it hears: the source address of each datagram is remembered for
five minutes, and a `tcp/connect` to such a host is accepted **on a profile's command port only**.
The vouch is the server's own observation (no request can add a host to it), it never opens the
camera or any other port, it expires, and once the record exists the record is what the rule reads.
An unvouched unknown address is refused with the way forward in the sentence: let the machine
announce itself on the network, or add it in Manage › Machines.

## What is claimed

- The server dials only machines in its own location document, on ports the machine's profile
  serves. An unknown address, a port no profile serves, and a record whose profile this build does
  not know are all refused **before** a socket is opened — with the one bounded exception above.
- A profile added to the client without a row in `machine_profiles.rs` fails closed: its machines
  are refused rather than offered another profile's ports.

## What is NOT claimed

- **Not authentication.** There is no user model. A LAN client with no `Origin` passes question 1
  by design (guard.rs: it is a local process that could edit the files directly, so refusing it
  buys nothing), and it can still drive a known machine through the bridge. That is decision 33's
  LAN boundary, unchanged; #660 closes the relay property, not machine access.
- **Not a claim about the machine's own login.** The controller's TCP protocol has no credential in
  this app's use of it. Anyone who can reach 2222 can talk to it directly, bypassing this server.
- **Not per-machine identity of the caller.** Two machines recorded at the same host (behind a
  router, say) are both honoured; the rule is about the address and the profile's ports, not about
  who is asking.

## Choosing a port, and adding a profile

`machine_profiles.rs` is the one Rust-side copy of the client's profile numbers
(`engine/cnc/machine.ts`, `platform/desktop/protocol.ts`). A new machine profile needs its row there
at the same time as the client profile; until it has one, its records cannot be dialled — the safe
direction. The camera proxy adds no second table: it asks the same rows for the camera port.
