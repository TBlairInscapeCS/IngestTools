# Ingest Streamlined

A Chrome extension + local macOS watcher that automates the
ingest-request pipeline end to end:

> request email → matched tracker rows → found files → explicit download →
> portal fill preview → verified records + Jira draft → reply

You review and approve; the tool does the carrying. Downloads, portal
fills, BEGIN INGEST, Jira posts, and replies are always your click.

## Get started (~5 minutes)

1. **Unzip the package somewhere permanent.** Chrome loads the extension
   live from the folder, so pick a spot that won't be cleaned or moved.
2. **Load the extension.** `chrome://extensions` → enable **Developer mode**
   → **Load unpacked** → select the `1-Extension` folder → pin the toolbar
   icon.
3. **Install the watcher** (macOS — does the file work). Double-click
   `2-Watcher/INSTALL.command`. That's the whole install: it copies itself
   to `~/Library/Application Support/IngestTools/` and starts at login.
   If macOS says "Apple could not verify": **System Settings → Privacy &
   Security → Open Anyway**, then double-click again — the file is
   unsigned, so that warning is expected.
4. **Finish on the welcome page.** It opens on first install and turns
   each requirement green as it's detected — watcher, ffmpeg, signed-in
   tabs, optional connections. Reopen it anytime via the panel's **help**
   link.

Requirements: `python3` for the watcher, and `brew install ffmpeg` for
spec checks and ticker builds. Without the watcher the extension still
does email matching, tracker work, Jira drafts, and replies — only the
download/spec/ticker/portal-feed pipeline needs it.

## Using it

Four color-coded folder tabs, left to right: **Request → Files → Ingest →
Confirm**. A stage dot pulses on whatever the panel is doing right now.

1. Open the request email in Outlook and press **Run all** — it loads the
   email, detects the client, picks the right tracker tab, matches the
   IDs, and discovers files. It never downloads on its own.
2. Review the matches, then press **Download files**. The watcher checks
   specs and builds required ticker versions in the background.
3. **Feed files** → **Check & preview** → **Accept fills** → **BEGIN
   INGEST** (your click). Ready ticker builds feed themselves afterward
   as the video-only batch 2.
4. **Verify & draft** polls records, drafts the Jira ticket and the reply
   — both wait for your approval.

Every module works independently: manual downloads, already-ingested
jobs, and trackerless requests can jump straight to the step they need.
`extension/README.md` is the detailed operating guide.

## Packages

`./package.sh` builds from a whitelist (tests and docs never ship):

| Package | Contents | For |
|---|---|---|
| `dist/ingest-streamlined-v*.zip` | the extension alone | matching + analysis without the file pipeline |
| `dist/ingest-streamlined-v*-full.zip` | `README.md` + `1-Extension/` + `2-Watcher/` installer — folders numbered in install order | the complete setup, one machine |
| `dist/ingest-streamlined-v*-portable.zip` | extension with scrubbed `clients.js` template | sharing outside the org — no sheet IDs or playbooks |

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

## Customer reference sheet

