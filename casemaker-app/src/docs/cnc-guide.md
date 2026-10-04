# The CNC guide

This is the user guide for Case Maker's CNC work, written for someone who owns a
**Makera Z1** and has never driven a CNC before. It covers the whole workflow: simulating
a G-code file, and (still to come) engraving text into a block of wood.

Two things to hold on to before you read on:

- **Case Maker produces a file. It does not drive the machine.** There is no connection to
  the Z1 here. You export a `.nc` file, upload it to the machine with **Makera Studio**, and
  set the work origin there. Every chapter that could be read otherwise says so again.
- **Case Maker supports the Z1 only.** Carvera and Carvera Air are different machines; the
  app does not model them.

For the rest of the app — building cases around boards — see the
[User Manual](https://github.com/SlyWombat/CaseMaker/blob/main/docs/user-manual.md). This
guide is about the CNC side only.

**Every section opens with a status line, and the status is true.** The three values are
**Available** (you can do it in the app today), **Partly available** (some of it works; the
rest is planned, and the rest names its issue), and **Planned** (not in the app yet; the
section describes the design). A planned section is written in the future tense on purpose —
if a sentence says "will", it is not shipping yet. Everything is in millimetres.

---

## 1 · What this is, and what it is not

> **Status: Available** — a statement of scope.

**What it is.** Case Maker can do two CNC things for a Makera Z1: **simulate** a G-code file
you already have (so you can see what it cuts before risking a blank), and — later — **write**
an engraving program for a block of wood. Both end at a `.nc` file on disk.

**What it is not.** It is not machine control. It does not talk to the Z1. You take the
`.nc` file to **Makera Studio**, upload it, set the work origin on the machine, and press
go on the machine itself. Nothing is sent to the machine from Case Maker, ever.

**What is deliberately not built** (from `/Fabrication.md` §9.1 — each is a decision, not an
oversight):

- Machine control over WiFi.
- Automatic probing.
- Autolevelling (`G32`).
- 3D surfacing.
- V-carving.
- Laser work.
- The 4th axis.
- Multi-tool jobs.

> **⚠ Safety.** The simulation assumes a **rigid, ideal machine**: no deflection, no runout,
> no Z-chain error, no chatter. It does not know about a clamp you added, a cutter you fitted
> differently, or a blank that is not the size you typed. A simulated file that looks clean is
> still a file cut by a real machine on a real block. **Never run a job unattended**, and keep
> your hand on the stop.

---

## 2 · The machine, and what you need

> **Status: Available** — reference.

**The Makera Z1** (from `/Fabrication.md` §1; figures are Makera's own machine-database row,
not a wiki page):

| | Makera Z1 |
|---|---|
| Work volume | 200 × 200 × 100 mm |
| Max spindle | 13 000 RPM (150 W, closed loop, 0.01 mm runout) |
| Max feed rate | 1 200 mm/min |
| Automatic tool changer | **none** — you change cutters by hand |

**The three probes.** Three things ship or are sold under nearly identical names, they all
install the same way and plug into the same connector. Only **one** can touch off
non-conductive material like wood or PLA. Getting this wrong means the whole workflow does
not work at all.

| Probe | Axes | Materials |
|---|---|---|
| **Wired probe** (in the box) | Z only, plus surface levelling and area scanning | not stated |
| **3D Probe Rod** (in the box) | X, Y and Z | **conductive only** — the workpiece must be electrically connected to the aluminium table |
| **Makera 3D Probe** (separate accessory) | X, Y and Z | both conductive **and non-conductive** |

For a wood blank you need the **separate Makera 3D Probe**. The rod that came in the box
cannot do it.

**The low-profile vise.** The **fixed jaw is on the left**. It locates the part in X and in
rotation, and leaves it free to slide in Y. It mounts with the wasteboard removed. Its
dimensions are published nowhere, which is why the app ships defaults and asks you to
measure your own (chapter 5).

**Cutters: flat end mills only, for now.** A V-bit *couples depth to stroke width* — cut
deeper and the groove grows wider — so a per-label depth control would stop meaning what the
screen says (`/Fabrication.md` §7.4). A flat end mill pockets the glyph region, where depth
is genuinely independent. That is the honest reason the app sweeps flat end mills only; it is
not that a V-bit is worse at small text.

---

## 3 · Ideas you need first

> **Status: Available**.

Short, each with a picture.

**The work origin.** The corner every coordinate is measured from is the **top-front-left
corner of the blank**. Z = 0 is on its **top face**, so cuts go to negative Z.

```text
        +Y (away from you)
         ^
         |
         |   top face:  Z = 0,  cuts go DOWN to -Z
   back  +---------------------+  back-left
         |                     |
         |      the blank      |     +X (to the right)
         |                     |
   front +---------------------+  <-- work origin (top-front-left)
        (you)  +Z up out of the page is +Z
```

You do not type this origin into Case Maker as a machine position. On the machine you set
it with Studio and the probe; Case Maker's simulation carries it as an input, tagged with
where it came from (see *Provenance*, below).

**The cutter's radius decides what can be engraved.** The cutter can only reach the part of
a stroke its centre can enter. Anything thinner than the cutter's **diameter** vanishes
entirely, and inside corners come out rounded at the cutter's radius. This is the
morphological *opening* of the glyph (`/Fabrication.md` §7.5). Measured on the bundled
bold sans with a 1 mm cutter (#191): a 4 mm cap height keeps **3.9 %** of its area, 6 mm
keeps **88.9 %**, 10 mm keeps **98.8 %**. Small text does not "look a bit rough" — most of
it is simply gone.

| Cap height | Kept with a 1 mm cutter |
|---|---|
| 4 mm | 3.9 % |
| 6 mm | 88.9 % |
| 10 mm | 98.8 % |

**Depth per label.** Each label carries its own depth. Depth is what decides how deep the
floor of an engraved word sits below the top face. On a one-colour blank it is a look; on a
two-colour blank it is what reveals the lower colour (chapter 6).

**What "simulated" means here.** The app sweeps the cutter along the file's **own moves** and
subtracts the result from the stock. It is **exact for a flat end mill cutting at a constant
depth**. Material updates at a limited number of points along the program; between those
points the tool moves over a still picture of the stock. So the simulation is not an
animation of every chip — it is a set of correct snapshots with the tool moving between them.

**Provenance.** Every number the app did not compute itself is tagged with where it came
from, and "unmeasured" is not "measured". You will see badges like:

- **"unmeasured defaults"** — a shipped guess (a vise's jaw numbers, a starting feed). Fine
  to run with, but the app tells you it is a guess.
- **"from file header"** — read from the `.nc` file's own `;@MKR|` header. Untrusted input:
  it prefills a form, it does not decide anything.
- **"placement: stub"** — the part's position on the bed is **assumed, not measured**.

That last one matters most. A real placement comes from probing on the machine; Case Maker's
simulation works from an assumed one until you give it a better number.

---

## 4 · Simulate a G-code file — CNC-1

> **Status: Partly available** — the Simulate panel (#196) works today; the viewport layers
> (#197), playback (#198) and the end-to-end browser tests (#199) are planned.

You have a `.nc` file — from Makera Studio, from another CAM tool, or from Case Maker's own
engraver once it lands — and you want to see what it does before it touches a blank.

The **Simulate .nc** entry sits in the sidebar under a **CNC** divider, below Export. It is
present in rack mode too.

![The sidebar with the two CNC entries](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sidebar.png)

*Design mockup — not the shipped screen.*

**Opening a file.** Click **Open .nc…** or drop a file onto the panel. Accepted extensions
are `.nc`, `.gcode`, `.cnc` and `.tap`, up to 64 MB. The file is parsed, run and swept **in
the app** — nothing is uploaded, and nothing is sent to a machine.

![The Simulate panel with no file open](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-idle.png)

*Design mockup — not the shipped screen.*

**Confirming stock and tool.** If the file carries a `;@MKR|` header, the stock length,
width and thickness are prefilled from it, each tagged **“from file header”**. The header
does not state the cutter's geometry reliably, so the tool dropdown starts empty and is
**required** — you choose the tool the program was written for. **Simulate** stays disabled
until both a file and a tool are present. A file with no header is fine; you just type the
three stock numbers yourself.

![The Simulate panel asking for a tool](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-tool-required.png)

*Design mockup — not the shipped screen.*

An **Advanced** disclosure lets you state the **tool in the spindle at the start** (unknown,
empty, or T1–T6). A program cannot know the machine's starting tool, and on the Z1 an `M6`
to the already-active tool does nothing — no change and no length calibration. If you leave
it *unknown*, the runner treats the first tool change as real and warns that it cannot know
better.

**Running.** Press **Simulate**. Parsing and running finish quickly; the **sweep** — unioning
the cuts at each checkpoint — is the slow part, a few seconds on a dense job. A progress bar
shows `sweeping n / m checkpoints`, and **Cancel** terminates the worker and disposes the
session.

![The Simulate panel sweeping](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-running.png)

*Design mockup — not the shipped screen.*

**Reading the picture** — *planned (#197)*. When the sweep finishes, the viewport will draw
the stock as cut so far, the removed material as a translucent ghost you can toggle, the cuts
as bright paths (with the cuts still to come dimmed), the rapids dashed in a third colour,
the tool as a cylinder at its current position, and any **gouge** — a rapid that passes
through material the program has not removed yet — in the alarm colour. A **Layers** panel
will toggle each one. The vise jaws will draw as translucent grey, labelled with their
source.

![The viewport with the stock, ghost, gouge and tool drawn](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-viewport-ready.png)

*Design mockup — not the shipped screen.*

**Playback** — *planned (#198)*. A transport bar at the bottom of the viewport will carry
start, step-back, play/pause, step-forward and run-to-completion, speeds of 1×, 5×, 20× and
100×, and a scrubber whose only tick marks are the program's **pause points**. The
read-out is **simulated time**, not a cycle-time estimate — rapids use a display-only rate.
Material updates at checkpoints, not every frame, so the tool moves smoothly over a still
stock between them. When the program reaches a tool change, playback **stops at the pause**,
names the change and waits: a virtual tool swap is a pause, not an error, unless you said the
starting tool was unknown.

![The transport bar](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-transport.png)

*Design mockup — not the shipped screen.*

![Playback stopped at a tool-change pause](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-paused.png)

*Design mockup — not the shipped screen.*

When the run is done — or refused — the panel reports the result: volume removed,
checkpoint count, sweep time, a **placement: stub** badge, and the **diagnostics**, grouped
by source (parser / runner / sweep) with errors first and true per-code counts.

![The Simulate result with diagnostics](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-ready.png)

*Design mockup — not the shipped screen.*

**When the app refuses a file.** Some jobs the app will not sweep at all, and it says why
instead of guessing:

- **A laser job** (`M321`): a mill simulation refuses it rather than drawing a cut.
- **A rotary job** (an `A` axis move): V1 does not simulate rotary work.
- **A 3D or dense job**: too many separate Z levels for the 2.5D sweep. When this happens the
  **tool path is still drawn** so you can inspect the file; the stock is not, because the
  sweep that would produce it was refused. A **Try again with a longer limit** button may
  appear.
- **An unknown tool shape**: V1 sweeps a flat end mill only.

Every refusal and warning has a short code. Chapter 8 lists all of them.

![The refused state with a path-only viewport](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-sim-refused.png)

*Design mockup — not the shipped screen.*

**What it cannot tell you.** The six-word version sits at the bottom of every result: *"This
simulation assumes a rigid, ideal machine: no deflection, no runout, no Z-chain error, no
chatter."* Spelled out: it does not model how the cutter bends under load, how much the
spindle and collet wobble, how far the Z stack creeps between a probe and a cut, or how the
wood chatters when the cutter bites. It does not know about the fixture unless the fixture
has been given to it, and it does not know whether your blank is the size you typed. It
answers *"does this file's geometry overlap the stock where I think it does"*. It does not
answer *"will this come out clean"*.

---

## 5 · Engrave text into wood — CNC-2

> **Status: Planned** — CNC-2 (#200, #201, #202, #203, #204, #205, #206, #207). Not in the
> app yet; this section describes the design.

This is a walkthrough of the default job, start to finish. Today the engine pieces exist
(the job document, the tool-radius check, the vise envelope, the feeds model), but there is
no **Engrave text** panel yet — the screen is designed, not shipped. **Read every step as
future tense.**

The **Engrave text** entry will sit in the sidebar next to **Simulate .nc**, and — like
every other part of this — **it ends at a `.nc` file you upload with Makera Studio.** Case
Maker will not start the machine.

**1. Describe the blank (#205).** You will type the stock's length (X), width (Y) and
thickness (Z), and pick a material (softwood, hardwood, MDF, PLA). X runs between the vise
jaws; the fixed jaw is on the left. The stock's front-left corner is the work origin.

**2. Add labels (#200, #205).** Each label will carry its own text, font, weight, cap height,
position on the blank, rotation and **depth**. The editor will show a depth box with a
slider beside it — never a slider alone, because depth is a number you will want to type.
Labels at different depths are normal: the default job is three words at 2.0, 1.0 and
0.5 mm.

![The Engrave panel being edited](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-editing.png)

*Design mockup — not the shipped screen.*

**3. Choose the cutter; read the lost-detail warnings (#201).** With the labels set, the app
will work out which cutter keeps the most of each glyph and put the best one first —
*"Largest cutter that keeps every label intact."* You can pick another; the app keeps your
choice and offers the recommendation back. A **Why?** disclosure will list every cutter
considered with its worst label and the percentage kept. When a label loses detail, a warning
under that row will say what to do — *"‘Maker' at 4 mm loses 96 % of its area with a 1.0 mm
cutter — increase to 6 mm or more."* When a label breaks through the floor, an error, not a
warning, and Generate stays disabled until it is fixed.

![The cutter recommendation with its reason](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-tool-recommendation.png)

*Design mockup — not the shipped screen.*

![Findings under the labels they belong to](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-findings.png)

*Design mockup — not the shipped screen.*

**4. Describe the vise; what "unmeasured defaults" means; save your own measurements
(#203).** The jaws are what hold the blank and what the tool must not hit. Their dimensions
are published nowhere, so the app will ship **unmeasured defaults** and say so. Two buttons
will record your own: **Save as my vise** and **I just measured these**. Until you measure,
`vise-default` is a standing warning and collisions cannot be trusted.

**5. Cutting parameters (#202).** Spindle speed, feed, plunge, step-down and step-over will
be shown as **starting values, unmeasured** — not recommendations. Nothing has measured what
this machine does in this wood yet (#209), so the numbers are a place to start, and the panel
will say exactly that. You can override each one.

**6. Generate — the three checks (#206).** Pressing **Generate** will produce the toolpath
and then run three gates, each a row with a tick or a cross:

- **Toolpath generated** — operations, move count and an estimated time.
- **Verified** — the toolpath re-read and checked against the stock: it does not exit the
  stock, does not cut deeper than the floor allows, and stays clear of the fixture.
- **Simulated** — the toolpath swept and compared against the predicted region.

**Nothing is written to disk until all three rows are ticks.** The **Save .nc…** button will
stay disabled while any gate fails, with the reason beside it. This is the answer to *"why is
Save disabled?"* in the troubleshooting table: one of the three checks has not passed, and
the failing row says which.

![All three checks passed; Save and Run sheet are enabled](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-generated.png)

*Design mockup — not the shipped screen.*

![Verification failed; Save is disabled with the reason](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-generated-blocked.png)

*Design mockup — not the shipped screen.*

**7. Watch it in the simulator before the machine.** The engrave preview will draw the blank
with each label's floor cut in and coloured by depth on a fixed ramp, so the same depth is the
same colour in every job. What it draws is the **opened region** — the glyph grown and shrunk
back by the cutter's radius — so inside corners are rounded and strokes thinner than the
cutter have vanished. That is what the cutter will actually make, not an idealised glyph.

![The engraved floors, coloured by depth](https://raw.githubusercontent.com/SlyWombat/CaseMaker/main/docs/assets/cnc/cnc-mockup-engrave-viewport.png)

*Design mockup — not the shipped screen.*

**8. Print the run sheet (#207).** A **Run sheet** will list, on one page, the cutter, the
work origin, the stock, the feeds and the steps to follow at the machine, so you are not
reading a phone next to a spinning cutter.

> **Placeholder — no capture yet.** The run-sheet screen has no mockup; it is designed in
> #207. A screenshot will go here when it ships.

**9. At the machine.**

> **⚠ These steps have not yet been confirmed on a machine.**

> **Placeholder — no capture yet.** #208 records the at-the-machine steps and #209 records
> the feeds and finishes. Until they land the steps below are unverified, and this is where
> their photographs will go.

The steps, in prose, will be: mount the correct cutter and probe its length; fit the blank in
the vise and confirm it is proud of the jaws; set the work origin with the Makera 3D Probe;
upload the `.nc` with Makera Studio; run the job with your hand on the stop. When #208 and
#209 record the real screens and numbers, the assumed numbers here become measured ones.

**10. After the cut.** Measure the actual depth of each floor and compare it with what you
asked for. The difference is the Z-chain error the simulation cannot see (`/Fabrication.md`
§7.6) — the sum of probe repeatability, `M491` tool-length repeatability and how the collet
seats. Writing it down is how the assumed numbers become measured ones.

---

## 6 · Two-colour badges — CNC-3

> **Status: Planned** — CNC-3 (#165, #205). Not in the app yet; this section describes the
> design.

A **two-colour badge** is a blank printed in two colours stacked in Z — the lower colour
underneath, the top colour above. Where the engraving cuts deeper than the boundary between
them, the lower colour shows through. Shallow labels stay in the top colour; deep labels
reveal the bottom one. That is the whole effect.

**What must be measured before it can be built (#165).** The badge's blank is printed, so its
thickness carries print error, and the height of the colour boundary is what a label's depth
is measured against. Until that boundary is measured on a real print, no depth means
anything. #165 is the measurement pass.

**Why depth is two choices, not a slider (decision 20).** On a two-colour badge, a label's
depth is not free: it either stays in the top colour (**"surface"**) or goes through to the
bottom one (**"reveal"**). A continuous slider would imply a continuous set of outcomes that
the two-colour stack does not have. So the badge will offer two states, and the honest default
between them carries the meaning.

This chapter describes **no screen**, because there is no mockup for one yet (#165). It
describes what the feature is and what has to be true first. See also CNC-3 #165.

---

## 7 · Later — CNC-4

> **Status: Planned** — CNC-4 (#181, #185, #189). None of these is started.

Three things are on the far side of this work, and none of them is in the app.

**Sending the job to the machine (#181).** A bridge that uploads the `.nc` to the Z1 over
WiFi and starts it, so you do not open Studio at all. This is the "one flag for the user"
narrowing in `/Fabrication.md` §9.1: V1 stops at a verified file on purpose, because the
bridge is the most environment-bound part of the whole job. Not started.

**Using the camera to find the part (#189).** The Z1 has an integrated camera. It cannot
measure Z, and Studio does not use it for origin-setting, so today it is a webcam you can
watch. The plan is to calibrate it against the machine's own motions — the machine is a far
better ruler than a printed sheet — and use it as a coarse datum so a probe starts from a
confident position instead of a blind one. Not started.

**V-carving small text (#185).** A V-bit couples depth to stroke width, so it can reach
strokes a flat end mill cannot — but it needs a medial-axis engine, and it is V2 by decision
(`/Fabrication.md` §7.4). Not started.

---

## 8 · Reference

> **Status: Available** — reference. The rows marked *planned* inside §8.1 and §8.4 are the
> one exception, and each names its issue.

### 8.1 Every diagnostic the app can raise

> **Status: Partly available** — every code the engine raises today is listed; rows marked *planned* arrive with #174, #194 and #204.

You will see these short kebab-case codes in the diagnostics list and in the refusal banner.
The severity is **error** (the app refuses or the cut is unsafe), **warning** (it proceeded,
but something is assumed or unmeasured), or **info** (worth knowing).

**Reading the file** (parser):

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `bad-number` | error | A word's number is not a number the machine would accept. | Fix the line the message names. |
| `stray-text` | error | A line holds text the dispatcher cannot read as G-code. | Fix or delete the line. |
| `console-line` | error | A line starting with a lowercase letter or `$` went to the controller's console, not the G-code dispatcher. | Nothing happened; if you meant G-code, fix it. |
| `n-line-ignored` | error | An `N`-numbered line whose command follows the number is **ignored** by the firmware. | Put the command on its own line, or drop the `N`. |
| `lone-f-switches-g1` | warning | A line starting with `F` becomes `G1`, and that makes `G1` the modal motion — following bare moves now cut. | Check the program's intent. |
| `comment-contains-g90-g91` | error | A comment mentioning `G90`/`G91` is hoisted out of the comment and applied by the firmware. | Remove `G90`/`G91` from comments. |
| `paren-comment-truncates` | error | Text **after** a `(` comment is discarded by the firmware, not run. | Move it out of the line. |
| `unterminated-comment` | warning | A `(` comment has no closing `)`. | Close it. |
| `ignored-line` | warning | A line starting with a character the firmware ignores. | Remove or fix it. |
| `multiple-codes` | error | One command holds both a `G` and an `M` word. | Split them onto separate lines. |
| `t-without-m6` | warning | A `T` word without `M6` on the same command does nothing. | Add `M6`, or remove it. |
| `m6-without-t` | error | `M6` with no `T` word does nothing on this firmware. | Put the `T` in the same command. |
| `unknown-code` | error | A `G` or `M` code the app does not know. | Check the code against §8.2. |
| `unsupported-code` | error | A known code the app will not model (inverse-time feed, canned cycles — the Z1 translates drill cycles instead). | Rewrite it as plain moves. |
| `unsupported-g10` | warning | Only `G10 L2`/`L20` sets a work offset; another `L` is ignored. | Use `G10 L2`. |
| `g10-without-p` | warning | `G10` with no `P` word is ignored by the firmware. | Add `P1` (G54) or `P0`. |
| `g53-invalid` | error | `G53` must be followed on the same line by `G0` or `G1`. | Put them on one line. |
| `g53-params-ignored` | warning | Axis words on a `G53` followed by `G0`/`G1` are discarded. | Remove the extra words. |
| `bad-feed` | error | A feed rate that is not positive. | Give a positive `F`. |
| `no-feed` | error / warning | A cut with no feed rate defined; an arc with none raises a firmware alarm. | Add an `F`. |
| `arc-zero-radius` | error | The arc's `I`/`J`/`K` offsets give a zero radius. | Fix the offsets. |
| `arc-from-unknown` | error | An arc starts or ends somewhere the program never established. | Establish the position first. |
| `arc-r-unsupported` | error | The firmware has no radius-form (`R`) arcs; only `I`/`J`/`K`. | Convert to `I`/`J`/`K`. |
| `arc-radius-mismatch` | warning | The arc's start and end do not sit at the same radius from its centre. | Check the offsets. |
| `atc-self-check` | warning | A bare `M490` is the ATC motor self-check, which this machine (no ATC) does not have. | Remove it. |
| `rotary-axis` | info | An `A` word: the rotary axis is tracked but not interpreted. | V1 does not simulate rotary work. |

**Running the program** (runner):

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `tool-change-noop` | info | `M6` to the tool that is already active does nothing — no change, no length calibration. | Confirm the tool in the spindle. |
| `tool-change-ambiguous` | info | The starting tool was not stated, so whether this is a real change cannot be known; it is treated as one. | State the starting tool if you know it. |
| `g92-4-manual-home` | warning | `G92.4` redefines the machine position; the setup no longer holds and positions are unknown from here. | Avoid it, or re-establish the origin. |
| `wcs-set-unmodelled` | warning | `G10 L…` writes an offset other than G54, which the app does not model; ignored. | Use G54. |
| `wcs-unmodelled` | warning | `G55`–`G59` selects an offset the app was not given; positions are unknown until G54 returns. | Stay on G54. |
| `outside-envelope` | error | A move leaves the machine's work envelope. | Fix the coordinates. |
| `cut-unknown-z` | warning | A cutting move at a Z the program never established — not swept, so the picture has a gap here. | Establish the Z first. |
| `cut-unknown-xy` | warning | A cutting move to an X or Y the program never established — not swept. | Establish XY first. |
| `cut-from-unknown-xy` | info | A cut starting from an unknown X,Y is swept as a plunge at its end point only. | Expect a small gap at the start. |

**Sweeping the cuts** (sweep):

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `stock-unsupported` | error | V1 sweeps a rectangular (prism) block only. | Use a rectangular blank. |
| `stock-invalid` | error | Stock thickness is not positive. | Type a real thickness. |
| `air-moves-unchecked` | warning | More air moves than the app checks; some were not verified. | Split a very long job. |
| `spindle-off-near-bed` | error | A feed move with the spindle off comes within a hair of the bed. | Turn the spindle on, or move it away. |
| `rapid-below-bed` | error | A rapid goes below the bed. | Fix the Z. |
| `spindle-off-near-stock` | error | A feed move with the spindle off comes within a hair of material still present. | Turn the spindle on, or move it away. |
| `rapid-through-stock` | error | A rapid passes through material the program has not removed yet — a gouge. | Slow/insert a feed move, or reorder. |
| `holder-unproven` | warning | The cutter's reach past the collet is unknown, so holder clearance cannot be proven. | Record the cutter's shoulder/flute length. |
| `holder-collision` | error | The cut is deeper than the cutter's shoulder/flute length: the shank would rub. | Use a longer cutter or a shallower cut. |
| `laser-job` | error | A laser job (`M321`); a mill simulation refuses it. | Simulate it elsewhere. |
| `rotary-job` | error | The job moves the A axis; V1 does not simulate rotary work. | Not supported in V1. |
| `tool-refused` | error | The selected tool shape is not a flat end mill, which is all V1 sweeps. | Pick a flat end mill. |
| `dense-3d-refused` | error | Too many separate cut runs at one (segment, Z): a 3D or dense job the 2.5D sweep will not take on. | — |
| `sweep-budget-exceeded` | error | The sweep would take longer than the allowed budget, so it was stopped. | Retry with a longer limit, or simplify the job. |
| `ramp-over-removed` | info | A checkpoint changes Z; it was swept at its lowest Z, removing more than the machine would. | Expect a slightly pessimistic picture. |
| `gouges-truncated` | info | Only the first few gouges are drawn; the rest are reported, not drawn. | Read the other diagnostics. |
| `fixture-unchecked` | info | The fixture is not modelled as an obstacle yet, so proximity to it is **not** checked. | Model the vise (chapter 5). |
| `nothing-to-sweep` | warning | The program has no cutting moves at a known position. | Check the program. |
| `gaps` | warning | Some cutting moves could not be placed and are missing from the picture. | Read the `cut-unknown-*` rows. |
| `label-empty` | error | A label has no text. | Type text or disable it. |
| `label-chars-lost` | error | A label loses whole characters to the cutter's radius. | Increase the size or use a smaller cutter. |
| `label-detail-lost` | warning | A label loses detail (thin strokes, inside corners) to the cutter's radius. | Increase the size or use a smaller cutter. |
| `label-outside-stock` | error | A label hangs off the blank. | Move it back inside the edge margin. |

**Checking the engraving job** (job):

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `depth-exceeds-stock` | error | A label cuts so deep the floor left under it is below the minimum. | Make it shallower or use thicker stock. |
| `no-labels` | error | The job has no enabled label with text. | Add one. |
| `tool-missing` | error | The job names a tool that is not in the library. | Pick a real tool. |
| `stock-proud-too-small` | warning | The blank stands too far below the jaw tops for the deepest cut, so the cutter would work below the jaws. | Seat the blank higher. |
| `vise-default` | warning | The vise dimensions are unmeasured defaults, so collisions cannot be trusted. | Measure your vise. |
| `vise-stock-not-proud` | error | The blank is not proud of the jaws at all — the cutter would hit the vise. | Seat the blank proud. |
| `vise-stock-proud-exceeds-thickness` | error | The blank stands proud by more than its own thickness; the numbers do not add up. | Re-check the vise and stock numbers. |
| `vise-grip-shallow` | warning | The jaws grip too little of the blank to hold it safely. | Seat the blank deeper, or use thicker stock. |
| `vise-jaw-short` | warning | The jaws are shorter than the blank, so part of it is unsupported. | Check the jaw length. |
| `feed-clamped` | warning | The requested feed is above the machine's ceiling and was clamped down. | Expect a slower cut. |
| `rpm-clamped` | warning | The requested spindle speed is above the Z1's 13 000 RPM and was clamped. | Expect a slower spindle. |
| `feed-refused` | error | The requested feed is so far above the ceiling it was refused rather than clamped. | Use a sane feed. |
| `rpm-refused` | error | The requested spindle speed is so far above the ceiling it was refused. | Use a sane spindle speed. |

**Reading the file header** (form prefill only; these never change the sweep):

| Code | Severity | What it means in plain words | What to do |
|---|---|---|---|
| `stock-multiple` | warning | More than one `STOCK` record; only the first is read. | Keep one. |
| `origin-multiple` | warning | More than one `ORIGIN` record; only the first is read. | Keep one. |
| `stock-shape-unsupported` | warning | The `STOCK` record is not a cuboid, so its geometry is not prefilled. | Type the stock yourself. |
| `stock-field-missing` | warning | A stock dimension is absent from the header. | Type it yourself. |
| `stock-field-invalid` | warning | A stock dimension is not a positive number. | Type it yourself. |
| `stock-axes-unverified` | warning | Length and width differ, and which runs along X is unverified (the one known sample is square). | Check the orientation. |
| `stock-incomplete` | warning | The header lacks a usable length, width or height. | Type the stock yourself. |
| `origin-preset-unverified` | warning | The `ORIGIN` corner is not one with any evidence behind it. | Set the origin on the machine. |
| `origin-unchecked` | warning | The origin cannot be cross-checked without a valid stock. | Type the stock first. |
| `origin-semantics-unverified` | warning | The origin's numbers do not match the expected corner for this stock. | Set the origin on the machine. |

*Planned rows (not in the app yet):* the CAM verifier (#174) will add its own codes
(`parse-error`, `not-our-dialect`, `cut-too-deep`, `cut-outside-stock`, `spindle-off-cut`,
`feed-too-high`, `rapid-too-low`, and others); the runner (#194) will add
`too-many-checkpoints`; the fixture checks (#204) will add `tool-into-fixture`,
`rapid-into-fixture`, `feed-into-fixture`, `holder-into-fixture` and
`holder-vs-fixture-unproven`.

### 8.2 G-code the simulator understands

> **Status: Available**.

From `/Z1-Firmware-Dialect.md`; the Z1 runs a branch of **Smoothieware** in grbl mode, so the
semantics are LinuxCNC-flavoured.

| Group | Codes |
|---|---|
| Motion | `G0`, `G1`, `G2`, `G3`, `G4` (dwell, seconds) |
| Units / distance | `G20` / `G21`, `G90` / `G91` |
| Planes | `G17`, `G18`, `G19` |
| Work offsets | `G10 L2` (set), `G54`–`G59` (select) |
| Probing / clearance | `G28` (clearance position, **not** home), `G38.2` |
| Machine coordinates | `G53` (the next `G0`/`G1` only) |
| Offsets | `G92`, `G92.1`, `G92.4` |
| Program | `M2`, `M30` (end of program) |
| Spindle | `M3` / `M4` / `M5` |
| Tools | `M6 T<n>` (with the `T` on the same command), `M491` (re-measure tool length) |
| Manual tool change | `M490.1` / `M490.2` (the operator handshake) |
| Air | `M7` / `M9` |
| Laser (refused) | `M321`–`M325` |
| Pause | `M600` |

**What it refuses:** inverse-time feed, canned cycles, radius-form (`R`) arcs, and anything
on an `A` axis (rotary). A laser job or a rotary job is refused outright rather than drawn as
a cut.

### 8.3 The `;@MKR|` file header

> **Status: Available**.

Makera Studio writes a self-documenting header, and the machine UI reads it for material,
stock, time estimate and thumbnail. Case Maker reads it too — **as untrusted input that
prefills a form**, never as a decision.

A record is a tag followed by `key=value` fields separated by `|`:

```text
;@MKR|TOOL|number=1|id=112111313812|name=3.175*12mm Flat End(Metal)|type=Flat End|...
```

| Tag | Fields the app reads | What it is used for |
|---|---|---|
| `STOCK` | `id`, `length`, `width`, `height` | Prefills the stock dimensions (cuboid only). |
| `ORIGIN` | `type_name`, `x`, `y`, `z` | A corner preset hint, cross-checked against the stock. |
| `TOOL` | `number`, `id`, `name`, `type`, `diameter`, … | Matches a file to a library tool. |

The full sequence Studio writes is `BEGIN`, `SCHEMA`, `MACHINE`, `MATERIAL`, `STOCK`,
`ORIGIN`, `CAM`, `UNIT`, `TOOL`, `TIME`, `TOOLPATH`, `END` (`/Fabrication.md` §2). The
origin defaults to the stock's **top-front-left** corner. Only the **first** `=` in a field
splits it, and a field with no `=` is kept rather than dropped.

### 8.4 Troubleshooting

> **Status: Partly available** — answers exist for what is built; entries that name a planned feature name it, such as #206 or #207.

| Symptom | What it means |
|---|---|
| **Save is disabled** (engrave) | One of the three gates has not passed (#206). The failing row — Toolpath generated, Verified, Simulated — says which, with the reason beside it. Fix it and generate again. |
| **My text disappeared** (engrave) | The cutter's radius opened the glyph and removed the stroke (#201). Read the `label-detail-lost` / `label-chars-lost` row; use a bigger size or a smaller cutter. |
| **The simulation says the cutter hits the vise** | A `holder-collision` or fixture finding (#203). The jaws and the blank's height above them disagree; re-check the vise numbers and how proud the blank sits. |
| **The simulator refuses my file** | See the refusal banner's code: `laser-job`, `rotary-job`, `dense-3d-refused`, or `tool-refused`. Chapter 8.1 explains each. |
| **The part came out mirrored / rotated / offset** | The work origin or the placement is wrong. The app's `placement: stub` badge means it assumed the position; on the machine, re-probe the origin. Also check `stock-axes-unverified` — which stock dimension runs along X is unverified. |
| **Why does it say "starting values, unmeasured"?** | No feed or speed has been measured on this machine in this wood yet (#209). They are a place to start, not a recommendation. |

### 8.5 Glossary

> **Status: Available**.

- **Stock** — the block you are cutting.
- **Work origin** — the point all coordinates are measured from: the stock's top-front-left
  corner, with Z = 0 on the top face.
- **WCS** — work coordinate system: the offset that puts the program's coordinates onto the
  physical blank (G54 and friends).
- **Rapid** — a fast move that does not cut (`G0`). It carries no feed rate.
- **Feed** — a cutting move at a controlled rate (`G1`), with an `F` in mm/min.
- **Plunge** — a vertical cutting move, straight down.
- **Step-down** — how deep each pass cuts.
- **Step-over** — how far the cutter moves sideways between passes.
- **Stick-out** — how far the cutter protrudes from the collet.
- **Collet nut** — the nut that clamps the cutter in the spindle.
- **Checkpoint** — a point in the program where the simulation updates the stock.
- **Gouge** — a rapid that passes through material the program has not removed yet.
- **Opened region** — the area a cutter of a given radius can actually reach: the glyph grown
  and shrunk back by the radius. Strokes thinner than the diameter vanish; inside corners
  round to the radius.
- **TLO** — tool length offset: the measured length of the fitted cutter, reset by `M491`.
