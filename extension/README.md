# Ingest Pipeline — Chrome extension

Browser-side pipeline for client ingest requests: request email → tracking
sheet → matched rows → batch download → (local ESPN conversion via the
watcher). Nothing is installed on the client's side and no API keys are needed.

## Install (one time, ~1 minute)

1. Open Chrome → `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** → select this `extension/` folder.
4. Click the extension's toolbar icon to open the side panel.
5. In Chrome **Settings → Downloads**, turn OFF **"Ask where to save each
   file"** — otherwise batch downloads will prompt once per file.

## The pipeline

### Client playbooks
The **Client** dropdown at the top auto-detects who this request is for —
by tracking-sheet document ID first (strongest), then keywords/sender
domains in the email — and shows the delivery playbook for that client:
*where its files actually come from*. Clients whose files arrive out-of-band
(Yangaroo, Extreme Reach, SharePoint) get a guidance note instead of a
"missing link column" error. Profiles live in `clients.js` — add an entry
per client (detection keys + delivery channel + playbook note).

### 1. Request email
- **Grab from open Outlook tab**: focus the Outlook-on-the-web tab with the
  request open, then click. For desktop Outlook, paste the email body.
- The panel shows what it extracted: link count by service type
  (google-drive, extreme-reach, dropbox, yangaroo…) and the dates
  mentioned.
- **Yangaroo delivery notifications** ("ADVERTISING DELIVERY" emails) are
  recognized automatically: each spot row's **Download** link is paired
  with its Ad-ID/ISCI and shown as "N spot(s) with download links" plus the
  order ID. Matched sheet rows then download straight from the email — the
  notification *is* the manifest. (Only `Download` anchors are read —
  `Confirm Delivery`, `Stream`, and `Support` links are never touched,
  since those have remote side effects. Use Grab, not paste: pasting loses
  the link targets.)

### 2. Tracking sheet
- **Grab from open Google Sheet** pulls the sheet's **XLSX export** through
  your existing login — works on client-owned sheets you can view. XLSX
  (unlike CSV) preserves cell *hyperlinks*: cells displaying a folder name
  like "Applebee's C7 2026" resolve to the real Drive/Extreme Reach URL
  underneath, which is what enables batch download for this sheet.
  CSV export is kept as a fallback (no hyperlinks).
- **SharePoint Excel trackers** (e.g. Kantar): open the workbook in the
  SharePoint/Excel Online tab and click grab — the file is pulled via the
  SharePoint REST API through your session. If that fails, use Excel's
  *File → Save a Copy → Download a Copy* and load the `.xlsx` here.
- You can also load a `.csv`/`.txt`/`.xlsx` file or paste a sheet selection.
- Header row and column mappings are auto-detected and shown as a one-line
  summary — the dropdowns are tucked under "Column mapping" and only needed
  when auto-detection misses (it auto-expands if the ID column can't be
  guessed). They exist because the *engine* needs to know which column is
  the ID/ESPN/link to match against — not for manual lookup.

### 3. Match & download
- **Match email to sheet**, in priority order: explicit sheet-row refs
  ("rows 1857-1859") > IDs in the email (Ad-ID `YKKL0288000H` or ISCI-style
  `0926607ZKCH` codes both recognized) > filenames > brand name (only when
  nothing explicit is found — a brand in a master tracker would otherwise
  match every historical row).
- The header row and all column mappings are auto-detected; verify the
  dropdowns before matching.
- If the email's own inline table has a "Need ESPN Version" YES/NO column,
  it's cross-checked against the sheet — disagreements get an `ESPN?` chip.
- The table shows each matched row: ID, title, match type, ESPN flag,
  access flag (`NO ACCESS` chip when the "access given" box is unchecked),
  and the link — folder names (non-URL cells like "via Yangaroo" or a
  campaign name) are shown for context since those files arrive out-of-band.
- **Download linked files** queues downloads into `~/Downloads/Ingest/<job>/`
  plus a `manifest.json` the watcher reads. Per matched row:
  - **Drive folder links** (the usual case for InMarket): the folder is
    listed via Drive's embedded view and the single file matching that row
    is downloaded — not the whole folder. Rows with no match or ambiguous
    matches are skipped and listed for manual review.
  - **Direct file links** (Dropbox etc.): downloaded as-is, with
    `dl=0`→`dl=1` rewriting.
  - **Yangaroo delivery links** (joined from the delivery email by code):
    queued as `<tracking_id>.mp4` — the URL carries no filename, so the ID
    names the file.
  - Rows with no link are skipped and listed.
- **Copy confirmation reply** drafts the "ingested under the following IDs"
  reply listing tracking IDs (apostrophes → underscores, matching the
  sheet's convention).
- Run `python3 ../local/ingest_watch.py` and the downloads get converted
  automatically — see `local/` README.

### 4. Verify files on share
- **Extreme Reach** (`app.extremereach.com` Spot Deliveries): a dedicated
  adapter reads each delivery row — Ad-ID, title, advertiser — and picks up
  the row's real `/Delivery/Download/<guid>` link (the delivered master
  file; the `/Media/Download` low-res proxy and Detail/Stream/QC links are
  deliberately ignored). The index paginates (10/20/50/100 per page) —
  captures **merge and dedupe** across grabs, so set the page size to 100,
  flip pages, and grab again to build a full batch; the panel warns when a
  next page exists. Reconcile then matches requested codes and **Download
  found files** queues every FOUND delivery URL through your ER session.
  **Clear** resets the accumulated list + captured links for a new batch.
- The reconciler: requested IDs vs. file names on the delivery site →
  FOUND / POSSIBLE MATCH / AMBIGUOUS / MISSING / DUPLICATE, plus **EXTRA**
  for files in the folder that were never requested (the "it was in the
  folder but not listed" case — they're listed under the results table).
- **Copy confirmation** after a reconcile drafts the discrepancy-aware
  reply: "N of M requested files", extras called out as "in the folder but
  not listed", missing as "not in the linked folder", ESPN spots getting
  `<id>_ticker` entries.
- **Grab file list from current page** captures filename-like lines **and
  their download links** when names are anchors (SharePoint file lists,
  Drive folder pages); when the email mentioned dates, entries whose line
  carries a non-matching date are filtered out to limit noise.
- **Download found files** queues the FOUND entries that have links into
  the same `~/Downloads/Ingest/<job>/` + manifest pipeline (ESPN flags join
  back from the sheet match).
- Outputs: exception email, confirmation email, results CSV.

### Universal fallback
On any site: select text → right-click → **"use selection as tracking
IDs"** / **"as file list"**. Works everywhere, even platforms with no adapter.

## Notes / limits

- **ER POD PDFs** are receipts only — no embedded links, nothing to
  extract. ER discovery happens on the delivery index page instead.
- **ER download URLs** serve the master file via your session; the saved
  filename comes from the row's "Ad-ID + title" since the URL is opaque.
- **Inbox monitoring** (auto-detecting new request emails without opening
  them) isn't possible from an extension — that path is Microsoft Graph API
  + IT consent. Current flow is "open email → one click."
- All processing is local; nothing is sent anywhere.
