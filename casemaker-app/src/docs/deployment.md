# Deployment & supported hardware

## Deployment surfaces

Case Maker ships in four runtime forms; each has a different hardware / OS floor.

### 1. Web SPA in a modern browser

The Vite-built static bundle, served from any HTTP server (the dev server, the embedded Tauri server, or a plain CDN).

**Browser floor:**
- Chromium 110+ / Edge 110+
- Firefox 110+
- Safari 16+
- **A 64-bit browser.** The CNC planner reserves roughly 454 MiB of address space while it ranks cutters, and a 32-bit renderer cannot: generation dies at the ball rank with "Array buffer allocation failed". On Windows on ARM, the installed Chrome is commonly a 32-bit x86 build under emulation — Edge there is the native ARM64 build. Check that `chrome://version` (or `edge://version`) says **64-bit**. The app refuses a 32-bit browser at Generate, with a plain sentence, before any planning starts; a 64-bit browser that cannot reserve the memory just then is warned and proceeds, and a run that runs out of memory names that cause.

Required platform features: WebGL2, WebAssembly, ES2022, BigInt, structuredClone.

**Hardware floor (practical):**
- Any 2018-or-newer x86_64 or Apple Silicon laptop with ≥ 4 GB RAM.
- GPU: integrated Intel UHD or better is fine for current scenes (host PCB + ~10–20 fixtures + case shell). Very large boards or many stacked HATs will start to chug on really old iGPUs.

**Phones / tablets:** the SPA loads, but the case-parameter sliders and 3D viewport are not designed for touch. Mobile is not a supported surface.

### 2. Tauri desktop app (Windows installer)

The `casemaker_setup.exe` NSIS installer wraps the SPA in a Tauri shell with an embedded Axum HTTP server (`src-tauri/src/server.rs`).

**OS floor:**
- Windows 10 1903+ or Windows 11.
- Requires Microsoft WebView2 (auto-installed on Win 11; bootstrap-pulled by the installer on Win 10).
- Architecture: x64 only today. ARM64 build target not wired up yet.

**Hardware floor:**
- ≥ 4 GB RAM.
- ~150 MB disk for the install.

**Install scope:** the installer is per-machine (`bundle.windows.nsis.installMode`), so it shows one UAC prompt and installs under `Program Files` for all users. That elevation is also what lets it add firewall rules. The bundle is NSIS only — there is no `.msi`, because the msi target runs none of the installer hooks and would silently skip the settings and firewall work.

**Settings:** a first install writes `%APPDATA%\casemaker\config.json` with port 8000 on loopback. The **App settings › App server** panel is the normal way to change the port or allow LAN access; the installer switches are for unattended deployment:

```cmd
rem wizard, switches applied at install
casemaker_setup.exe /PORT=9000 /HOST=192.168.10.16
rem silent
casemaker_setup.exe /S /PORT=9000 /HOST=192.168.10.16
```

`/PORT` must be 1024–65535 (anything else logs and falls back to 8000). `/HOST` opens an inbound TCP rule for the chosen port; without it the server stays on loopback and no TCP rule is added. A switch rewrites the whole file, so pass **both** to pin both — `/PORT` alone resets `host` to null.

**Upgrades keep the settings.** The install hook runs on every install, upgrades included, but it writes `config.json` only when the file is absent (a first install) or when `/PORT`/`/HOST` was passed. An ordinary upgrade over an existing install leaves the file byte-for-byte alone, so a custom port and `host` survive.

**Firewall rules:** every install adds an inbound UDP 3333 rule named **Case Maker Discovery** — the Z1 broadcasts its discovery datagram to that port and the app binds it, so without the rule discovery looks like “no machine found”. The rule is deleted before it is added, so reinstalls replace it rather than stack it. Uninstall removes it, and removes the TCP rule recorded by `/HOST`; the uninstaller step of an *upgrade* deliberately leaves both alone, because the install that follows re-adds them.

**Upgrade-in-place check (each release).** The template's rule is that production install data must survive upgrades, and an upgrade is only proven by running one:

1. On a clean Windows machine, install the **previous** release over the top of nothing; accept the UAC prompt.
2. Set a non-default port (App settings, or `/PORT=`), allow LAN if that is the deployment, and save a project plus any machine/bench records.
3. Install the **new** release over it with no switches.
4. Confirm `%APPDATA%\casemaker\config.json` still carries the custom port and `host`; the saved project opens; the records are there; Add/Remove Programs shows the new version; and `netsh advfirewall firewall show rule name="Case Maker Discovery"` (elevated) still lists the discovery rule.
5. Launch the app and connect to the Z1 on the LAN. A pass here is the release's upgrade evidence; a failure blocks the release.

