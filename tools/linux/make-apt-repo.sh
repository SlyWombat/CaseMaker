#!/usr/bin/env bash
# Builds Case Maker's signed APT repository from one or more .debs (#866).
#
#     APT_SIGNING_KEY_FILE=~/secrets/casemaker/apt-signing-key.asc \
#         tools/linux/make-apt-repo.sh <out-dir> <deb>...
#
# or, in CI, with the armoured key in APT_SIGNING_KEY (the Actions secret of that name).
#
# <out-dir> becomes the repository root a website serves:
#
#     pool/main/c/casemaker/casemaker_<version>_amd64.deb
#     dists/stable/main/binary-amd64/Packages{,.gz,.xz}
#     dists/stable/{Release,Release.gpg,InRelease}
#     casemaker.gpg, casemaker.asc, casemaker.sources   (the files a person subscribes with)
#
# Every .deb already in <out-dir>/pool is kept, so the repository grows one release at a time
# rather than being rebuilt from nothing; apt picks the newest.
#
# The script refuses to sign with any key but the one whose fingerprint is committed in
# tools/linux/apt/FINGERPRINT, and checks its own InRelease against the public half of that key with
# gpgv before it finishes — the same check apt makes on a user's machine — so a repository that
# would fail `apt update` never leaves here. It prints the fingerprint and nothing else about the
# key. The public files are written from the signing key, which is why none are committed: the
# FINGERPRINT is the one committed fact (see tools/linux/apt/README.md).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PUBLIC="$ROOT/tools/linux/apt"
USAGE='usage: make-apt-repo.sh <out-dir> <deb>...'
OUT=${1:?$USAGE}; shift
[ $# -gt 0 ] || { echo "$USAGE" >&2; exit 2; }

SUITE=stable
COMPONENT=main
ARCH=amd64
PKG=casemaker
[ -f "$PUBLIC/FINGERPRINT" ] || {
    echo "::error::tools/linux/apt/FINGERPRINT does not exist — the maintainer creates the signing key and commits its fingerprint first (tools/linux/Linux-Packaging.md, 'The signing key')" >&2
    exit 1
}
EXPECTED="$(tr -d '[:space:]' < "$PUBLIC/FINGERPRINT")"

for tool in gpg gpgv apt-ftparchive dpkg-deb curl; do
    command -v "$tool" >/dev/null || { echo "::error::$tool is not installed" >&2; exit 1; }
done

# --- the key, in a keyring of its own that is deleted on the way out -----------------------------
GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT
if [ -n "${APT_SIGNING_KEY:-}" ]; then
    printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import 2>/dev/null
elif [ -n "${APT_SIGNING_KEY_FILE:-}" ] && [ -r "$APT_SIGNING_KEY_FILE" ]; then
    gpg --batch --quiet --import < "$APT_SIGNING_KEY_FILE" 2>/dev/null
else
    echo "::error::no signing key: set APT_SIGNING_KEY or APT_SIGNING_KEY_FILE" >&2
    exit 1
fi
FPR="$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr/{print $10; exit}')"
if [ "$FPR" != "$EXPECTED" ]; then
    echo "::error::the signing key is $FPR, but tools/linux/apt/FINGERPRINT says $EXPECTED" >&2
    exit 1
fi
echo "signing with $FPR"

# --- pool ----------------------------------------------------------------------------------------
POOL="pool/$COMPONENT/c/$PKG"
mkdir -p "$OUT/$POOL" "$OUT/dists/$SUITE/$COMPONENT/binary-$ARCH"
for deb in "$@"; do
    pkg="$(dpkg-deb -f "$deb" Package)"
    ver="$(dpkg-deb -f "$deb" Version)"
    arch="$(dpkg-deb -f "$deb" Architecture)"
    [ "$pkg" = "$PKG" ] && [ "$arch" = "$ARCH" ] || {
        echo "::error::$deb is $pkg/$arch, not $PKG/$ARCH" >&2; exit 1; }
    cp "$deb" "$OUT/$POOL/${pkg}_${ver}_${arch}.deb"
    echo "  pool: ${pkg}_${ver}_${arch}.deb"
done

# --- indices -------------------------------------------------------------------------------------
# apt-ftparchive writes paths relative to the directory it runs in, which has to be the repository
# root for the Filename: fields to resolve against the URL.
BIN="dists/$SUITE/$COMPONENT/binary-$ARCH"
(
    cd "$OUT"
    apt-ftparchive packages "pool/$COMPONENT" > "$BIN/Packages"
    gzip -9nkf "$BIN/Packages"
    xz -9kf "$BIN/Packages"
    apt-ftparchive \
        -o "APT::FTPArchive::Release::Origin=Electric RV" \
        -o "APT::FTPArchive::Release::Label=Case Maker" \
        -o "APT::FTPArchive::Release::Suite=$SUITE" \
        -o "APT::FTPArchive::Release::Codename=$SUITE" \
        -o "APT::FTPArchive::Release::Architectures=$ARCH" \
        -o "APT::FTPArchive::Release::Components=$COMPONENT" \
        -o "APT::FTPArchive::Release::Description=Case Maker for Debian and Ubuntu" \
        release "dists/$SUITE" > "dists/$SUITE/Release.tmp"
    mv "dists/$SUITE/Release.tmp" "dists/$SUITE/Release"
    rm -f "dists/$SUITE/InRelease" "dists/$SUITE/Release.gpg"
    gpg --batch --yes --local-user "$FPR" --clearsign \
        -o "dists/$SUITE/InRelease" "dists/$SUITE/Release"
    gpg --batch --yes --local-user "$FPR" --armor --detach-sign \
        -o "dists/$SUITE/Release.gpg" "dists/$SUITE/Release"
)

# --- the files a person subscribes with, exported from the signing key ---------------------------
gpg --batch --export "$FPR" > "$OUT/$PKG.gpg"
gpg --batch --armor --export "$FPR" > "$OUT/$PKG.asc"
cat > "$OUT/$PKG.sources" <<EOF
Types: deb
URIs: https://electricrv.ca/casemaker/apt/
Suites: $SUITE
Components: $COMPONENT
Architectures: $ARCH
Signed-By: /etc/apt/keyrings/$PKG.gpg
EOF

# --- the check apt makes -------------------------------------------------------------------------
gpgv --keyring "$OUT/$PKG.gpg" "$OUT/dists/$SUITE/InRelease" 2>/dev/null \
    || { echo "::error::InRelease does not verify against the exported public key" >&2; exit 1; }
gpgv --keyring "$OUT/$PKG.gpg" "$OUT/dists/$SUITE/Release.gpg" "$OUT/dists/$SUITE/Release" 2>/dev/null \
    || { echo "::error::Release.gpg does not verify against the exported public key" >&2; exit 1; }
echo "  InRelease and Release.gpg verify against the public key"
grep -E '^(Package|Version|Filename):' "$OUT/$BIN/Packages" | paste - - - | sed 's/^/  /'
echo "repository: $OUT"