A link-shared Google Sheet (`Customer | Exceptions & rules | Tracker |
Files / share`) is the live per-customer store: the panel fetches it on
open and every 15 min, and its values beat the built-in playbooks —
the Tracker column drives tracker auto-load subject to workbook ownership
checks (it cannot authorize another client's known tracker), the exceptions note shows
as the client caveat, and both render as links for sheets/shares the
tool can't reach itself (2FA, expired links). `customer-reference.tsv`
seeds it from `clients.js` (`node extension/gen_reference.js` to
regenerate); rows match clients by name containment, so "Horizon Media"
covers every `Horizon / <brand>` child.

## How a job flows — the details

1. **Request** — load the email and confirm the customer. Outlook folder
   rules take priority, followed by the recognized sender domain and
   fallback clues; manual selection wins. Check Document, worksheet,
   workbook ID, and owner before using row references. Known foreign
   trackers are blocked. Multi-tab workbooks are indexed once; Match
   scores every tab on cited codes, row numbers (doubled at the live
   bottom edge), name overlap, newest-row recency, and pending rows, then
   switches to the one holding the request. For trackerless clients the
   tracker is hidden and **Identify email IDs** uses the email. Override
   Match source under **Advanced request options**. Emails that cite no
   IDs auto-commit small pending pools, or use **Match sheet selection**
   on highlighted tracker rows.
2. **Files** — choose a source, **Find files**, review, then explicitly
   download. **Run all** stops at discovery. ER auto-search expands
   2 → 7 → configured days (default 14). **I already have the files**
   searches Downloads/Ingest; **Use portal file picker** takes you to the
   portal to select/drop files there yourself, without a manifest.
   **Stop downloads** remains in the header while this job is queueing
   or downloading. ZIPs landing in the job folder are unpacked and
   paired automatically. Detailed overrides live under **Advanced
   search options**.
3. **Ingest** — **Feed files** or the separate **Feed ticker files**
   batch, then **Check & preview**. Review Reporting ID, Portal Title,
   and ticker outputs before **Accept fills**. Fill profiles remain
   under **more → fill**. Title defaults to ID unless rules specify
   otherwise; ComScore uses `_t` for tickers. **I already ingested
   them** jumps to Confirm and checks records; it does not mark anything
   complete by assertion.
4. **Confirm** — records/Jira and the editable reply are together. Check
   actual processing/completion/failure evidence, prepare a Jira draft
   if needed, and post only on approval. Trackerless requests can draft
   acknowledgments from email IDs/filenames. Proof files land in
   `Ingest/_previous jobs/` (newest 3 jobs kept). Fully-archived job
   dirs fold under `Ingest/_archive/` (pruned after ~45 days), and the
   watcher logs rotate at ~2 MB with one backup each.

Busy operations disable repeated/competing starts and show their current
work. **New request** / **Clear all** clears per-job evidence, download
totals, and fill-preview state without deleting logs, sign-ins, settings,
media, or portal records; finish or stop downloads first. Advanced
settings → **Show all steps (advanced)** restores the expanded view.

**Edit selected client rules** lets you load the selected client's rules
and save local overrides for sender domains, tracker requirement, ingest
realm, Jira epic, ER sender filter, ticker requirement, and suffix.
Overrides stay in this Chrome profile; they do not update the shared
reference sheet. Client rules can also turn off **Include file
discovery in Run all**.

## Client-specific notes

- **InMarket**: portal Advertiser, Brand, and Vertical use each matched
  row's **InMarket Campaign Name (column D)**, not the customer or Brand
  column. A blank campaign leaves those fields untouched. Tracker-context
  ranges such as `campaign (1878-1883)` are recognized.
- **Vizio internal requests** (`@vizio.com` senders) ingest every file
  into both `geniusdigital` and `vizio` silos, verify records in each,
  and draft the reply listing each file's commercial ID per realm.
- **ComScore and SimulMedia** are trackerless. ComScore ticker IDs use
  lowercase `_t`; SimulMedia uses Jira epic `DD-597` and its delivery
  search supports both Comcast and Extreme Reach.

## Security & privacy

What the audit verified — the extension is purely local:

- **No telemetry.** No analytics, beacons, crash reporting, or calls to
  anywhere you didn't configure. The only network traffic is the APIs
  *you* keyed in (Microsoft Graph, Jira, Airtable, Extreme Reach,
  Databricks), the sheets and files you load, and `127.0.0.1:8770`.
- **No credentials in the package.** Every token/key is entered through
  ⚙ Settings and lives only in `chrome.storage.local` on that machine —
  nothing syncs to a Google account, nothing ships in the zips, nothing
  logs. The only outbound use of each credential is its own service.
- **The watcher is loopback-only** (127.0.0.1). File serving is limited to
  manifest entries or recently discovered request-ID-matched media in the
  fixed Downloads/Ingest roots. Discovery authorizations expire and reject
  symlinks, changed files, ambiguous matches, and arbitrary path requests.
- **Nothing destructive is automatic.** BEGIN INGEST, Push fills, Post
  to Jira, and sending replies are all explicit clicks. The panel
  previews every fill before it touches the page.
- **Evidence files are name-free**: job slugs are `YYYYMMDD-HHMMSS-client`.
- **The `-full` package is internal**: it includes `clients.js` with the
  org's playbooks and link-shared sheet IDs — share it inside the org
  only. The `-portable` package ships a commented template instead.
- `local/*.env`, logs, and `customer-reference.tsv` are gitignored and
  never packaged.

## Troubleshooting

- **"download watcher not running"** (red strip in the panel): install
  via `2-Watcher/INSTALL.command` or check
  `launchctl print gui/$(id -u)/dev.ingest-watch` and
  `local/logs/watch.log` (dev install: `~/Library/Application
  Support/IngestTools/logs/`).
- **Tickers "awaiting download"**: the base file hasn't landed — the
  status line flips to `building…` then `ready` as the convert finishes.
- **Sheet rows won't highlight**: only Google Sheets and SharePoint
  workbooks can open/navigate — file-uploaded `.xlsx` has no URL.
- **Wrong tracker or no match**: confirm the displayed document title,
  worksheet, workbook ID, owner, and client before using row references.
  For trackerless requests, choose email-only mode instead of loading a
  sheet.
- **Extension changes**: run `cd extension && osascript -l JavaScript test_fixtures.js`
  and `node test_tracker_selection.js` from `extension/`. See `AGENTS.md` for
  verification, the watcher restart rule, and the requirement to update README,
  welcome/onboarding, and relevant in-panel help with feature/UI changes.

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
