# Ingest Streamlined — Chrome extension

Browser-side workflow: request email → tracker or email-only IDs → reviewed
matches → find files → explicit download → portal fill preview → verify,
Jira draft, and reply. The local macOS watcher handles file checks, ticker
conversion, and portal file feeding. External services use your existing
browser session or optional credentials configured in Settings.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this `extension/` folder.
3. Pin the toolbar icon and open the side panel.
4. Follow the welcome page's setup checklist. Reopen it using the panel's
   **help** link. Watcher installation instructions are in `../local/README.md`.
5. For batches, disable Chrome Downloads → **Ask where to save each file**.
6. After updating extension files, reload the extension in `chrome://extensions`.

## InMarket matching and portal metadata

InMarket's default fill uses **InMarket Campaign Name (column D)** from each
matched tracker row for **Advertiser, Brand, and Vertical**. Mixed-campaign
jobs retain each row's own campaign; blanks leave existing portal fields alone.
**Check & preview** shows these values before **Accept fills**. Profiles that
omit advertiser fields still omit all three metadata fields.

Tracker-context ranges such as `campaign (1878-1883)` work alongside explicit
`rows 1884-1904`. Older unmarked confirmation text beginning “I've ingested”
is excluded when a newer request already cites tracker rows. Other unmarked
thread formats can still need review: always check the selected row list.
A filename typo (for example, `Part Fits` versus `Party Fits`) is not an exact
match; review the possible match rather than assuming the extension is wrong.

## Next-level automation

- **Auto-verify:** after files are fed (or after a manual `Verify & draft`),
  records are polled every 60 s until every wanted ID reaches a terminal
  state, then *"Ingest finished — review the drafted reply"* pops and the
  draft refreshes. No manual re-check needed.
- **Reply sanity gate:** the reply module shows a `Before sending:` warning
  whenever the draft would claim more than records prove — fuzzy-matched
  files, still-processing/failed IDs, or flagged ticker versions with no
  record yet.
- **Resumable evidence:** locate/ingest evidence is persisted to extension
  storage keyed by the request; reopening the same email context after a
  reload rehydrates located/completed proof so found never regresses to
  "not found" just because the panel restarted.
- **Delivery auto-recheck:** when Find files ends with nothing
  downloadable, a low-frequency retry (every 15 min while the panel is
  open) re-runs discovery and stops as soon as a link/file appears or
  downloads start.
- **Yangaroo pages:** `Download` anchors are resolved through the delivery
  page — the real media href + filename are used for the manifest and
  portal naming; an unparseable page falls back to `<id>.mp4`.
- **Possible matches tightened:** fuzzy candidates need similarity ≥0.7
  and within 0.12 of the best score — weak guesses no longer flood review.

## Vizio internal requests (dual-silo)

Emails from `@vizio.com` asking for ingest (e.g. "clip for Ingestion") match the
**Vizio (internal request)** playbook: no tracker, Reporting ID = the clip
filename, and every file ingests into **both** `geniusdigital` and `vizio`
silos. **Verify & draft** queries both realms and only counts an ID complete
when it reached that stage in *each* silo. The auto-reply mirrors the real
format — each filename followed by its `C(^.~)c_Commercial_<realm>-…` ID per
realm; a realm whose cid hasn't been assigned shows "(pending)" and the draft
says you'll send it. Use **▣ Make screenshot** on the portal for the file
screenshots to attach.

## Row scope and portal fill checks

When the email cites tracker rows, those rows define the match scope. Rematching
replaces previous sheet matches rather than carrying unrelated creatives and
ticker flags into the reply or fill plan. Check the match list before drafting. Standalone email sign-offs such as
“Thanks!” or “Best,” stop creative-title extraction. Jira retains the sign-off
in the request copy, not as a title under **Ingest:**; a missing title remains
blank instead of borrowing signature text.

Portal matching checks Reporting ID, Title, and exact **File Name** aliases from
the tracker (ignoring common media extensions and punctuation). Ambiguous aliases
are left untouched for review. Accepting a new plan replaces the live observer,
so later file drops use the latest accepted metadata. The fill status reports
actual filled/queued counts and files needing review; the log records unmatched
filenames. Verification checks Advertiser, Brand, and Vertical as well as
Reporting ID, Title, and fingerprint mode. Resolve differences before BEGIN INGEST.

