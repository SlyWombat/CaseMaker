#!/usr/bin/env bash
# tools/baseline/run-after.sh — REPLAY THE v0.2 BASELINE'S COMMANDS FOR A NEW SHA (#1212 §12).
#
# The baseline (#1212) saves "the exact command line of every run, in order" in its
# manifest.json's `commands` array, "so the 'after' run can copy them". This script copies
# them: one invocation builds the after worktree at the given sha and replays every command
# with its outputs redirected into the new baseline folder.
#
#   run-after.sh <sha> [--manifest <baseline manifest.json>] [--out-root <dir>]
#                 [--worktree <dir>] [--repo <dir>] [--stage <dir>] [--inputs <dir>]
#                 [--dry-run]
#
# Run it ON K3, the baseline's machine (§10: "same machine for before and after"). The
# defaults are k3's layout: the repo at ~/cm, the stage scripts at ~/v02-stage, the Set B
# inputs at ~/setb-inputs. Everything is overridable.
#
# READ-ONLY ON THE BASELINE. The manifest is the only thing read from the baseline folder;
# every write goes to $BASELINE_ROOT/v<version>-<sha9>/ (refused if that resolves to the
# baseline folder itself). The commands still may read the baseline's script copies.
#
# `commands` entries may be a plain shell string, or an object:
#   { "name": "vitest", "command": "…", "cwd": "…", "timeoutSeconds": 3600 }
# `cwd` is optional (default: the after worktree). Each command runs with `bash -c` and the
# environment below; its stdout+stderr goes to <target>/logs/<NN>-<name>.log, and one row
# (rc, wall seconds) to <target>/logs/commands.tsv.
#
#   HOME=$TARGET/.home   — a fake home, so a command written against ~/v02-out or
#                          ~/cm-wt/v0.2 writes INTO the target folder. It holds:
#                            cm-wt/v0.2 → the after worktree
#                            v02-out    → the target folder
#                            v02-stage, setb-inputs, .nvm, .npm, .cache, casemaker-manager,
#                            cm, cargo-shared, … → the real ones (symlinks)
#                          and the literal real-home path in a command is rewritten to it.
#   AFTER_SHA, AFTER_WT, AFTER_OUT, BASELINE_DIR — also exported, for commands written to
#                          use them.
#
# Substitutions in a command (and in its `cwd`): the baseline's sha in any abbreviation a
# command may carry (40, 9, 8 or 7 chars) becomes the after sha's; `$HOME/cm-wt/v0.2` and
# `~/cm-wt/v0.2` become the worktree; `$HOME/v02-out` and `~/v02-out` become the target;
# the real home path becomes the fake home. Nothing else is touched.
set -u

die() { printf 'run-after: %s\n' "$*" >&2; exit 2; }
usage() {
  printf '%s\n' \
    'usage: run-after.sh <sha> [--manifest <file>] [--out-root <dir>] [--worktree <dir>]' \
    '                    [--repo <dir>] [--stage <dir>] [--inputs <dir>] [--dry-run]' >&2
  exit 2
}

SHA_ARG=''
MANIFEST=''
OUT_ROOT=''
WT=''
REPO=''
STAGE=''
INPUTS=''
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST=${2:-}; shift 2 || usage ;;
    --out-root) OUT_ROOT=${2:-}; shift 2 || usage ;;
    --worktree) WT=${2:-}; shift 2 || usage ;;
    --repo) REPO=${2:-}; shift 2 || usage ;;
    --stage) STAGE=${2:-}; shift 2 || usage ;;
    --inputs) INPUTS=${2:-}; shift 2 || usage ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [ -z "$SHA_ARG" ] || die "pass one sha, not two ('$SHA_ARG' and '$1')"; SHA_ARG=$1; shift ;;
  esac
done
[ -n "$SHA_ARG" ] || usage

BASELINE_ROOT=${BASELINE_ROOT:-/mnt/house/casemaker/baselines}
REAL_HOME=$HOME
REPO=${REPO:-$REAL_HOME/cm}
STAGE=${STAGE:-$REAL_HOME/v02-stage}
INPUTS=${INPUTS:-$REAL_HOME/setb-inputs}
OUT_ROOT=${OUT_ROOT:-$BASELINE_ROOT}