**USB serial (#775):** a controller on its USB cable, with no network at all, is reached from **Manage › Machines › USB serial** — pick the COM port and Connect. The link carries the same protocol as TCP 2222 (same framing, same commands), because serial is a second connection kind behind the same transport, not a second protocol. It is offered only in the desktop app window on Windows: the web build has no ports, and a LAN browser served by the desktop app is not offered the pane either. Discovery is a LAN broadcast, so a serial machine cannot be found — it is always chosen by hand. Nothing on the link announces the model, so the machine's envelope and limits stay unknown and it is not recorded as the network machine. Program uploads are still network-only; sending a job over the serial link is not wired into the Cut flow yet (bench check: #767).

### 3. Desktop app and server (Linux .deb)

The same Tauri shell builds on Linux as a `.deb` (`Case Maker_1.0.0_amd64.deb`) with the same embedded Axum server. It is **x86_64 only** today — no arm64 Linux target is wired up — and Debian/Ubuntu-family hosts install it with `dpkg -i` (or `apt install ./Case\ Maker_1.0.0_amd64.deb`), which pulls WebKitGTK 4.1, the AppIndicator library and the rest of the runtime.

**Build prerequisites (Debian/Ubuntu):**
- Rust stable ≥ 1.90 and Node 22.12+ (24 LTS recommended) in the build environment.
- `libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev build-essential file curl xz-utils patchelf`.
- `npm ci` in `casemaker-app/`. The lockfile is generated on Windows, so `npm ci` on Linux skips the Linux-native rolldown binding; add it once with `npm install --no-save "@rolldown/binding-linux-x64-gnu@$(node -p "require('rolldown/package.json').version")"` (#565).
- `npm ci` runs the package `postinstall` too: `patch-package` applies everything in `casemaker-app/patches/` — today `manifold-3d+3.5.4.patch`, upstream master's two glue deletes for the polygon-conversion leak (#1022). Drop the patch when a manifold-3d release ships them; `tests/unit/manifoldGlueLeak.spec.ts` holds it in place.

**One package (#867).** The same bundle is the desktop app AND the house server. The Rust server embeds `dist/` at compile time, and that one desktop bundle both opens the window and serves LAN browsers: a browser drives the machine through the instance's relay, while the window's own controls — local-file dialogs and the app-server settings — are runtime `isTauri` checks, so a LAN browser is never offered them. It is built once:

```sh
npx tauri build --bundles deb
```

`tauri.conf.json` keeps `targets: ["nsis"]` so the Windows release path never meets a Linux target; `--bundles` names the bundle the host builds.

**Headless server.** `casemaker --headless --bind-all` runs the same binary as the server alone — no window, no webview. The package ships `/lib/systemd/system/casemaker.service` (installed, not enabled): `systemctl enable --now casemaker` serves the app on the machine's LAN address and drives the machine through the same instance relay. The unit ships without `User=`; set it to the account that should own the app's data — the servers, cutter library and run records it serves.

`CASEMAKER_BUILD=<short sha>` stamps the binary when the build tree has no usable git (a container build does not), so `/api/v1/health` names the commit it came from (#566).

**Floor:** the same hardware floor as the Windows app (≥ 4 GB RAM, ~150 MB disk); WebKitGTK 4.1 is the webview.

**Discovery:** the Z1 announces itself by UDP broadcast to port 3333. On Linux a host firewall such as ufw or firewalld **silently drops it**, and the app reports no machine found; allow inbound UDP 3333 on the interface that reaches the LAN. The Windows installer adds its own rule; the `.deb` changes no firewall setting. The same silence appears if the app runs in a bridged container, because Docker's bridge does not forward the broadcast — run it with host networking to test discovery.

**Makera Studio's library:** Studio does not ship for Linux, so there is no `~/.local/share/MakeraStudio/makera_library.db`; `studio_db_path()` reports "no Studio install", which is the correct answer, and the catalogue tier starts empty. Fill it by enabling an online source or by importing a library export; the house-file import (`/api/v1/import`) carries the house, **not** the catalogue (#212).

**Where it has run:** the house rig on kdocker3 builds the `.deb` from a pinned commit in a `rust:1.90-bookworm` container and runs it on a Debian x86_64 host — the house service on `:8000` from it, and the desktop app from it in a test container under Xvfb, where it serves `/api/v1/health` and its inventory API accepts a cutter. (The rig's script still builds two `.deb`s until it is switched to this one package.) The test container is bridged, so it cannot receive the Z1's discovery broadcast — LAN discovery is the check that needs a host-networked or native install. This is a build-and-run proof, not a released channel: the Windows NSIS installer remains the released desktop build.

### 4. CLI / sample-export script

`scripts/export-sample.ts` (and the export-sample npm script) compiles a `.caseproj.json` to STL/3MF without launching a UI. Useful for batch jobs and CI.

**Runtime floor:**
- Node 22.12+ (24 LTS recommended). Vite 8 itself accepts 20.19+, but this repo's `engines` floor is 22.12 (#565).
- Headless on Linux / macOS / Windows / Docker.

## What Case Maker cannot run on

- **ARM SBCs (Pi / Jetson) as the Tauri server** — no ARM64 build target wired up. ARM browsers can still load the SPA as a client.
- **Browsers without WebGL2 / WebAssembly** — rules out IE, very old Safari, and some locked-down corporate browsers.
- **The slicer / printer side** — Case Maker exports STL; you slice and print elsewhere.

## LAN access — running the dev server on a specific IP

The Vite dev server defaults to `127.0.0.1`. To make it reachable from other machines on the same LAN:

```bash
# from inside the casemaker-app directory, with Node 22.12+ in PATH
npx vite --host 192.168.10.16 --port 8000 --strictPort
```

`--host 0.0.0.0` binds to every interface; specifying an IP picks one.

### Windows Firewall (only if running on Windows directly)

The installer adds the rule automatically when `/HOST=` is supplied. For a hand-launched dev server, run elevated:

```cmd
netsh advfirewall firewall add rule name="Case Maker (TCP 8000)" dir=in action=allow protocol=TCP localport=8000
```

To remove:

```cmd
netsh advfirewall firewall delete rule name="Case Maker (TCP 8000)"
```

### WSL2 → Windows port forward (only if running the dev server inside WSL2)

WSL2 in NAT mode binds inside its own VM, invisible to the LAN. Bridge it from Windows (elevated):

```cmd
netsh interface portproxy add v4tov4 listenport=8000 listenaddress=192.168.10.16 connectport=8000 connectaddress=<WSL_IP>
```

`<WSL_IP>` is the value of `wsl hostname -I` (or `ip -4 addr show eth0` inside WSL). On WSL2 mirrored mode the WSL IP equals the Windows IP and the proxy is a no-op; on NAT mode they differ.

To remove:

```cmd
netsh interface portproxy delete v4tov4 listenport=8000 listenaddress=192.168.10.16
```

### Triage from another machine

```bash
curl -v http://<host>:8000/
```

- *Connection refused* → nothing listening on that IP. Check `netstat -ano | findstr LISTENING | findstr :8000` on the host.
- *Connection timed out* → firewall or NAT dropping. Add the firewall rule (and portproxy if WSL2).
- *200 OK with HTML* → working; any failure beyond this is in the client browser / DNS.

## Static / shared-hosting (Apache, Nginx, GitHub Pages, etc.) — issue #71

The `dist/` build is a pure SPA (no Node runtime needed on the server). Host it on plain Apache, Nginx, GitHub Pages, or any other static-file host.

### Build + upload

1. From `casemaker-app/`: `npm run build` produces `dist/`.
2. Copy the contents of `dist/` to the host's public root (e.g. `public_html/casemaker/`).
3. Drop a `.htaccess` next to `index.html` so `.wasm` is served with the right MIME type and the asset hash bundles get long-lived caching:

```apache
AddType application/wasm .wasm

<FilesMatch "\.(js|wasm|css)$">
  Header set Cache-Control "max-age=31536000, immutable"
</FilesMatch>

# SPA fallback — uncomment if/when client routes are added.
# RewriteEngine On
# RewriteCond %{REQUEST_FILENAME} !-f
# RewriteCond %{REQUEST_FILENAME} !-d
# RewriteRule ^ index.html [L]
```

For Nginx, the equivalent server-block fragment:

```nginx
types { application/wasm wasm; }
location ~* \.(js|wasm|css)$ {
  add_header Cache-Control "public, max-age=31536000, immutable";
}
# SPA fallback — uncomment if/when client routes are added.
# location / { try_files $uri $uri/ /index.html; }
```

### HTTPS strongly recommended

The File System Access API (planned for issue #70) requires HTTPS — without it the app falls back to download / upload instead of an in-browser file dialog. Free Let's Encrypt certs work on essentially every shared host.

### What doesn't carry over from the Tauri build

| Feature | Tauri | Static / shared host |
|---|---|---|
| Embedded HTTP server, `--host` / `--port` flags, installer firewall rules | yes | n/a |
| Native file dialogs (Tauri plugin) | yes | falls back to browser File System Access API on HTTPS, or download/upload on HTTP |
| Multi-user LAN access via embedded server | yes | replaced by the public host |

### Automation

Repo operators can wire up a one-command deploy via whatever automation their host supports (rsync, FTP, S3 sync, host-specific API). Keep host-specific credentials in a `.env` at the repo root (already gitignored). Project-specific deploy walkthroughs live in the operator's local notes — they're not committed because they reference account names, hostnames, and tokens.

## Asking for a specific deployment

If you need a particular target validated (kiosk PC, shared LAN server, browser-only client served from a Pi), open an issue with the scenario; the answer will be a concrete spec, not a generic "should work."
