#!/usr/bin/env bash
# tools/baseline/rerun.sh — RE-RUN A BASELINE'S MANIFEST ON ANY BUILD (#1233, step 1 of #1212 §12).
#
#   rerun.sh <manifest.json> <out-dir> [--only suites|tray|references|samples|demo]
#            [--sha <ref>] [--skip name,name] [--allow-busy] [--no-verify]
#            [--repo <dir>] [--worktree <dir>] [--stage <dir>] [--inputs <dir>] [--dry-run]
#
# Runs every command in the manifest, in the manifest's order, on <ref> (default: this checkout's
# HEAD), with the same inputs, into <out-dir>/v<version>-<sha9>/ — the same folder layout as the
# baseline — and writes that folder's own manifest.json (the new sha, the same harnessPatches).
# It is D's run-after.sh underneath (worktree, fake HOME, per-command logs and timeouts); what
# this adds is the rest of #1233 step 1:
#
#   * every input's sha256 is checked first (scripts/inputs.sha256 beside the manifest); a
#     mismatch or a missing file stops the run naming the file. --no-verify is for a dry run on a
#     machine that does not hold the inputs.
#   * #1212 §10: a timed run is alone. The run refuses to start while the 1-minute load average is
#     above MAX_LOAD (below) unless --allow-busy, and each command's log opens with the load average
#     and the processes above 50 % CPU at that moment; they are gathered into manifest.json "load".
#   * --only runs one section: suites (vitest, cargo, tsc, e2e), tray (the tray runs, pictures,
#     facts, traces and the live-house pair), references (the demo restricted to its 12 ref-* cards,
#     and their traced runs), samples, or demo (the 43 cards and the j28/j29 rerun).
#   * the derived steps (demo-split, summary, phases) and `prepare` are not replayed: compare.mts
#     reads the raw demo runs, and run-after.sh already installs the dependencies.
#
# The manifest's commands name the baseline's own script copies by absolute path; if the baseline
# folder lives elsewhere on this machine than where it was saved (k3 has no /mnt/house), pass the
# manifest from a mirror of that folder (manifest.json + scripts/) and the recorded path is
# rewritten to the mirror's.
set -u

# A heavy job on the box makes a timed number meaningless; above this 1-minute load the run stops.
MAX_LOAD=3

die() { printf 'rerun: %s\n' "$*" >&2; exit 2; }

HERE=$(cd "$(dirname "$0")" && pwd)
MANIFEST=''; OUT=''; ONLY=''; SHA_ARG=''; SKIP=''; ALLOW_BUSY=0; VERIFY=1; DRY=0
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY=${2:-}; shift 2 || die "--only needs a section" ;;
    --sha) SHA_ARG=${2:-}; shift 2 || die "--sha needs a ref" ;;
    --skip) SKIP=${2:-}; shift 2 || die "--skip needs names" ;;
    --allow-busy) ALLOW_BUSY=1; shift ;;
    --no-verify) VERIFY=0; shift ;;
    --dry-run) DRY=1; PASS+=(--dry-run); shift ;;
    --repo|--worktree|--stage|--inputs) PASS+=("$1" "${2:-}"); shift 2 || die "$1 needs a value" ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) if [ -z "$MANIFEST" ]; then MANIFEST=$1; elif [ -z "$OUT" ]; then OUT=$1; else die "unexpected argument $1"; fi; shift ;;
  esac
