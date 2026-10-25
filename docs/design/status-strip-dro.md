# The status strip: what the operator sees of the machine — design, 2026-10-25

Bar: "the best in the category, the most intuitive UI" (the maintainer, 2026-10-25). Evidence:
`docs/market-research/MACHINE-STATUS-READOUTS.md`. Today the strip (`components/viewport/MachineStatusStrip.tsx`,
#526) shows the state word, the registration step or the program name, the spindle, the vacuum as sent, "probe"
or a T number, and an empty "X — Y — Z — (work)" slot.

## The five decisions

1. **The WORK frame is primary; the machine frame is secondary, de-emphasised, and visible — not hidden.** Per
   axis: the work value large, the machine value small and muted directly beneath it, three decimals, one unit.
   This is the pattern the three apps built for one machine converged on independently (Studio, Carvera
   Controller, gSender) and it follows two standards: *visibility of system status* (the operator never has to
   ask where the machine is) and *progressive disclosure by hierarchy* (the primary number dominates; the
   secondary is there for the moment it matters — homing, a limit, an alarm — without a gesture). A hover-only
   reveal was considered and rejected: hover does not exist on touch, and the consumer apps that hide the second
   frame (Carbide's click-toggle, Easel's inspector) have years of users asking where it went. Real estate is
   held down by typography (small, muted second line), not by removal. The maintainer's own suggestion was one
   set with hover; they asked for the standard pattern over their preference, and this is it.
2. **The tool slot names the tool.** "0.5 mm 30° engraver" from the frozen package, "Wired Probe V2" from the
   checked-out accessory during a registration; a hover gives the T number and the last M491 length. No
   disclaimers: the slot states the tool the job runs with, the way every other app's tile does.
   Carvera/Studio's tile ("1–6 / None / Probe + TLO") is the reference; the name is the improvement.
   Rule for the whole product (the maintainer, 2026-10-25): no defensive qualifiers in operator text — "as the
   job asked for, not measured", "as sent", "not a measurement of this machine's own …" and the like state a
   fact the operator did not ask about and read as the app covering itself. State the value; put provenance
   where provenance lives (the run sheet, the record, a hover), as a fact, not a caveat.
3. **One state element that is also the connection: colour + plain word, fixed position, modest size.** Idle,
   Running, Paused, Alarm (with its reason), Homing, Probing, Not answering, Offline — one vocabulary, the same
   words the Cut step uses. Not a banner (gSender's 60 px trapezoid "really bothers me").
4. **Progress beside the transport: percent, elapsed, remaining, and "until the cutter change"**; remaining
   recomputed under an override; the bar driven by acknowledged lines (CNCjs), not sent lines.
5. **Persistent: the strip is under the viewport in every mode** (design, cut, simulate) and reads the same
   heartbeat the app already polls every 2 s — no new machine traffic.

Not now: feed/spindle overrides (refused, R-10), jog, per-axis click-to-type (gSender/MASSO; worth it once a jog
exists), the status-monitor fields (limits, cover, temperatures, RSSI — the matrix's next absent row).

## Layout (mock: `docs/bench/img/2026-10-25-dro-mock/`)

```
[● Idle]   X  19.627   Y   4.702   Z   0.420     ⌂ 0.5 mm 30° engraver   vacuum off   ▮▮▮░░ 62 % · 1:41 left
             −160.498     −188.048     −55.049        ^ hover/tap: T1 · as the job asked for · M491 −72.529
            (small, muted = machine coordinates)
```

Variant A (work only, machine on hover) and variant B (this) are both captured in the mock folder; B is the
design.

Order left to right follows the operator's questions: is it running → where is it → what is in it → what is
on → how far along. Width: the work readout and the tool name are the only things that grow; everything else is
fixed-width.

## Data already in hand

`protocol.ts` parses the state word, MPos, WPos and `P:`; `machineStore` holds the heartbeat; the frozen package
knows the cutter; the location knows the checked-out probe; the registration executor knows when it owns the
machine. Nothing new is read from the machine.

## Bench check

Power on, Idle at home: the strip reads `Idle · X 178.975 Y 191.925 Z 53.129 (work)` (tonight's G54 against the
homed rest) and the tool slot reads the cutter from the frozen badge package; hover shows `−1.000 −1.000 −1.000`.
Then one registration: the slot flips to the probe while the executor owns the machine, the coordinates follow
the touches, and the state word walks Probing → Homing → Idle.
