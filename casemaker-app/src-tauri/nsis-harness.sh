#!/usr/bin/env bash
# Build and run the installer-hook harness (#403).
#
# Needs a Windows makensis and a Windows filesystem to run the built installer, because
# `installer-hooks.nsh` is NSIS and the thing under test is a real installer. Run it from WSL (or
# any shell that can execute a .exe). It finds makensis itself — Tauri's own copy, or `makensis` on
# PATH, or `MAKENSIS=/path/to/makensis.exe` — and EXITS NON-ZERO when there is none, rather than
# skipping: a harness that reports success without running anything is worse than no harness.
#
#     casemaker-app/src-tauri/nsis-harness.sh
#
# It writes only inside this directory (`harness-config/`, `harness-install/`, `nsis-harness.exe`)
# and removes what it made; the settings directory is redirected by a compile-time define, so it
# never touches %APPDATA%. The hook calls `netsh advfirewall` on every install (the discovery rule,
# #403 gap 3), and so does the harness — unelevated, which makes those calls inert. Rather than
# trust that, the run asserts the machine's firewall rule list is byte-identical afterwards, and it
# refuses to run at all from an elevated shell, where the calls would land.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/nsis-harness.nsi"
EXE="$HERE/nsis-harness.exe"
CONFIG_DIR="$HERE/harness-config"
CONFIG="$CONFIG_DIR/config.json"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok()   { printf '  ok: %s\n' "$*"; }

find_makensis() {
  if [[ -n "${MAKENSIS:-}" ]]; then printf '%s' "$MAKENSIS"; return 0; fi
  if command -v makensis >/dev/null 2>&1; then command -v makensis; return 0; fi
  local c
  for c in /mnt/c/Users/*/AppData/Local/tauri/NSIS/makensis.exe; do
    [[ -f "$c" ]] && { printf '%s' "$c"; return 0; }
  done
  return 1
}

to_windows() {
  if command -v wslpath >/dev/null 2>&1; then wslpath -w "$1"; else printf '%s' "$1"; fi
}

is_elevated() {
  powershell.exe -NoProfile -Command \
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)" \
    2>/dev/null | tr -d '\r'
}

# One hash of the whole firewall rule list, so the run can show it changed nothing rather than
# assert it.
firewall_rules() { netsh.exe advfirewall firewall show rule name=all 2>/dev/null | md5sum | cut -d' ' -f1; }

command -v powershell.exe >/dev/null 2>&1 || fail "this harness needs Windows (powershell.exe, netsh.exe and makensis); run it from WSL on a Windows host"
[[ "$(is_elevated)" == "False" ]] || fail "this shell is elevated: the harness's netsh calls would add a real firewall rule. Run it unelevated."

# The exe is built and run on the Windows side; both calls go through PowerShell so the working
# directory is a real Windows one (NSIS resolves OutFile against it).
MAKENSIS_BIN="$(find_makensis)" || fail "no makensis found; set MAKENSIS=/path/to/makensis.exe (Tauri keeps one under %LOCALAPPDATA%\\tauri\\NSIS)"

echo "compiling the harness with $MAKENSIS_BIN"
powershell.exe -NoProfile -Command \
  "Set-Location -LiteralPath '$(to_windows "$HERE")'; & '$(to_windows "$MAKENSIS_BIN")' /V2 'nsis-harness.nsi'" \
  || fail "makensis failed to compile nsis-harness.nsi"
[[ -f "$EXE" ]] || fail "makensis reported success but produced no $EXE"

install_silently() { "$EXE" /S "$@"; }

# Read one top-level number/string out of the written config, without a JSON parser: the hook's own
# output shape is three fixed keys on their own lines and this is what proves which branch wrote it.
# (the file is CRLF — NSIS writes $\r$\n — so every read must drop the carriage return)
port_of() { sed -n 's/.*"port": *\([0-9][0-9]*\).*/\1/p' "$1" | tr -d '\r'; }
host_of() { sed -n 's/.*"host": *\(.*[^ ,]\).*/\1/p' "$1" | tr -d '\r'; }

firewall_before="$(firewall_rules)"

echo "case 1 — a first install writes the defaults"
rm -rf "$CONFIG_DIR" "$HERE/harness-install"
[[ -e "$CONFIG" ]] && fail "case 1: $CONFIG was not removed before the case"
install_silently
[[ -f "$CONFIG" ]] || fail "case 1: no config.json after a first install"
[[ "$(port_of "$CONFIG")" == "8000" ]] || fail "case 1: port is $(port_of "$CONFIG"), expected 8000"
[[ "$(host_of "$CONFIG")" == "null" ]] || fail "case 1: host is $(host_of "$CONFIG"), expected null"
ok "port 8000, host null"

echo "case 2 — an upgrade with no switches leaves the settings alone (#403)"
mkdir -p "$CONFIG_DIR"
printf '{\r\n  "port": 9100,\r\n  "bind_to_all": false,\r\n  "host": "192.168.10.16"\r\n}\r\n' > "$CONFIG"
before="$(md5sum "$CONFIG" | cut -d' ' -f1)"
install_silently
after="$(md5sum "$CONFIG" | cut -d' ' -f1)"
[[ "$after" == "$before" ]] || fail "case 2: the install rewrote the settings ($before -> $after)"
[[ "$(port_of "$CONFIG")" == "9100" ]] || fail "case 2: port is now $(port_of "$CONFIG"), expected 9100"
ok "customised config.json is byte-identical after the install"

echo "case 3 — a passed /PORT rewrites the settings"
install_silently /PORT=9200
[[ "$(port_of "$CONFIG")" == "9200" ]] || fail "case 3: port is $(port_of "$CONFIG"), expected 9200"
ok "port 9200"

echo "case 4 — a first install with /PORT uses it"
rm -rf "$CONFIG_DIR" "$HERE/harness-install"
install_silently /PORT=9300
[[ -f "$CONFIG" ]] || fail "case 4: no config.json after a silent install with /PORT"
[[ "$(port_of "$CONFIG")" == "9300" ]] || fail "case 4: port is $(port_of "$CONFIG"), expected 9300"
ok "port 9300"

# The hook calls netsh on every install now; prove those calls were inert here (they are unelevated,
# asserted above) instead of assuming it.
firewall_after="$(firewall_rules)"
[[ "$firewall_after" == "$firewall_before" ]] \
  || fail "the run changed the machine's firewall rules ($firewall_before -> $firewall_after)"
ok "the machine's firewall rule list is unchanged"

rm -rf "$CONFIG_DIR" "$HERE/harness-install"
printf 'all 4 cases passed\n'
