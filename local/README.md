# Ingest watcher (local component)

Watches `~/Downloads/Ingest/*/manifest.json` written by the Chrome
extension and post-processes downloads — most importantly, running
`espn_ticker.sh` on files the tracking sheet flagged for an ESPN version.

## Setup

Paths at the top of `ingest_watch.py` point at your ESPN script and
`ticker.png`. Defaults:

```python
ESPN_SCRIPT  = /Users/tim.blair/Devin/espn_ticker.sh
TICKER_IMAGE = /Users/tim.blair/Devin/ticker.png
```

## Run

```bash
python3 ingest_watch.py          # poll every 15s, Ctrl+C to stop
python3 ingest_watch.py --once   # single pass (testing)
```

## Always-on (launchd)

Installed as `~/Library/LaunchAgents/dev.ingest-watch.plist` — starts at
login and launchd restarts it if it dies. Manage it with:

```bash
launchctl print gui/$(id -u)/dev.ingest-watch          # status / pid
launchctl kickstart -k gui/$(id -u)/dev.ingest-watch   # restart (e.g. after edits)
launchctl bootout gui/$(id -u)/dev.ingest-watch        # stop + unload
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.ingest-watch.plist  # reload
```

Logs: watch errors in `logs/watch.log`, stdout/stderr in
`logs/watch-stdout.log`, per-job results in each job's `report.json`.

**Restart after every edit to `ingest_watch.py`** — Python runs the code
loaded at launch, so a running watcher never picks up file changes.

## What it does per manifest entry

1. Finds the downloaded file (tolerates Chrome's ` (1)` rename suffix and
   waits out `.crdownload` partials).
2. If `needs_espn`: copies `ticker.png` into the job folder, runs
   `espn_ticker.sh <stem>`, and confirms `<stem>_ticker.mp4` appears.
3. Writes `report.json` in the job folder with per-file status:
   `downloaded` / `downloading` / `missing` / `espn_done` / `espn_failed` /
   `downloaded (non-media ext - check link type)`.
4. On failure or a missing download, fires a macOS notification so
   someone can take over — each problem alerts once, not in a loop.

`.watcher_state.json` tracks what's already been converted or reported, so
re-running is safe and idempotent.
