#!/bin/bash
# Package Ingest Streamlined for distribution:
#   dist/ingest-streamlined-v<version>.zip       - the extension alone
#   dist/ingest-streamlined-v<version>-full.zip  - extension + watcher installer
# The extension file list is a whitelist - tests, the preview shim, and
# repo docs never ship.
set -euo pipefail
cd "$(dirname "$0")"
EXT=extension
VER=$(python3 -c "import json; print(json.load(open('$EXT/manifest.json'))['version'])")
mkdir -p dist

FILES=(
  manifest.json
  background.js engine.js clients.js graph.js xlsx.js
  offscreen.html offscreen.js
  sidepanel.html sidepanel.js welcome.html
  icon16.png icon32.png icon48.png icon128.png
)

OUT="dist/ingest-streamlined-v$VER.zip"
rm -f "$OUT"
(cd "$EXT" && zip -q -X "$OLDPWD/$OUT" "${FILES[@]}")
echo "Built $OUT"

# Full package: everything a new install needs - the unpacked extension
# plus the watcher and its double-click installer.
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
PKGDIR="$STAGE/ingest-streamlined-v$VER"
mkdir -p "$PKGDIR/extension" "$PKGDIR/watcher"
(cd "$EXT" && cp "${FILES[@]}" "$PKGDIR/extension/")
cp local/ingest_watch.py local/espn_ticker.sh local/ticker.png local/install.command "$PKGDIR/watcher/"
chmod +x "$PKGDIR/watcher/install.command"
cat > "$PKGDIR/README first.txt" <<EOF
INGEST STREAMLINED v$VER

1. THE EXTENSION
   chrome://extensions -> Developer mode -> Load unpacked ->
   pick this folder's "extension" directory.
   On first install a welcome page walks you through setup.

2. THE WATCHER (recommended - does the file work)
   Double-click watcher/install.command. It installs to
   ~/Library/Application Support/IngestTools/ and starts at login.
   Needs: macOS, python3, and ffmpeg/ffprobe (brew install ffmpeg)
   for spec checks and _ticker builds.

   Extension-only (no watcher): email matching, sheet highlighting,
   Jira drafts. The download/ticker/portal-feed pipeline needs it.
EOF
(cd "$STAGE" && zip -q -r "$OLDPWD/dist/ingest-streamlined-v$VER-full.zip" \
  "ingest-streamlined-v$VER" -x '*.DS_Store')
echo "Built dist/ingest-streamlined-v$VER-full.zip"
