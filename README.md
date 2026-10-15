# Ingest Pipeline Tools

> **Read-only guarantee (pre-deployment):** nothing here modifies client
> services. The extension only *reads* — it fetches sheet/file exports and
> scrapes pages you already have open; it never POSTs, edits cells, sends
> email, or submits forms. Emails are drafted to your clipboard for you to
> send yourself. The watcher touches only `~/Downloads/Ingest/`.
> **Exception:** `Code.gs` writes to whichever sheet it's bound to — do not
> install it in client sheets.

## Deployment checklist (do NOT do these until ready to deploy)

- [ ] **Tracking-sheet write-back** — updating `Tracking ID`,
      `Ingest Completion Date`, `Completed by` on client sheets needs the
      Google Sheets API (write scope) or a bound Apps Script per sheet.
      Until then: update sheets manually.
- [ ] **Jira ticket creation** — needs a Jira Cloud API token and POSTs
      to your Jira instance. Until then: create tickets manually, attach
      the results CSV.
- [ ] **Inbox monitoring** — auto-detecting new request emails needs
      Microsoft Graph API + IT consent. Until then: open the email, click
      Grab.
- [ ] **Extension distribution** — currently sideloaded (Load unpacked).
      For teammates: Chrome Web Store or enterprise policy install.
- [ ] **`Code.gs`** — stays uninstalled entirely; it writes to sheets.

Three pieces that together automate the ingest-request workflow:

- **`extension/`** — a Chrome extension: request-email extraction, tracking-
  sheet matching (by ID, brand fallback), batch file download, and the
  original file-list reconciler. Works on any platform; nothing is installed
  client-side. See `extension/README.md`.
- **`local/`** — `ingest_watch.py`: watches the extension's download folder,
  runs `espn_ticker.sh` on files the sheet flagged for ESPN versions, and
  raises macOS notifications on failures. See `local/README.md`.
- **`Code.gs`** — the earlier Google Apps Script version, bound to a sheet.
  Only practical for sheets **you** own; superseded by the extension for
  client-owned sheets.

## What the Apps Script does

## What it does

- Deduplicates the IDs the client sent (flags repeats)
- For each ID, reports one of: `FOUND`, `POSSIBLE MATCH` (file named
  differently), `AMBIGUOUS` (multiple files match), `MISSING`, `DUPLICATE`,
  `BLANK`
- Writes Status / Matched File / File URL / Notes columns and color-codes rows
- Drafts the "missing / mismatched files" reply email for copy-paste

## Install (one time, ~2 minutes per tracking sheet)

1. Open the tracking sheet in Google Sheets.
2. Go to **Extensions → Apps Script**.
3. Delete the default `myFunction` stub, paste the full contents of `Code.gs`,
   and save (disk icon).
4. Reload the spreadsheet. A new **Ingest Tools** menu appears in the toolbar.
5. First run of any menu item will ask for authorization — approve it with your
   Google account (it only needs Drive read + Sheets access to this doc).

## Use

1. **Ingest Tools → 1. Set Drive folder** — paste the client's Drive folder link.
   It searches that folder and all subfolders.
2. **Ingest Tools → 2. Reconcile IDs with Drive** — scans and writes results.
   Review `POSSIBLE MATCH` and `AMBIGUOUS` rows manually.
3. **Ingest Tools → 3. Draft exception email** — copy the generated text into
   your reply to the client.
4. **Ingest Tools → Clear reconciliation columns** — resets for the next batch.

## Notes / limits

- The ID column is auto-detected: any header containing "ID" works, with a
  preference for "Tracking ID"-style names. Row 1 must be the header row.
- Matching ignores case, file extensions, and separator characters, so
  `ABC-12345` matches `abc_12345_master_v2.mp4`.
- Very large Drive folders (tens of thousands of files) may be slow to index;
  Apps Script has a ~6 minute per-run limit.
- The script is bound to the one spreadsheet you install it in. For a new
  customer's sheet, repeat the install — or make a copy of a sheet that already
  has it (the script copies with it).
