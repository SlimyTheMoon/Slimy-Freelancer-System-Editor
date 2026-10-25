#!/bin/sh
# Builds freelancer-system-editor-<version>.vsix from the editor sources.
# Usage: sh vscode/build.sh   (from the system-editor folder; needs Node + network for npx @vscode/vsce)
set -e
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(dirname "$HERE")
STAGE=$(mktemp -d)
cp "$HERE/package.json" "$HERE/extension.js" "$HERE/icon.png" "$HERE/README.md" "$STAGE/"
cp "$ROOT/server.js" "$STAGE/"
mkdir -p "$STAGE/public" && (cd "$ROOT/public" && find . -type f ! -name gallery.html -exec sh -c 'mkdir -p "$1/$(dirname "$2")" && cp "$2" "$1/$2"' _ "$STAGE/public" {} \;)
cat "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES.md" > "$STAGE/LICENSE.txt"
cd "$STAGE" && npx --yes @vscode/vsce@3 package --no-dependencies --allow-missing-repository --skip-license -o "$ROOT/" 2>&1 | tail -5
rm -rf "$STAGE"
