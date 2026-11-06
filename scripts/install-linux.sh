#!/bin/sh
# Per-user manual install. Existing versions and application data are retained.
set -eu
archive=${1:?Usage: sh scripts/install-linux.sh /absolute/path/bckgrnd-msc.tar.xz}
case "$archive" in /*) ;; *) archive="$PWD/$archive" ;; esac
digest=$(sha256sum "$archive" | cut -d ' ' -f 1)
data_root=${XDG_DATA_HOME:-"$HOME/.local/share"}
install_root="$data_root/bckgrnd-msc/versions/$digest"
mkdir -p "$data_root/bckgrnd-msc/versions" "$HOME/.local/bin" "$data_root/applications"
if [ ! -d "$install_root" ]; then
    stage=$(mktemp -d "$data_root/bckgrnd-msc/versions/.install-XXXXXX")
    trap 'rm -rf "$stage"' EXIT HUP INT TERM
    # Release archives contain one directory, whose name is the product/version.
    tar -xJf "$archive" --strip-components=1 -C "$stage"
    test -x "$stage/bckgrnd-msc"
    test -f "$stage/resources/build/app/public/build-manifest.json"
    mv "$stage" "$install_root"
    trap - EXIT HUP INT TERM
fi
ln -sfn "$install_root/bckgrnd-msc" "$HOME/.local/bin/bckgrnd-msc"
cat > "$data_root/applications/com.chrislanejones.bckgrndmsc.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=bckgrnd-msc
Comment=Create, save and render music locally
Exec="$install_root/bckgrnd-msc"
Icon=$install_root/resources/build/icon.png
Terminal=false
Categories=AudioVideo;Audio;Music;
StartupWMClass=bckgrnd-msc
EOF
printf 'Installed %s\nApplication data stays in your desktop configuration directory.\nPrevious versions are retained under %s/bckgrnd-msc/versions.\n' "$install_root" "$data_root"
