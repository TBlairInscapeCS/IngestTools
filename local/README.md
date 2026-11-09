# Ingest watcher (local component)

Watches `~/Downloads/Ingest/*/manifest.json` written by the Chrome
extension and post-processes downloads — spec checks, ZIP unpacking,
portal file serving, Jira proof files, job archival, and running
`espn_ticker.sh` on files the tracking sheet flagged for an ESPN version.

## Install (the easy way)

Double-click **`install.command`**. It copies everything to
`~/Library/Application Support/IngestTools/`, registers a launchd agent
that starts at login, and prints any missing requirements (python3,
ffmpeg). That's the whole setup — everything below is for running it by
hand or developing it.

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

## Feeding manually downloaded media

The panel's **Search → Downloads / Ingest** and **Feed files** can locate recent
stable media directly in `~/Downloads/` or `~/Downloads/Ingest/`, even without a
manifest. Discovery matches code-shaped request IDs with token boundaries and
registers only unique matches for that job. It does not move or rename files.
Files must be at least two seconds old and no more than 14 days old. Symlinks,
partials, unrelated media, and ambiguous duplicates are excluded; use **Pick &
feed** when a manual choice is required. `.zip` archives in a job folder are
unpacked and paired automatically — no manual unzipping needed.

The loopback `POST /ingest-discover` accepts a job and explicit requested IDs.
The feed endpoints may serve only registered matching media or manifest entries;
local discovery registrations expire after one hour and are rechecked for file
changes before serving. Discovery does not itself create a manifest, probe
media, or generate missing ticker versions. Keep the manifest workflow for
those tasks.

Verify with `cd local && python3 -m unittest test_local_discovery.py`.

## Fixing metadata on already-ingested records

`fix_metadata.py` corrects a record's identifying fields
(`reportingId`, `contentTitle`) and commercial metadata (`advertiser` /
`brand` / `vertical`) on records already in the portal's cidmap backend —
e.g. a batch ingested before the fill profile supplied brand data. Those
five fields are the only ones the tool can write; everything else about
the ingest record is protected. It writes via
`PUT /v1/{realm}/content/{content_id}` and is built so the ingest record
itself stays intact:

- **Dry-run by default** — prints the before/after table, writes nothing;
  `--apply` performs the edits one record at a time.
- Only `reportingId`, `contentTitle`, `advertiser`, `brand`, `vertical`
  are writable. After every PUT it re-GETs the record and diffs: if
  anything else
  changed (besides the server's own `status`/`datetime` audit fields),
  the run flags it. Reporting IDs are matched to `content_id`s before any
  write, and each record's before/after snapshot lands in
  `logs/metadata-fix-<timestamp>.jsonl`.
- The ingest record is asserted field-by-field: `content_id`,
  `retention` (default 17520h = 2 years from ingest),
  `deleted`, `detection_result`, `fingerprint`, `contentType`, and every
  ingest/detection timestamp must match their pre-write values or the
  run reports a protected-field violation. The customer's record of
  origin survives a metadata edit intact.
- `status` flipping to `METADATA_UPDATED` is the API's audit trail —
  detection results, commercial cids, and ingest timestamps are
  preserved.

```bash
# Preview a brand fix on specific IDs
python3 fix_metadata.py horizonmedia --brand CARE --ids ID1 ID2 ID3

# Titles + brand from a tracker CSV, scoped to specific IDs
python3 fix_metadata.py horizonmedia --brand CARE --csv tracker.csv \
    --id-col "Tracking ID" --title-col "Spot Title" --ids ID1 ID2

# Apply
python3 fix_metadata.py horizonmedia --brand CARE --ids ID1 ID2 --apply
```

Realm names take the same aliases as the extension (`horizon` →
`horizonmedia`, `in-market` → `inmarket`, …). IDs not found in the
realm's recent records are reported, never guessed.

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
