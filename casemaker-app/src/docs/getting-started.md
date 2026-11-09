# Getting Started

A first run, start to finish: install the app, open it, make a case, export it for printing, and
cut a hardwood name plate on the CNC. Ten minutes, no prior experience needed.

Building Case Maker from source, or running its test suites, isn't here — see **For developers**
in the docs list for that.

## 1. Install

Case Maker runs two ways:

- **In a browser, no install.** Open **<https://electricrv.ca/casemaker>**. Nothing to download;
  your projects save to the browser and export normally.
- **As a desktop app.** Download the installer for your platform and run it. The desktop app adds
  offline use and, on a machine with a CNC attached, direct control of the cut.

Either way opens to the same welcome page.

For the CNC side, use a **64-bit browser**: the planner needs 64-bit address space.
On Windows on ARM, Edge is the native ARM64 build; `chrome://version` or `edge://version` shows
whether the browser is 64-bit. A 32-bit browser is refused at Generate with a plain sentence,
before planning starts.

## 2. Open the app

The welcome page offers four things to make:

- **Cases that fit the board** — pick a board and the shell grows around its ports, holes and
  standoffs.
- **Racks sized to your gear** — a snap-together 10-inch rack, resized to fit your printer.
- **Toolboxes that stack** — bins and lids that register on each other, with inserts pocketed to
  your own tools.
- **Cut it on the CNC** — carve hardwood: a name plate, a coaster, a pocket, an engraving.

This walkthrough tries the first and the last. The **User Manual** covers all four, each with its
own worked example. (The CNC side is withheld on the public site unless the address carries
`?BETA=yes`; the desktop app shows it without the switch.)

## 3. Make a case

1. Click **Cases that fit the board**.
2. Search for a board — try "rpi-4b" for a Raspberry Pi 4B — and click its card. A detail panel
   shows its connectors and mounting holes.
3. Click **★ Create from quickstart**. The shell generates around the board's real geometry: ports
   lined up with connectors, standoffs under the mounting holes.
4. In the sidebar, drag the **Wall thickness** slider — the shell rebuilds as you move it.
5. Under **Case parameters → Joint type**, try **Snap-fit**. Catches appear on the shell and the
   lid without any further setup.

## 4. Export it

Open **Export** and click **STL (ASCII)** — the default, readable format. The file is in
millimetres, upright, ready to drop into a slicer — no rotation or unit conversion needed.

## 5. Cut a hardwood job

1. Back on the welcome page, click **Cut it on the CNC**. This opens a short wizard: Machine, What
   are you cutting?, Stock, Holding.
2. Walk through it without picking anything new, and press **Create the job** on the last step. A
   fresh job already carries three lines of engraved text on a 100 × 60 × 12 mm hardwood block —
   nothing to build from scratch for this first look.
3. In the Job panel, click **Generate**. The app plans the cut, checks it against the stock, and
   runs a simulated pass — watch the simulation sweep across the block.
4. When it finishes, the job is ready to post as G-code for a CNC machine, the same way the case
   above was ready to export as an STL.

That's the shape of every project in Case Maker: pick what you're making, let the app do the
geometry, check the result, then export or cut it.

## Next steps

- **User Manual** — all four capabilities, each with a worked example, the main options, and
  common questions
- **For developers** — build the app from source, run its test suites, or drive a job from the
  command line
