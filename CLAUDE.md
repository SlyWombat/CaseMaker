# Case Maker — notes for Claude sessions

The app lives in `casemaker-app/` (React + Vite + TypeScript, **Tauri** desktop shell in
`casemaker-app/src-tauri`, Playwright tests). Same cPanel deploy pattern as Dust-Analysis.

## Node environment & where to run (machine setup, 2026-09-14)

- **Node 24 LTS.** Windows: `winget install OpenJS.NodeJS.LTS`. WSL Debian: nvm,
  `nvm use 24` (default 24.21).
- **The Windows desktop build must run on Windows**, not WSL. Prerequisites on this
  machine: Node 24, Rust `stable-x86_64-pc-windows-msvc` (rustup, installed 2026-09-14),
  Visual Studio Build Tools with the **Desktop development with C++** workload, and the
  WebView2 runtime (present). Recommended checkout: `C:\Dev\CaseMaker` (not OneDrive).
  Then `cd casemaker-app && npm ci && npm run tauri build`.
- **The Linux build runs on kdocker3 (192.168.10.38), not WSL.** IT's rig at
  `/data/builds/casemaker-src/cm_build.sh <sha>` builds **two .debs** from a pinned commit in a
  throwaway `rust:1.90-bookworm` container: the house bundle first (`--config
  '{"build":{"beforeBuildCommand":"npm run build:house"}}'`, kept as `house.deb`) then the desktop
  bundle, both with `--bundles deb`. `cm_house.sh` publishes the house deb to `:8000`;
  `cm_swap.sh` puts the desktop deb into the Xvfb/tauri-driver test container. The full recipe —
  packages, Node, the rolldown-binding workaround, the two-bundle order, `CASEMAKER_BUILD` — is in
  `casemaker-app/src/docs/deployment.md` §3. A WSL clone (`~/projects/CaseMaker`) can still build,
  but **never point both OSes at one checkout**. Allow inbound UDP 3333 for discovery on Linux; the
  deb installs no firewall rule.
- **Pick one side per checkout.** `node_modules` holds OS-specific native binaries
  (esbuild, rolldown, @tauri-apps/cli) and `.bin` links.
- **Never `npm install` from WSL inside the OneDrive folder.** On 2026-09-14 WSL-created
  Linux symlinks in `casemaker-app/node_modules/.bin` (incl. `playwright`,
  `playwright-core`) were the files OneDrive reported "in use" and couldn't upload
  (Reason 334), driving an endless retry/CPU loop; `node_modules` was deleted to stop it.
- Restore deps with `npm ci` (uses `package-lock.json`; never commit `node_modules`).
- Playwright browsers: `npx playwright install` (Windows) or
  `npx playwright install --with-deps chromium` (WSL, needs sudo).
- Back up via the git remote, not OneDrive.

## Bench power — the Makera CNC plug (2026-10-07)

The Z1's mains runs through a Home Assistant smart plug: **`switch.makera_cnc`** ("Makera CNC",
device class `outlet`). **Turn it on before any hardware-based activity and off when finished** —
an air run, a cut, a config sweep, anything that expects the machine to answer on the LAN.

It is driven through the HomeAssistant checkout's `ha-api.sh`, which resolves the admin token on
`kdocker2` over SSH and never prints it. No token goes on a command line:

```sh
HA=/mnt/c/Projects/HomeAssistant/scripts/ha-api.sh
$HA /api/states/switch.makera_cnc          # what it is set to right now
$HA -X POST /api/services/switch/turn_on  -d '{"entity_id":"switch.makera_cnc"}'
$HA -X POST /api/services/switch/turn_off -d '{"entity_id":"switch.makera_cnc"}'
```

`casemaker-app/tools/z1/power.sh` wraps this and does the part a bare curl does not: `on` waits for
the controller to **come online** (command port 2222 accepts, then the `?` status line answers) and
exits non-zero if it does not, leaving the plug on; `off` refuses unless the machine is `Idle`
(`--force` overrides; an unreachable machine is switched off with a warning). `status` reads both.
Run it from WSL (it calls the Windows harness itself):

```sh
casemaker-app/tools/z1/power.sh on        # --wait <seconds>, default 180; --dry-run to rehearse
casemaker-app/tools/z1/power.sh on --cycle  # plug already on but the machine silent: it sometimes fails to
                                            # join the network at power-up, and only a plug cycle brings it back
casemaker-app/tools/z1/power.sh off
casemaker-app/tools/z1/power.sh status
```

Switching it is a **physical** act, not a code change: check the state before toggling, and never
cut power while a job is running. The machine itself is at `192.168.10.43`; the bench harness is
`casemaker-app/tools/z1/` (run from Windows).
