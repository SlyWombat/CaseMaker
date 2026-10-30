# Bench 2026-10-30 — 3D probe survey (moved from .scratch at check-in; written during the session under a no-docs-writes rule)

Machine: Makera Z1 at 192.168.10.43 (MAC e0:72:a1:cf:6f:ec). Plug off at start; `power.sh on` → port 2222 in 12 s,
self-homed, Idle at MPos -1,-1,-1. power.sh needs HA=<CRLF-stripped copy of ha-api.sh> (the HomeAssistant checkout's
copy has Windows line endings; bash fails on `set -euo pipefail\r`).

## Reads that expose probe state (all motion-free)
- `M119` → `X_max Y_max Z_max A_min ... Probe: <0|1>`
- `diagnose` → `{S:..|L:..|V:..|F:..|G:..|T:<toolsensor out>|C:<probecharger out>|E:<endstops>|P:<probe in>,<calibrate in>|I:<estop>|RSSI}`
  (Kernel::get_diagnose_string; the read Studio's Diagnostic panel polls — `onDiagnosePollDue`)
- `get wp` → `Probe Addr:[0]` (no wireless probe paired); `?` frame carries no `W:` voltage field.
- `$#` → `[PRB:0,0,0:0]`, `[TL0:0.0003]`.

## Firmware facts (MakeraInc/MakeraZ1Firmware, src/configZ1.default + ZProbe.cpp + ATCHandler.cpp)
- ONE probe input: `zprobe.probe_pin 2.6v`; `zprobe.calibrate_pin 1.10^` (tool setter, G38.6); `zprobe.debounce_ms 1`.
- `switch.toolsensor` output 2.13, M831/M832 — the firmware drives it for tool 9999 ("open wired probe laser") and via M494.1/M494.2.
- `switch.probecharger` output 0.23, M841/M842, startup on (that is `C:1`; wireless-probe charger, Carvera heritage).
- Tool numbers: Studio sends M6T9999 = "change tool to probe" (wired), M6T8888 = "change tool to 3dprobe". Firmware: T0/T9999 are the probe
  tools (calibration script, laser, M495 gating); T8888 handling is commented out → treated as an ordinary tool.
- No code anywhere checks a probe is physically connected. M492.3/probe_detect() = "probe input triggered within 10 s".

## Hardware observations
- Head has two ports on the right side of the spindle housing: the 3-pin IONIZER port (Makera Ionizer page step 4) and the WIRED-PROBE
  connector. Operator first plugged the 3D probe into the ionizer port → P:0 (issue #788: show a diagram).
- Final wiring: ionizer on its port, wired probe V2 unplugged (body left docked), Makera 3D Probe cable on the wired-probe connector, probe in collet.
- 22:0x UTC: M831 sent (toolsensor output on, `T:1`); operator reports a BLUE ring on the probe.
- 22:06:36 → P:1,0 ; 22:06:45 → P:0,0 during a ~10 s stylus press; ring BLUE → GREEN while pressed. Probe input confirmed.
- Photo: img/2026-10-30-3d-probe/3d-probe-in-collet-blue-ring.jpg.
- M832 sent → operator: the blue ring TURNED OFF. The toolsensor output (2.13) IS the probe connector's supply. The 3D probe is dead without it.
  (`diagnose` E: field's 6th value read 1 before and 0 after M832 — unexplained, noted only.)
- M822 work light off after the hands-in work. Machine untouched by motion all session: still homed, Idle.

## Fixed-jaw survey with the Makera 3D Probe (22:08–22:40 UTC) — all PRB values are MACHINE coords of the BALL CENTRE
Prep: M493.2T8888 (Studio's 3D-probe tool number), M831 (supply), M491 → setter trigger Z −66.977, stored TL0 6.084.
(Wired probe: setter −75.92, jaw top −56.82 → the 3D probe is 8.95 mm longer at both places.)
| Feature | Where | Reading | Note |
|---|---|---|---|
| fixed jaw TOP | X −186.2, Y −180 | Z −47.873 | first touch, from Z −1 at F200 |
| fixed jaw TOP | X −186.2, Y −192 | Z −47.870 | level to 0.004 over 12 mm |
| fixed jaw INNER face (stock side), top band | Y −180, Z −49.4, moving −X | X −180.243 / −180.223 | two touches, 0.02 apart |
| fixed jaw LEDGE top | X −179.17 | Z −50.873 | 3.00 below the top (calipered 3.1) |
| fixed jaw LEDGE wall | Z −52.4 / −54.4, moving −X | X −178.089 / −178.091 | ledge stands 2.14 in from the face (calipered 1.9) |
| fixed jaw BACK end (+Y) | X −186.2, Z −49.4, moving −Y | Y −106.429 | end face ≈ −106.43 − R |
| fixed jaw FRONT end (−Y) | X −186.2, Y −192 | still on the top | end is beyond the Y travel; 100 mm bar → ≈ −207 |
| fixed jaw OUTER face | — | unreachable | bar sits at the −X travel limit |
| moving jaw stock-facing face, top band | Z −49.4, moving +X | X −156.837 | |
| moving jaw back face | Z −49.4 / −54.4, moving −X | X −146.536 / −146.544 | straight |
| moving jaw stock-facing face, below the step | Z −54.4, moving +X | X −158.891 | its ledge stands 2.05 in |
Moving-jaw top band width between ball centres = 10.30 mm; calipered 10.0 → EFFECTIVE stylus radius ≈ 0.15 mm (ball Ø ≈ 1.7–2 by eye, so the pre-travel is large). Release hysteresis (G38.5 after contact): 0.05–0.08 mm sideways, 0.05 in Z.
Alarms: (1) `G0` retract right after a sideways contact → "ALARM: unexpected probe trigger" (H:3). Fix: retract with `G38.5 <axis><+few mm> F100` (probe-away) before any G0. (2) An alarm/halt switches the toolsensor supply OFF (T:0) → re-send M831 after $X. (3) My own: descending at the retract X put the ball on the ledge top; always go back to the start X before a new descent, and check the descent's PRB flag is :0.
Camera frames img/2026-10-30-3d-probe/cam-01…07; trace traces/2026-10-30-probe-survey.log. End: $H, M832, M822; plug left ON; active tool left at 8888 (the 3D probe IS in the collet).
