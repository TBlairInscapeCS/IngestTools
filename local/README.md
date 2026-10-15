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

To have it always running, create a launchd agent or just leave a terminal
open during ingest batches.

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
