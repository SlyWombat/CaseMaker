# Deployment & supported hardware

## Three deployment surfaces

Case Maker ships in three runtime forms; each has a different hardware / OS floor.

### 1. Web SPA in a modern browser

The Vite-built static bundle, served from any HTTP server (the dev server, the embedded Tauri server, or a plain CDN).

**Browser floor:**
- Chromium 110+ / Edge 110+
- Firefox 110+
- Safari 16+

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

**LAN exposure:** the bundled HTTP server listens on `127.0.0.1` by default. The installer accepts `/HOST=<ip>` and `/PORT=<port>` to bind to a LAN address and open the Windows Firewall on the chosen port (see `src-tauri/installer-hooks.nsh`). The server CLI also takes `--host`, `--port`, and `--bind-all` for run-time overrides.

### 3. CLI / sample-export script

`scripts/export-sample.ts` (and the export-sample npm script) compiles a `.caseproj.json` to STL/3MF without launching a UI. Useful for batch jobs and CI.

**Runtime floor:**
- Node 20.19+ or Node 22.12+ (matches Vite 8's engine requirement).
- Headless on Linux / macOS / Windows / Docker.

## What Case Maker cannot run on

- **ARM SBCs (Pi / Jetson) as the Tauri server** — no ARM64 build target wired up. ARM browsers can still load the SPA as a client.
- **Browsers without WebGL2 / WebAssembly** — rules out IE, very old Safari, and some locked-down corporate browsers.
- **The slicer / printer side** — Case Maker exports STL; you slice and print elsewhere.

## LAN access — running the dev server on a specific IP

The Vite dev server defaults to `127.0.0.1`. To make it reachable from other machines on the same LAN:

```bash
# from inside the casemaker-app directory, with Node 20.19+ in PATH
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

## Static / shared-hosting (cPanel, Nginx, etc.) — issue #71

The `dist/` build is a pure SPA (no Node runtime needed on the server). Host it on cPanel, plain Apache, Nginx, GitHub Pages — anywhere static files can live.

### One-command deploy via cPanel API (`npm run deploy`)

1. Generate a cPanel API token (cPanel → Manage API Tokens).
2. Create `.env` at the **repo root** (already gitignored):
   ```
   CPANEL_HOST=cpanel.example.com
   CPANEL_PORT=2083
   CPANEL_USER=<your-cpanel-user>
   CPANEL_TOKEN=<the-api-token>
   WEB_ROOT=/home/<your-cpanel-user>/public_html/casemaker
   ```
3. From `casemaker-app/`:
   ```
   npm run deploy             # build + upload
   npm run deploy -- --skip-build   # upload existing dist/ as-is
   npm run deploy -- --dry-run      # walk + log without uploading
   ```

The script (`scripts/deploy-cpanel.mjs`) builds, walks `dist/`, recursively `mkdir`s the remote subdirectories, uploads every file via `Fileman::upload_files` with the API-token header, and writes a `.htaccess` for the `.wasm` MIME type and long cache headers. A `VERSION.txt` (matching the in-app StatusBar) is also uploaded so you can confirm what's live by hitting `<host>/casemaker/VERSION.txt`.

### Manual cPanel / generic Apache deploy

If you'd rather drag-and-drop in cPanel File Manager, copy the contents of `dist/` into the destination directory and add a `.htaccess` next to `index.html`:

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

### HTTPS strongly recommended

The File System Access API (planned for issue #70) requires HTTPS. cPanel ships free Let's Encrypt certs — enable AutoSSL on the deployed subdirectory before users start saving projects.

### What doesn't carry over from the Tauri build

| Feature | Tauri | Static / shared host |
|---|---|---|
| Embedded HTTP server, `--host` / `--port` flags, installer firewall rules | yes | n/a |
| Native file dialogs (Tauri plugin) | yes | falls back to browser File System Access API on HTTPS, or download/upload on HTTP |
| Multi-user LAN access via embedded server | yes | replaced by the public host |

## Asking for a specific deployment

If you need a particular target validated (kiosk PC, shared LAN server, browser-only client served from a Pi), open an issue with the scenario; the answer will be a concrete spec, not a generic "should work."
