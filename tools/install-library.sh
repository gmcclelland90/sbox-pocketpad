#!/usr/bin/env sh
# Copies the PocketPad s&box library into a game project's Libraries folder.
#   tools/install-library.sh /path/to/mygame
set -e
project="${1:?usage: install-library.sh <s&box project folder>}"
here="$(cd "$(dirname "$0")" && pwd)"
ls "$project"/*.sbproj >/dev/null 2>&1 || { echo "No .sbproj in $project" >&2; exit 1; }
target="$project/Libraries/pocketpad"
rm -rf "$target"
mkdir -p "$target"
cp "$here/../sbox/pocketpad.sbproj" "$target/"
cp -R "$here/../sbox/Code" "$target/"
echo "PocketPad library copied to $target"
