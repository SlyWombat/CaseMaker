# Linux packaging: the .deb, the tarball and the APT repository (#866)

The release pipeline this document describes was modelled on MegaPDF's,
`MegaPDF/tools/Linux-Packaging.md`; the scripts here are its Case Maker equivalents. The Flathub
manifest and the hand-started Snap workflow are part of it: both are built and launched in CI, so
what a submitter would send is what has been run.

Nothing here runs on a push. A `linux-v*` tag makes a **draft** release; a person publishes it.

## What is in the tree

| | |
|---|---|
| `tools/linux/package-version.sh` | the package version: tauri.conf.json's `version`, plus `PACKAGE-REVISION`'s `-<n>` while it names that version. |
| `tools/linux/PACKAGE-REVISION` | the packaging revision, `"<app version> <n>"`. Empty (comments only) until a rebuild of unchanged app needs one. |
| `tools/linux/build-deb.sh` | builds the ONE `.deb` (#867: desktop bundle = server) with `npx tauri build --bundles deb`, stamps `CASEMAKER_BUILD`, re-stamps the control `Version` to the package version, and checks the systemd unit is inside it. |
| `tools/linux/check-deb.sh` | installs that `.deb` on a bare machine, launches it **headless** (`--headless --bind-all`), asks `/api/v1/health`, checks the unit, removes it. |
| `tools/linux/make-apt-repo.sh` | the signed APT repository (`dists/stable`, `pool/main/c/casemaker`) from one or more `.debs`, plus the keyring/`.sources` a person subscribes with. Refuses any key but the one in `tools/linux/apt/FINGERPRINT`, and checks its own InRelease with gpgv before it finishes. |
| `tools/linux/check-apt-repo.sh` | subscribes to that repository in clean Debian/Ubuntu containers, installs, runs headless, publishes a newer version and watches `apt upgrade` take it, and checks a stranger's signature is refused. |
| `tools/linux/make-release-tarball.sh` | `casemaker-linux-x64-<ver>.tar.gz` + sha256 — the binary, desktop entry, icon, licence and install scripts; it then unpacks and launches the archive headless. |
| `tools/linux/install.sh`, `uninstall.sh` | installs the tarball under a prefix (`/usr/local` by default) and removes it. |
| `tools/linux/casemaker.desktop` | the desktop entry. |
| `tools/linux/apt/FINGERPRINT` | the APT signing key's fingerprint. **Committed by the maintainer**; the repository will not build without it. |
| `tools/linux/flatpak/flathub/ca.electricrv.CaseMaker.yml.in` | the Flathub manifest as a template; `make-flathub-manifest.sh` fills the source from the tarball. |
| `tools/linux/make-flathub-manifest.sh` | writes the manifest a Flathub pull request would contain (URL + sha256), or a local one for a dry run. |
| `tools/linux/build-flathub-flatpak.sh`, `check-flatpak.sh` | build that manifest into a bundle, install it, and ask the page's own server for health from inside the sandbox. |
| `tools/linux/flatpak/ca.electricrv.CaseMaker.metainfo.xml` | the AppStream listing (also carried in the tarball). |
| `tools/linux/snap/snapcraft.yaml.in`, `snap/make-snapcraft-yaml.py`, `build-snap.sh`, `check-snap.sh` | the core24 snap, built from the release tarball and proved under strict confinement. |
| `.github/workflows/snap.yml` | the snap build, rehearsal on every change to these files, and the hand-started edge upload. |
| `.github/workflows/linux-release.yml` | the tag build: deb → tarball → install-and-serve proof → signed APT repo → draft release. |
| `.github/workflows/windows-installer.yml` | the Windows tag build: signed NSIS installer → install-and-serve proof → draft release, on `windows-v*`. |

## Building them by hand

```sh
cd casemaker-app && npm ci
cd .. && tools/linux/build-deb.sh                 # -> artifacts/release/casemaker_<ver>_amd64.deb
sudo tools/linux/check-deb.sh                     # installs it, serves headless, removes it
tools/linux/make-release-tarball.sh               # -> artifacts/release/casemaker-linux-x64-<ver>.tar.gz

APT_SIGNING_KEY_FILE=~/secrets/casemaker/apt-signing-key.asc \
    tools/linux/make-apt-repo.sh artifacts/apt artifacts/release/casemaker_*_amd64.deb
APT_SIGNING_KEY_FILE=~/secrets/casemaker/apt-signing-key.asc \
    tools/linux/check-apt-repo.sh artifacts/apt
```

Needs: Node 24, Rust stable, the WebKitGTK 4.1 build packages (deployment.md §3), `dpkg-dev`,
`apt-utils`, `gnupg`, `curl`, and `docker` for `check-apt-repo.sh`.

## Decisions already made, and why

- **One package (#867).** The deb and the tarball carry the desktop app, which is also the headless
  server (`--headless --bind-all`). There is no separate "house" build; a LAN browser is served the
  same bundle, and the window's own controls are runtime `isTauri` checks.
- **The deb is built by Tauri**, not by a hand-rolled `dpkg-deb` tree: the bundle's dependencies,
  desktop entry, icons and the systemd unit mapping are Tauri's, and duplicating them would be a
  second, drifting copy. `build-deb.sh` adds what a release needs around it (naming, the build
  stamp, the packaging revision, the unit check).
- **A tarball as well as a deb.** It is the portable install for systems whose package manager does
  not matter, and it is the one artefact a future Flathub manifest can fetch by URL and checksum.
- **The packaging revision lives in `PACKAGE-REVISION`**, not in tauri.conf: a Debian revision is
  not semver, so Tauri cannot carry it; `build-deb.sh` re-stamps the control `Version` and the
  artefact name. `apt upgrade` then orders 1.0.0 < 1.0.0-2 < 1.0.1 as dpkg does.
- **Secrets are referenced only.** `WINDOWS_CERT_PFX_BASE64`/`WINDOWS_CERT_PASSWORD` sign the
  installer (#290); `APT_SIGNING_KEY` signs the repository; `SNAPCRAFT_STORE_CREDENTIALS` can
  upload the snap to its edge channel. A tag build without the Windows secrets FAILS (an unsigned
  installer must never be attached); a run without `APT_SIGNING_KEY` says so and builds no
  repository; a snap run without the store credential builds and checks the snap and uploads
  nothing.
- **The Flatpak shares the network, on purpose.** The app exists to serve a LAN and drive a
  machine, so the sandbox is given `--share=network`, X11 and the GPU — and no filesystem beyond
  the portals. The runtime is GNOME's, which is what Tauri's own Flatpak guide uses.

## Going live

### The signing key

The maintainer creates it once, as MegaPDF's was:

```sh
gpg --quick-gen-key "Case Maker APT repository <noreply@electricrv.ca>" ed25519 sign never
gpg --armor --export-secret-keys <fingerprint> > ~/secrets/casemaker/apt-signing-key.asc   # chmod 600
gpg --with-colons --list-keys <fingerprint> | awk -F: '/^fpr/ {print $10; exit}' > tools/linux/apt/FINGERPRINT
```

Then commit `tools/linux/apt/FINGERPRINT`, and add the ARMOURED private key as the repository
secret `APT_SIGNING_KEY`. The key's public files are exported by `make-apt-repo.sh` from the key
itself, which is why none are committed. Back the key file up offline: if both copies are lost,
every existing user has to fetch a new key before apt will take another update. No expiry is the
usual choice for a one-person project, and for the same reason MegaPDF made it: an expired key
stops everyone's updates silently.

### The day

1. Tag the commit: `git tag linux-v<version> && git push origin linux-v<version>` (the version is
   `tools/linux/package-version.sh "$(node -p "require('./casemaker-app/src-tauri/tauri.conf.json').version")"`;
   the workflow refuses a tag that disagrees). Windows: `windows-v<version>`.
2. The tag run builds, proves, and leaves a **draft** release. Read the run: the deb was installed
   and served headless, the tarball was unpacked and served, the APT images passed.
3. Publish the draft (that is the maintainer's click).
4. Download the `CaseMaker-apt-repository` artefact and sync it to `electricrv.ca/casemaker/apt/`
   (the site deploy's job when it exists), so the `casemaker.sources` a person already has keeps
   resolving. The pool keeps every published version.
5. The k3 rig: IT switches `cm_build.sh` to the one build and the house container to
   `casemaker --headless --bind-all --port 8000` (#867's hand-in carries the exact change).

### The Snap Store

Nothing uploads until the maintainer creates the Snap Store account and runs
`snapcraft export-login` into the repository secret `SNAPCRAFT_STORE_CREDENTIALS`. Then the Snap
workflow, run **by hand** with `upload` ticked, uploads the built snap to the **edge** channel —
which no one is on unless they ask for it. Promotion to stable is a click in the Snap Store
dashboard, never the workflow. Until then every run still builds the snap and proves it under
strict confinement on an Ubuntu 24.04 runner.

### The Flathub pull request

The tag build writes `ca.electricrv.CaseMaker.yml` with the release tarball's URL and sha256 and
builds that exact manifest (with the local path) into a bundle it then launches. A pull request
against `flathub/flathub` is a person's step: fork, add that generated manifest, open the PR. The
listing text is `tools/linux/flatpak/ca.electricrv.CaseMaker.metainfo.xml`, which the tarball
carries; its newest `<release>` must be the version being released (the tarball builder enforces
it).
