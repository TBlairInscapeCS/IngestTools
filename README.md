# Ingest Streamlined

A Chrome extension + local macOS watcher that automates the
ingest-request pipeline end to end:

> request email → tracking sheet → matched rows → downloaded media →
> filled portal queue → verified records + Jira proof → drafted reply

Two artifacts ship from `./package.sh`:

| Package | Contents | For |
|---|---|---|
| `dist/ingest-streamlined-v*.zip` | the extension alone | matching + analysis without the file pipeline |
| `dist/ingest-streamlined-v*-full.zip` | unpacked extension + `watcher/` + `install.command` | the complete setup, one machine |

## Install

### The extension (everyone)

1. Unzip the package somewhere stable — Chrome reads the folder live,
   so it must not be a temp or auto-cleaned directory.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select the `extension/` folder.
3. Pin the toolbar icon. On first install a **welcome page** opens with
   a live setup checklist — every dependency shows a checkbox that turns
   green when it's detected, plus the fix when it isn't. Reopen it
   anytime via the panel's **help** link.

### The watcher (macOS — does the file work)

Full package: double-click `watcher/install.command`. It installs to
`~/Library/Application Support/IngestTools/` and starts at login via
launchd. From the repo, `local/README.md` covers the same install by hand.

Requires `python3`, and `ffmpeg/ffprobe` (`brew install ffmpeg`) for spec
checks and `_ticker` builds. The watcher listens only on
`127.0.0.1:8770` and touches only `~/Downloads/Ingest/` (plus the
`~/Documents/Customer Content/` archive on completion).

## What each feature needs

The welcome checklist checks all of these live; the panel also warns on
open if the watcher or ffprobe is missing.

| Dependency | Unlocks | How it's detected |
|---|---|---|
| Watcher (`ingest_watch.py`) | downloads tracking, spec checks, `_ticker` builds, portal feed, archive | `/health` on 127.0.0.1:8770 |
| ffmpeg/ffprobe | media spec validation + ticker conversion | watcher health flags |
| Outlook on the web | request emails (grab from tab or paste) | open Outlook tab |
| Google sign-in | link-shared Sheets via xlsx export | docs.google.com tab |
| portal.cognet.tv | ingest queue feed + fills + verify | open portal tab |
| Extreme Reach tab | delivery sweep for ER clients | open ER tab (optional) |
| Microsoft sign-in | inbox watch, Grab Email, mark-read | refresh token stored (optional) |
| Jira credentials | ticket draft + post | stored in ⚙ Settings (optional) |
| Airtable token | direct tracker pulls | stored in ⚙ Settings (optional) |
| ER API key | keyed delivery fetch (no ER tab) | stored in ⚙ Settings (optional) |
| Databricks | impression counts | stored in ⚙ Settings (optional) |

## How a job flows

1. **Request** — open the request email in Outlook web; the panel grabs
   it (or paste it in), detects the client, extracts the cited codes.
2. **Tracker** — the sheet loads from the email's link, an open tab, or
   a manual pick. Row numbers deep-link back: click one to highlight it.
3. **Match** — codes ↔ sheet rows; exclude anything that doesn't belong.
4. **Download** — *Find & download* cascades: direct links → ER sweep →
   open delivery pages. The watcher tracks each arrival against the
   manifest and builds `_ticker` versions for flagged rows.
5. **Portal** — *Feed files* (batch 1: standard) then *Feed ticker
   files* (batch 2: video-only) into the portal picker; *Check &
   preview* shows exactly what would be written before *Accept fills*
   pushes it. BEGIN INGEST is always your click.
6. **Report** — verify records against the ingest API, review the Jira
   draft (posts only on approval), copy the reply for the requester.
   Evidence (records JSON + screenshots) lands in
   `Ingest/_previous jobs/` — newest 3 jobs kept.

## Repo layout

- `extension/` — the Chrome MV3 extension (side panel). Self-contained:
  `engine.js` is the parse/match core, `clients.js` the playbooks,
  `sidepanel.*` the UI. `welcome.html` is the onboarding page.
- `local/` — `ingest_watch.py` (watcher), `espn_ticker.sh` + `ticker.png`
  (ticker assets), `install.command` (launchd installer),
  `dev.ingest-watch.plist` (dev plist), `fi_status_watch.py` (standalone
  status probe).
- `package.sh` — builds the dist zips (whitelist packaging; tests and
  docs never ship).
- `Code.gs` — legacy Google Apps Script version. Writes to sheets;
  superseded — do not install it in client sheets.

## Safety notes

- **Nothing destructive is automatic.** BEGIN INGEST, Push fills, Post
  to Jira, and sending replies are all explicit clicks. The panel
  previews every fill before it touches the page.
- **The watcher is loopback-only** (127.0.0.1) and every file endpoint
  is manifest-scoped — it cannot read or write arbitrary paths.
- **No secrets ship in the package.** Credentials live in Chrome local
  storage entered through ⚙ Settings; `local/*.env` is gitignored.
- Evidence files are name-free: job slugs are `YYYYMMDD-HHMMSS-client`.

## Troubleshooting

- **"download watcher not running"** (red strip in the panel): install
  via `watcher/install.command` or check
  `launchctl print gui/$(id -u)/dev.ingest-watch` and
  `local/logs/watch.log` (dev install: `~/Library/Application
  Support/IngestTools/logs/`).
- **Tickers "awaiting download"**: the base file hasn't landed — the
  status line flips to `building…` then `ready` as the convert finishes.
- **Sheet rows won't highlight**: only Google Sheets and SharePoint
  workbooks can open/navigate — file-uploaded `.xlsx` has no URL.
- **Extension changes**: `osascript -l JavaScript extension/test_fixtures.js`
  (the engine test gate; see `AGENTS.md` for the watcher restart rule).