## Four-step daily view

The panel shows color-coded folder tabs—**Request, Files, Ingest, Confirm**—
ordered left to right, one page at a time. Each page matches its tab's color.
The persistent summary separates identified IDs, located media, downloads
completed this run, and verified reporting IDs (including required tickers).
The main button suggests the next action from current evidence. It never
approves portal fills, posts Jira, sends replies, or begins ingest for you.
You can navigate to any step at any time.

- **Request** contains email intake, tracker loading, and ID review. Trackerless
  clients hide the tracker entirely; the override remains under **Advanced
  request options → Match source**.
- **Files** contains source selection and separate find/review/download actions.
  The **Search** selector includes **Yangaroo**, which uses the delivery email's
  per-spot Download links attached to matched rows (or an open Yangaroo page) so
  Download files pulls only requested spots. When files arrive manually (Pick &
  feed, local discovery), the extension writes the job manifest first so
  sheet-flagged ticker versions still auto-build in the job folder.
  **I already have the files** searches local media. **Use portal file picker**
  activates the portal and points you at its picker; select/drop files there
  yourself without needing a manifest. Detailed tools and the manifest action
  are under **Advanced search options**.
- **Ingest** contains feeding and previewing/accepting fills. **I already
  ingested them** navigates to Confirm and checks actual records.
- **Confirm** contains records, Jira drafting/approval, and the editable reply.

**Stop downloads** remains in the header while this job is queueing or downloading.
Repeated/competing starts are disabled while an operation is running. Errors
and progress stay visible; a queued operation is not reported as completed media.
**Clear all** clears the request, evidence, download totals, previews, visible
errors, and notifications. Selecting a different request also dismisses the
previous job's alerts and toasts and collapses **Log**. Saved diagnostic logs,
sign-ins, and settings remain available; clearing does not delete media or
portal records. Finish or stop downloads first. Client rules are under **Client guidance and
advanced rules**. Advanced settings → **Show all steps (advanced)** restores the
expanded view; that preference is saved locally.

The following sections are detailed control reference, not additional steps.

## Client selection and rules

The **Client** dropdown supports automatic detection and manual selection.
Outlook folder classification takes priority, followed by the actual sender's
recognized domain, then fallback sheet/subject/body signals. Folder information
comes from inbox loading through Microsoft Graph; pasted text does not carry
an Outlook folder. A manual selection remains authoritative.

**Edit selected client rules** provides local overrides:

1. Select the client, then press **Load selected client**.
2. Adjust **No tracker**, sender domains, ingest realm, Jira epic, ER sender
   filter, ticker requirement, or ticker suffix.
3. Press **Save rules locally**. Rules stay in this Chrome profile; they do not
   edit the shared customer reference sheet or the repository's `clients.js`.

Built-in examples: ComScore and SimulMedia have no tracker. ComScore ticker
Reporting IDs and portal Titles use lowercase `_t`; SimulMedia has no special
suffix and uses Jira epic `DD-597`. Naming follows the active client rules and
fill profile, so review the portal preview before accepting fills.

## Request: read the email

- **From Outlook** reads an open Outlook web message; **Check inbox** loads
  requests through optional Microsoft sign-in. Paste and `.eml` are under **more**.
- A new email resets the run. Check the detected client and extracted IDs.
- Yangaroo and Comcast delivery messages can supply per-spot download links.
  Load through the inbox or Outlook grab to retain HTML link targets; pasting
  visible text may lose them. A viewer or login page is not a media file, and
  a parsed link may still require an authenticated delivery session.

## Request: tracker or email-only IDs

**Match source** offers:

- **Client rules (auto)** — follow the client's tracker requirement.
- **No tracking sheet — email IDs only** — disable tracker acquisition controls
  and use the request email as the manifest, even if a sheet was already loaded.
- **Tracking sheet** — use the sheet workflow.

For tracker-backed requests, use **Grab tracker**, an email-linked workbook,
a known client tracker, or **other sources → Load file / Paste tracker**.
Google exports use XLSX to preserve hyperlinks; CSV fallback loses those links.
SharePoint uses your browser session. If export fails, download the workbook
from Excel and load the `.xlsx` manually. Airtable also supports its own
capture/API paths when configured.

