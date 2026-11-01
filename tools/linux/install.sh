#!/usr/bin/env bash
# Installs Case Maker from the release tarball (#866).
#
#     sudo bin/install.sh [prefix]        # default prefix: /usr/local
#
# The app is one binary: the window, the embedded server and the headless server are the same
# program (#867). It is installed under <prefix>/lib/casemaker, with a launcher in <prefix>/bin,
# a desktop entry and an icon. The WebKitGTK 4.1 runtime is a system package the tarball does not
# carry: install `libwebkit2gtk-4.1-0` (Debian/Ubuntu) or the equivalent before running it.
#
# Remove it again with bin/uninstall.sh (same prefix).
set -euo pipefail

PREFIX="${1:-/usr/local}"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -x "$HERE/casemaker" ] || { echo "install.sh must sit beside the casemaker binary" >&2; exit 1; }
if [ ! -w "$PREFIX" ] && [ "$(id -u)" != 0 ]; then
    echo "::error::cannot write $PREFIX — run as root, or pass a prefix you own" >&2
    exit 1
fi

install -d "$PREFIX/lib/casemaker" "$PREFIX/bin"
install -m 0755 "$HERE/casemaker" "$PREFIX/lib/casemaker/casemaker"
ln -sf "../lib/casemaker/casemaker" "$PREFIX/bin/casemaker"

if [ -d "$PREFIX/share" ] || [ "$PREFIX" = /usr/local ] || [ "$PREFIX" = /usr ]; then
    install -d "$PREFIX/share/applications" "$PREFIX/share/icons/hicolor/128x128/apps"
    install -m 0644 "$HERE/../flatpak/casemaker.desktop" "$PREFIX/share/applications/casemaker.desktop"
    install -m 0644 "$HERE/../flatpak/casemaker.png" "$PREFIX/share/icons/hicolor/128x128/apps/casemaker.png"
fi

echo "installed: $PREFIX/bin/casemaker"
echo "run it, or serve it headless: $PREFIX/bin/casemaker --headless --bind-all"
echo "remove it with: $HERE/uninstall.sh $PREFIX"
