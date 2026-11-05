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
INGEST STREAMLINED v$VER — setup in 3 steps (~5 min)

1. MOVE this folder somewhere permanent (not Downloads-as-temp) —
   Chrome loads the extension live from it.

2. EXTENSION: chrome://extensions -> enable "Developer mode" ->
   "Load unpacked" -> pick this folder's "extension" directory.
   Pin the toolbar icon. A welcome page opens with a live checklist.

3. WATCHER: double-click watcher/install.command (right-click -> Open
   if macOS blocks it). It installs itself and starts at login —
   nothing else to configure. Then run "brew install ffmpeg" once if
   the checklist flags it.

That's it. Open a request email in Outlook and press Run all.

Without the watcher the extension still does matching, sheets, Jira
drafts, and replies — only downloads/spec checks/ticker builds/portal
feeding need it.
EOF
(cd "$STAGE" && zip -q -r "$OLDPWD/dist/ingest-streamlined-v$VER-full.zip" \
  "ingest-streamlined-v$VER" -x '*.DS_Store')
echo "Built dist/ingest-streamlined-v$VER-full.zip"

# Portable build: same extension, but clients.js is the scrubbed
# template - no sheet IDs, no playbooks, no epics, no reference sheet.
# A new user ships zero of the original org's data pointers.
PORT=$(mktemp -d)
trap 'rm -rf "$STAGE" "$PORT"' EXIT
mkdir -p "$PORT/extension"
for f in "${FILES[@]}"; do
  if [ "$f" = "clients.js" ]; then
    cp "$EXT/clients.template.js" "$PORT/extension/clients.js"
  else
    cp "$EXT/$f" "$PORT/extension/$f"
  fi
done
POUT="dist/ingest-streamlined-v$VER-portable.zip"
rm -f "$POUT"
(cd "$PORT/extension" && zip -q -X "$OLDPWD/$POUT" "${FILES[@]}")
echo "Built $POUT"
