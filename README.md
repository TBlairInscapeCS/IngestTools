# Ingest Streamlined

A Chrome extension + local macOS watcher that automates the
ingest-request pipeline end to end:

> request email → tracker or email-only IDs → reviewed matches → find files →
> explicit download → portal fill preview → verified records + Jira draft → reply

Two artifacts ship from `./package.sh`:

| Package | Contents | For |
|---|---|---|
| `dist/ingest-streamlined-v*.zip` | the extension alone | matching + analysis without the file pipeline |
| `dist/ingest-streamlined-v*-full.zip` | unpacked extension + `watcher/` + `install.command` | the complete setup, one machine |

For InMarket, portal Advertiser, Brand, and Vertical use each matched row's
**InMarket Campaign Name (column D)**, not the customer or Brand column.
Review these values in **Check & preview** before accepting fills. A blank
campaign leaves those fields untouched. Tracker-context parenthesized row
ranges such as `campaign (1878-1883)` are recognized; filename typos remain
possible matches requiring review rather than automatic approval.

Explicit tracker row ranges restrict matching to those rows; earlier sheet
matches and their ticker flags are not carried into replies or fill plans.
Portal fills also recognize exact tracker filenames, leave ambiguous matches
untouched, and verify Advertiser/Brand/Vertical as well as ID and Title.
The fill status separates actually filled files from files needing review.
The **Search → Yangaroo** option resolves spots from the delivery email's
Download anchors (or an open Yangaroo page) onto matched rows. Feeding or
picking files writes the job manifest first so sheet-flagged ticker versions
still auto-build even when files arrive outside a download run.

**Vizio internal requests** (`@vizio.com` senders) ingest every file into both
`geniusdigital` and `vizio` silos, verify records in each, and draft the reply
listing each file's commercial ID per realm.
Jira keeps the email sign-off in the request copy, but does not interpret a
standalone farewell as a creative title under **Ingest:**.

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
`127.0.0.1:8770`. Job processing uses `~/Downloads/Ingest/` and the
`~/Documents/Customer Content/` archive. On explicit discovery/feed requests,
it can also read recent media matching the request's IDs in `~/Downloads/`;
this discovery does not move or rename those files.

**Clear all** resets the request and dismisses its visible errors and
notifications without deleting saved diagnostic logs, sign-ins, settings,
media, or portal records. Selecting a different request also dismisses old
alerts and collapses **Log**. Finish or stop downloads before clearing.

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

## How a job flows

The default view uses four color-coded folder tabs, ordered left to right
(Request, Files, Ingest, Confirm), with a persistent job summary and one suggested
next-action button. The summary distinguishes identified IDs, located files,
downloads completed this run, and verified reporting IDs (including required
ticker variants). A located link is not a download or proof of completed ingest.
You can jump to any step; the suggestion is guidance, not a mandatory sequence.

1. **Request** — load the email and confirm the customer. Outlook folder rules
   take priority, followed by the recognized sender domain and fallback clues;
   manual selection wins. Tracker loading and matching are inside this step.
   Check Document, worksheet, workbook ID, and owner before using row references.
   Known foreign trackers are blocked. Multi-tab workbooks are indexed once;
   Match scores every tab on cited codes, row numbers (doubled at the live
   bottom edge), name overlap, newest-row recency, and pending rows, then
   switches to the one holding the request. For trackerless
   clients, the tracker is
   hidden and **Identify email IDs** uses the email. Override Match source under
   **Advanced request options**. Sheet-first work can start from pending rows.
2. **Files** — choose a source, **Find files**, review, then explicitly download.
   **Run all** also stops at discovery. ER auto-search expands 2 → 7 → configured
   days (default 14). **I already have the files** searches Downloads/Ingest;
   **Use portal file picker** takes you to the portal to select/drop files there
   yourself, without a manifest. **Stop downloads** remains in the header while
   this job is queueing or downloading, even if you view another step. Completed
   files are not removed. Detailed overrides live under **Advanced search options**.
3. **Ingest** — **Feed files** or the separate **Feed ticker files** batch, then
   **Check & preview**. Review Reporting ID, Portal Title, and ticker outputs
   before **Accept fills**. Fill profiles remain under **more → fill**. Title
   defaults to ID unless rules specify otherwise; ComScore uses `_t` for tickers.
   BEGIN INGEST stays your click. **I already ingested them** jumps to Confirm
   and checks records; it does not mark anything complete by assertion.
4. **Confirm** — records/Jira and the editable reply are together. Check actual
   processing/completion/failure evidence, prepare a Jira draft if needed, and
   post only on approval. Trackerless requests can draft acknowledgments from
   email IDs/filenames. An acknowledgment is not ingest proof. Copy/send the
   reply yourself or create an Outlook draft for review. Both draft fields have
   **Clear**. Proof files land in `Ingest/_previous jobs/` (newest 3 jobs kept).

Busy operations disable repeated/competing starts and show their current work.
**New request** clears per-job evidence, download totals, and fill-preview state;
finish or stop active downloads first. Client guidance/rules, column mapping,
source overrides, and fill profiles are secondary controls. Advanced settings →
**Show all steps (advanced)** restores the expanded view and is saved locally.

**Edit selected client rules** lets you load the selected client's rules and
save local overrides for sender domains, tracker requirement, ingest realm,
Jira epic, ER sender filter, ticker requirement, and suffix. Overrides stay in
this Chrome profile; they do not update the shared reference sheet. ComScore
and SimulMedia are trackerless; SimulMedia uses Jira epic `DD-597` and no special
naming suffix. Its delivery search supports both Comcast and Extreme Reach.
Use the download module's **Search** selector to choose Comcast email, ER,
Downloads/Ingest, open pages, or automatic discovery. **Feed files** can find
unique, recent request-ID-matched media in Downloads without moving it or
requiring a manifest. Use **Use portal file picker** for duplicates or different
filenames; **Pick & feed** remains an advanced manifest-based option.

Client rules can turn off **Include file discovery in Run all**. You can identify
IDs, handle downloads/portal upload manually, and go straight to **Verify &
draft**. Within the active request, local/media evidence and verified completion
override earlier search misses in the auto-reply; failed and processing records
are not claimed as completed ingest. User-edited drafts remain unchanged until
Redraft. See `extension/README.md` for the detailed operating guide.

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
- **Two builds:**
  - `ingest-streamlined-v*-full.zip` — internal: includes `clients.js`
    with the org's playbooks and link-shared sheet IDs. Anyone who can
    open this zip can open those sheets — share it inside the org only.
  - `ingest-streamlined-v*-portable.zip` — scrubbed: `clients.js` is a
    commented template (no sheet IDs, no playbooks, no Jira epics, no
    reference sheet). The new user supplies their own config; nothing
    of the original org's data travels with it.
- `local/*.env`, logs, and `customer-reference.tsv` are gitignored and
  never packaged.

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
- **Wrong tracker or no match**: confirm the displayed document title,
  worksheet, workbook ID, owner, and client before using row references.
  Reload the extension after updates to activate foreign-reference cleanup.
  For trackerless requests, choose email-only mode instead of loading a sheet.
- **Extension changes**: run `cd extension && osascript -l JavaScript test_fixtures.js`
  and `node test_tracker_selection.js` from `extension/`. See `AGENTS.md` for
  verification, the watcher restart rule, and the requirement to update README,
  welcome/onboarding, and relevant in-panel help with feature/UI changes.
