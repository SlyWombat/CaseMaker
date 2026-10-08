#!/usr/bin/env bash
# Bench power for the Makera Z1: switch the Home Assistant plug, then CHECK the machine followed.
#
#   tools/z1/power.sh status
#   tools/z1/power.sh on  [--wait <seconds>] [--cycle] [--dry-run]
#   tools/z1/power.sh off [--force] [--dry-run]
#
# `on` is not done when the plug clicks. It is done when the controller has booted, joined the LAN
# and answered its status line (`?`) — until then the Z1 is a warm brick that the app will report as
# "no machine reached". So `on` waits, in two stages, and exits non-zero if either does not happen:
#
#   1. the command port (2222) accepts a TCP connection;
#   2. the status line comes back (read through tools/z1/z1.mjs, which has to run on Windows).
#
# A POWERED MACHINE CAN BE SILENT. Observed 2026-10-08: on and answering at 11:4x UTC, then silent on
# every port by ~13:00 with the plug still on. The maintainer's experience is that the machine
# sometimes fails to make its network connection at power-up; why it dropped this time is not known.
# Either way a plug that is already on proves nothing, and `on --cycle` (plug off, wait, on again) is
# the only remote way back; plain `on` says so when it times out with the plug already on.
#
# On a timeout the plug is LEFT ON. A machine that is slow to boot is not a reason to cut its mains,
# and the exit code plus the last thing seen say where it stopped.
#
# `off` refuses while the machine is reachable and its status is not `Idle` (CLAUDE.md: never cut
# power while a job is running). `--force` overrides that. An unreachable machine is switched off
# with a warning: there is nothing to ask, and leaving it powered is the worse outcome.
#
# Switching the plug is a PHYSICAL act. This script does it only when run, and nothing else in the
# repo calls it — it is for the person (or session) the user has told to power the bench.
#
# Environment: HA (default /mnt/c/Projects/HomeAssistant/scripts/ha-api.sh), Z1_HOST (default
# 192.168.10.43), Z1_PORT (default 2222), Z1_ENTITY (default switch.makera_cnc).

set -u

HA="${HA:-/mnt/c/Projects/HomeAssistant/scripts/ha-api.sh}"
HOST="${Z1_HOST:-192.168.10.43}"
PORT="${Z1_PORT:-2222}"
ENTITY="${Z1_ENTITY:-switch.makera_cnc}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cmd="${1:-}"
[ $# -gt 0 ] && shift
wait_s=180
force=0
dry=0
cycle=0
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) wait_s="${2:?--wait needs a number of seconds}"; shift 2 ;;
    --force) force=1; shift ;;
    --cycle) cycle=1; shift ;;
    --dry-run) dry=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'power.sh: %s\n' "$1" >&2; exit "${2:-1}"; }

[ -x "$HA" ] || [ -f "$HA" ] || die "cannot find ha-api.sh at $HA (set HA=...)" 2

plug_state() {
  "$HA" "/api/states/$ENTITY" 2>/dev/null |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["state"])' 2>/dev/null
}

plug_set() { # on|off
  if [ "$dry" -eq 1 ]; then say "[dry-run] would POST switch/turn_$1 for $ENTITY"; return 0; fi
  "$HA" -X POST "/api/services/switch/turn_$1" -d "{\"entity_id\":\"$ENTITY\"}" >/dev/null 2>&1
}

port_open() { timeout 3 bash -c "exec 3<>/dev/tcp/$HOST/$PORT" 2>/dev/null; }

# The status line, or nothing. The harness must run from Windows (transport.node.mjs says why).
status_line() {
  powershell.exe -NoProfile -Command \
    "Set-Location '$(wslpath -w "$APP_DIR")'; node tools/z1/z1.mjs status $HOST --port $PORT" 2>/dev/null |
    tr -d '\r' | grep -m1 -E '<[A-Za-z]+[|>]' | sed -e 's/^[^<]*//' -e 's/"[[:space:]]*$//'
}

state_word() { sed -n 's/.*<\([A-Za-z]*\)[|>].*/\1/p' <<<"$1" | head -1; }

case "$cmd" in
  status)
    s="$(plug_state)"; [ -n "$s" ] || die "could not read $ENTITY from Home Assistant"
    say "plug $ENTITY: $s"
    if port_open; then
      line="$(status_line)"
      say "machine $HOST:$PORT: reachable${line:+, $line}"
    else
      say "machine $HOST:$PORT: not reachable"
    fi
    ;;

  on)
    before="$(plug_state)"; [ -n "$before" ] || die "could not read $ENTITY from Home Assistant"
    say "plug is $before"
    if [ "$before" = "on" ] && [ "$cycle" -eq 1 ]; then
      if port_open; then
        say "machine already answers on $HOST:$PORT; no cycle needed"
      else
        say "plug is on but the machine is silent on $HOST:$PORT: cycling the plug"
        plug_set off || die "Home Assistant refused turn_off"
        [ "$dry" -eq 1 ] || sleep 10
        before=off
      fi
    fi
    if [ "$before" != "on" ]; then
      plug_set on || die "Home Assistant refused turn_on"
      [ "$dry" -eq 1 ] || say "plug switched on"
    fi
    [ "$dry" -eq 1 ] && { say "[dry-run] would now wait up to ${wait_s}s for $HOST:$PORT and a status line"; exit 0; }

    deadline=$((SECONDS + wait_s))
    say "waiting up to ${wait_s}s for $HOST:$PORT ..."
    until port_open; do
      if [ "$SECONDS" -ge "$deadline" ]; then
        hint=""
        [ "$cycle" -eq 0 ] && hint=" The plug was already on: the machine may have failed to join the network (it sometimes does at power-up) - re-run with --cycle."
        die "plug is ON but $HOST:$PORT never accepted a connection in ${wait_s}s (left powered).$hint" 3
      fi
      sleep 3
    done
    say "command port is accepting connections after $((SECONDS - (deadline - wait_s)))s"

    line=""
    until line="$(status_line)"; [ -n "$line" ]; do
      [ "$SECONDS" -lt "$deadline" ] || die "port is open but no status line came back in ${wait_s}s (plug left ON)" 4
      sleep 3
    done
    say "machine answered: $line"
    say "state: $(state_word "$line")"
    ;;

  off)
    before="$(plug_state)"; [ -n "$before" ] || die "could not read $ENTITY from Home Assistant"
    if [ "$before" = "off" ]; then say "plug is already off"; exit 0; fi
    if [ "$force" -eq 0 ]; then
      if port_open; then
        line="$(status_line)"
        word="$(state_word "$line")"
        if [ "$word" != "Idle" ]; then
          die "machine reports '${word:-no status}' (${line:-no reply}), not Idle - refusing to cut power. Use --force to override." 5
        fi
        say "machine is Idle"
      else
        say "warning: $HOST:$PORT is not reachable, so I could not confirm the machine is idle"
      fi
    fi
    plug_set off || die "Home Assistant refused turn_off"
    [ "$dry" -eq 1 ] && exit 0
    sleep 2
    after="$(plug_state)"
    [ "$after" = "off" ] || die "asked for off but the plug reads '$after'" 6
    say "plug is off"
    ;;

  *)
    sed -n '2,/^set -u/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
