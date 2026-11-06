#!/bin/bash
# Ingest Streamlined - watcher installer. Double-click to run.
# Installs ingest_watch.py + its assets to
#   ~/Library/Application Support/IngestTools/
# and starts it at login via launchd (label dev.ingest-watch).
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/IngestTools"

echo "Installing the Ingest Tools watcher..."
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "ERROR: python3 not found. Install the Xcode command line tools"
  echo "       first:  xcode-select --install" >&2
  read -n1 -s -r -p "press any key to close"; exit 1
fi

mkdir -p "$DEST" "$DEST/logs" "$HOME/Library/LaunchAgents" "$HOME/Downloads/Ingest"
cp "$SRC/ingest_watch.py" "$SRC/espn_ticker.sh" "$SRC/ticker.png" "$DEST/"
chmod +x "$DEST/espn_ticker.sh"

PLIST="$HOME/Library/LaunchAgents/dev.ingest-watch.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.ingest-watch</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$DEST/ingest_watch.py</string></array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DEST/logs/watch-stdout.log</string>
  <key>StandardErrorPath</key><string>$DEST/logs/watch-stdout.log</string>
</dict>
</plist>
EOF

# Hint for one-click updates: the watcher swaps this dir when the panel
# asks it to apply a new release package.
for d in "$SRC/../1-Extension" "$SRC/../extension" "$SRC"; do
  if [ -f "$d/manifest.json" ]; then
    (cd "$d" && pwd) > "$DEST/extension_dir.txt"
    break
  fi
done

launchctl bootout "gui/$(id -u)/dev.ingest-watch" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

if ! command -v ffprobe >/dev/null; then
  echo
  echo "NOTE: ffprobe not found - spec checks and _ticker builds need ffmpeg:"
  echo "      brew install ffmpeg"
fi
echo
echo "Done - the watcher is running and will start at every login."
echo "It watches ~/Downloads/Ingest (the extension's download folder)."
read -n1 -s -r -p "press any key to close"