if [ -z "$MANIFEST" ]; then
  MANIFEST=$(ls -1dt "$BASELINE_ROOT"/*/manifest.json 2>/dev/null | head -1)
fi
[ -n "$MANIFEST" ] || die "no manifest found under $BASELINE_ROOT — pass --manifest"
[ -r "$MANIFEST" ] || die "cannot read $MANIFEST"
BASELINE_DIR=$(cd "$(dirname "$MANIFEST")" && pwd -P) || die "cannot resolve $MANIFEST"

SHA=$(git -C "$REPO" rev-parse --verify --quiet "$SHA_ARG^{commit}" 2>/dev/null) \
  || die "unknown commit '$SHA_ARG' in $REPO — fetch it first (git -C $REPO fetch origin)"
SHA9=$(printf '%s' "$SHA" | cut -c1-9)

# The manifest is parsed in python (NUL-separated fields: version, baseline sha, then
# name/command/cwd/timeoutSeconds per command) so no quoting in a command can break it.
mapfile -d '' -t F < <(python3 - "$MANIFEST" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding='utf-8') as fh:
        m = json.load(fh)
except Exception as exc:  # noqa: BLE001 — the caller reports it as one sentence
    sys.stderr.write(f'unreadable manifest: {exc}\n')
    sys.exit(0)
version = str(m.get('version') or '')
sha = str(m.get('sha') or '')
out = [version, sha]
for i, entry in enumerate(m.get('commands') or []):
    if isinstance(entry, str):
        name, command, cwd, timeout = f'cmd{i + 1:02d}', entry, '', ''
    elif isinstance(entry, dict):
        name = str(entry.get('name') or f'cmd{i + 1:02d}')
        command = str(entry.get('command') or entry.get('cmd') or '')
        cwd = str(entry.get('cwd') or '')
        timeout = str(entry.get('timeoutSeconds') or '')
    else:
        name, command, cwd, timeout = f'cmd{i + 1:02d}', '', '', ''
    out.extend([name, command, cwd, timeout])
sys.stdout.write('\0'.join(out) + '\0')
PY
)
[ "${#F[@]}" -ge 2 ] || die "$MANIFEST is not readable JSON with a version and a sha"
VERSION=${F[0]}
BASE_SHA=${F[1]}
[ -n "$VERSION" ] || die "$MANIFEST states no version"
[ $(( (${#F[@]} - 2) % 4 )) -eq 0 ] || die "$MANIFEST's command list is malformed"
N=$(( (${#F[@]} - 2) / 4 ))
# Fail fast on an entry that records no command (an object with only a note, say): replaying
# an empty string would log a meaningless green row.
for ((i = 0; i < N; i += 1)); do
  [ -n "${F[3 + 4 * i]}" ] || die "command entry '${F[2 + 4 * i]}' in $MANIFEST has no command string"
done
case "$VERSION" in v*) OUT_VERSION=$VERSION ;; *) OUT_VERSION=v$VERSION ;; esac
BASE_SHA9=$(printf '%s' "$BASE_SHA" | cut -c1-9)
TARGET=$OUT_ROOT/$OUT_VERSION-$SHA9
WT=${WT:-$REAL_HOME/cm-wt/after-$SHA9}
FAKE_HOME=$TARGET/.home
TARGET_REAL=$(realpath -m "$TARGET")
[ "$TARGET_REAL" != "$BASELINE_DIR" ] || die "the target resolves to the baseline folder $BASELINE_DIR — refusing to write there"

# ---------------------------------------------------------------- print (dry run) or set up
substitute() {
  local s=$1 len prefix replacement
  # The real home first, so an absolute path becomes the fake home before anything is put
  # back into the string; the worktree/output rules then match the fake-home forms too.
  s=${s//"$REAL_HOME"/$FAKE_HOME}
  s=${s//"$FAKE_HOME/cm-wt/v0.2"/$WT}
  s=${s//'~/cm-wt/v0.2'/$WT}
  s=${s//'$HOME/cm-wt/v0.2'/$WT}
  s=${s//"$FAKE_HOME/v02-out"/$TARGET}
  s=${s//'~/v02-out'/$TARGET}
  s=${s//'$HOME/v02-out'/$TARGET}
  # The baseline sha in any abbreviation a command may carry (40, 9, 8, 7 chars).
  for len in 40 9 8 7; do
    [ -n "$BASE_SHA" ] || break
    prefix=$(printf '%s' "$BASE_SHA" | cut -c1-$len)
    replacement=$(printf '%s' "$SHA" | cut -c1-$len)
    s=${s//"$prefix"/$replacement}
  done
  printf '%s' "$s"
}

if [ "$DRY_RUN" = 1 ]; then
  printf 'baseline   %s\n' "$MANIFEST"
  printf '           version %s, sha %s\n' "$VERSION" "${BASE_SHA:-unknown}"
  printf 'after      %s\n' "$TARGET"
  printf 'worktree   %s  (checked out at %s)\n' "$WT" "$SHA"
  printf 'commands   %d\n' "$N"
  for ((i = 0; i < N; i += 1)); do
    name=${F[2 + 4 * i]}
    command=${F[3 + 4 * i]}
    cwd=${F[4 + 4 * i]}
    timeout=${F[5 + 4 * i]}
    printf '\n[%02d] %s%s\n' "$((i + 1))" "$name" "${timeout:+  (timeout ${timeout}s)}"
    printf '     cwd: %s\n' "$( [ -n "$cwd" ] && substitute "$cwd" || printf '%s' "$WT" )"
    printf '     %s\n' "$(substitute "$command")"
  done
  [ "$N" -gt 0 ] || printf '\nnote: the manifest has no commands yet — 4a fills it as the baseline runs\n'
  exit 0
fi

[ "$N" -gt 0 ] || die "$MANIFEST has no commands yet — nothing to replay"
mkdir -p "$TARGET/logs" || die "cannot create $TARGET/logs"
TSV=$TARGET/logs/commands.tsv
: > "$TSV"

if [ -s "$REAL_HOME/.nvm/nvm.sh" ]; then . "$REAL_HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true; fi

# ---------------------------------------------------------------- the after worktree
ENV_LOG=$TARGET/logs/00-env.log
{
  echo "# after worktree setup — $(date -u +%FT%TZ)"
  echo "# repo $REPO"
  echo "# worktree $WT"
  echo "# sha $SHA"
} > "$ENV_LOG"
if [ ! -e "$WT" ]; then
  git -C "$REPO" fetch -q origin >> "$ENV_LOG" 2>&1 || die "git fetch failed in $REPO (see $ENV_LOG)"
  git -C "$REPO" worktree add -q --detach "$WT" "$SHA" >> "$ENV_LOG" 2>&1 \
    || die "cannot check out $SHA in $WT (see $ENV_LOG)"
else
  CURRENT=$(git -C "$WT" rev-parse HEAD 2>/dev/null || true)
  if [ "$CURRENT" != "$SHA" ]; then
    git -C "$WT" checkout -q --detach "$SHA" >> "$ENV_LOG" 2>&1 \
      || die "$WT cannot be checked out at $SHA (see $ENV_LOG)"
  fi
fi
APP=$WT/casemaker-app
[ -d "$APP" ] || die "$WT has no casemaker-app"
LOCK=$(sha256sum "$APP/package-lock.json" | cut -c1-16)
if [ ! -d "$APP/node_modules" ] || [ "$(cat "$APP/.after-lock" 2>/dev/null || true)" != "$LOCK" ]; then
  echo "# npm ci ($LOCK)" >> "$ENV_LOG"
  (
    cd "$APP" || exit 1
    npm ci --no-audit --no-fund
    npm install --no-save "@rolldown/binding-linux-x64-gnu@$(node -p "require('rolldown/package.json').version")"
  ) >> "$ENV_LOG" 2>&1 || die "npm ci failed in $APP (see $ENV_LOG)"
  printf '%s\n' "$LOCK" > "$APP/.after-lock"
fi
echo "# worktree ready, dependencies $( [ -d "$APP/node_modules" ] && echo present )" >> "$ENV_LOG"

# ---------------------------------------------------------------- the fake home
# Runs every command as if ~/v02-out and ~/cm-wt/v0.2 were the after run's paths, so the
# baseline's own script copies (which hardcode $HOME/...) write into the target.
rm -rf "$FAKE_HOME"
mkdir -p "$FAKE_HOME/cm-wt" || die "cannot create $FAKE_HOME"
ln -sfn "$WT" "$FAKE_HOME/cm-wt/v0.2"
ln -sfn "$TARGET" "$FAKE_HOME/v02-out"
ln -sfn "$STAGE" "$FAKE_HOME/v02-stage"
ln -sfn "$INPUTS" "$FAKE_HOME/setb-inputs"
for name in .nvm .npm .cache .local .config .gitconfig .ssh casemaker-manager cm cargo-shared makerables catalogue.json; do
  if [ -e "$REAL_HOME/$name" ]; then ln -sfn "$REAL_HOME/$name" "$FAKE_HOME/$name"; fi
done

# ---------------------------------------------------------------- replay
FAILED=0
for ((i = 0; i < N; i += 1)); do
  name=${F[2 + 4 * i]}
  command=${F[3 + 4 * i]}
  cwd=${F[4 + 4 * i]}
  timeout=${F[5 + 4 * i]}
  command=$(substitute "$command")
  if [ -n "$cwd" ]; then cwd=$(substitute "$cwd"); else cwd=$WT; fi
  safe=$(printf '%s' "$name" | tr -cs 'A-Za-z0-9._-' '_')
  log=$TARGET/logs/$(printf '%02d' "$((i + 1))")-$safe.log
  printf '== [%d/%d] %s — %s\n' "$((i + 1))" "$N" "$name" "$(date -u +%FT%TZ)"
  {
    printf '# name: %s\n# cwd: %s\n# command: %s\n# started: %s\n' \
      "$name" "$cwd" "$command" "$(date -u +%FT%TZ)"
  } > "$log"
  start=$(date +%s)
  if [ -n "$timeout" ]; then
    ( cd "$cwd" && HOME="$FAKE_HOME" AFTER_SHA="$SHA" AFTER_WT="$WT" AFTER_OUT="$TARGET" \
        BASELINE_DIR="$BASELINE_DIR" timeout --foreground "$timeout" bash -c "$command" ) >> "$log" 2>&1
  else
    ( cd "$cwd" && HOME="$FAKE_HOME" AFTER_SHA="$SHA" AFTER_WT="$WT" AFTER_OUT="$TARGET" \
        BASELINE_DIR="$BASELINE_DIR" bash -c "$command" ) >> "$log" 2>&1
  fi
  rc=$?
  seconds=$(( $(date +%s) - start ))
  printf '# rc=%d seconds=%d\n' "$rc" "$seconds" >> "$log"
  printf '%02d\t%s\t%d\t%d\t%s\n' "$((i + 1))" "$name" "$rc" "$seconds" "$command" >> "$TSV"
  printf '   rc=%d  %ds  log: %s\n' "$rc" "$seconds" "$log"
  [ "$rc" -eq 0 ] || FAILED=$((FAILED + 1))
done

# ---------------------------------------------------------------- facts + hygiene
python3 - "$TARGET/logs/after-run.json" "$OUT_VERSION" "$SHA" "$SHA_ARG" "$BASE_SHA" \
  "$BASELINE_DIR" "$TARGET" "$TSV" <<'PY'
import json, sys
path, version, sha, ref, base_sha, baseline, target, tsv = sys.argv[1:9]
commands = []
with open(tsv, encoding='utf-8') as fh:
    for line in fh:
        n, name, rc, seconds, command = line.rstrip('\n').split('\t', 4)
        commands.append({'index': int(n), 'name': name, 'command': command,
                         'rc': int(rc), 'seconds': int(seconds)})
with open(path, 'w', encoding='utf-8') as fh:
    json.dump({'version': version, 'sha': sha, 'ref': ref, 'baselineSha': base_sha,
               'baseline': baseline, 'target': target, 'commands': commands},
              fh, indent=1)
    fh.write('\n')
PY

# Worktrees k3.sh made inside the fake home are this run's; discard them (the run is over).
git -C "$REPO" worktree list --porcelain 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    "worktree $FAKE_HOME"/*)
      git -C "$REPO" worktree remove --force "${line#worktree }" 2>/dev/null || true
      ;;
  esac
done
git -C "$REPO" worktree prune 2>/dev/null || true

printf '\nafter run: %s — %d command(s), %d failed\n' "$TARGET" "$N" "$FAILED"
printf 'logs: %s\n' "$TARGET/logs"
[ "$FAILED" -eq 0 ]
