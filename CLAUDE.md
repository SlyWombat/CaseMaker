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
- A Linux build, if ever wanted, needs a **separate** clone in WSL (`~/projects/CaseMaker`)
  plus webkit2gtk system packages — never point both OSes at one checkout.
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

Switching it is a **physical** act, not a code change: check the state before toggling, and never
cut power while a job is running. The machine itself is at `192.168.10.43`; the bench harness is
`casemaker-app/tools/z1/` (run from Windows).
