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
# plus the watcher and its double-click installer. Folders are numbered
# in install order so an unpacked zip (or GitHub repo download) is
# self-explanatory, and README.md renders on GitHub.
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
PKGDIR="$STAGE/ingest-streamlined-v$VER"
mkdir -p "$PKGDIR/1-Extension" "$PKGDIR/2-Watcher"
(cd "$EXT" && cp "${FILES[@]}" "$PKGDIR/1-Extension/")
cp local/ingest_watch.py local/espn_ticker.sh local/ticker.png "$PKGDIR/2-Watcher/"
cp local/install.command "$PKGDIR/2-Watcher/INSTALL.command"
chmod +x "$PKGDIR/2-Watcher/INSTALL.command"
cat > "$PKGDIR/README.md" <<EOF
# Ingest Streamlined v$VER

**Setup: 3 steps, about 5 minutes.**

1. **Move this folder somewhere permanent** — Chrome loads the extension
   live from it, so not a temp or auto-cleaned spot.
2. **Load the extension** — open \`chrome://extensions\`, enable
   **Developer mode**, click **Load unpacked**, select the
   \`1-Extension\` folder, then pin the toolbar icon. A welcome page
   opens with a live setup checklist that turns each requirement green.
3. **Install the watcher** — open \`2-Watcher\` and double-click
   **INSTALL.command**. It installs itself and starts at login —
   nothing else to configure. Then run \`brew install ffmpeg\` once
   if the checklist flags it.

**"Apple could not verify INSTALL.command"?** Normal — it's unsigned.
Either: **System Settings → Privacy & Security** → scroll down →
**Open Anyway** → double-click INSTALL.command again. Or paste this in
Terminal once (from inside this folder):
\`xattr -dr com.apple.quarantine .\`

**Done.** Open a request email in Outlook and press **Run all**.

No watcher? The extension still does matching, sheets, Jira drafts, and
replies — only downloads, spec checks, ticker builds, and portal feeding
need it. macOS + python3 required for the watcher.
EOF
rm -f "dist/ingest-streamlined-v$VER-full.zip"
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