The module prominently shows **Document: [title]**, including while collapsed.
Inside, check the separate worksheet name, request client, workbook ID, and
known owner. Pasted data or unavailable metadata is labeled honestly rather
than given an invented document title.

Selection cross-checks exact workbook IDs and known ownership instead of
assuming every `docs.google.com` tab belongs to the request. Known foreign
workbooks are blocked at load, refresh, and match time. Invalid remembered
references are removed during cleanup; a known Horizon workbook must not load
for a non-Horizon client. Unregistered workbook ownership still needs review.

Check the header row and field mappings under **columns**. A row-number request
is meaningful only against the correct workbook; a matching row number alone
does not prove the tracker is right.

Multi-tab workbooks are indexed once on load (rows, detected header, column
map, pending count, and newest date per tab). **Match** scores every tab on
the request's cited codes, cited row numbers (counted double at the grid's
bottom edge — trackers fill top-to-bottom, so new rows land there), tab-name
overlap with the request/brand, how recent its newest dated row is (the
"last edited" area is where new lines would be), and its pending-row queue,
then switches to the tab that holds the request — the open Sheets tab follows
so the flip is visible. Cited codes and rows always outrank the softer
signals, and a tab already covering the request is never left for a weaker
signal. Cited codes found only on sibling tabs are listed under the results
with click-to-switch links that re-match there.

For sheet-first work before an email arrives, **N pending row(s) — use as
requested IDs** seeds the request and commits pending rows when the email is
empty. Pending uses empty fill-back fields and a recent-date filter relative
to the newest dated unclaimed row. Review this set before finding files.

## Request: review requested IDs

- **Match** pairs explicit row references, IDs, filenames, and fallback clues
  with the loaded sheet. Review IDs, titles, links, and ticker flags.
- In email-only mode the button becomes **Identify email IDs**. Email-derived
  rows feed file discovery, portal fills, Jira, and replies without a tracker.
- Exclude rows that do not belong; downstream stages skip excluded rows.
- **Show on sheet** can highlight matched rows when a navigable workbook is known.

## Files: find, review, then download

1. Press **Find files**. Discovery tries matched direct links, an Extreme Reach
   search, then open delivery pages. This button does not queue media downloads.
2. Review the linked match rows and reconciliation results. Only the correct
   request IDs should be present; investigate ambiguous or missing candidates.
3. Press **Download files** to start the explicit download step.
4. **Stop** appears during the download queue: it stops new queue entries and
   cancels this run's tracked in-flight downloads. It does not undo completed
   files or stop every kind of background process.

**Run all** reads the email, loads/matches the tracker as needed, and discovers
files; it stops short of downloading. ER search, open-page capture, API search,
and delivery re-checks also leave downloading to your explicit action.

ER auto-search starts at 2 days, widens to 7, then the configured window
(default 14) if necessary. Manual **ER search** uses the entered window.
Requested IDs are required for sweeps, preventing a sender-only search from
turning an entire delivery window into the request. Client changes clear a
previous client's sender preset. The scrape path is capped at 1,200 deliveries;
very large batches may need the optional keyed API or manual review.

**Re-check** checks delivery availability and may arm a five-minute watch while
the panel remains open. Module status lines report live work and real progress
fractions where countable; do not repeatedly click while a stage is running.

Downloads and manifests use `~/Downloads/Ingest/`; the watcher reconciles the
job, checks media specs, and builds required ticker versions. Drive folder
resolution selects a matching file rather than downloading the entire folder;
ambiguous matches need review. HTML viewer pages are rejected as media.

### Mixed deliveries and manual work

SimulMedia defaults to **no tracker** and a mixed Comcast/Extreme Reach delivery
search. The module's **Search** selector can use client rules, all sources,
**Comcast email**, **Extreme Reach**, **Downloads / Ingest**, or open pages.
Comcast discovery reads open Outlook web delivery messages without replacing
the request email. It pairs Spot/Download links to the IDs on the same row and
keeps only requested IDs; keep the original HTML delivery email open.

