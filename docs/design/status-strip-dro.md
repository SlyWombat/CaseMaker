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

6. **Accessories as indicators, not text.** (The maintainer, 2026-10-25, after seeing the live strip: the vacuum
   takes real estate "for something that is not that important".) The accessory states — vacuum, antistatic,
   work light — become small indicators at the far left, beside the state dot, in the status-bar pattern every
   desktop uses (menu-bar / status-bar icons with a popover): an icon per accessory (not a bare dot — colour alone
   fails colour-blind operators), filled when on and outlined when off, a tooltip with its name and state, and a
   click opens a small popover that says what it is in one line and offers the toggle with the same guards the
   card switches have (only on an Idle machine with no job; an alarm refuses; the reason shown when disabled).
   The 'vacuum off' text leaves the strip. The matrix row "Accessory-mode panel" (#289) is the long form of this.

Not now: feed/spindle override CONTROLS (refused, R-10 — a reduced override's READOUT landed in #769, below), jog,
per-axis click-to-type (gSender/MASSO; worth it once a jog exists), the status-monitor fields (limits, cover,
temperatures, RSSI — the matrix's next absent row; the temperatures and the halt reason landed behind the state
element in #659).

## The rest of the frame on the DRO (#769)

The frame carries more than position and progress, and the operator asked for all of it in one line. After the
axes and before the tool slot, the strip reads:

- **`F:` — the feed.** The actual mm/min (one decimal at most) as the value; the program's set figure and the full
  override in the hover; a non-100 % override rides beside the value (`F 250 · 50 %`), because a reduced feed is
  news. A 100 % override is not printed (#646: state the value).
- **`S:` — the spindle.** The actual rpm, rounded to a whole number as rpm is read; set figure, override, and the
  same non-100 % rule in the hover. The `S:` temperatures stay in the #659 popover, not in this cell.
- **`T:` — the tool.** The tool slot now states the frame's own active tool number with the name it already had:
  `T1 · ⌀ 1 mm flat end`. `T:0` is the firmware's "nothing fitted" (a manual change parks at 0), so 0 is never
  printed as a tool; the raw value stays in the hover as provenance.
- **`A:` — the ATC state, when a machine sends one.** Not a fourth-axis position: the firmware writes `|A:%d` only
  when the ATC bit is set (`Kernel::get_query_string`), and the Z1 has that bit clear. The cell therefore appears
  only on a machine that sends the field, raw, never dressed as an angle. The fourth axis is the A value of
  WPos/MPos and reads in the rotary read-out's words (`A 154.5° · 3 turns`), as before (#658).

Absent or unreadable fields print "—" and never break the strip; an Offline machine's last F/S are not live, so
they print "—" with the axes (#652). Pinned against recorded frames in `docs/bench/traces`: the idle rest
(2026-10-24-run1-status-trail.log), a cut at feed 600 / 11 677.9 rpm (2026-10-12-cut-rowA.log) and the waiting
frame `T:0,-9.757,1` (2026-10-08-console.log). No recorded frame carries `A:` (0 of 5 689 across docs/ and
.scratch), so the ATC cell's absence is the corpus case and its presence is pinned against the firmware's write
shape, marked synthetic.

WIDTH, MEASURED AND RESOLVED (2026-10-29, #769 review): the band WRAPS rather than clips. At a 1440 window the
viewport column is exactly 760 px and a running strip with a rotary module measures 987 px of content, so one row
clipped its tail — progress and Stop. Before #769 the same strip measured 862 px with a rotary module (790 px
without one), i.e. it already clipped a little: the #647 budget was consumed after it by the machine name/address
(#689), the accessory icons (#648) and the rotary A cell (#658), and #769 adds ~125 px (F + S, and the A's °/turns
words). The row now breaks at cell boundaries onto a second line, so nothing is hidden at the column width: at
760 px the first line reads `Makera Z1 · 192.0.2.10 · icons · Running  X Y Z A  F 600  S 11678` and the second
`T1 · ⌀ 1 mm flat end · progress · 17 % · 49 s left · Stop`. Nothing is dropped; the tool name stays the one
elastic cell, but it yields only within its own row. `tests/e2e/cutConfirm.spec.ts` is the pin: at the 760 px
column with a module checked out it asserts the band's `clientWidth` is exactly 760, `scrollWidth <= clientWidth`,
the band is two rows tall, every kept cell's box lies fully inside the band's, and the tool cell's text is not
truncated. Screenshot: `docs/bench/img/2026-10-29-769-status-fields/20261029-224134-strip-760-rotary.png`; the
1920 view (1240 px column) stays at `20261029-203351-strip-running.png`.

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

`protocol.ts` parses the state word, MPos, WPos, `P:`, `F:`, `S:`, `T:` and `A:` (#526/#659/#769); `machineStore`
holds the heartbeat; the frozen package knows the cutter; the location knows the checked-out probe; the
registration executor knows when it owns the machine. Nothing new is read from the machine.

## Bench check

Power on, Idle at home: the strip reads `Idle · X 178.975 Y 191.925 Z 53.129 (work)` (tonight's G54 against the
homed rest) and the tool slot reads the cutter from the frozen badge package; hover shows `−1.000 −1.000 −1.000`.
Then one registration: the slot flips to the probe while the executor owns the machine, the coordinates follow
the touches, and the state word walks Probing → Homing → Idle.