done
[ -n "$MANIFEST" ] && [ -n "$OUT" ] || die "usage: rerun.sh <manifest.json> <out-dir> [--only section]"
[ -r "$MANIFEST" ] || die "cannot read $MANIFEST"
case "$ONLY" in ''|suites|tray|references|samples|demo) ;; *) die "--only takes suites, tray, references, samples or demo" ;; esac
BASEDIR=$(cd "$(dirname "$MANIFEST")" && pwd -P)
[ -z "$SHA_ARG" ] && SHA_ARG=$(git -C "$HERE" rev-parse HEAD) && true
SHA_REF=$SHA_ARG
mkdir -p "$OUT" || die "cannot create $OUT"
OUT=$(cd "$OUT" && pwd -P)
case "$OUT/" in "$BASEDIR"/*) die "the out-dir is inside the baseline folder $BASEDIR — the baseline is read-only" ;; esac

# ---------------------------------------------------------------- inputs
if [ "$VERIFY" = 1 ]; then
  LIST=$BASEDIR/scripts/inputs.sha256
  [ -r "$LIST" ] || die "$LIST is missing — the baseline lists its inputs there"
  python3 - "$LIST" "$ONLY" "$BASEDIR/tray/live-house/inputs/sha256.txt" <<'PY' || exit 2
import hashlib, os, sys
lst, only, extra = sys.argv[1], sys.argv[2], sys.argv[3]
home = os.path.expanduser('~')
# which input prefixes a section reads (everything when there is no --only)
sections = {
    'suites': [],
    'tray': ['~/setb-inputs/', '~/v02-stage/live-house/'],
    'samples': ['~/v02-stage/sample-inputs/', '~/v02-stage/casemaker/samples-gdrive/'],
    'references': ['~/v02-stage/casemaker/z1-real-jobs/', '~/v02-stage/casemaker/makerables/', '~/v02-stage/demo-build/', '~/v02-stage/casemaker/9'],
    'demo': ['~/v02-stage/casemaker/z1-real-jobs/', '~/v02-stage/casemaker/makerables/', '~/v02-stage/demo-build/', '~/v02-stage/casemaker/9', '~/v02-stage/meshes/'],
}
want = sections.get(only) if only else None
bad = n = 0
lines = open(lst, encoding='utf-8').read().splitlines()
if os.path.exists(extra):  # the live-house pair's inputs are listed beside its own folder
    lines += open(extra, encoding='utf-8').read().splitlines()
for line in lines:
    if not line.strip():
        continue
    sha, _, path = line.partition('  ')
    if want is not None and not any(path.startswith(p) for p in want):
        continue
    real = path.replace('~', home, 1)
    n += 1
    try:
        got = hashlib.sha256(open(real, 'rb').read()).hexdigest()
    except OSError:
        print(f'rerun: input missing: {path}', file=sys.stderr); bad += 1; continue
    if got != sha:
        print(f'rerun: input changed: {path} (sha256 {got[:12]}…, the baseline recorded {sha[:12]}…)', file=sys.stderr); bad += 1
if bad:
    print(f'rerun: {bad} of {n} input(s) differ — stopping before any command runs', file=sys.stderr); sys.exit(2)
print(f'rerun: {n} input(s) match their recorded sha256')
PY
fi

# ---------------------------------------------------------------- load (§10)
LOAD1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo 0)
if [ "$ALLOW_BUSY" = 0 ] && [ "$DRY" = 0 ] && awk -v l="$LOAD1" -v m="$MAX_LOAD" 'BEGIN{exit !(l>m)}'; then
  die "the 1-minute load average is $LOAD1 (above $MAX_LOAD): a timed run must be alone (#1212 §10). Wait, or pass --allow-busy and say so."
fi

# ---------------------------------------------------------------- the manifest to replay
# run-after.sh rewrites the baseline's sha wherever a command carries it (the baseline's folder
# name, v0.2-c2dd27afa, is such a place) and rewrites the real home into its fake one; the commands
# reach the baseline's scripts through a link under /tmp with a neutral name, so the path stays true.
TMP=$(mktemp -d /tmp/rerun-baseline.XXXXXX)
trap 'rm -rf "$TMP"' EXIT
LINK=$TMP/baseline-src
ln -sfn "$BASEDIR" "$LINK" || die "cannot link the baseline at $LINK"
python3 - "$MANIFEST" "$TMP/manifest.json" "$LINK" "$ONLY" "$SKIP" <<'PY' || exit 2
import json, re, sys
src, dst, basedir, only, skip = sys.argv[1:6]  # basedir: the neutral link to the baseline folder
m = json.load(open(src, encoding='utf-8'))
DERIVED = {'prepare', 'demo-split', 'summary', 'phases'}
SECTIONS = {
    'suites': ['vitest', 'cargo', 'tsc', 'e2e'],
    'tray': ['tray-timed', 'tray-pictures', 'tray-facts', 'tray-traces', 'tray-live-house', 'tray-live-house-pictures', 'tray-live-house-facts'],
    'references': ['demo', 'ref-traces'],
    'samples': ['samples'],
    'demo': ['demo', 'demo-j28-j29'],
}
REFS = 'ref-tray70,ref-tray70-tape,ref-organizer,ref-topclamp,ref-halfclamp,ref-coasters,ref-badge,ref-ringbox,ref-toolholder,ref-wildspirit,ref-knifebox,ref-accuracy'
skip = {s for s in skip.split(',') if s}
cmds = [c if isinstance(c, dict) else {'name': f'cmd{i + 1:02d}', 'command': c} for i, c in enumerate(m.get('commands') or [])]
# the baseline's recorded folder, from its first script path: .../<folder>/scripts/x
recorded = None
for c in cmds:
    mm = re.search(r'(/[^\s\'"]*?)/scripts/[A-Za-z0-9_.-]+', c.get('command', ''))
    if mm:
        recorded = mm.group(1); break
# The v0.2 manifest lists the live-house pictures before the live-house run that makes them; the
# replay puts each after its producer.
AFTER = {'tray-live-house-pictures': 'tray-live-house'}
for late, early in AFTER.items():
    names = [c.get('name') for c in cmds]
    if late in names and early in names and names.index(late) < names.index(early):
        cmds.insert(names.index(early), cmds.pop(names.index(late)))
keep = []
for c in cmds:
    name = c.get('name', '')
    if name in DERIVED or name in skip:
        continue
    if only and name not in SECTIONS[only]:
        continue
    c = dict(c)
    cmd = c.get('command', '')
    if recorded:
        cmd = cmd.replace(recorded, basedir)
    if only == 'references' and name == 'demo':
        cmd += f' --only {REFS}'
    # §10: the load average and any other heavy process, in the command's own log
    pre = ('echo "# load_before: $(cut -d\' \' -f1-3 /proc/loadavg)  heavy: $(ps -eo pcpu,comm --sort=-pcpu | '
           'awk \'NR>1 && $1>50 {printf "%s:%s ", $2, $1}\')"; ')
    c['command'] = pre + cmd
    keep.append(c)
if not keep:
    print('rerun: no command of the manifest belongs to that section', file=sys.stderr); sys.exit(2)
m['commands'] = keep
json.dump(m, open(dst, 'w', encoding='utf-8'), indent=1)
print(f'rerun: {len(keep)} command(s): ' + ', '.join(c.get("name", "?") for c in keep))
PY

# ---------------------------------------------------------------- replay
STARTED=$(date -u +%FT%TZ)
bash "$HERE/run-after.sh" "$SHA_REF" --manifest "$TMP/manifest.json" --out-root "$OUT" "${PASS[@]+"${PASS[@]}"}"
RC=$?
[ "$DRY" = 1 ] && exit "$RC"

# ---------------------------------------------------------------- the new folder's manifest
python3 - "$MANIFEST" "$TMP/manifest.json" "$OUT" "$SHA_REF" "$STARTED" "$ONLY" "$RC" <<'PY'
import glob, json, os, platform, re, subprocess, sys
src, replayed, out, ref, started, only, rc = sys.argv[1:8]
base = json.load(open(src, encoding='utf-8'))
used = json.load(open(replayed, encoding='utf-8'))
ver = str(base.get('version') or '')
ver = ver if ver.startswith('v') else 'v' + ver
folders = sorted(glob.glob(os.path.join(out, ver + '-*')), key=os.path.getmtime)
if not folders:
    sys.exit(0)
target = folders[-1]
facts = {}
try:
    facts = json.load(open(os.path.join(target, 'logs', 'after-run.json'), encoding='utf-8'))
except OSError:
    pass
def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()
    except OSError:
        return ''
loads = []
for log in sorted(glob.glob(os.path.join(target, 'logs', '[0-9]*.log'))):
    for line in open(log, encoding='utf-8', errors='replace'):
        if line.startswith('# load_before:'):
            loads.append({'log': os.path.relpath(log, target), 'line': line[2:].strip()})
            break
sha = facts.get('sha') or ref
out_manifest = {
    'version': base.get('version'),
    'rerunOf': {'sha': base.get('sha'), 'tag': base.get('tag')},
    'sha': sha,
    'tag': None,
    'ref': ref,
    'only': only or 'all',
    'startedAt': started,
    'finishedAt': sh('date -u +%FT%TZ'),
    'machine': {'hostname': platform.node(), 'cpu': sh("lscpu | sed -n 's/^Model name: *//p' | head -1"), 'cores': os.cpu_count(),
                'ramGiB': round(int(sh("awk '/MemTotal/{print $2}' /proc/meminfo") or 0) / 1048576), 'node': sh('node -v'), 'os': platform.platform()},
    'load': loads,
    'commands': [{k: v for k, v in c.items() if k != 'command'} | {'command': re.sub(r'^echo "# load_before:.*?\)"; ', '', c.get('command', ''))} for c in used.get('commands', [])],
    'harnessPatches': base.get('harnessPatches', []),
    'perCardLimitSeconds': base.get('perCardLimitSeconds'),
    'failedCommands': [c['name'] for c in facts.get('commands', []) if c.get('rc')],
}
json.dump(out_manifest, open(os.path.join(target, 'manifest.json'), 'w', encoding='utf-8'), indent=1)
print(f'rerun: wrote {os.path.join(target, "manifest.json")}')
PY
exit "$RC"
