#!/usr/bin/env bash
# Proves the APT repository the way a person meets it (#866): in a clean container, subscribe
# exactly as the site says, install, run the app headless, then publish a newer version and watch
# `apt upgrade` take it. And one refusal: the same repository re-signed by a stranger's key must
# stop `apt update` cold.
#
#     APT_SIGNING_KEY[_FILE]=… tools/linux/check-apt-repo.sh <repo-dir> [image...]
#
# <repo-dir> is what tools/linux/make-apt-repo.sh built. The signing key is needed because the
# upgrade step builds a second repository: the same .deb repacked as <version>.1, added to a copy of
# the first, and signed like a real release would be. Images default to debian:12, debian:13,
# ubuntu:22.04, ubuntu:24.04 and ubuntu:26.04, plus debian:12+norecs: the same Debian with
# `--no-install-recommends`, which is how a minimal system installs and how an undeclared dependency
# shows up.
#
# When the repository holds more than one version (it keeps every published .deb), each image first
# installs the oldest and checks that `apt upgrade` takes it to the newest.
#
# The repositories are served over HTTP from this machine and the containers reach them on the host
# network, so apt goes through its real transport, its real signature check and its real Signed-By
# handling. The only line that differs from the site's instructions is the URI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
USAGE='usage: check-apt-repo.sh <repo-dir> [image...]'
REPO="$(cd "${1:?$USAGE}" && pwd)"
shift
IMAGES=("$@")
[ ${#IMAGES[@]} -gt 0 ] || IMAGES=(debian:12 debian:13 ubuntu:22.04 ubuntu:24.04 ubuntu:26.04 debian:12+norecs)

WORK="$(mktemp -d)"
cleanup() { [ -n "${SERVER:-}" ] && kill "$SERVER" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
SERVE="$WORK/serve"
mkdir -p "$SERVE"

# --- r1: the repository as built ----------------------------------------------------------------
cp -a "$REPO" "$SERVE/r1"

# --- r2: r1 plus the next version, signed the same way ------------------------------------------
# Newest and oldest by dpkg's own ordering, not sort -V: apt goes by dpkg.
VERSION="" OLDEST="" DEB=""
for d in "$REPO"/pool/main/c/casemaker/casemaker_*_amd64.deb; do
    [ -f "$d" ] || continue
    v="$(dpkg-deb -f "$d" Version)"
    if [ -z "$VERSION" ] || dpkg --compare-versions "$v" gt "$VERSION"; then VERSION="$v"; DEB="$d"; fi
    if [ -z "$OLDEST" ] || dpkg --compare-versions "$v" lt "$OLDEST"; then OLDEST="$v"; fi
done
[ -n "$DEB" ] || { echo "::error::no .deb in $REPO/pool" >&2; exit 1; }
echo "repository holds $OLDEST … $VERSION"
NEXT="$VERSION.1"
dpkg-deb -R "$DEB" "$WORK/repack"
sed -i "s/^Version: .*/Version: $NEXT/" "$WORK/repack/DEBIAN/control"
mkdir -p "$WORK/repack/usr/share/doc/casemaker"
echo "$NEXT" > "$WORK/repack/usr/share/doc/casemaker/UPGRADE-TEST"
dpkg-deb --root-owner-group -Zxz --build "$WORK/repack" "$WORK/casemaker_${NEXT}_amd64.deb" >/dev/null
cp -a "$REPO" "$SERVE/r2"
"$ROOT/tools/linux/make-apt-repo.sh" "$SERVE/r2" "$WORK/casemaker_${NEXT}_amd64.deb" >/dev/null

# --- forged: r1 re-signed by a key nobody trusts -------------------------------------------------
cp -a "$REPO" "$SERVE/forged"
(
    export GNUPGHOME="$WORK/stranger"; mkdir -m 700 "$GNUPGHOME"
    gpg --batch --quiet --passphrase '' --quick-gen-key "Not Electric RV <x@example.invalid>" ed25519 sign never 2>/dev/null
    rm -f "$SERVE/forged/dists/stable/InRelease" "$SERVE/forged/dists/stable/Release.gpg"
    gpg --batch --clearsign -o "$SERVE/forged/dists/stable/InRelease" "$SERVE/forged/dists/stable/Release"
    gpg --batch --armor --detach-sign -o "$SERVE/forged/dists/stable/Release.gpg" "$SERVE/forged/dists/stable/Release"
)

PORT=$(( 20000 + RANDOM % 20000 ))
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$SERVE" >/dev/null 2>&1 &
SERVER=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT/r1/casemaker.sources" >/dev/null 2>&1 && break; sleep 0.1; done

cat > "$WORK/inside.sh" <<'INSIDE'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
BASE="http://127.0.0.1:$PORT"
fails=0
ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }
point() { sed -i "s|^URIs: .*|URIs: $BASE/$1|" /etc/apt/sources.list.d/casemaker.sources; }

apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq curl ca-certificates >/dev/null 2>&1
INSTALL=(apt-get install -y -qq)
[ "${NORECS:-0}" = 1 ] && INSTALL+=(--no-install-recommends)

echo "-- subscribe, exactly as the site says (URI aside)"
install -d -m 0755 /etc/apt/keyrings
curl -fsSL "$BASE/r1/casemaker.gpg" | tee /etc/apt/keyrings/casemaker.gpg > /dev/null
curl -fsSL "$BASE/r1/casemaker.sources" | tee /etc/apt/sources.list.d/casemaker.sources > /dev/null
grep -q '^URIs: https://electricrv.ca/casemaker/apt' /etc/apt/sources.list.d/casemaker.sources \
    && ok "the published .sources names https://electricrv.ca/casemaker/apt" \
    || fail "the published .sources does not name the site"
point r1

echo "-- a stranger's signature is refused"
point forged
forged=$(apt-get update 2>&1 || true)
if printf '%s\n' "$forged" | grep -qE 'NO_PUBKEY|is not signed|BADSIG'; then
    ok "apt update refuses the forged repository"
else
    fail "apt update accepted a repository signed by another key"
fi
point r1

echo "-- install"
apt-get update 2>&1 | grep -E 'casemaker|electricrv|127.0.0.1' | sed 's/^/     /' | head -4
if [ "$OLDEST" != "$VERSION" ]; then
    if "${INSTALL[@]}" "casemaker=$OLDEST" >/dev/null 2>&1; then
        ok "apt install casemaker=$OLDEST (the oldest the repository keeps)"
        apt-get upgrade -y -qq >/dev/null 2>&1
        now=$(dpkg-query -W -f='${Version}' casemaker 2>/dev/null)
        [ "$now" = "$VERSION" ] && ok "apt upgrade moved $OLDEST to $VERSION" \
            || fail "after apt upgrade casemaker is ${now:-missing}, expected $VERSION"
    else
        printf '  note  casemaker %s does not install on this release; no upgrade path to test\n' "$OLDEST"
    fi
fi
if "${INSTALL[@]}" casemaker >/dev/null 2>&1; then
    ok "apt install casemaker: $(dpkg-query -W -f='${Version}' casemaker)"
else
    fail "apt install casemaker failed"; "${INSTALL[@]}" casemaker 2>&1 | tail -5
fi
[ "$(dpkg-query -W -f='${Version}' casemaker 2>/dev/null)" = "$VERSION" ] \
    && ok "the installed version is the newest, $VERSION" \
    || fail "the installed version is not the newest ($VERSION)"
[ -f /lib/systemd/system/casemaker.service ] \
    && ok "the systemd unit is installed" \
    || fail "no /lib/systemd/system/casemaker.service"

echo "-- it serves headless"
unset DISPLAY
casemaker --headless --bind-all --port 18124 > "$WORK/app.log" 2>&1 &
APP=$!
HEALTH=""
for _ in $(seq 60); do
    HEALTH="$(curl -fsS -m 2 http://127.0.0.1:18124/api/v1/health 2>/dev/null || true)"
    [ -n "$HEALTH" ] && break; sleep 1
done
if [ -n "$HEALTH" ] && printf '%s' "$HEALTH" | grep -q '"ok":true'; then
    ok "casemaker --headless serves /api/v1/health"
else
    fail "the installed app did not serve /api/v1/health"; tail -10 "$WORK/app.log" 2>/dev/null
fi
kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null

echo "-- a newer version is published: apt upgrade takes it"
point r2
apt-get update -qq >/dev/null 2>&1
apt-get upgrade -y -qq >/dev/null 2>&1
now=$(dpkg-query -W -f='${Version}' casemaker)
if [ "$now" = "$NEXT" ] && [ "$(cat /usr/share/doc/casemaker/UPGRADE-TEST 2>/dev/null)" = "$NEXT" ]; then
    ok "apt upgrade moved casemaker to $now, and the new files are on disk"
else
    fail "after apt upgrade casemaker is $now, expected $NEXT"
fi

echo "-- remove"
apt-get remove -y -qq casemaker >/dev/null 2>&1
[ ! -e /usr/bin/casemaker ] && ok "apt remove takes the app away" || fail "files left after apt remove"

exit $fails
INSIDE

total=0
for entry in "${IMAGES[@]}"; do
    image="${entry%+norecs}"
    norecs=0; [ "$image" != "$entry" ] && norecs=1
    echo
    echo "=== $entry"
    if docker run --rm --network host -e PORT="$PORT" -e NEXT="$NEXT" \
            -e VERSION="$VERSION" -e OLDEST="$OLDEST" -e NORECS="$norecs" \
            -v "$ROOT:/src:ro" -v "$WORK/inside.sh:/inside.sh:ro" \
            "$image" bash /inside.sh; then
        echo "=== $entry: all passed"
    else
        echo "=== $entry: FAILED"
        total=$((total + 1))
    fi
done
echo
[ "$total" -eq 0 ] && echo "APT repository: every image passed" || echo "APT repository: $total image(s) failed"
exit "$total"