**Downloads / Ingest** checks recent, stable media in the top level of
`~/Downloads/` and `~/Downloads/Ingest/`, by code-shaped request ID. It does not
move or rename files. Unrelated files, symlinks, partials, files older than
14 days, and ambiguous duplicates are not fed automatically. Unzip archives
first; **Use portal file picker** lets you select ambiguous/differently named
media in the portal itself. The advanced **Pick & feed** upload path requires
an existing job manifest.
**Feed files** also runs this discovery, even when no manifest exists. Local
discovery alone does not create a manifest or build missing ticker versions;
use the normal manifest/ticker workflow when conversions are required.

Under **Edit selected client rules**, set the delivery search and uncheck
**Include file discovery in Run all** if that client is handled manually.
Tracker selection, discovery, feeding/filling, and verification can be used
independently: identify request IDs, perform any manual steps, then continue
with the module you need rather than restarting the whole job.

For the current request, later local-file, portal-feed, and verified-record
evidence takes precedence over an earlier search miss. **Verify & draft** and
live portal checks refresh the auto-reply: completed detection records confirm
ingest, processing records say it is not complete, and failures are called out.
Partial results list the remaining IDs separately. An unsuccessful later search
cannot erase known completion. User edits are preserved; choose **Auto draft**
and **Redraft** to replace a previously edited or manually selected variant.
This evidence is scoped to the active request and is cleared for a new run.

## Ingest and Confirm

- **Feed files** feeds standard media; **Feed ticker files** feeds the separate
  video-only ticker batch. **Pick & feed** is under **more**.
- **Check & preview** shows Reporting ID and **Portal Title** as separate output
  values, with standard/ticker rows. Confirm the document, client, and values
  before **Accept fills** writes the queue.
- **more → fill** chooses **auto (playbook)**, **ID as title**, **ID + title**,
  or **ID + title + advertiser**. The choice is persisted and changing it
  refreshes the preview. By default, Title equals Reporting ID unless client
  rules specify a distinct title. Ticker fields use the client's configured
  suffix; ticker fingerprinting is video-only. Realm, Type, and Retention
  remain untouched. **BEGIN INGEST** is your click.
- **Verify & draft** checks records and prepares Jira content. Review missing
  information and proof; a draft is not a posted ticket. The workflow prefers
  a partial draft with gaps flagged over no draft and may ask for missing
  realm/epic information.
- Review the editable Jira and reply fields. Each has a **Clear** button.
  Jira posting requires approval; copy the reply and send it yourself. An
  acknowledgment draft is not evidence that media has been downloaded/ingested.
  Trackerless email matches automatically open an acknowledgment using the
  email's IDs/filenames, including ComScore filename-style IDs. **Redraft** also
  works before Match. After actual ingest, choose **Ingested + IDs** explicitly;
  trackerless confirmations omit sheet-update claims and use client ticker
  suffixes (ComScore `_t`). User-edited replies stay unchanged until Redraft.

## Troubleshooting and fallbacks

- Wrong tracker: check **Document**, worksheet, workbook ID, owner, and client
  before matching. Load the correct workbook explicitly; do not trust row
  numbers from a different tracker. Reload after an update to activate cleanup.
- Open tracker not selected: ensure the client is correct and the tab is the
  matching workbook. Unknown/ambiguous tabs are not selected merely because
  they share Google's host. Use a focused correct tab or load the file manually.
- No-tracker client: select **No tracking sheet — email IDs only**, then
  **Identify email IDs**, rather than pasting an unrelated tracker.
- Comcast/Yangaroo link missing: load the original HTML email rather than
  plain-text paste; check delivery sign-in and review the captured links.
- On any site, select text and use the context-menu **use selection as tracking
  IDs** / **as file list** fallback.
- ER POD PDFs are receipts, not a source of downloadable media links.
- Optional Microsoft Graph, Jira, Airtable, ER API, and Databricks connections
  are configured in Settings. Credentials are stored locally; requests go to
  the selected external services, file hosts, and local watcher. There is no
  extension telemetry.

## Verification

From this directory:

```sh
osascript -l JavaScript test_fixtures.js
node test_tracker_selection.js
node test_trackerless_reply.js
node test_journey_ui.js
node --check sidepanel.js
node --check xlsx.js
```

See `../AGENTS.md` for the documentation-update and watcher-restart rules.
