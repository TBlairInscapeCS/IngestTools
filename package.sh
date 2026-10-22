#!/bin/bash
# Package the Chrome extension for distribution:
#   dist/ingest-streamlined-v<manifest version>.zip
# The file list is a whitelist - tests, the preview shim, and repo docs
# never ship. Unzip anywhere, then chrome://extensions -> Developer mode
# -> Load unpacked -> pick the unzipped folder.
set -euo pipefail
cd "$(dirname "$0")"
EXT=extension
VER=$(python3 -c "import json; print(json.load(open('$EXT/manifest.json'))['version'])")
OUT="dist/ingest-streamlined-v$VER.zip"
mkdir -p dist
rm -f "$OUT"
FILES=(
  manifest.json
  background.js engine.js clients.js graph.js xlsx.js
  offscreen.html offscreen.js
  sidepanel.html sidepanel.js
  icon16.png icon32.png icon48.png icon128.png
)
(cd "$EXT" && zip -q -X "$OLDPWD/$OUT" "${FILES[@]}")
echo "Built $OUT"
unzip -l "$OUT"
