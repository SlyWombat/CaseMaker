# Makera Studio vs Case Maker — capability matrix

**As of `main` 6768b049, 2026-10-29.** Row-per-capability, Studio 0.1.2.0 against Case Maker.
Companion to `/Makera-Parity.md` (the 2026-10-12 review; its "Us" column is superseded here) and
to `CASEMAKER-VS-MARKET.md` (the same product against the 20-vendor grid). Every Studio cell cites its
evidence; every Case Maker cell cites the issue or file it was verified against.

## Summary

| Status | Rows | Meaning |
|---|--:|---|
| **AHEAD** | 42 | Case Maker does something Studio does not, or does it demonstrably better |
| **PARITY** | 41 | both do it; the mechanism may differ |
| **PARTIAL** | 16 | Case Maker does part of what Studio does |
| **ABSENT** | 3 | Studio does it, Case Maker does not, and nothing refuses it |
| **REFUSED** | 8 | refused on the record (`/Makera-Parity.md` §14.4 R-n, or a `/Fabrication.md` decision) |
| **UNKNOWN** | 3 | Studio's side is not established — not a guess in either direction |
| | **113** | |

**Milestone.** The remaining parity work is tracked in the milestone *Parity with Makera Studio*
(#17); #774 (STEP import) is decided and built — a STEP is tessellated through the OpenCascade
WASM kernel at import (#774), so R-13 is lifted for STEP; the remaining decision is #775 (USB/serial
transport, decision 10), and Gerber stays refused as R-12.

**Three biggest gaps.** (1) **Pause/resume and the full status monitor AT THE BENCH** — the software
is on `main` for both: the run panel sends the firmware's own suspend/resume at the next poll
boundary (#618, 138e3ea7), and the strip reads the monitor's spindle/power temperatures, the halt
reason and the leveling state behind the state element (#659, b6a9d462; `L:`/`C:`/`E:`/`W:` are
deliberately unread — the bits are undocumented or the captures disagree), while Studio's Monitor
adds limits, probe, cover switch and RSSI. Neither has met the machine: #767 is the bench checklist.
(2) **XY probing with the 3D probe and grid auto-levelling** — Studio's `Set Origin with 3D Probe`
and Auto Workpiece Leveling; Case Maker now touches edges sideways with the 3D probe where the
mount allows (#525) and emits/pushes the G32 grid route for a dome (#631), but corner finding and a
bench-proved G32 remain (B9, B10; #525, #501). (3) **Rotary's run path and the relief programs** —
Studio runs its Rotation Relief; ours now authors, generates, verifies and simulates wrapped text,
indexed faces and ball/V finishes, but the run path waits for the module's bench (#545, #238) and
the relief CAM is part 1 of #723; the flat 3D relief's feeds are the bench slice (#536).

**Three biggest leads.** (1) **The simulation gate** — exact sweep, collision/gouge errors, a
volumetric oracle and a dry-run file before anything is uploaded; Studio's dexel simulator is
unwired and its flow ends in "upload and find out" (G20–G22, D2, D10). (2) **Registration v2** —
`M119` rest-check, one tap on the mount's own datum, Z-only edge finding by bracket-and-bisect,
`G38.3` so a miss is a reading not an alarm, plane-fit against tilt, every reading written back with
provenance (B6–B8, B15). (3) **The house model and the ways in** — accessories, inventory copies,
measured-beats-catalogue feeds, run records, a LAN browser front end, a headless CLI/MCP, Apache-2.0
and no account (F2–F9, A10, H4–H10, I5–I7).

**Evidence keys.** `RE nn` = `docs/reverse/makera-studio/nn-*.md` (decompile notes, `[DECOMPILED]`
unless marked `[BENCH]`); `Parity §n` = `/Makera-Parity.md`; `Workflow A.n` =
`docs/design/cnc-job-workflow.md` Appendix A (Studio read from the install, 2026-10-15);
`FM §2.x` = `FEATURE-MATRIX.md`; `Bridge §n` = `/Z1-Bridge-Protocol.md`; `Dialect §n` =
`/Z1-Firmware-Dialect.md`. Case Maker paths are under `casemaker-app/src/` unless they start with
`src-tauri/` or `tools/`. An issue in **bold** is open; `R-n` is a §14.4 refusal.

## What changed since the 2026-10-12 review

`/Makera-Parity.md` §14.1 was written with no bridge and no machine time. Twelve days of `main`
moved these cells; the review's "Us" column should not be read for them:

| §14.1 said | Now | Rows |
|---|---|---|
| Jog / MDI / overrides "refused until the bridge" (R-10) | A guarded typed console shipped (#302); jog, overrides and pendant stay refused | C7–C11 |
| Thread milling refused (R-14) | Shipped as a helical thread in an existing pilot (#445) | G8 |
| Ramping refused (R-16) | Lifted for **metal shape pockets** — adaptive clearing with a helix (or ramp) entry is the pocket's rough cut, wired into the job by #666 (#433, Q9); bores helix (#668). Wood, text, V-cuts, through cut-outs and the finishing pass still plunge | G10 |
| Stock-to-leave "absent" (M3) | A finish pass with a shop-setting allowance (#250) | G11 |
| Restart from a step "absent" (M2) | Generated and gated (#249); untested against a real stop (#284) | H7 |
| G-code viewer "absent" (A5) | Read-only pane synced to the transport (#245) | G24 |
| One time estimate (A1), framing file (A3), `FieldSource` on overrides (A4), "my machine" export (A6) | All landed (#242/#281, #244, #246, #247) | G23, B11, F4, F9 |
| "We do not drive the machine" | Discover, identify, upload, play, stop, console, vacuum, laser, power, registration — desktop and LAN browser (#255 → #571) | A, C, D |
| Registration = run sheet §6 by hand | Registration v2 on the machine: `M119`, mount tap, Z-only edge finding, plane fit, write-backs (#598–#608, #613) | B |
| Camera = #189 "covered" | The buildable half landed; capture/stitch gated (#286); the live view is in the harness, not the app (#530) | E |
| Catalogue "never the feeds source" | A tier below measurement, clamped, with provenance (#310); synced from Studio's DB (#308); headless cannot sync (#560) | F1, F4, F8 |

## What changed since the 2026-10-25 matrix

2026-10-29, checked row by row against `main` 127c14ad (commits by `git merge-base --is-ancestor`;
in-flight work is named as such, never counted):

| Then (2026-10-25) | Now | Rows |
|---|---|---|
| Status monitor ABSENT | PARTIAL — the popover reads temperatures, the halt reason and leveling (#659); limits/probe/cover/RSSI are not read, with reasons | C |
| Chamfer ABSENT | PARITY — one bevel cut by the cone's flank, its own row and program (#669) | G |
| Rotary ABSENT | PARTIAL — the authoring/simulation path is in the app (#714/#716/#752/#763); the run gate and the relief CAM remain | G |
| Pause/resume software only | Software landed (#618, 138e3ea7); the bench proof is #767 | D |
| Work light PARTIAL, "no switch drawn" | PARITY — the Machines card's switch (`M821`/`M822`), Idle and jobless only (3242722c, #422) | C |
| Unlock `$X` PARTIAL, "no card button" | PARITY — the Machines card's Unlock, offered only in Alarm (3242722c, #644) | B |
| Live stream PARTIAL, "nothing in the app" | PARITY — the camera pane, its frame age and the server's path (cadf14ba, #530) | E |
| 3D relief row cited an open UI slice | The goal row, the ball auto-pick (#762) and the extra finishes (#671/#672) are in; the clear-around ring (#764) is in flight; the feeds remain the bench slice (#536) | G |
| — | The first cut's one-confirmation flow (#656), the item-kind cutter pick (#762) and the V-bit raised-text rest (#765, 127c14ad) | D, G |
| — | The tool-selection evaluator (#766) has landed its interface and measures; the search is in flight | F, G |
| Seven issues whose only open line was a machine check | One bench checklist, #767 | B–D |

## A. Connection & status

| Capability | Makera Studio | Case Maker (main c0d680ab) | Status | Next |
|---|---|---|---|---|
| Transport to the controller | TCP `:2222` (`WIFIStream`), plus `SerialPortStream`, `USBStream` (libusb) and a BLE scanner, all behind one `BaseStream` — RE 01 | TCP `:2222` only: five dumb calls in `src-tauri/src/machine.rs`, framing in `platform/desktop/protocol.ts` (#255); USB is a seam, not a transport (decision 10) | PARTIAL | — |
| Discovery | UDP datagrams via `QUdpSocket`, payload bytes still `[PENDING]`; typed IP (`AddDeviceFromIPWgt`); saved devices in `t_MyDeviceList` — RE 01, RE 07 | Passive UDP `:3333` listener (Bridge §2, #275); "Connect `<ip>`" on the Machines card; machines kept in `location.json` with a nickname (#596) | PARITY | — |
| Identify the machine | `MachineDetector` decides a device is a Makera; method `[PENDING]` — RE 01 | `M482.5` (IP) / `M482.4` (MAC) `identify()`; the broadcast name resolves to a profile and an unknown name is reported unknown, never as a Z1 (`platform/machineProbe.ts`, #280) | PARITY | — |
| Status-frame fields | `FUN_140a94310` parses `State\|MPos\|WPos\|F\|S\|T\|W\|L\|P\|A`; the state word is stored verbatim; a `toDouble` failure stores `0.0` — RE 02 | `protocol.ts` parses the state word, `MPos`, `WPos`, `P:<line>,<percent>,<seconds>`, `F:` (actual/set/override), `S:` (rate, plus the monitor's spindle/power temperatures), `T:` (active/offset/awaited) and `A:` (the ATC state; absent on a Z1) (#526/#659/#769), with the `H:` halt reason and `O:` leveling state (#659, b6a9d462); `L:`/`C:`/`E:`/`W:` are deliberately not read (the firmware's bits are undocumented or our captures disagree — the reasons are in `protocol.ts`); the alarm line (`alarmLine`) and the G54 offset as `MPos − WPos` (#567) | PARTIAL | — |
| What "homed" means | From the state word; `MPos:-1,-1,-1` is the rest position, not "unhomed" — RE 02 | Same rule, pinned by tests (#561, commit 142b877f); the harness and the app judge `$H` by `Home → Idle` | PARITY | — |
| Status poll cadence | ~0.6 s `[BENCH]`; the timer itself `[PENDING]` — RE 02 | Floor of 2 s (`MIN_STATUS_POLL_MS`, #386) after a 0.6 s poll faulted the controller on 2026-10-12 (Bridge §6/§8) | PARITY | — |
| Live reachability | `StateMachineManager` owns the connection state; detail `[PENDING]` — RE 02 | Heartbeat `?` every 2 s with an online/offline notice and a pinned machine section (#555/#556, commit 25aaedcd; `platform/machineHeartbeat.ts`) | PARITY | — |
| Reconnect after a network drop | Command channel `[PENDING]`; the camera stream auto-reconnects after 2 s — RE 01, RE 04 | One connection per explicit action, nothing persistent to reconnect (Bridge §8); the Z1 itself drops off the LAN and only a plug cycle brings it back (**#304**, **#499**) | UNKNOWN | **#304** |
| Reading a reply | The MDI log's bare `ok` is rendered by the client, not read off the wire `[BENCH]` — RE 02 | Success is judged by the next `?`; frames with no line in flight are *carried*, never merged into a reply, and an alarm in them still refuses (`#386` item 3; Bridge §6) | AHEAD | — |
| Front end over the LAN | None — Qt desktop; the Makera App shows the camera only (FM §2.A note) | A LAN browser served by `casemaker --bind-all` drives the same sockets through `/api/v1/machine/*` (#571; `platform/desktop/httpTransport.ts`, `src-tauri/src/machine_api.rs`, same-origin `guard.rs`); `/api/v1/health` reports the build's commit, and a git-less publish stamps it with `CASEMAKER_BUILD` (#566) | AHEAD | — |

## B. Homing, probing & tool length

| Capability | Makera Studio | Case Maker (main c0d680ab) | Status | Next |
|---|---|---|---|---|
| Home `$H` | `$H`; ~31 s; confirmed by state, not by an ack `[BENCH]` — RE 03 | `$H` before every bit change and after every activity (bench rule; `platform/machineRun.ts`, `registration/execute.ts`); waits for `Idle` | PARITY | — |
| Unlock `$X` | An **Unlock** button on the Control card — Workflow A.6 | An **Unlock** button on the Machines card — only while the controller is actually in Alarm — plus the registration executor's own `$X` on recovery and the guarded console (3242722c, #644; #588's alarm-only rule) | PARITY | — |
| Probe-input rest check | Not established for Studio; the Carvera firmware halts `PROBE_FAIL` on a probe that reads triggered at rest (`registration-flow-v2.md` §1) | `M119` before anything descends; `Probe: 1` at rest stops with "check its plug" (#599; `execute.ts`) | UNKNOWN | — |
| Tool-length probe `M491` | `M491` in the binary; inside `M6` the firmware runs `M493.2 → G38.6 Z-108 F500 → G38.6 Z-2 F100 → M493.1` — RE 03, Workflow A.5 | `M491` for the probe and again for the cutter; Z0 = surface + (cutter PRB − probe PRB) (`execute.ts` `applyCorrection`); the reading is kept on the probe record (`lastM491`, #599/#600); the reply window covers the 15 s macro (#563) | PARITY | — |
| Z surface touch | `G38.2 Z-108 F500 → G91 G0 Z1 → G38.2 Z-2 F100 → G10 L20 P0 Z0` — Workflow A.5 | Fast `G38.3` to the expected surface − tolerance, `G0 Z1`, slow `G38.3`; both readings inside a per-stock plausibility band (#589) | PARITY | — |
| A probe miss | `G38.2` → `ALARM: Probe fail` → `$X` — RE 03 | Every probe is `G38.3`: a miss is `[PRB:…:0]`, the machine stays `Idle`, no `$X` (`execute.ts`; #518, maintainer 2026-10-18) | AHEAD | **#518** (close) |
| XY edges with the Z-only wired probe | The wired probe is Z-only; XY origin needs the 3D probe (`Set Origin with 3D Probe`) — Workflow A.5, cnc-guide §2 | Edge scans by Z touches: bracket-and-bisect (#594), inward search on a missed first touch (#593, commit 2fc50ded), extents after the edges (#591) | AHEAD | **#593**, **#570** |
| Mount datum | Anchor bracket is a preset (`Relative to: Anchor1`); rotary X/Y/Z offsets are config strings — Workflow A.4, Parity §7 | One tap on the vise's fixed-jaw top → `jawTopZ`, compared with the record, written back as `probed` with history; the first tap creates the bed profile (#598–#600, #613). The bracket's seat tap landed with the same write-back (#607; its arm tap is dormant until the seat is measured). The rotary's tap needs the module's nose geometry (#626) | AHEAD | — |
| 3D probe (sideways XYZ) | `Probe3DTaskManager`, `OperationDetailsCfg3DProbeDlg`, corner finding — RE 03, Workflow A.5 | The "Makera 3D Wired Probe" is a registered accessory (#601) whose variant drives the plan: edge touches go SIDEWAYS where the mount allows it (vise free front/back, every edge on the bracket/tape) with the probe's own ball radius, and the narration names the probe (#525). No corner finding | PARTIAL | **#525** |
| Grid auto-levelling | Auto Workpiece Leveling (clearance 5 mm, 3×3 points) — Workflow A.4 | Five extent touches → plane fit, program re-posted against the tilted plane (#608, #623); a dome is no longer refused (#631) — the row offers the console's G32 grid (sized for the cut and the cutter), gates upload on it, or takes the operator's accepted centre miss. G32's own bench proof is still the open end | PARTIAL | **#501** |
| Area scan before cutting | `Scan Now` → `M495 X Y C D` margin trace with the probe fitted — Workflow A.4 | `<job>-frame.nc` (#244), the laser frame (#431) and the lifted dry-run program (#547) | PARITY | — |
| Writing the work origin | `G10 L20 P0 Z0` after the Z touch (resets the TLO reference, #387) — Workflow A.5 | `G10 L2 P1 X Y Z` from the found stock (`execute.ts`); `G10 L2 P1 X Y` from the laser dot (#431) | PARITY | — |
| G54 read-back | WPos shown on the Control card — Workflow A.6 | `MPos − WPos` on X/Y as the registration pre-flight check (#567) | PARITY | — |
| Which probe is fitted | "Please change to: Probe / Then press Confirm" dialog — Workflow A.4 | The plan names the checked-out probe (#598); the operator fits it through a callback; `M119` checks the input | PARITY | — |
| Probe records | None; probe speeds/heights are config strings — Parity §7, Workflow A.7 | `accessories[]` with tip Ø, rim offset ±, `lastM491`, `lastM119Rest`, whereabouts and history (#597/#601; `src-tauri/src/house.rs`). A datum records the probe that tapped it and is refused by a different one (#611; the surface top too, #632) | AHEAD | — |
| Tool setter | `M6` drives to the fixed sensor; `ToolSensorPWR` is Carvera-only — Workflow A.5/A.7 | `M491` uses the Z1's sensor; the emulator animates the macro (#182); the sensor position follows the machine's own `anchor1` (#279, `engine/cnc/calibration.ts`) | PARITY | — |

## C. Machine controls

| Capability | Makera Studio | Case Maker (main c0d680ab) | Status | Next |
|---|---|---|---|---|
| Spindle switch | `M3S10000` / `M5` toggle — Workflow A.7 | None by hand; the spindle runs only inside a verified program, and the verifier refuses a start at an unestablished Z (#396) | REFUSED | R-10 |
| Vacuum | Dust-collection switch; on the Z1 the mode is `M331`/`M332` `[BENCH]` — RE 03, Parity §4 | Every program carries `M331`…`M332` (#283); a Machines-card switch only when `Idle` and no job (#390); the strip's indicator says on/off/unknown from what was sent, and a release's record expires a manual press (#648/#652); the span is kept across a multi-program run (#469) | PARITY | — |
| Antistatic | "Anti-Static" assist option — Workflow A.4 | `M331.4`/`M332.4` auto-enabled for plastic jobs, a capability flag on the profile (#564; bench #568) | PARITY | — |
| Work light | `M821`/`M822` switch, `switch.light.startup_state` — Workflow A.7 | A switch on the Machines card (`M821`/`M822`, only on an Idle machine with no job) plus the run plan's machine strip; bench-proved 2026-10-18 (3242722c, #422 closed; `engine/cnc/plan/features.ts`) | PARITY | — |
| Probe laser pointer | `M831`/`M832` on/off toggle — Workflow A.7 | The laser **frame** and **point-to-origin**, off by default, lift guarded at the point of use (#431; `platform/machineLaser.ts`) | AHEAD | — |
| Laser module | Laser Image / Laser Vector strategies, `M3S0.05` — Parity §2, Workflow A.7 | `capabilities.laser: false` on the Z1 profile; no laser strategy will be written (decision 4; `engine/cnc/machine.ts`) | REFUSED | decision 4 |
| Jog | Jog pad + QuickMove — Workflow A.6 | None, except the laser dot's `G91 G0` X/Y steps inside point-to-origin (#431) | REFUSED | R-10 |
| DRO | WPos and MPos per axis — Workflow A.6 | The status strip's DRO (#647): per axis the WORK value large over the MACHINE value, the state as a connection, the live feed (`F:`) and spindle (`S:`) with a non-100 % override shown (#769), the cutter or probe by NAME with the frame's own T number (#646/#651/#769) and the probe's last M491 in the hover, the vacuum state, and progress from `P:`; A appears only when a rotary module is checked out and reads in °/turns (#658/#769); a frame's `A:` is the ATC state and shows only on a machine that sends it. Absent/unreadable fields print — | AHEAD | — |
| Feed / spindle override | Readouts on the Control card; `F:`/`S:` carry a 100.0 % field — Workflow A.6, Bridge §6 | The READOUT landed (#769): the strip prints the live F/S and, beside them, an override that is not 100 %; the CONTROLS to change one remain refused | PARTIAL | R-10 |
| Pendant / gamepad | `?` — FM §2.E | None | REFUSED | R-10 |
| MDI / console | `G-Code` / `MDI` tabs, "Enter Command…" — Workflow A.6 | A guarded one-line console: refuses `config-set`, card writes, reset/flash, transfers, the realtime bytes and any line the dispatcher would run as more than one command (#302, #386; `engine/cnc/consoleGate.ts`); desktop and LAN browser | PARITY | — |
| Stop | Grey Stop = `abort` (queue drains ~18 s); red STOP = realtime halt → `ALARM: Abort during cycle` — Workflow A.5, Dialect §11.13 | `abort`, then `M332` once `Idle` (#424); the realtime bytes are deliberately unwired; the machine's button is the E-stop (Q16) | PARTIAL | — |
| Power | None (the machine's button; auto-sleep in config) — Workflow A.7 | Optional smart-plug switch on the machine record, never off while running, token in the secure store (#416; `components/manage/MachinePower.tsx`); the bench uses `tools/z1/power.sh`; no CLI/MCP power (#479) | AHEAD | — |
| Status monitor | Limits, probe, tool sensor, E-stop, cover switch, temperatures, RSSI — Workflow A.7 | The strip's state element opens a popover with the readings the frame makes unambiguous — spindle and power temperatures (`S:`), the firmware's halt reason (`H:`, which is where a cover or probe fault lands) and the leveling state (`O:`), each in operator words (#659, b6a9d462; e2e proof 475b0d48). Studio's limits, probe and tool-sensor inputs, cover switch and RSSI are not read: `L:` is the laser, `C:` the model/factory bitfield, `E:` disagrees with the endstop list and `W:` is not the wireless state (`protocol.ts` says why per field) | PARTIAL | bench (#767) |
| Accessory-mode panel | Toggles for spindle fan, power fan, external output, air, WP charge… — Parity §7 | Vacuum, antistatic and work light — a Machines-card switch and a strip indicator for each, on/off/unknown from what was actually sent, changing only on an Idle machine with no job (#564/#648/#652) | PARTIAL | **#289** |

## D. Job transfer & run

| Capability | Makera Studio | Case Maker (main c0d680ab) | Status | Next |
|---|---|---|---|---|
| Upload to `/sd/gcodes` | One generic put; name timestamped `yyyyMMddhhmmss.nc`; QuickLZ when `> 4096` bytes with a `.bin` suffix — RE 05 | Receiver-driven framed transfer with an MD5 step, 8192-byte packets; "already present" is checked by hashing the path (#255, #291, #298); `Idle` asked first (#296). No compression | PARTIAL | **#562** |
| Verified-only wall | None — any file goes up | The upload gate is re-asked at send time (#295/#296); the CLI's `upload`/`play` need the program's FNV hash as the token (#479) | AHEAD | — |
| Play | `play /sd/gcodes/<f>` `[BENCH]` — RE 05 | Same word, only on `Idle` with no alarm, never streamed (#386; `platform/machineRun.ts`) | PARITY | — |
| Start from the registration | Set Origin (its probe dialog) → Generate → Send to machine → Run on the Control card — Workflow A.5/A.6 | After the cutter prompt's Continue the chain runs itself — re-post when the registration measured a tilt, the oracle, the upload — to ONE screen: the program, the frozen cutter (already confirmed at the prompt), the verdict, one clearance/at-the-machine statement and ONE Cut press; anything that fails stops there with its own sentence, and the manual steps stay behind a disclosure (#656). The firmware's own `M6` stop is #655's prompt | AHEAD | #656 on the bench |
| Pause / resume | `suspend` / `resume` with "save current pos… / Restoring saved XYZ positions" — RE 05, Workflow A.5 | The run panel sends the firmware's own suspend/resume at the next status poll boundary and the same button resumes (#618, 138e3ea7). A stopped job still restarts from a generated `<file>-from-L<n>.nc` (#249). Neither has met a real stop: the bench is #767 | PARTIAL | bench (#767) |
| Progress | `Progress: n%`, elapsed, remaining; `EstimatedProcessingTimeFromPathvertex` — Workflow A.6 | `P:<line>,<percent>,<seconds>` every ≥ 2 s, phase progress, the viewport follows `P` (#423, #442); the estimate is #242/#281 | PARITY | — |
| Job end | Not established | Percent 100 **and** `Idle` (`Idle` alone appears mid-job); end-of-run bookkeeping once (#386, #414; `store/machineRunStore.ts`) | PARITY | — |
| Tool-change prompts | "Tool Change Required … Confirm / Ignore"; `buffer M6T%1` sequenced at run time — RE 06, Workflow A.4 | One program per tool (Q15); a bit-change pause with cutter confirm and Z0 re-touch between files (#469, #516, #538). The firmware's own `Tool` stop after `T<n> M6` is recognised (#655): the run panel names the tool and its cutter ("The machine is waiting for tool 1 — the 1 mm flat end — to be in the spindle.") and Continue sends `M490.2`, which measures it at the sensor and carries the program on; the strip reads "Waiting for the cutter" | AHEAD | bench: the prompt's Continue |
| Multi-program run | One file at a time | The release step uploads every program first, then plays them in order with the vacuum span held across bit changes (#469; `store/engraveReleaseStore.ts`) | AHEAD | — |
| Job queue | None — FM §2.F | None | REFUSED | R-9 |
| Dry run | Not established (`Scan Now` traces the margin only) | The verified program lifted to a safe plane with the spindle off, re-verified before upload (#547; `engrave/dryRun.ts`) | AHEAD | — |
| Finished-program record | None in the 21 tables; "Repeat Last Job" on a long press — RE 07, Workflow A.7 | FNV hash per machine, appended on a clean finish, read by the run plan (#419 §4.5; `platform/finishedProgramsClient.ts`) | AHEAD | — |
| Firmware update | `MakeraStudioLauncher` pushes `/sd/firmware[.bin]` — RE 05, RE 08 | Refused by the console gate (`dfu`, `flash`, `upgrade`, `reboot`) | REFUSED | consoleGate |
| SD-card file management | `FileSystemNetworkManager` list / upload / delete — RE 05 | Upload, `cat` and the controller's own `md5`; no list, no delete (console refuses `rm`/`mv`) | PARTIAL | **#388** |

## E. Camera & monitoring

| Capability | Makera Studio | Case Maker (main c0d680ab) | Status | Next |
|---|---|---|---|---|
| Live stream | `ws://<host>:82/ws_video`, text `start_stream`, JPEG frames, reconnect after 2 s — RE 04 | A camera pane in the app: the live frame, its age and the server's path, with the harness's reconnect-on-drop behind it (cadf14ba, #530 closed; `tools/z1/camera.mjs`, commit 394583a0) | PARITY | — |
| Time-lapse | Recorded on the module per job, replayed over `vpreview` — RE 04 | The harness replays `vpreview` (394583a0); monitoring and time-lapse are refused for the app | REFUSED | R-17 |
| Camera metrology | None — a monitoring feed, no crosshair, no origin overlay (Parity §9) | Target spec and milled fiducial job built (#189 half; `engine/cnc/camera/`); capture, stitch and tie-point open; the camera is frame-mounted | PARTIAL | **#286** |
| "Camera ToHome" | A control that moves to a camera-home pose — RE 04 | One fixed move to the machine's own clearance pose (`coordinate.clearance_x/y/z`, resolved through its saved calibration where one exists), beside the camera pane and offered only on an idle machine with no job — a fixed move, not a jog (R-10 stands). 0f6d4fc4, #770; `platform/machineCameraHome.ts` | PARITY | — |

## F. Library data

| Capability | Makera Studio | Case Maker (main c0d680ab) | Status | Next |
|---|---|---|---|---|
| Cutter catalogue | `t_MakeraCutterList`, 129 rows, `cutterId` UUID + `g_ID` — RE 07, Parity §3.2 | Imported from Studio's SQLite as an immutable tier, diffed on re-sync (#308; `src-tauri/src/catalogue.rs`); the same 129 rows | PARITY | — |
| User cutters | `t_CustomCutterList`, a materialised clone, 0 rows — RE 07 | Clones and typed cutters with provenance (#212, #311), registered from the box code or a QR scan (#309), named in the `.nc` by `;@CM\|TOOL\|key=` (#332) | AHEAD | — |
| Inventory | `t_CutterInventoryList (cutterID, qty)`, 0 rows — RE 07 | Copies with condition (#415), runtime (#381), case colour (#491), whereabouts (#602) | AHEAD | — |
| Feeds & speeds | `t_MakeraCutterProperties`, 1 328 rows, no machine column, 32 rows above 13 000 rpm — Parity §5.1 | The catalogue is a tier clamped to the machine; a measured row always wins; `FieldSource` on every cutting field; coupons and readback (#310, #246, #248). No row is measured yet | AHEAD | **#284** |
| Materials & stock | `t_MaterialList` 15, `t_MaterialSpecs` 189; no PLA/PETG — Parity §5 | Filament classes (#456), a stock shelf with layers, finish, flatness and quantities (#413), vendor sizes read at runtime (#446/#466), purchased laminates (#492) | AHEAD | — |
| Machines | `t_MachineType` 3 rows (Z1, Carvera, Air); `t_MyDeviceList` name → IP — RE 07 | One profile (Z1) with per-field provenance (#184), the machine's own frame read by `config-get sd` (#279), bed profiles (#510/#511), wasteboard scars (#417) | PARTIAL | **#512** |
| Accessories / mounts | None (rotary offsets as config) — Parity §7 | `accessories[]` — mounts and probes with measured records, check-out/return, history (#597/#601/#602) | AHEAD | **#595** |
| Sync | Authenticated account sync, `t_SystemParameters` watermarks, `t_DeletionQueue` — RE 07, RE 08 | The desktop reads Studio's `makera_library.db` (#308); a headless/remote house cannot self-sync | PARTIAL | **#560** |
| The document & its export | A per-install SQLite file | `location.json` / `house.json` over `/api/v1` with `If-Match`; "my machine" export/import; the headless export carries accessories (#247, #412, #605) | AHEAD | — |
| Shop defaults | `config.json` / `interface_config.json` — Workflow A.7 | `location.json` `defaults` seeded three ways, every threshold a setting plus a per-job recommendation (#447–#451) | PARITY | — |

## G. CAM & output

| Capability | Makera Studio | Case Maker (main c0d680ab) | Status | Next |
|---|---|---|---|---|
| 2D pocket | type 0 — Parity §2 | Contour-parallel pocketing (#172), shapes and combinations (#214–#216) | PARITY | — |
| 2D contour / through-cut with tabs | type 1; `supportTabs…` fields — Parity §2, §4 | Through-cuts with holding tabs as shop defaults (#218; `cam/tabSettings.ts`) | PARITY | — |
| Drilling / peck | types 2 and 10 — Parity §2 | Plunge-drilled holes, pecks as plain `G1`/`G0` (no canned cycles on the Z1) (#220) | PARITY | — |
| V-carve | type 5 hypothesis; `VCarvePath.json` ships nowhere — Parity §2.1 | Floor-correct at the colour plane (#221), V-bit traces (#405), the groove oracle (#408), bold/condensed text (#409) | AHEAD | **#268** |
| Chamfer | types 13 and 14 — Parity §2 | A chamfer is one bevel cut by the cone's flank: `job.chamfers[]` with its own row and panel (floor and rim inferred from the item it follows), posted as one closed pass before the cut-outs, and listed in the run sheet (#669, e2c838f6; `EngraveChamferRow.tsx`, `cam/`'s chamfer program). The demo j16 cuts a real chamfer with a cone | PARITY | — |
| 3D relief / pocket / contour | types 6, 7, 8 — Parity §2 | Goal mesh → heightfield → raster roughing + ball finishing (#534, c019724b), the flat dexel route (#531), the goal row with its own step-down/step-over/pitch settings and the ball auto-picked by the finishing budget (#535/#762, bf7997f5), image relief (#672), scallop and pencil passes (#671); the item's clear-around ring to its base plane is in flight (#764). The 3D feeds are still the labelled 2.5D placeholder — the bench slice (#536) | PARTIAL | **#536** |
| Rotary | type 11 Rotation Relief — Parity §2 | The whole write-and-simulate path: the rod/tube stock and the chuck's holding (#714), the map, the turning view and Unroll (#716), wrapped text, pockets and flutes on the map, the rotary Operation step (#752), indexed faces (#241, #757), the feed-at-radius warning (#759), ball-nose and V-bit footprints in the rotary column engine (#763, e4a7065f), and Open-`.nc` on a rod in Simulate (#761). The RUN path stays gated until the module is measured (#545, #238), and the rotation relief (a goal mesh on the rod) is part 1 of #723 — the design and the radial heightfield have landed, the relief CAM is next | PARTIAL | **#545**, **#723** |
| Thread milling | types 9 and 12 — Parity §2 | Helical thread in an existing pilot, ISO 261 pitch, a thread model in the simulator (#445, #434) — supersedes R-14 | PARITY | — |
| Facing | Not one of the 14 strategy types — Parity §2 | Raster skim to Z0, wood and metal only, never plastic (#432, #473, #474) | AHEAD | — |
| Ramping / adaptive entry | `useRamping`, `rampingType`… fields — Parity §4 | A metal job's SHAPE pocket is cleared adaptively (`cam/adaptive.ts`, #433, Q9; wired into the job by #666) — a capped engagement on a measured material grid, entered by a helix (or a ramp), posted as the ROUGH half of #250's split when the allowance splits the pocket; the finishing pass stays contour-parallel rings. The run states the plan's engagement, entry and the feeds row it ran (`adaptive-clearing`); a planner refusal falls back to those rings and says why (`adaptive-fallback`) — a report, never a refusal of the job. Wood, text labels, V-cuts, through cut-outs and a finish-only rest program keep the straight plunge (Q9). A hole sizes its helix down the wall (bore, #668) | PARITY | — |
| Stock-to-leave / finish pass | `radial_allowance`, `axial_allowance` fields — Parity §4 | A finish pass whose allowance is a shop setting (#250) | PARITY | — |
| Rest machining | Guided Mode picks a Main Tool and a Clearance Tool — Workflow A.2 | Rest regions measured by the simulation, per-setup item → cutter assignment (#410, #436, #472) | PARITY | — |
| Multi-setup / two-sided | One `Set Stock` per project — Workflow A.4 | Setups planned from the geometry, a remount page, features from setup 1 as references (#428, #429, #471) | AHEAD | — |
| Import | STEP/STP/STL/OBJ, DXF/SVG, JPG/PNG/BMP, Gerber — RE 06 | SVG/DXF (#217), image trace (#252), STL/3MF/STEP as stock or goal (#418, #533, #774 — a STEP is tessellated through the OpenCascade WASM kernel at import), PrusaSlicer 3MF design (#410); Gerber refused | PARTIAL | R-12 |
| Text & fonts | The text subsystem logs `ERROR::FREETYPE: Failed to load font` — Parity §8 | Real glyph outlines with a multi-font registry (#169), per-label fonts and depths (#170) | AHEAD | — |
| Parametric part | None — Studio takes a mesh and cuts it | The whole app: the CAM reads the compiler's own profiles and depths (Parity §9) | AHEAD | — |
| Output dialect | `;@MKR\|` header, linear-only `G1`, `T1 M6`, `M7`, `S M3`, `M9 M05 G28 M02`, base64 thumbnail, no `G54`/`G10` — Parity §6 | `G90 G21`, the same header plus `;@CM\|TOOL\|key=`, a machine-frame lift after `M6` (#384), `M331`…`M332`, `M05 G28 M02`; linear-only; no probing or origin command in the file (decision 26) (`cnc/post/z1.ts`) | PARITY | — |
| Embedded thumbnail | Base64 PNG after `M02` — Parity §6 | None | ABSENT | — |
| Reading other people's files | Reads its own | Parser tessellates `G2`/`G3` as the firmware does, refuses canned cycles, `N` lines, laser and rotary words (#174, #385; cnc-guide §8.2) | AHEAD | — |
| Material-removal simulation | `dexeltool.dll` ships, the workflow never reaches it — RE 06, FM §2.D | Exact sweep with checkpointed transport (#182, #193–#199) and a dexel route for dense flat and 3D jobs (#531) | AHEAD | — |
| Collision / gouge | `?` — FM §2.D | Fixture, holder, gouge, spindle-off-near-material and envelope checks as **errors** (#204, #396) | AHEAD | — |
| Oracle | None | Volumetric prediction-vs-simulation gate before Save/Upload, resolution-aware floor, located under-cut, deterministic (#206, #580, #584, #577) | AHEAD | **#581** |
| Time estimate | From path vertices; elapsed/remaining on the Monitor — Workflow A.6 | One trapezoid estimate from the machine's rapid model, in the panel, the sheet and `TIME` (#242, #281); last timed run shown beside it (#277). A feed run now ends at a corner, so short strokes are not timed as one long run (#657) — the first cut's comparison read 2:42 predicted against ~4:15 cut | PARITY | **#281** |
| G-code viewer | `G-Code` tab — Workflow A.6 | Read-only pane synced to the transport (#245); editing refused | PARITY | R-8 |

## H. Workflow & records

| Capability | Makera Studio | Case Maker (main c0d680ab) | Status | Next |
|---|---|---|---|---|
| Guided job flow | Machining Wizard: Set Stock → Set Origin → Auto Probe → Assist → Run; a modal that remembers nothing — Workflow A.4 | Start wizard (#280), guided setup (#254), Cut mode's four-line flow from job to run — Checked · Frozen · Register the blank · Run (#689), Design/Cut switch with a frozen package (#419) | PARITY | **#512** |
| Operator run sheet | None — FM §2.F | Generated from the job, registration driven from the plan, frame file named (#207, #272, #244) | AHEAD | — |
| Transcripts | The MDI log | Dock Transcript tab with a header naming machine, probe, mount and the found position (#528, #604); console "Copy transcript" | AHEAD | — |
| Run record & history | No table for it — RE 07 | `<job>-run.json` beside the `.nc` (#277), readback into `runHistory.ts`, finished hashes (#419), stock consumed and runtime counted at run end (#414) | AHEAD | **#284** |
| Provenance | Persisted `0xCCCCCCCC` and denormals — Parity §8 | `FieldSource` on every number; the receipt's `provenance` (seeded / located / typed / measured) (#478); decision 28 records | AHEAD | — |
| Save / reload a job | `*.mks` project — Workflow A.1 | `.cutjob.json` v3 with embedded sources and package hashes (#425) | PARITY | — |
| Restart from a step | Not established (pause/resume only is recorded) | A generated, gated `<file>-from-L<n>.nc` with modal and accessory state replayed (#249); never yet met a real stop | UNKNOWN | **#284** |
| Coupons (measured, not assumed) | None | Coupon job kind, scripted job → `.nc`, readback flips a feeds row to `measured` (#248); no coupon cut yet | AHEAD | **#284** |
| Error messaging | 25 minidumps, "invalid null parameter" on the where-is-the-part dialogs — Parity §8 | Every diagnostic a coded row in cnc-guide ch. 8; stop sentences name the reading | AHEAD | **#587**, **#588** |
| Headless CLI / MCP | None | `casemaker` CLI with a versioned receipt; MCP server read-only towards the machine (#485, #605; cnc-guide §8.6) | AHEAD | **#498** |

## I. Platform

| Capability | Makera Studio | Case Maker (main c0d680ab) | Status | Next |
|---|---|---|---|---|
| Operating systems | Windows; macOS `?`; no Linux — FM §2.A | Windows desktop (Tauri, NSIS target in `src-tauri/tauri.conf.json`); the web build runs anywhere; macOS/Linux deferred | PARITY | **#322**, **#323**, **#565** |
| Browser | None | `electricrv.ca/casemaker/?BETA=yes` (#343) and a LAN browser that drives the machine (#571) | AHEAD | — |
| Mobile | Makera App shows the camera feed — FM §2.A | Responsive web (#503, #507); no native app | PARITY | **#376** |
| Offline | Yes; the catalogue sync needs the account — RE 08 | Local-first; no server | PARITY | — |
| Account & licence | Auth0 login; licence bound to a device/disk serial or an email; trial state — RE 08 | None; Apache-2.0 | AHEAD | R-19, R-20 |
| Update | `MakeraStudioLauncher.exe` updater — RE 00 | None; the installer reads a static 1.0.0 | ABSENT | **#403**, **#290**, **#566** |
| Open source | No | Apache-2.0 (`LICENSE`) | AHEAD | — |
| Localisation | `lang_us_EN.json` only; no `.qm` files — Workflow A | English only | PARITY | R-18 |
| Crash resilience | 25 minidumps, all a paint-time Qt exception; libEGL failures — Parity §8 | Geometry in a worker, a broken viewport is non-fatal, an error boundary on the panel (#490) | AHEAD | — |
| Two instances / two people | One install, one DB | A house lock, `If-Match` on writes, a second instance refused (#321; `house.rs`) | AHEAD | — |

## How to keep this current

- **The statuses are dated.** Each cell is true of `main` 6768b049; re-verify the Case Maker column
  on every k3 publish (and whenever a `fabrication` issue closes), the Studio column whenever a
  `docs/reverse/makera-studio/` module promotes a `[PENDING]`.
- **Closed ≠ shipped, open ≠ absent.** Several rows above cite a commit for an issue the tracker
  still lists open, and one issue can carry several slices. Check `git log --grep '#NNN'` and
  `git merge-base --is-ancestor <sha> origin/main` before changing a status (a commit on a branch
  is not on `main`), and read the last comment: a later "do not" beats the body. As of
  2026-10-29 the machine-only leftovers live in one bench checklist, #767; #628, #545, #595,
  #609, #622 and #663 stay open on purpose.
- **Studio claims need a pointer.** Add a row only with an `RE nn` / `Parity §` / `Workflow A.n`
  citation; if the decompile has not reached it, the status is UNKNOWN, not a guess.
- **Count after editing.** The summary's six numbers are the table's `Status` column counted; a row
  added or re-scored changes them.
