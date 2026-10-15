/* Side panel controller. engine.js provides: normalizeName, similarity,
   reconcile, parseInput, guessField, ingestFileName, extractLinks, extractDates,
   filterByDates, firstUrl, truthyFlag, guessColumn, matchEmailToSheet,
   latestSegment,
   downloadName, espnOutputName, buildManifest, buildExceptionEmail,
   buildConfirmationEmail, resultsToCsv. */

const $ = id => document.getElementById(id);
const emailEl = $('email'), idsEl = $('ids'), filesEl = $('files');

let sheet = null;          // { headers, rows } data rows (header excluded)
let matched = null;        // rows matched by the request email
let matchedFor = '';       // email text at match time - drift = stale results
let lastResults = null;    // reconcile() output
let emailDates = new Set();
let emailSubject = '';
let emailSender = '';      // sender first name for reply greetings
let capturedByName = {};   // file name -> {url, line} from last page capture
const queuedUrls = new Set(); // URLs already queued for download this session
let matchCols = {};        // column picks in effect for the current match
let detectedAdvertiser = ''; // brand from delivery-notification subjects
let pendingRows = [];      // sheet rows with empty fill-back columns
let emailPairs = [];       // code+title pairs from the email (Chief Media)
let emailSpots = [];       // row#/title/code/link blocks from the email (AMC)
let yangaroo = null;       // {spots, orderName, orderId} from delivery email
let lastExtras = [];       // files present but not requested (reconcile)
let client = null;         // active playbook from clients.js
let clientSource = '';     // 'sheet' | 'email' | 'manual'
let sheetSource = '';      // where the loaded sheet came from (tab/file name)
let sheetBuf = null;       // raw xlsx of the whole workbook (all tabs)
let sheetTabs = [];        // tab names in that workbook
let sheetTabName = '';     // which tab was loaded
let sheetSourceTab = null; // the open Sheets tab the workbook came from
let sheetGids = {};        // tab name -> web gid (for #gid= navigation)
let dlTotal = 0, dlDone = 0, dlFailed = 0;
const ourDlIds = new Set(); // chrome.downloads ids we started - onChanged fires for ALL browser downloads
let lastCapTab = null;     // tab the last page capture ran against

// Freshness stamps: each section header shows when its data was last
// pulled, so stale captures are obvious at a glance.
function stamp(id) {
  const el = $(id);
  if (el) el.textContent = '· ' + new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Traffic-light per stage: grey untouched, green done, orange needs user
// action, red failed. The tooltip carries the detail (source/counts/why).
function setStage(id, cls, tip) {
  const el = $(id);
  if (!el) return;
  el.className = 'sdot' + (cls ? ' ' + cls : '');
  el.title = tip || '';
}

// ---------- Helpers ----------

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.style.display = 'none'), 3000);
  dbg('toast: ' + msg);
}

// Clickable info bubbles: any .ib[data-bubble] toggles its target div.
document.addEventListener('click', e => {
  const ib = e.target.closest('.ib[data-bubble]');
  if (!ib) return;
  e.preventDefault();
  const b = $(ib.dataset.bubble);
  if (b) b.classList.toggle('hidden');
});

// ---------- Debug log ----------
// Rolling event log persisted to storage so a test run leaves a readable
// trail - the bottom "Log" section shows recent entries and Copy Log puts
// the whole thing on the clipboard for sharing.
let dbgLog = [];
function dbg(msg, data) {
  dbgLog.push({ t: new Date().toISOString().slice(11, 19), msg, ...(data ? { data } : {}) });
  if (dbgLog.length > 300) dbgLog = dbgLog.slice(-300);
  chrome.storage.local.set({ dbgLog });
  renderDbg();
  scheduleLogFlush();
}

// Mirror the log to the project's logs/ folder via the watcher's local
// endpoint (no Downloads round-trip, no download entries). Falls back to
// writing the file through chrome.downloads when the watcher is offline.
let logFlushTimer = null;
function scheduleLogFlush() {
  clearTimeout(logFlushTimer);
  logFlushTimer = setTimeout(flushLog, 1500);
}
let lastFileFlush = 0;
async function flushLog(force) {
  const text = dbgLog.map(e => e.t + ' ' + e.msg + (e.data ? ' ' + JSON.stringify(e.data) : '')).join('\n') + '\n';
  try {
    await fetch('http://127.0.0.1:8770/ingest-log', { method: 'POST', body: text });
    return;
  } catch (e) { /* watcher offline - fall through to file write */ }
  // The downloads channel is visible to the user (download entries), so
  // only use it sparsely - at completion points or once a minute max.
  if (!force && Date.now() - lastFileFlush < 60000) return;
  lastFileFlush = Date.now();
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    await chrome.downloads.download({ url, filename: 'Ingest/_debug/ingest-tools-log.txt', conflictAction: 'overwrite' });
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) { /* downloads unavailable - storage copy still works */ }
}
function renderDbg() {
  const el = $('dbgLog');
  if (!el) return;
  el.innerHTML = dbgLog.slice(-30).map(e =>
    '<div>' + e.t + ' ' + esc(e.msg) + (e.data ? ' <span class="hint">' + esc(JSON.stringify(e.data)) + '</span>' : '') + '</div>'
  ).join('');
}
chrome.storage.local.get(['dbgLog'], d => { dbgLog = d.dbgLog || []; renderDbg(); });

function activeTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(t => t[0]);
}

// Classify open tabs by pipeline role. Broad host_permissions expose
// url/title for every http(s) tab even without the "tabs" permission.
async function stageTabs() {
  const tabs = await chrome.tabs.query({});
  const cls = { outlook: [], sheet: [], sharepoint: [], airtable: [], er: [], portal: [] };
  tabs.forEach(t => {
    const u = t.url || '';
    if (/outlook\.(office|live)\.com/i.test(u)) cls.outlook.push(t);
    if (/docs\.google\.com\/spreadsheets/i.test(u)) cls.sheet.push(t);
    else if (/\.sharepoint\.com|\.sharepoint-df\.com/i.test(u)) cls.sharepoint.push(t);
    else if (/airtable\.com/i.test(u)) cls.airtable.push(t);
    if (/extremereach\.com/i.test(u)) cls.er.push(t);
    if (/portal\.cognet\.tv/i.test(u)) cls.portal.push(t);
  });
  return cls;
}

// The focused tab wins when it qualifies (user intent), else first match.
function pickTab(cands, activeId) {
  return cands.find(t => t.id === activeId) || cands[0] || null;
}

// Google Sheets doc refs the request email links to (SafeLinks-unwrapped).
// Lets the tracker load with NO sheet tab open - the doc id + gid are all
// the export fetch needs.
function emailSheetRefs() {
  const refs = [];
  extractLinks(latestSegment(emailEl.value)).forEach(l => {
    let u = l.url;
    const w = u.match(/[?&]url=([^&]+)/i);
    if (w && /safelinks|protection\.outlook/i.test(u)) u = decodeURIComponent(w[1]);
    const m = u.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (m) refs.push({ id: m[1], gid: (u.match(/[#?&]gid=(\d+)/) || [])[1] || '' });
  });
  return refs;
}

function saveInputs() {
  chrome.storage.local.set({
    emailText: emailEl.value, idsText: idsEl.value, filesText: filesEl.value,
    capturedByName,
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// New request = fresh run: wipe every artifact of the previous one
// (persisted ids/files/URL map restore on panel open, so stale state
// survives reloads unless actively cleared).
function resetRun() {
  matched = null; matchedFor = ''; lastResults = null; lastExtras = [];
  idsEl.value = ''; filesEl.value = '';
  capturedByName = {}; queuedUrls.clear(); lastCapTab = null;
  $('matchResults').innerHTML = '';
  $('results').innerHTML = ''; $('counts').innerHTML = '';
  $('missingNote').innerHTML = '';
  $('outRow').classList.add('hidden');
  $('download').classList.add('hidden');
  $('showSheet').classList.add('hidden');
  $('replyArea').classList.add('hidden');
  $('capInfo').innerHTML = '';
  ourDlIds.clear();
  // Sheet/email dots keep their state (the sheet stays loaded across
  // requests); match/download dots reset with the data they described.
  ['sdMatch', 'sdDl', 'sdIngest'].forEach(id => setStage(id));
  $('ingestInfo').innerHTML = ''; $('ingestPreviewBox').innerHTML = '';
  saveInputs();
}

// ---------- Client playbook (clients.js) ----------

// Live customer-exceptions sheet: link-shared Google doc, fetched as xlsx
// with no auth at all. Refresh on panel open, every 15 min while open,
// and force at the start of Run - it's rarely edited, but when it is the
// update must reach the next ingest. Last fetch is cached in storage so
// a dead network still shows the previous snapshot.
const EXC_SHEET_ID = '1u4mgQQ6YfdiMMYMA6QcQHMASMv3trtassknq-Vh_kcw';
let excByClient = {};   // client id -> live exception note
let excFetchedAt = 0;

// Customer-name rows map onto clients by containment in either direction:
// "Horizon Media" covers every Horizon / <brand> child, "TubeMogul" sits
// inside "Adobe (TubeMogul)". The longest customer key wins on overlaps.
function mapExceptions(notes) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const custKeys = Object.keys(notes).map(k => ({ k, n: norm(k), note: notes[k] }))
    .filter(c => c.n);
  const out = {};
  CLIENTS.forEach(c => {
    const names = [norm(topName(c)), norm(c.name), norm(c.id)];
    const hits = custKeys.filter(cu => names.some(nm => nm && (cu.n.includes(nm) || nm.includes(cu.n))));
    if (hits.length) out[c.id] = hits.sort((a, b) => b.n.length - a.n.length)[0].note;
  });
  return out;
}

async function fetchExceptions(force) {
  if (!force && Date.now() - excFetchedAt < 15 * 60 * 1000) return;
  try {
    const r = await fetch(
      'https://docs.google.com/spreadsheets/d/' + EXC_SHEET_ID + '/export?format=xlsx',
      { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const wb = await readXlsx(await r.arrayBuffer(), '');
    const notes = {};
    wb.rows.forEach(row => {
      const cust = String(row[0] || '').trim(), note = String(row[1] || '').trim();
      if (cust && note && !/^customer$/i.test(cust)) notes[cust] = note;
    });
    excByClient = mapExceptions(notes);
    excFetchedAt = Date.now();
    chrome.storage.local.set({ excData: { ts: excFetchedAt, notes } });
    dbg('exceptions sheet', { customers: Object.keys(notes).length, matched: Object.keys(excByClient).length });
    renderClientNote();
  } catch (e) { dbg('exceptions fetch fail', { err: String(e) }); }
}
setInterval(() => fetchExceptions(false), 15 * 60 * 1000);

function renderClientNote() {
  const el = $('clientNote');
  if (!client) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const ing = ingestSummary(client);
  // The exceptions sheet is the authoritative caveat source - live text
  // wins over the static playbook note (which stays behind the ? bubble).
  const live = excByClient[client.id];
  const caveat = live
    ? live.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0]
    : (client.note || '').split(/\s+[–-]\s+|\.\s/)[0];
  // The extracted advertiser is only surfaced when the client's ingest spec
  // needs it as metadata, or on notify profiles where the brand is the only
  // identity we have for which agency is about to send a request.
  const showAdv = detectedAdvertiser &&
    ((client.ingest && client.ingest.advertiser) ||
     client.id === 'er-notify' || client.id === 'yangaroo-delivery');
  el.innerHTML = '<b>' + esc(client.name) + (client.inactive ? ' (inactive)' : '') + '</b> - ' +
    esc(caveat) +
    ((live || (client.note && caveat !== client.note)) ? ' <span class="ib" data-bubble="clientFull">?</span>' : '') +
    (showAdv ? '<br><b>Advertiser:</b> ' + esc(detectedAdvertiser) : '') +
    (client.er && client.er.sender
      ? '<br><b>ER sweep:</b> sender "' + esc(client.er.sender) + '"' +
        (client.er.days ? ' · ' + client.er.days + 'd' : '')
      : '') +
    (ing ? '<br><b>Ingest:</b> ' + esc(ing) : '') +
    (live || (client.note && caveat !== client.note)
      ? '<div class="bubble hidden" id="clientFull">' +
        (live ? '<b>Exceptions sheet (live):</b><br>' + esc(live).replace(/\r?\n/g, '<br>') +
                (client.note ? '<br><br><b>Playbook:</b> ' + esc(client.note) : '')
              : esc(client.note)) + '</div>'
      : '');
}

// Ingest file naming: only rename when the client's spec calls for the
// spot title, and only with spec'd fields - tracking ID + title. Identical
// fields collapse (InMarket: title IS the reporting ID). Sheets with no
// title column still rename to the tracking ID alone. ext keeps the
// delivered extension.
function nameForIngest(trackingId, title, deliveredName) {
  if (!client || !client.ingest || !client.ingest.nameTitle) return deliveredName;
  const ext = (String(deliveredName).match(/\.[a-z0-9]{2,5}$/i) || ['.mp4'])[0];
  return ingestFileName(trackingId, title, ext) || deliveredName;
}

// Ingest fields for the manifest + whether every file needs a ticker.
// The live exception text rides along so ingest_watch's report shows the
// rules in effect at download time.
function clientInfo() {
  return client ? { name: client.name, ...(client.ingest || {}), exceptions: excByClient[client.id] || '' } : null;
}
function tickerAlways() {
  return !!(client && client.ingest && client.ingest.ticker === 'always');
}

// via: 'sheet' | 'email'. Sheet-id detection outranks email inference, and
// either loses to a manual pick. Umbrella profiles (master trackers) are
// refinable: they prove the agency, then any later signal's brand keyword
// narrows to the "Agency / Brand" profile - whichever order grabs happen.
// Profiles collapse to agency-level dropdown options: "Agency / Brand"
// children and lane variants ("X (file arrival)") fold under their top
// name. The user picks the client, not the brand - the ingest-time client
// name is entered later anyway. Brand refine still happens internally so
// the right ingest spec applies.
function topName(c) { return c.name.split(' / ')[0].replace(/ *\(.*/, '').trim(); }

const agencyFamilies = {};
CLIENTS.filter(c => !c.inactive).forEach(c => (agencyFamilies[topName(c)] = agencyFamilies[topName(c)] || []).push(c));

// Representative profile for a family: umbrella beats exact-name beats
// "generic" beats non-parenthesized, else first member.
function repOf(fam) {
  return fam.find(c => c.umbrella) ||
         fam.find(c => c.name === topName(c)) ||
         fam.find(c => /generic/i.test(c.name + c.id)) ||
         fam.find(c => c.name.indexOf('(') < 0) ||
         fam[0];
}

// Dropdown value that represents a (possibly brand-level) profile.
function setSelFor(c) {
  const fam = agencyFamilies[topName(c)];
  if (fam) $('clientSel').value = repOf(fam).id;
}

// A client can keyword-refine to a brand sibling when its agency has
// "Agency / Brand" children (e.g. Warner -> WBD USN, Hearts & Science).
function refinable(c) {
  return c.umbrella ||
    CLIENTS.some(x => x !== c && x.name.indexOf(' / ') > 0 && topName(x) === topName(c));
}

// The playbook's ER recipe pre-fills the sweep controls (sender is a
// substring match against the detail page's "Trafficked By"). Only set
// for confirmed traffickers - a wrong preset would silently keep nothing.
// User edits survive until the next client (re)detection.
function applyErPreset(c) {
  if (!c || !c.er) return;
  if (c.er.sender) { $('erSender').value = c.er.sender; chrome.storage.local.set({ erSender: c.er.sender }); }
  if (c.er.days) { $('erDays').value = c.er.days; chrome.storage.local.set({ erDays: String(c.er.days) }); }
}

function applyClient(c, via) {
  if (!c) { renderClientNote(); return; }
  const agencyOf = x => x.name.split(' / ')[0].split(' ')[0];
  const refine = (base, cand) => {
    const agency = agencyOf(base);
    const hit = detectClient({ emailText: emailEl.value, subject: emailSubject });
    if (hit && !hit.umbrella && hit.name.indexOf(agency) === 0) return hit;
    if (cand && !cand.umbrella && cand.name.indexOf(agency) === 0) return cand;
    return base;
  };
  if (client && (clientSource === 'manual' ||
      (clientSource === 'sheet' && via !== 'sheet'))) {
    if (refinable(client)) {
      const r = refine(client, c);
      if (r !== client) { client = r; setSelFor(r); applyErPreset(r); }
    }
    renderClientNote(); return;
  }
  if (refinable(c)) c = refine(c, c);
  client = c;
  clientSource = via;
  setSelFor(c);
  applyErPreset(c);
  renderClientNote();
}

// ---------- Injected page functions (self-contained) ----------

// Inside docs.google.com: just LOCATE the open sheet + active tab. The
// export fetch happens in the extension context below - page-context fetch
// dies on the export URL's cross-origin redirect to googleusercontent.com
// ("TypeError: Failed to fetch"), while extension fetches are CORS-exempt
// via host_permissions and still send session cookies.
function grabSheetLoc() {
  const m = location.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return { error: 'The active tab is not a Google Sheet.' };
  const tab = document.querySelector('[role="tab"][aria-selected="true"], .docs-sheet-active-tab');
  // The name span is reliable; innerText on the tab itself can carry badge
  // junk like "9\nHorizon Next Tracker" that breaks workbook name-match.
  const nameEl = tab && tab.querySelector('.docs-sheet-tab-name');
  const raw = ((nameEl || tab) && (nameEl || tab).innerText || '').trim();
  // Bottom tab elements carry the web gid as sheet-button-<gid> - the
  // map back to tab names powers #gid= navigation for live highlights.
  const tabs = [...document.querySelectorAll('[id^="sheet-button-"]')].map(el => ({
    gid: el.id.replace('sheet-button-', ''),
    name: ((((el.querySelector('.docs-sheet-tab-name') || el).innerText) || '')
      .trim().split('\n').filter(Boolean).pop()) || '',
  })).filter(t => t.name);
  return {
    id: m[1],
    gid: (location.hash.match(/gid=(\d+)/) || [0, '0'])[1],
    tab: raw.split('\n').map(s => s.trim()).filter(Boolean).pop() || '',
    tabs,
  };
}

// Inside sharepoint.com: locate the workbook (sourcedoc GUID + site) -
// same reason as above, the REST download happens in extension context.
function grabSharePointLoc() {
  const sd = (location.search + location.href).match(/sourcedoc=(?:%7B|\{)?([0-9a-fA-F-]{36})/i);
  const site = location.pathname.match(/(\/sites\/[^/]+)/i) ||
               location.href.match(/sharepoint\.com\/(sites\/[^/:]+)/i);
  return {
    sourcedoc: sd ? sd[1] : '',
    site: site ? site[1] : '',
    origin: location.origin,
    pageUrl: location.href,
  };
}

// Inside Outlook on the web: pull the open conversation's text + subject.
// A thread renders one container per reply - querySelectorAll the union and
// drop containers nested inside a bigger one, so a request mid-thread is
// captured, not just the newest reply.
function grabEmailText() {
  let subject = '';
  const subjEl = document.querySelector(
    '[role="heading"], [aria-label*="subject" i], [class*="SubjectLine" i], [data-testid*="subject" i]'
  );
  if (subjEl) subject = (subjEl.innerText || subjEl.getAttribute('aria-label') || '').trim();

  const sels = [
    '[aria-label*="message body" i]', '[id*="UniqueMessageBody"]',
    '[id*="Item.Message"]', '.ReadingPaneContent', '[role="document"]',
  ];
  let containers = [];
  for (const s of sels) containers = containers.concat([...document.querySelectorAll(s)]);
  containers = containers.filter((el, i, arr) =>
    arr.indexOf(el) === i &&
    !arr.some(o => o !== el && o.contains(el)) &&
    (el.innerText || '').trim().length > 20);
  let text = containers.map(el => el.innerText).join('\n\n').trim();

  if (text.length <= 20) {
    let best = '';
    document.querySelectorAll('div').forEach(d => {
      const t = d.innerText || '';
      if (t.length > best.length && t.length < 80000) best = t;
    });
    text = best;
  }
  // Sender display name off the reading-pane header - best effort; the
  // reply greeting falls back to a bare "Hi," when it's unreadable.
  let sender = '';
  const sndEl = document.querySelector(
    '[aria-label*="sender" i], [data-testid*="sender" i], ' +
    '[class*="PersonaDetails" i] [class*="primaryText" i], ' +
    '[role="article"] [title*="@"]'
  );
  if (sndEl) sender = (sndEl.innerText || sndEl.getAttribute('title') || sndEl.getAttribute('aria-label') || '').trim();
  return { text: text.slice(0, 80000), subject, sender };
}

// Inside Outlook: Yangaroo "ADVERTISING DELIVERY" notifications carry a
// per-spot Download link - the email IS the delivery manifest. Pair each
// Download anchor with the Ad-ID/ISCI in its table row so files can be
// queued straight from the email, no portal scraping. Only anchors
// literally labelled "Download" are taken - never Confirm Delivery /
// Stream / Support, which have remote side effects.
function grabYangarooDelivery() {
  const CODE = '\\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\\d)[A-Z0-9]{7,14}\\b';
  const codeRe = new RegExp(CODE);
  const codeReG = new RegExp(CODE, 'g');
  const spots = [];
  const seen = new Set();
  document.querySelectorAll('a[href]').forEach(a => {
    if ((a.innerText || '').trim().toLowerCase() !== 'download') return;
    const row = a.closest('tr') || a.closest('li') || a.closest('td') || a.parentElement;
    const txt = row ? (row.innerText || '') : '';
    // If a row carries more than one Download link, pair them positionally.
    let idx = 0;
    if (row) {
      const dls = [...row.querySelectorAll('a[href]')]
        .filter(x => (x.innerText || '').trim().toLowerCase() === 'download');
      idx = Math.max(0, dls.indexOf(a));
    }
    const codes = [...txt.matchAll(codeReG)].map(m => m[0]);
    const code = codes[idx] || codes[0];
    if (!code) return;
    const rest = txt.slice(txt.indexOf(code) + code.length)
      .split('\n').map(s => s.trim()).filter(Boolean);
    const key = code + '|' + a.href;
    if (seen.has(key)) return;
    seen.add(key);
    spots.push({ id: code, title: rest[0] || '', url: a.href });
  });
  const body = (document.body && document.body.innerText) || '';
  const om = body.match(/Order Name:\s*([^\n]+)/i);
  const oi = body.match(/Order ID:\s*([^\n]+)/i);
  return { spots, orderName: om ? om[1].trim() : '', orderId: oi ? oi[1].trim() : '' };
}

// Inside app.extremereach.com Spot Deliveries: each row's download icon is
// a real /Delivery/Download/<guid> URL (the delivered master file - NOT the
// /Media/Download low-res proxy, and not Detail/Stream/QC links). Emit one
// entry per row keyed by "Ad-ID + title" so requested codes match while the
// list stays human-readable. Verified against a real saved delivery index.
function grabExtremeReach() {
  const CODE = /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{7,14}\b/;
  const files = [];
  document.querySelectorAll('tr').forEach(tr => {
    const dl = tr.querySelector('a[href*="/Delivery/Download/"]');
    if (!dl) return;
    const cells = [...tr.querySelectorAll('td')]
      .map(td => (td.innerText || '').replace(/\s+/g, ' ').trim());
    let code = '', ci = -1;
    for (let i = 0; i < cells.length; i++) {
      const m = cells[i].match(CODE);
      if (m) { code = m[0]; ci = i; break; }
    }
    const title = ci >= 0 && cells[ci + 1] ? cells[ci + 1] : '';
    const name = (code + (title ? ' ' + title : '')).trim();
    if (!name) return;
    files.push({ name, brand: cells[2] || '', line: cells.join(' '), url: dl.href });
  });
  return { files, hasMore: !!document.querySelector('a[title="Go to next page"]') };
}

// Inside a SharePoint document library (modern AllItems view): file rows
// render as heroField spans - no anchors - but the ?id= param is the
// folder's server-relative path, so a file's download URL is just
// folder + filename + ?download=1. Grid is virtualized: scroll + re-grab
// accumulates via the merge dedupe.
function grabSharePointDocs() {
  // heroField spans only - header cells carry title attrs too and would
  // leak "Modified"/"New" into the file list.
  const cells = [...document.querySelectorAll('[data-id="heroField"]')];
  if (!cells.length) return { files: [] };
  const folder = (location.href.match(/[?&]id=([^&]+)/) ||
                  location.href.match(/[?&]RootFolder=([^&]+)/i) || [])[1];
  // Fallback: strip /Forms/AllItems.aspx off the URL for the library root.
  const base = folder ? decodeURIComponent(folder).replace(/\/+$/, '')
    : (location.href.match(/(https?:\/\/[^/]+\/sites\/[^?]+?)\/Forms\//i) || [])[1];
  const files = cells.map(sp => {
    const name = (sp.getAttribute('title') || sp.textContent || '').trim();
    return {
      name, line: name,
      url: base ? location.origin + encodeURI(base) + '/' + encodeURIComponent(name) + '?download=1' : '',
    };
  }).filter(f => f.name);
  return { files, hasMore: true }; // virtualized - more rows may sit below the fold
}

// Inside any page: collect filename-like strings with their enclosing line
// (so the panel can pull dates off the same line), plus download links.
function grabFileNames() {
  const MEDIA_EXT = 'mp4|mov|mxf|mpg|mpeg|avi|wmv|flv|webm|mkv|ts|m2ts|mp3|wav|aac|aif|aiff|jpg|jpeg|png|gif|tif|tiff|pdf|zip|srt|vtt';
  const fileRe = new RegExp('[\\w\\-.()\\[\\]#&+ ]+\\.(?:' + MEDIA_EXT + ')\\b', 'i');
  const entries = new Map();

  const text = (document.body && document.body.innerText) || '';
  text.split(/\r?\n/).forEach(line => {
    const m = line.match(fileRe);
    if (m) {
      const name = m[0].trim();
      if (name.length > 3 && name.length < 300 && !entries.has(name)) {
        entries.set(name, { name, line: line.trim().slice(0, 500) });
      }
    }
  });

  document.querySelectorAll('a[href]').forEach(a => {
    try {
      const base = decodeURIComponent(a.href.split('?')[0].split('/').pop() || '');
      if (new RegExp('\\.(' + MEDIA_EXT + ')$', 'i').test(base) && base.length < 300 && !entries.has(base)) {
        entries.set(base, {
          name: base,
          line: (a.innerText || a.href).slice(0, 500),
          url: new URL(a.getAttribute('href'), location.href).href,
        });
      }
    } catch (e) { /* skip */ }
  });

  const rowRe = /\b(asset|creative|file|spot|deliver)/i;
  document.querySelectorAll('tr, li, [class*="asset"], [class*="file"], [class*="creative"]').forEach(el => {
    const cls = String((el.className && el.className.baseVal) || el.className || '') + ' ' + String(el.id || '');
    if (!rowRe.test(cls)) return;
    const t = (el.innerText || '').trim().split('\n')[0].trim();
    if (t && t.length > 4 && t.length < 200 && !/[<>{}]/.test(t) && !entries.has(t)) {
      entries.set(t, { name: t, line: t });
    }
  });

  return { files: Array.from(entries.values()) };
}

// Inside airtable.com: two jobs. Always read the column names off the DOM
// headers (Airtable's copy carries data rows WITHOUT headers - without
// them the TSV can't auto-map). When doCopy, also drive the grid's own
// select-all + copy - the app writes the ENTIRE view to the clipboard as
// TSV, the only complete extraction since the DOM holds ~20 virtualized
// rows. Chrome transfers user activation into injected scripts.
function airtableCopyAll(doCopy) {
  const headers = [...document.querySelectorAll('[data-tutorial-selector-id="gridHeaderCell"]')]
    .sort((a, b) => (+a.getAttribute('data-columnindex') || 0) - (+b.getAttribute('data-columnindex') || 0))
    .map(c => {
      const lab = (c.querySelector('.nameAndDescription') || c).getAttribute('aria-label') || '';
      const m = lab.match(/^(.+?) column header/);
      if (m) return m[1].trim();
      const n = c.querySelector('.name');
      return (n && n.textContent || '').trim();
    });
  let okCopy = false;
  if (doCopy) {
    const grid = document.querySelector('[data-testid="grid"], [role="grid"], .dataRows, .dataPane')
             || document.body;
    const cell = grid.querySelector('[data-testid^="gridCell"], .cell') || grid;
    // Select-all only works when a grid CELL owns focus - the manual flow
    // is click-inside-the-table then Cmd+A. Pointer events + real focus
    // first, then a keystroke carrying keyCode (React handlers read that,
    // which a plain KeyboardEvent doesn't set).
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(type => {
      cell.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });
    cell.click();
    if (cell.focus) cell.focus();
    const keyA = t => {
      const ev = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', metaKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { value: 65 });
      Object.defineProperty(ev, 'which', { value: 65 });
      t.dispatchEvent(ev);
    };
    keyA(cell);
    keyA(document.activeElement || cell);
    keyA(document);
    okCopy = document.execCommand('copy');
  }
  return { okCopy, headers,
    selected: document.querySelectorAll('[aria-selected="true"], .selected, [class*="cellSelected"]').length,
    focus: document.activeElement ? document.activeElement.tagName : '',
    domSel: String(window.getSelection ? window.getSelection() : '').length };
}

// ---------- Section 1: request email ----------

// Read the request email (+ Yangaroo delivery links) off an Outlook tab.
// Takes a Tab object so callers pick the source tab, not focus.
async function grabEmailFrom(tab) {
  let res;
  try {
    [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabEmailText });
  } catch (e) { dbg('email grab fail', { tab: tab.id, err: String(e) }); return false; }
  const text = (res.result && res.result.text || '').trim();
  if (!text) { setStage('sdEmail', 'fail', 'Outlook tab had no readable email'); return false; }
  let yr = {};
  try {
    const [yres] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabYangarooDelivery });
    yr = yres.result || {};
  } catch (e) { /* delivery-link scrape is optional */ }
  yangaroo = (yr.spots && yr.spots.length) ? yr : null;
  setEmailText(text, (res.result && res.result.subject) || '', (res.result && res.result.sender) || '');
  return true;
}

// Email intake shared by the Outlook grab, clipboard paste, and .eml load.
// Anything that arrives as plain text loses the delivery-page anchor
// scrape - callers null yangaroo themselves.
function setEmailText(text, subject, sender) {
  if (text !== emailEl.value) resetRun(); // new request = fresh run state
  emailEl.value = text;
  emailSubject = subject || '';
  // Reply greeting: explicit sender name wins (Outlook DOM / .eml From:),
  // else parse a leading From: line (Graph inbox / pasted headers).
  emailSender = sender || senderFirstName(text) || '';
  detectedAdvertiser = extractAdvertiser(emailSubject);
  applyClient(detectClient({ emailText: text, subject: emailSubject }), 'email');
  stamp('tsEmail');
  onEmailChange();
  saveInputs();
}

$('grabEmail').addEventListener('click', async () => {
  const cls = await stageTabs();
  const tab = pickTab(cls.outlook, ((await activeTab()) || {}).id);
  if (!tab) return toast('Open the request email in an Outlook web tab (or paste it).');
  if (!await grabEmailFrom(tab)) return toast('Could not read an email on that tab - paste the body instead.');
  toast('Email captured' + (yangaroo ? ' - Yangaroo delivery: ' + yangaroo.spots.length + ' spot(s) with download links' : '') + '.');
});

$('clearEmail').addEventListener('click', () => { emailEl.value = ''; onEmailChange(); saveInputs(); });

// One-click email intake without an Outlook tab: clipboard or a saved
// .eml file (Outlook desktop exports them; web users keep grab/paste).
$('pasteEmail').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) return toast('Clipboard is empty - copy the email body first.');
    yangaroo = null;
    setEmailText(text.trim(), '');
    toast('Email pasted.');
  } catch (e) { toast('Clipboard blocked - paste into the box directly.'); }
});
$('loadEmail').addEventListener('click', () => { loadTarget = 'email'; $('fileInput').click(); });
emailEl.addEventListener('dragover', e => e.preventDefault());
emailEl.addEventListener('drop', e => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  e.preventDefault();
  const r = new FileReader();
  r.onload = () => {
    const eml = /\.eml$/i.test(f.name) ? parseEml(r.result) : { subject: '', body: r.result };
    yangaroo = null;
    setEmailText(String(eml.body || '').trim(), eml.subject, senderFirstName(eml.from));
    toast('Loaded ' + f.name + '.');
  };
  r.readAsText(f);
});

// ---------- Graph inbox scan ----------
// "Check inbox" reads unread mail via the user's own app registration -
// no Outlook tab needed. Sign-in is device-code OAuth; the refresh token
// persists so it's one consent, then silent.
let inboxSeen = new Set(); // Graph message ids already surfaced

let msPkceCtx = null; // {verifier, redirect} while an interactive sign-in is open

// Primary: interactive auth-code + PKCE. Tenants that block the device-
// code flow via Conditional Access usually still allow a plain browser
// sign-in - and first-party public apps already carry localhost/
// nativeclient redirects, so no redirect registration is needed.
$('msSignIn').addEventListener('click', async () => {
  MS.clientId = $('msClientId').value.trim();
  MS.tenant = $('msTenant').value.trim() || 'organizations';
  if (!MS.clientId) return toast('Paste the app registration client ID first.');
  chrome.storage.local.set({ msClientId: MS.clientId, msTenant: MS.tenant });
  const msg = $('msMsg');
  // Graph PowerShell reliably registers http://localhost; other public
  // clients (Azure PowerShell, CLI, admin-made apps) carry nativeclient.
  const redirect = MS.clientId === '14d82eec-204b-4c2f-b7e8-296a70dab67e' ? MS_LOCALHOST : MS_NATIVECLIENT;
  try {
    const pk = await msPkce();
    msPkceCtx = { verifier: pk.verifier, redirect };
    window.open(msAuthorizeUrl(pk.challenge, redirect), '_blank');
    $('msCodeRow').classList.remove('hidden');
    msg.textContent = ' sign in on the page that opened, then paste the code (or full URL) below.';
  } catch (e) { msg.textContent = ' failed: ' + e.message; }
});

$('msCodeGo').addEventListener('click', async () => {
  const raw = $('msCode').value.trim();
  if (!raw || !msPkceCtx) return toast('Paste the code from the sign-in page.');
  const m = raw.match(/[?&]code=([^&\s]+)/);
  const code = m ? decodeURIComponent(m[1]) : raw;
  const msg = $('msMsg');
  try {
    await msExchangeCode(code, msPkceCtx.verifier, msPkceCtx.redirect);
    msPkceCtx = null;
    $('msCodeRow').classList.add('hidden');
    $('msSetup').style.display = 'none';
    checkInbox(false);
  } catch (e) { msg.textContent = ' exchange failed: ' + e.message; }
});

// The authorize page can reject one redirect form while accepting the
// other - flip and reopen.
$('msAltRedirect').addEventListener('click', async e => {
  e.preventDefault();
  if (!msPkceCtx) return toast('Hit Sign in first.');
  msPkceCtx.redirect = msPkceCtx.redirect === MS_LOCALHOST ? MS_NATIVECLIENT : MS_LOCALHOST;
  const pk = await msPkce();
  msPkceCtx.verifier = pk.verifier;
  window.open(msAuthorizeUrl(pk.challenge, msPkceCtx.redirect), '_blank');
});

// Device-code fallback: kept for admin-registered apps in tenants where
// the flow isn't policy-blocked.
$('msDevCode').addEventListener('click', async e => {
  e.preventDefault();
  const msg = $('msMsg');
  try {
    msg.textContent = ' requesting code…';
    const d = await msDeviceCode();
    msg.innerHTML = ' go to <a href="' + esc(d.verification_uri) + '" target="_blank">' +
      esc(d.verification_uri) + '</a> and enter <b>' + esc(d.user_code) + '</b>';
    window.open(d.verification_uri, '_blank');
    await msPollForToken(d.device_code, d.interval);
    msg.textContent = ' signed in.';
    $('msSetup').style.display = 'none';
    checkInbox(false);
  } catch (e2) {
    msg.textContent = ' device-code failed: ' + e2.message;
  }
});

$('checkInbox').addEventListener('click', () => checkInbox(false));

// No Entra app access? Microsoft's own Graph PowerShell client is a
// first-party public app that supports device-code sign-in and is often
// pre-consented where user app registration is locked down. If the
// tenant blocks user consent entirely it fails with
// admin_consent_required - which is itself the definitive answer.
$('msUsePsApp').addEventListener('click', e => {
  e.preventDefault();
  $('msClientId').value = '14d82eec-204b-4c2f-b7e8-296a70dab67e'; // Graph PowerShell
  if (!$('msTenant').value.trim()) $('msTenant').value = 'organizations';
  $('msMsg').textContent = ' using Microsoft\u2019s Graph PowerShell app - hit Sign in.';
});

async function checkInbox(quiet) {
  await msLoad();
  if (!MS.refreshToken) {
    if (!quiet) {
      const su = $('msSetup');
      su.classList.remove('hidden');
      su.style.display = 'block'; // .info is display:none in CSS
      toast('Sign in to read the inbox (one-time app registration, below).');
    }
    return;
  }
  let msgs;
  try { msgs = await graphUnread(25); }
  catch (e) {
    dbg('graph inbox fail', { err: String(e) });
    if (!quiet) toast('Inbox check failed: ' + e);
    return;
  }
  renderInbox(msgs || [], quiet);
}

// Unread mail scored by the same detectors the rest of the pipeline uses
// (extractCodes + delivery vocabulary). Each candidate gets a Load link.
function renderInbox(msgs, quiet) {
  const el = $('inboxList');
  const cands = [];
  msgs.forEach(m => {
    const body = stripHtml((m.body && m.body.content) || '');
    if (looksLikeRequest(m.subject, body)) cands.push({ m, body });
  });
  if (!cands.length) {
    el.style.display = 'none';
    if (!quiet) toast('No unread request-like emails.');
    return;
  }
  el.style.display = 'block';
  el.innerHTML = '<b>' + cands.length + ' unread request-like email(s):</b>' +
    cands.map((c, i) => {
      const from = (c.m.from && c.m.from.emailAddress && c.m.from.emailAddress.name) || '';
      const when = String(c.m.receivedDateTime || '').replace('T', ' ').slice(5, 16);
      return '<div><a href="#" data-ib="' + i + '"><b>load</b></a> ' +
        esc(c.m.subject || '(no subject)') + ' <i>' + esc(from) + ' · ' + esc(when) + '</i></div>';
    }).join('');
  el.querySelectorAll('a[data-ib]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    const c = cands[parseInt(a.dataset.ib, 10)];
    const from = c.m.from && c.m.from.emailAddress;
    yangaroo = null;
    setEmailText('From: ' + (from ? (from.name + ' <' + from.address + '>') : '') +
      '\nSubject: ' + (c.m.subject || '') + '\n\n' + c.body, c.m.subject || '');
    toast('Email loaded from inbox.');
  }));
  // Quiet background polls announce only genuinely new candidates.
  const fresh = cands.filter(c => !inboxSeen.has(c.m.id));
  inboxSeen = new Set(cands.map(c => c.m.id));
  if (quiet && fresh.length) toast(fresh.length + ' new request-like email(s) in inbox.');
}

// While the panel is open, poll quietly every 5 min so a fresh request
// surfaces without the user pressing anything.
setInterval(() => { if (MS.refreshToken) checkInbox(true); }, 5 * 60 * 1000);

$('copyLog').addEventListener('click', () => {
  const text = dbgLog.map(e => e.t + ' ' + e.msg + (e.data ? ' ' + JSON.stringify(e.data) : '')).join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Log copied.'));
});
$('clearLog').addEventListener('click', () => { dbgLog = []; chrome.storage.local.set({ dbgLog }); renderDbg(); flushLog(); });
emailEl.addEventListener('input', () => { stamp('tsEmail'); onEmailChange(); saveInputs(); });

function onEmailChange() {
  const text = emailEl.value;
  if (text.trim()) applyClient(detectClient({ emailText: text, subject: emailSubject }), 'email');
  // The request is the newest message only - older replies in a pasted
  // thread carry already-confirmed codes that must not re-extract.
  const req = latestSegment(text);
  const trimmed = req.length < text.length;
  const links = extractLinks(req);
  const dates = extractDates(req);
  const rowRefs = extractRowRefs(req);
  const newCount = extractNewCount(req);
  emailDates = new Set(dates);
  const info = $('emailInfo');
  if (!text.trim()) { info.style.display = 'none'; setStage('sdEmail'); return; }
  info.style.display = 'block';
  const bits = [];
  if (emailSubject) bits.push('subject: <i>' + esc(emailSubject) + '</i>');
  if (trimmed) bits.push('<i>thread trimmed - using newest message</i>');
  bits.push('<b>' + links.length + '</b> link(s)' + (links.length ? ' [' + links.map(l => esc(l.type)).join(', ') + ']' : ''));
  bits.push('<b>' + dates.length + '</b> date(s)' + (dates.length ? ': ' + dates.map(esc).join(', ') : ''));
  if (rowRefs.length) bits.push('<b>' + rowRefs.length + '</b> sheet row(s) referenced: ' + rowRefs.slice(0, 12).join(', ') + (rowRefs.length > 12 ? '…' : ''));
  if (newCount) bits.push('email says <b>' + newCount + '</b> new item(s)');
  if (yangaroo) bits.push('Yangaroo delivery: <b>' + yangaroo.spots.length + '</b> spot(s) with download links' + (yangaroo.orderId ? ' · order ' + esc(yangaroo.orderId) : ''));
  // Inline code lists (Tatari batch emails, Horizon ISCIs in prose) can
  // seed the requested-IDs box. Always surfaced so a miss is visible.
  const emailCodes = extractCodes(req);
  bits.push('<b>' + emailCodes.length + '</b> code(s)' + (emailCodes.length ? ': ' + emailCodes.slice(0, 15).map(esc).join(', ') + (emailCodes.length > 15 ? '…' : '') : ''));
  if (emailCodes.length >= 2) {
    bits.push('<a href="#" id="useEmailCodes">use codes as requested IDs</a>');
  }
  // Same-line code+title pairs (Chief Media) feed spot-title naming when
  // the sheet has no title column.
  emailPairs = extractCodeTitlePairs(req);
  if (emailPairs.length >= 2) bits.push(emailPairs.length + ' code+title pair(s) in email');
  // Column-per-line manifests (AMC): row#/title/code/link per spot - the
  // row numbers are tracker row refs, the links are per-spot shares.
  emailSpots = extractSpotBlocks(req);
  const nLinked = emailSpots.filter(s => s.url).length;
  if (emailSpots.length >= 2) {
    bits.push('<b>' + emailSpots.length + '</b> spot block(s) in email' +
      (emailSpots.some(s => s.row) ? ' · with sheet row refs' : '') +
      (nLinked ? ' · ' + nLinked + ' share link(s)' : ''));
  }
  info.innerHTML = bits.join(' · ');
  // Surface tracker/doc links as click-to-open shortcuts.
  const docLinks = links.filter(l => /google-drive|wrapped/.test(l.type)).slice(0, 4);
  if (docLinks.length) {
    info.innerHTML += '<br>' + docLinks.map(l =>
      '<a href="' + esc(l.url) + '" target="_blank">open ' + esc(l.type) + ' link</a>').join(' · ');
  }
  $('dateFilterHint').textContent = dates.length
    ? 'capture date filter: ' + dates.join(', ')
    : '';
  const uc = $('useEmailCodes');
  if (uc) uc.addEventListener('click', e => {
    e.preventDefault();
    idsEl.value = emailCodes.join('\n');
    saveInputs();
    toast(emailCodes.length + ' email code(s) set as requested IDs.');
  });
  // Green when the email carries something matchable; orange when it
  // loaded but nothing extractable came with it (probably the wrong
  // message - or an inbox view instead of an opened email).
  const nRefs = emailCodes.length + rowRefs.length + emailSpots.length +
    (yangaroo ? yangaroo.spots.length : 0);
  setStage('sdEmail', nRefs ? 'ok' : 'warn', nRefs
    ? emailCodes.length + ' code(s) · ' + rowRefs.length + ' row ref(s) · ' + links.length + ' link(s)'
    : 'loaded - no codes, links, or row refs found; is it the right message?');
}

// ---------- Section 2: tracking sheet ----------

const COLS = [
  { key: 'id',     el: 'colId',     guess: (h, rows, grp) => guessField(h, 'trackingId', rows, grp) },
  { key: 'title',  el: 'colTitle',  guess: (h, rows, grp) => guessField(h, 'spotTitle', rows, grp) },
  { key: 'file',   el: 'colFile',   guess: h => guessColumn(h, /file.?name/i) },
  { key: 'link',   el: 'colLink',   guess: h => guessColumn(h, /link|url|source|drive|extreme/i) },
  { key: 'access', el: 'colAccess', guess: h => guessColumn(h, /access|given|permission/i) },
  { key: 'brand',  el: 'colBrand',  guess: h => guessColumn(h, /^brand$|brand|advertiser|client|product|network/i) },
  { key: 'espn',   el: 'colEspn',   guess: h => guessColumn(h, /espn|ticker|version/i) },
  { key: 'date',   el: 'colDate',   guess: h => guessColumn(h, /ingest.*date|request.*date|date|flight|air|start/i) },
];

// Fetch a Google workbook by doc id - the export endpoint only needs the
// id, so an email-linked tracker loads with no sheet tab open at all.
// XLSX first (keeps hyperlinks + every tab); CSV fallback needs a gid.
async function loadSheetDoc(id, gid, tabName, sourceLabel) {
  sheetSourceTab = null; // cleared here; tab-grabs re-set it on success
  scoreCache = { key: '', scores: null }; // new workbook = new tab map
  try {
    const r = await fetch(
      `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
      { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    sheetBuf = await r.arrayBuffer();
    const wb = await readXlsx(sheetBuf, tabName || '', gid);
    sheetTabs = wb.sheetNames || [];
    sheetTabName = wb.sheetName;
    if (tabName && wb.sheetName !== tabName) {
      toast('Loaded tab "' + wb.sheetName + '" (you had "' + tabName + '" focused) - check you\'re on the right tab.');
      dbg('tab mismatch', { focused: tabName, gid, loaded: wb.sheetName });
    }
    loadSheetRows(wb, sourceLabel || ('tab "' + wb.sheetName + '"'));
    return true;
  } catch (e) {
    dbg('xlsx fetch fail', { id: id.slice(0, 12), err: String(e) });
  }
  try {
    const r2 = await fetch(
      `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid || '0'}`,
      { credentials: 'include' });
    if (!r2.ok) throw new Error('HTTP ' + r2.status);
    sheetBuf = null; sheetTabs = []; sheetTabName = '';
    loadSheetText(await r2.text(), 'Sheet tab gid=' + (gid || '0'));
    return true;
  } catch (e2) { toast('Could not export sheet: ' + e2); setStage('sdSheet', 'fail', 'sheet export failed (auth?)'); return false; }
}

// Load a tracker off an already-open tab (Google Sheet or SharePoint
// Excel). Takes a Tab object so the caller, not focus, picks the source.
async function grabSheetTab(tab) {
  const isSp = /\.sharepoint\.com|\.sharepoint-df\.com/i.test(tab.url || '');
  if (isSp) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabSharePointLoc });
    applyClient(detectClient({ sheetId: (res.result || {}).sourcedoc }), 'sheet');
    const loc = res.result || {};
    const cands = [];
    if (loc.sourcedoc && loc.site) {
      const base = loc.origin + (loc.site.startsWith('/') ? '' : '/') + loc.site;
      cands.push(base + "/_api/web/GetFileById(guid'" + loc.sourcedoc + "')/$value");
      cands.push(base + "/_api/web/GetFileById('" + loc.sourcedoc + "')/$value");
    }
    cands.push(loc.pageUrl + (loc.pageUrl.includes('?') ? '&' : '?') + 'download=1');
    for (const u of cands) {
      try {
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) continue;
        const ab = await r.arrayBuffer();
        const b = new Uint8Array(ab);
        if (b[0] === 0x50 && b[1] === 0x4b) { // 'PK' zip magic = real workbook
          const wb = await readXlsx(ab, '');
          sheetBuf = ab;
          sheetTabs = wb.sheetNames || [];
          sheetTabName = wb.sheetName;
          loadSheetRows(wb, 'SharePoint workbook');
          return true;
        }
      } catch (e) { /* try next candidate */ }
    }
    toast('Could not download the workbook. Use File > Save a Copy > Download, then load the .xlsx here.');
    setStage('sdSheet', 'fail', 'SharePoint workbook download failed');
    return false;
  }
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabSheetLoc });
  const loc = res.result || {};
  if (loc.error) { toast(loc.error); setStage('sdSheet', 'fail', String(loc.error).slice(0, 80)); return false; }
  applyClient(detectClient({ sheetId: loc.id }), 'sheet');
  sheetGids = {};
  (loc.tabs || []).forEach(t => { if (t.name) sheetGids[t.name] = t.gid; });
  const ok = await loadSheetDoc(loc.id, loc.gid, loc.tab);
  if (ok) sheetSourceTab = tab; // the open tab enables live highlight
  return ok;
}

// Airtable's copy carries data rows only - prepend the header names read
// off the tab's DOM so the TSV maps like a normal sheet. Guards: a paste
// that already leads with the same names isn't doubled, and a wildly
// different column count means it's a different table's data.
function withHeaders(text, headers) {
  if (!headers || !headers.length) return text;
  const first = (text.split('\n')[0] || '').split('\t').map(s => s.trim().toLowerCase());
  if (Math.abs(first.length - headers.length) > 3) return text;
  const have = headers.map(h => h.toLowerCase());
  const overlap = have.filter(h => first.includes(h)).length;
  if (overlap >= Math.min(2, have.length)) return text;
  return headers.join('\t') + '\n' + text;
}

// Does a pasted table's first row read like headers? Header rows name
// things; data rows carry code-shaped values.
function firstRowLooksLikeHeaders(text) {
  const first = (text.split('\n')[0] || '').trim();
  const cells = first.split('\t').length > 1 ? first.split('\t') : first.split(',');
  const headerish = /isci|ad.?id|tracking|title|brand|advertis|client|campaign|flight|link|url|file|date|status|length|version|market|network|agency|ingest/i;
  const hits = cells.filter(c => headerish.test(c.trim())).length;
  return hits >= 2 && !cells.some(c => isCodeLike(c.trim()));
}

// Column names off an open Airtable tab, for the manual-paste path when
// the clipboard lacks headers.
async function airtableHeadersFromTab() {
  const cls = await stageTabs();
  if (!cls.airtable.length) return [];
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: cls.airtable[0].id }, func: airtableCopyAll, args: [false] });
    return (res && res.result && res.result.headers) || [];
  } catch (e) { return []; }
}

// An open Airtable tracker: drive the grid's own select-all + copy, then
// pull the TSV back off the clipboard with its DOM headers prepended.
// Falls back to manual paste if the app swallows the synthetic events.
async function grabAirtableTab(tab) {
  let res;
  try {
    [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: airtableCopyAll, args: [true] });
  } catch (e) { dbg('airtable inject fail', { err: String(e) }); return false; }
  const r = (res && res.result) || {};
  dbg('airtable copy attempt', { okCopy: r.okCopy, headers: (r.headers || []).length, selected: r.selected, focus: r.focus, domSel: r.domSel });
  if (!r.okCopy) {
    toast('Airtable blocked the auto-copy - click the grid, Cmd+A, Cmd+C, then Paste tracker.');
    setStage('sdSheet', 'warn', 'Airtable needs a manual copy-paste');
    return false;
  }
  await new Promise(x => setTimeout(x, 600)); // the app writes the clipboard async
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !/\t/.test(text)) {
      dbg('airtable clipboard not TSV', { len: (text || '').length });
      toast('Airtable copy produced nothing - try Cmd+A, Cmd+C on the grid, then Paste tracker.');
      return false;
    }
    loadSheetText(withHeaders(text, r.headers), 'Airtable tracker');
    return true;
  } catch (e) {
    dbg('airtable clipboard read fail', { err: String(e) });
    toast('Clipboard read failed - copy the grid, then Paste tracker.');
    return false;
  }
}

// Route a tracker tab to its loader: Google/SharePoint fetch the workbook
// by URL; Airtable goes through the app's own copy handler.
function grabTrackerTab(tab) {
  return /airtable\.com/i.test(tab.url || '') ? grabAirtableTab(tab) : grabSheetTab(tab);
}

$('grabSheet').addEventListener('click', async () => {
  const cls = await stageTabs();
  const active = ((await activeTab()) || {}).id;
  const cands = cls.sheet.concat(cls.sharepoint, cls.airtable);
  // Open tracker tabs win - they ride the user's own session, no auth
  // guessing. The email-linked doc fetch is the last resort when no
  // tracker tab is open at all.
  const focused = cands.find(t => t.id === active);
  if (focused) { await grabTrackerTab(focused); return; }
  if (cands.length) { await grabTrackerTab(cands[0]); return; }
  const ref = emailSheetRefs()[0];
  if (ref) {
    applyClient(detectClient({ sheetId: ref.id }), 'sheet');
    if (await loadSheetDoc(ref.id, ref.gid, '', 'email-linked tracker')) return;
  }
  setStage('sdSheet', 'fail', 'no tracker found');
  toast('No tracker found - open the sheet tab or load a file.');
});

let loadTarget = null;
$('loadSheet').addEventListener('click', () => { loadTarget = 'sheet'; $('fileInput').click(); });
$('loadFiles').addEventListener('click', () => { loadTarget = 'files'; $('fileInput').click(); });

// Grid tools that virtualize (Airtable, Notion, Monday) can't be scraped -
// only ~20 viewport rows exist in the DOM at once. But select-all + copy
// on the grid copies EVERY row as TSV, headers included. One click here
// feeds the whole tracker through the normal TSV parser; a paste box is
// the fallback when clipboard access is denied.
$('pasteSheet').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim()) { await loadPastedSheet(text); return; }
    toast('Clipboard is empty - copy the tracker grid first.');
  } catch (e) {
    $('pasteRow').classList.remove('hidden');
    toast('Clipboard blocked - paste into the box below, then Load pasted.');
  }
});
$('pasteSheetLoad').addEventListener('click', async () => {
  if (!$('sheetPaste').value.trim()) return toast('Paste the tracker rows first.');
  await loadPastedSheet($('sheetPaste').value);
  $('pasteRow').classList.add('hidden');
});

// Pasted trackers from Airtable lack headers - borrow them off the open
// Airtable tab so column mapping can run unattended.
async function loadPastedSheet(text) {
  if (!firstRowLooksLikeHeaders(text)) {
    const headers = await airtableHeadersFromTab();
    if (headers.length) {
      text = withHeaders(text, headers);
      dbg('paste: airtable headers prepended', { headers: headers.length });
    } else {
      dbg('paste: headerless TSV, no airtable tab for names');
      toast('Paste has no header row and no Airtable tab is open to read names - columns may need a manual pick.');
    }
  }
  loadSheetText(text, 'pasted tracker');
}

// Start a fresh batch: clears the accumulated file list and captured URLs
// (grabs merge across pages, so a new job needs an explicit reset).
$('clearFiles').addEventListener('click', () => {
  filesEl.value = '';
  capturedByName = {};
  queuedUrls.clear();
  ourDlIds.clear();
  $('results').innerHTML = '';
  $('counts').innerHTML = '';
  $('missingNote').innerHTML = '';
  $('capInfo').innerHTML = '';
  $('outRow').classList.add('hidden');
  lastResults = null;
  setStage('sdDl');
  saveInputs();
});
$('fileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  if (loadTarget === 'email') {
    const r = new FileReader();
    r.onload = () => {
      const eml = /\.eml$/i.test(f.name) ? parseEml(r.result) : { subject: '', body: r.result };
      yangaroo = null;
      setEmailText(String(eml.body || '').trim(), eml.subject, senderFirstName(eml.from));
      toast('Loaded ' + f.name + '.');
    };
    r.readAsText(f);
    e.target.value = '';
    return;
  }
  if (/\.xlsx$/i.test(f.name) && loadTarget === 'sheet') {
    const r = new FileReader();
    r.onload = async () => {
      try {
        const wb = await readXlsx(r.result, '');
        sheetSourceTab = null; sheetGids = {};
        scoreCache = { key: '', scores: null };
        sheetBuf = r.result;
        sheetTabs = wb.sheetNames || [];
        sheetTabName = wb.sheetName;
        loadSheetRows(wb, f.name);
      } catch (err) { toast('Could not parse ' + f.name + ': ' + err); }
    };
    r.readAsArrayBuffer(f);
    e.target.value = '';
    return;
  }
  const r = new FileReader();
  r.onload = () => {
    if (loadTarget === 'sheet') loadSheetText(r.result, f.name);
    else { filesEl.value = r.result; saveInputs(); toast('Loaded ' + f.name); }
  };
  r.readAsText(f);
  e.target.value = '';
});

function loadSheetText(text, sourceLabel) {
  sheetBuf = null; sheetTabs = []; sheetTabName = '';
  sheetSourceTab = null; sheetGids = {};
  scoreCache = { key: '', scores: null };
  const p = parseInput(text);
  if (!p.rows.length) { setStage('sdSheet', 'fail', 'nothing parsed'); return toast('Nothing parsed from ' + sourceLabel); }
  if (!p.isTable) {
    setStage('sdSheet', 'fail', 'parsed as a list, not a table');
    toast(sourceLabel + ' looks like a plain list, not a table.');
    return;
  }
  loadSheetRows({ rows: p.rows, links: {}, sheetName: sourceLabel }, sourceLabel);
}

function loadSheetRows(wb, sourceLabel) {
  const hIdx = detectHeaderRow(wb.rows);
  const nLinks = wb.links ? Object.keys(wb.links).length : 0;
  sheet = { headers: wb.rows[hIdx] || [], allRows: wb.rows, links: wb.links || {}, dataRows: wb.rows.slice(hIdx + 1), groupRow: hIdx > 0 ? wb.rows[hIdx - 1] : null };
  $('headerRow').value = hIdx + 1;
  buildColumnDropdowns();
  // Pending queue: fill-back columns empty on a row = not yet ingested.
  // Skip fully-empty rows (xlsx exports pad to the used range - the USN
  // tracker ships 531k blank rows under 836 real ones). Matching itself
  // stays on unfiltered rows so absolute ROW refs still line up.
  const fbCols = fillBackColumns(sheet.headers, sheet.groupRow);
  const liveRows = sheet.dataRows.filter(r => r.some(c => {
    const v = String(c || '').trim();
    return v && !/^[_\-~.]+$/.test(v);  // '___' placeholder cells aren't data
  }));
  pendingRows = fbCols.length
    ? pendingRowIndices(liveRows, fbCols).map(i => liveRows[i])
    : [];
  sheetSource = sourceLabel;
  stamp('tsSheet');
  // Green when the ID column auto-mapped; orange when it needs a pick.
  // Tooltip says WHICH source loaded - the user asked to always know.
  const idcNow = parseInt($('colId').value, 10);
  setStage('sdSheet', idcNow < 0 ? 'warn' : 'ok',
    sourceLabel + ' · ' + liveRows.length + ' rows' + (idcNow < 0 ? ' · pick the ID column' : ''));
  dbg('sheet loaded', { rows: liveRows.length, headerRow: hIdx + 1, source: sourceLabel, links: nLinks, pending: pendingRows.length });
  $('sheetInfo').style.display = 'block';
  $('sheetInfo').innerHTML =
    esc(liveRows.length + ' data rows, ' + sheet.headers.length + ' columns from ' + sourceLabel +
    ' (header row ' + (hIdx + 1) + (nLinks ? ', ' + nLinks + ' hyperlinks' : '') +
    '). Verify the column dropdowns, then match.') +
    (pendingRows.length
      ? ' <a href="#" id="usePending"><b>' + pendingRows.length + '</b> pending row(s) (fill-back empty) - use as requested IDs</a>'
      : '');
  const up = $('usePending');
  if (up) up.addEventListener('click', e => {
    e.preventDefault();
    const idc = parseInt($('colId').value, 10);
    if (idc < 0) return toast('Pick the ID column first.');
    idsEl.value = pendingRows.map(r => String(r[idc] || '').trim()).filter(Boolean).join('\n');
    saveInputs();
    toast(pendingRows.length + ' pending row ID(s) set as requested IDs.');
  });
  toast('Sheet loaded.');
}

function buildColumnDropdowns() {
  COLS.forEach(c => {
    const sel = $(c.el);
    sel.innerHTML = '<option value="-1">(none)</option>';
    sheet.headers.forEach((h, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = h || '(col ' + (i + 1) + ')';
      sel.appendChild(o);
    });
    sel.value = c.guess(sheet.headers, sheet.dataRows, sheet.groupRow);
  });
  // One-line detected summary; the dropdowns stay tucked away unless the
  // ID column can't be guessed.
  const LABELS = { id: 'ID', title: 'Title', file: 'File', link: 'Link', brand: 'Brand', espn: 'ESPN', date: 'Date' };
  $('colSummary').textContent = 'Columns: ' + Object.keys(LABELS).map(k => {
    const i = parseInt($(COLS.find(c => c.key === k).el).value, 10);
    return LABELS[k] + '→' + (i >= 0 ? String(sheet.headers[i] || '?').trim().slice(0, 20) : 'none');
  }).join(' · ');
  $('colDetails').open = parseInt($('colId').value, 10) < 0;
}

function currentCols() {
  const c = {};
  COLS.forEach(x => (c[x.key] = parseInt($(x.el).value, 10)));
  return c;
}

// ---------- Section 3: match & download ----------

// The whole match step as a callable stage: returns true when `matched`
// is committed (results shown), 'guess' when it stopped at the confirm
// picker, false on failure (a toast already explains why).
async function doMatch() {
  if (!sheet) { toast('Load a tracking sheet first (step 2).'); setStage('sdMatch', 'warn', 'needs a tracking sheet'); return false; }
  if (!emailEl.value.trim()) { toast('Add the request email first (step 1).'); setStage('sdMatch', 'warn', 'needs the request email'); return false; }
  let cols = currentCols();
  if (cols.id < 0) { toast('Pick the ID column.'); setStage('sdMatch', 'warn', 'pick the ID column'); return false; }

  // Wrong-tab guard: score every workbook tab against the requested
  // codes BEFORE matching - a tab holding none of them produces only
  // guesswork that looks like matches. Best coverage wins; the open
  // sheet follows the switch so the flip is visible, not silent.
  const reqCodes = [...new Set(extractCodes(latestSegment(emailEl.value))
    .concat(idsEl.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean)))];
  const scores = await sheetTabScores(reqCodes);
  if (scores) {
    const cur = scores.find(s => s.name === sheetTabName) || { name: sheetTabName, hits: 0 };
    const best = [...scores].sort((a, b) => b.hits - a.hits)[0];
    if (best && best.hits > cur.hits) {
      await switchSheetTab(best.name,
        cur.hits + ' of ' + reqCodes.length + ' requested IDs were on "' + cur.name +
        '", ' + best.hits + ' are on "' + best.name + '"');
      cols = currentCols();
      if (cols.id < 0) { toast('Pick the ID column on the new tab.'); setStage('sdMatch', 'warn', 'pick the ID column'); return false; }
    } else if (reqCodes.length && best && best.hits === 0) {
      dbg('match guard: requested codes appear on no tab',
        { codes: reqCodes.length, tabs: scores.map(s => s.name) });
    }
  }

  const headerRow = Math.max(1, parseInt($('headerRow').value, 10) || 1);
  const dataRows = sheet.allRows.slice(headerRow);

  // AMC-style spot blocks carry bare sheet row numbers - feed them as row
  // refs (guarded: only numbers inside the sheet's actual row range).
  let matchText = latestSegment(emailEl.value);
  const spotRows = (emailSpots || []).map(s => s.row)
    .filter(n => n > headerRow && n <= sheet.allRows.length);
  if (spotRows.length) matchText += '\nrows ' + spotRows.join(', ');
  // Pending rows (fill-back empty) are the clue-match candidate pool for
  // vague emails that cite neither IDs nor rows.
  const pendingSet = new Set(pendingRows);
  const pendingIdx = pendingRows.length
    ? dataRows.map((r, i) => pendingSet.has(r) ? i : -1).filter(i => i >= 0)
    : null;
  // Clear any previous reconcile output - it belongs to the old run.
  lastResults = null;
  $('results').innerHTML = ''; $('counts').innerHTML = '';
  $('outRow').classList.add('hidden');
  let fresh = matchEmailToSheet(matchText, dataRows, cols, { headerRow, pendingIdx });
  // The newest-message segment may genuinely carry no refs (short cover
  // note quoting a long thread) - retry the full paste before guessing.
  const segTrimmed = matchText.length < emailEl.value.length;
  if (segTrimmed && !fresh.some(m => m.matchType !== 'GUESS')) {
    const retry = matchEmailToSheet(emailEl.value, dataRows, cols, { headerRow, pendingIdx });
    if (retry.some(m => m.matchType !== 'GUESS')) {
      fresh = retry;
      matchText = emailEl.value;
      dbg('match retry: explicit hits found in older thread text');
    }
  }
  if (!fresh.length) { setStage('sdMatch', 'fail', 'no rows matched'); toast('No sheet rows matched anything in that email.'); return false; }
  // Rows whose fill-back columns are already filled = previously ingested.
  // pendingIdx only exists when fill-back columns were identified.
  if (pendingIdx) {
    const pendingNums = new Set(pendingIdx.map(i => i + headerRow + 1));
    fresh.forEach(m => {
      if (m.matchType !== 'ROW (out of range)' && !pendingNums.has(m.row)) m.ingested = true;
    });
  }
  matchCols = cols;
  fresh.forEach(m => { m.tab = sheetTabName; }); // which workbook tab produced each row
  stamp('tsMatch');
  const byType = {};
  fresh.forEach(m => { byType[m.matchType] = (byType[m.matchType] || 0) + 1; });
  dbg('match', { rows: fresh.length, carried: (matched || []).length, ...byType, pendingPool: pendingIdx ? pendingIdx.length : 'n/a',
    emailCodes: extractCodes(matchText), rowRefs: extractRowRefs(matchText), trimmed: segTrimmed,
    req: matchText.slice(0, 1500),
    cols: { id: sheet.headers[cols.id], title: sheet.headers[cols.title], file: sheet.headers[cols.file],
      link: sheet.headers[cols.link], date: sheet.headers[cols.date] },
    ids: fresh.slice(0, 15).map(m => m.id || m.trackingId || '(row ' + m.row + ')') });

  // Guess-only result -> confirm before committing. The user picks which
  // pending rows the vague email actually meant.
  if (fresh.every(m => m.matchType === 'GUESS')) { setStage('sdMatch', 'warn', 'confirm the guessed rows below'); presentGuessPicker(fresh); return 'guess'; }
  matched = mergeMatches(fresh);
  presentMatches();
  return true;
}

// Requests can span trackers/tabs/views: batch A on sheet 1, batch B on
// sheet 2. A fresh match set merges into the accumulated one instead of
// replacing it - rows found on earlier sheets keep their data and are
// tagged offSheet ("relevant to this request, not on the current page").
// Only merges while the email is the one those rows were matched against;
// a new request resets via matchedFor.
function mergeMatches(fresh) {
  if (!matched || !matched.length || matchedFor !== emailEl.value) return fresh;
  const key = m => normalizeName(m.id || m.trackingId || ('row' + m.row)).replace(/[\s:_-]+/g, '');
  const freshKeys = new Set(fresh.map(key));
  const carried = matched.filter(m => !freshKeys.has(key(m)))
    .map(m => ({ ...m, offSheet: true }));
  return fresh.concat(carried);
}

$('match').addEventListener('click', () => { doMatch(); });

// Everything that runs once `matched` is final: link/spot joins, results
// table, requested-ID seeding, and the delivery-path pick.
function presentMatches() {
  matchedFor = emailEl.value;

  // Join inline spot blocks: titles fill blanks, share links show when the
  // sheet row has no link of its own.
  if (emailSpots && emailSpots.length) {
    const byId = {};
    emailSpots.forEach(s => { byId[normalizeName(s.id).replace(/ /g, '')] = s; });
    matched.forEach(m => {
      const s = byId[normalizeName(m.id).replace(/ /g, '')] ||
                byId[normalizeName(m.trackingId || '').replace(/ /g, '')];
      if (s) {
        if (!m.title && s.title) m.title = s.title;
        if (!m.link && s.url) m.link = s.url;
      }
    });
  }

  // Resolve hyperlinks the cell text didn't carry (CSV can't see them),
  // and convert Excel serial dates for display. offSheet rows came from
  // an earlier tracker - their row numbers don't exist on this sheet, so
  // a link lookup would pull the wrong row's URL.
  matched.forEach(m => {
    if (m.offSheet) return;
    if (!m.link && sheet.links) {
      const u = sheet.links[(m.row - 1) + ',' + matchCols.link];
      if (u) m.link = u;
    }
    if (m.date) m.date = serialToDate(m.date);
  });

  // Join Yangaroo delivery-email spots: a matched row whose code appears in
  // the delivery email can download straight from that link.
  if (yangaroo && yangaroo.spots) {
    const byId = {};
    yangaroo.spots.forEach(s => { byId[normalizeName(s.id).replace(/ /g, '')] = s; });
    matched.forEach(m => {
      const s = byId[normalizeName(m.id).replace(/ /g, '')] ||
                byId[normalizeName(m.trackingId || '').replace(/ /g, '')];
      if (s) m.yangarooUrl = s.url;
    });
  }

  // Already-ingested rows (fill-back columns filled) still match - flagged
  // red so a re-request is obvious rather than silently processed again.
  const rows = matched.map(m =>
    '<tr><td>' + m.row + '</td><td>' + esc(m.id || '(no id)') + '</td>' +
    '<td>' + esc(m.title) + '</td>' +
    '<td><span class="chip ' + m.matchType.split(' ')[0] + '">' + m.matchType + '</span>' +
      (sheetTabs.length > 1 ? '<div class="hint">' + esc(m.tab || sheetTabName) + '</div>' : '') +
      (m.matchType === 'GUESS' && (m.guessClues || []).length
        ? '<div class="hint">' + esc(m.guessClues.join(' · ')) + '</div>' : '') + '</td>' +
    '<td>' + (m.ingested ? '<span class="chip warn">INGESTED</span> ' : '') +
      (m.offSheet ? '<span class="chip" title="matched on an earlier sheet - still part of this request" style="background:#3a414d;color:#aab1bd">prev</span>' : '') +
      (m.espn ? '<span class="chip espn">ESPN</span>' : '') +
      (m.espnConflict ? ' <span class="chip warn" title="email and sheet disagree">ESPN?</span>' : '') +
      (m.access === false ? ' <span class="chip warn">NO ACCESS</span>' : '') + '</td>' +
    '<td>' + esc(m.date) + '</td>' +
    '<td>' + (m.link ? '<a href="' + esc(m.link) + '" target="_blank">link</a>'
      : m.yangarooUrl ? '<a href="' + esc(m.yangarooUrl) + '" target="_blank">yangaroo</a>'
      : m.linkText ? '<i title="not a URL">' + esc(m.linkText.slice(0, 30)) + '</i>' : '<i>none</i>') + '</td></tr>'
  ).join('');
  // Codes the email cited but no matched row carries: likely on another
  // tracker tab - surface them instead of silently dropping.
  const cited = extractCodes(latestSegment(emailEl.value));
  const missed = cited.filter(c => {
    const n = normalizeName(c).replace(/[\s:_-]+/g, '');
    return !matched.some(m =>
      normalizeName([m.id, m.trackingId, m.title, m.fileName, m.brand].join(' '))
        .replace(/[\s:_-]+/g, '').includes(n));
  });
  $('matchResults').innerHTML =
    (missed.length
      ? '<div class="hint" id="missedNote"><b>not found on this tab:</b> ' + esc(missed.join(', ')) +
        ' - loaded: ' + esc(sheetSource || '?') + ' · checking other tabs…</div>'
      : '') +
    '<table><thead><tr><th>Row</th><th>ID</th><th>Title</th><th>Match</th><th>ESPN/Access</th><th>Date</th><th>Link</th></tr></thead><tbody>' +
    rows + '</tbody></table>';
  if (missed.length) findCodeTabs(missed).then(tabHits => {
    const el = $('missedNote');
    if (!el || !tabHits.length) { if (el) el.innerHTML = el.innerHTML.replace(' · checking other tabs…', ''); return; }
    dbg('code found on other tab', tabHits);
    const byTab = {};
    tabHits.forEach(h => (byTab[h.tab] = byTab[h.tab] || []).push(h));
    el.innerHTML = '<b>not on this tab:</b> ' + esc(missed.join(', ')) + ' - found on ' +
      tabLinksHTML(byTab) + ' - click to switch &amp; match there.';
    wireTabLinks(el);
  });
  refreshReply();

  // Delivery path pick: real URLs -> inline download button in this step;
  // label-only/empty links (master-sheet convention) -> open step 4 where
  // the delivery page (ER Spot Deliveries) provides the file URLs.
  const nDl = matched.filter(m => /^https?:/i.test(m.link || '') || m.yangarooUrl).length;
  const dlBtn = $('download');
  if (nDl) {
    dlBtn.textContent = 'Download ' + nDl + ' linked';
    dlBtn.classList.remove('hidden');
    $('sec4').open = false;
  } else {
    dlBtn.classList.add('hidden');
    $('sec4').open = true;
  }
  // Live verification button: only when the workbook came off an open
  // Sheets tab whose gid we can navigate.
  $('showSheet').classList.toggle('hidden',
    !(sheetSourceTab && (sheetGids || {})[sheetTabName] && matched.length));

  // Feed the reconcile box + suggest a job folder name.
  idsEl.value = matched.map(m => m.id).filter(Boolean).join('\n');
  if (!$('jobLabel').value) {
    const d = extractDates(emailEl.value)[0] || new Date().toISOString().slice(0, 10);
    const slug = emailSubject
      ? emailSubject.replace(/^\[external\]\s*/i, '').replace(/^(re|fw|fwd):\s*/i, '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
      : '';
    $('jobLabel').value = d.replace(/-/g, '') + (slug ? '-' + slug : '');
  }
  const nLinks = matched.filter(m => m.link).length;
  const nEspn = matched.filter(m => m.espn).length;
  const nCarried = matched.filter(m => m.offSheet).length;
  const newCount = extractNewCount(emailEl.value);
  setStage('sdMatch', 'ok', matched.length + ' rows matched' +
    (missed.length ? ' · ' + missed.length + ' cited code(s) not on this tab' : '') +
    (nCarried ? ' · ' + nCarried + ' carried from earlier sheet(s)' : ''));
  toast(matched.length + ' rows matched (' + nLinks + ' with links, ' + nEspn + ' ESPN)' +
    (nCarried ? ', ' + nCarried + ' carried from earlier sheet(s)' : '') +
    (newCount && newCount !== matched.length ? ' — note: email said ' + newCount + ' new' : '') + '.');
}

// The email named no IDs or rows - show the pending-row guesses with the
// clues that produced them and let the user confirm which ones the vague
// request actually means. Committing runs the normal match pipeline.
// The xlsx export holds every tab of the workbook - when cited codes miss
// on the loaded tab, scan the rest and say exactly where they live.
// Per-tab hit counts for a code set - the wrong-tab guard. The xlsx
// export already holds every tab, so scoring is a local parse, not a
// fetch. Cached per code-set since accumulation re-runs the same list.
let scoreCache = { key: '', scores: null };
async function sheetTabScores(codes) {
  if (!sheetBuf || (sheetTabs || []).length < 2) return null;
  const needles = [...new Set(codes.map(c => normalizeName(c).replace(/[\s:_-]+/g, '')).filter(Boolean))];
  if (!needles.length) return null;
  if (scoreCache.key === needles.join(',') && scoreCache.scores) return scoreCache.scores;
  const scores = [];
  for (const name of sheetTabs) {
    try {
      const wb = await readXlsx(sheetBuf, name, '');
      const hay = normalizeName(wb.rows.map(r => r.join(' ')).join('\n')).replace(/[\s:_-]+/g, '');
      scores.push({ name, hits: needles.filter(n => hay.includes(n)).length });
    } catch (e) { /* skip unreadable tab */ }
  }
  scoreCache = { key: needles.join(','), scores };
  return scores;
}

// Point the loaded sheet at another workbook tab; the open Sheets tab
// follows when the DOM gave us its gid (sheet-button-<gid> elements).
async function switchSheetTab(name, reason) {
  if (name === sheetTabName) return;
  const wb = await readXlsx(sheetBuf, name, '');
  sheetTabName = name;
  loadSheetRows(wb, 'tab "' + name + '"');
  if (reason) toast('Switched to tab "' + name + '" - ' + reason + '.');
  const gid = (sheetGids || {})[name];
  if (sheetSourceTab && gid) {
    try { await chrome.tabs.update(sheetSourceTab.id, { url: sheetSourceTab.url.split('#')[0] + '#gid=' + gid }); }
    catch (e) { /* tab may be gone */ }
  }
}

// "on tab X" links that switch the loaded sheet and re-match.
function tabLinksHTML(byTab) {
  return Object.keys(byTab).map(t =>
    '<a href="#" data-tab="' + esc(t) + '"><b>"' + esc(t) + '" (' + byTab[t].length + ')</b></a>').join(' · ');
}
function wireTabLinks(el) {
  el.querySelectorAll('a[data-tab]').forEach(a => a.addEventListener('click', async e => {
    e.preventDefault();
    await switchSheetTab(a.dataset.tab, 'matching cited codes there');
    doMatch();
  }));
}

// Live verification: Sheets' #gid=&range= anchor switches the open tab
// to the matched tab AND outlines the matched rows natively.
async function showOnSheet() {
  if (!sheetSourceTab || !(matched || []).length) return false;
  const gid = (sheetGids || {})[sheetTabName];
  const rows = matched.filter(m => !m.offSheet && m.row > 0).map(m => m.row).sort((a, b) => a - b);
  if (!gid || !rows.length) return toast('The sheet tab isn\'t open - re-grab from it to highlight.');
  const lo = rows[0], hi = Math.min(rows[rows.length - 1], lo + 199);
  try {
    await chrome.tabs.update(sheetSourceTab.id, {
      url: sheetSourceTab.url.split('#')[0] + '#gid=' + gid + '&range=' + lo + ':' + hi,
      active: true });
  } catch (e) { toast('Sheet tab is gone - re-grab it.'); return false; }
  toast('Highlighting rows ' + lo + '-' + hi + ' on tab "' + sheetTabName + '".');
  return true;
}

async function findCodeTabs(codes) {
  const hits = [];
  if (!sheetBuf || !sheetTabs.length) return hits;
  const needles = codes.map(c => normalizeName(c).replace(/[\s:_-]+/g, ''));
  for (const name of sheetTabs) {
    if (name === sheetTabName) continue;
    try {
      const wb = await readXlsx(sheetBuf, name);
      wb.rows.forEach((r, i) => {
        const rowHay = normalizeName(r.join(' ')).replace(/[\s:_-]+/g, '');
        needles.forEach((n, k) => {
          if (n && rowHay.includes(n)) hits.push({ tab: name, code: codes[k], row: i + 1 });
        });
      });
    } catch (e) { /* skip unreadable tab */ }
  }
  return hits.slice(0, 20);
}

async function presentGuessPicker(cands) {
  // Extracted codes that matched no row mean this tab doesn't hold the
  // request - the tracker doc has multiple tabs; flag it loudly.
  const missingCodes = extractCodes(latestSegment(emailEl.value));
  const tabHits = missingCodes.length ? await findCodeTabs(missingCodes) : [];
  if (tabHits.length) dbg('code found on other tab', tabHits);
  const byTab = {};
  tabHits.forEach(h => (byTab[h.tab] = byTab[h.tab] || []).push(h));
  $('matchResults').innerHTML =
    (missingCodes.length
      ? '<div class="hint"><b>Code(s) ' + esc(missingCodes.join(', ')) + ' not found on this tab</b>' +
        (tabHits.length
          ? ' - they ARE on ' + tabLinksHTML(byTab) +
            ' - click to switch &amp; match there instead of guessing.'
          : ' - loaded: ' + esc(sheetSource || '?') + '. Check you\'re on the right tracker tab, or pick rows below:') + '</div>'
      : '<div class="hint"><b>Nothing explicit in the email</b> - best guesses among pending rows. Check the right ones:</div>') +
    '<table><thead><tr><th></th><th>Row</th><th>ID</th><th>Title</th><th>Clues</th><th>Date</th></tr></thead><tbody>' +
    cands.map((m, i) =>
      '<tr><td><input type="checkbox" class="guessChk" data-i="' + i + '"' + (m.guessScore > 0 ? ' checked' : '') + '></td>' +
      '<td>' + m.row + '</td><td>' + esc(m.id || '(no id)') + '</td><td>' + esc(m.title) + '</td>' +
      '<td class="hint">' + esc((m.guessClues || []).join(' · ')) + '</td><td>' + esc(m.date) + '</td></tr>'
    ).join('') +
    '</tbody></table>' +
    '<div class="row"><button id="useGuessed" class="primary">Use selected rows</button></div>';
  wireTabLinks($('matchResults'));
  $('useGuessed').addEventListener('click', () => {
    const keep = [...document.querySelectorAll('.guessChk')].filter(c => c.checked).map(c => +c.dataset.i);
    if (!keep.length) return toast('Check at least one row.');
    matched = mergeMatches(keep.map(i => cands[i]));
    dbg('guess committed', { picked: keep.length });
    presentMatches();
  });
}

$('showSheet').addEventListener('click', showOnSheet);

// ---------- Section 1 reply drafts ----------

// The reply preview + self-check: the best available draft (reconcile
// confirmation when results exist, else the match confirmation) and a
// line proving every ID the email cited is claimed in it - the user
// verifies the draft before it ever gets pasted.
function refreshReply() {
  const area = $('replyArea');
  let text = null;
  if (lastResults) {
    const espnIds = new Set();
    (matched || []).forEach(m => {
      if (!m.espn) return;
      [m.id, m.trackingId].filter(Boolean).forEach(v =>
        espnIds.add(normalizeName(v).replace(/ /g, '')));
    });
    text = buildReconConfirmation(lastResults, lastExtras, espnIds, emailSender) ||
      buildConfirmationEmail(lastResults, emailSender);
  }
  if (!text && matched) text = buildMatchConfirmation(matched, emailSender);
  if (!text) { area.classList.add('hidden'); return; }
  area.classList.remove('hidden');
  $('replyPreview').textContent = text;
  const wanted = [...new Set(extractCodes(latestSegment(emailEl.value)))];
  const body = normalizeName(text).replace(/ /g, '');
  const missing = wanted.filter(c => !body.includes(normalizeName(c).replace(/ /g, '')));
  $('replyCheck').innerHTML =
    (emailSender ? 'greeting: "Hi ' + esc(emailSender) + ',"' : 'greeting: "Hi," (sender unknown)') +
    ' · ' + (wanted.length
      ? (missing.length
        ? '<span style="color:#ec9a9a">' + missing.length + ' requested ID(s) NOT in reply: ' + missing.map(esc).join(', ') + '</span>'
        : 'all ' + wanted.length + ' requested ID(s) in reply')
      : 'no IDs cited in email');
}

$('copyReply').addEventListener('click', () => {
  const t = $('replyPreview').textContent;
  if (t) copyText(t, 'Reply');
});
$('copyExcReply').addEventListener('click', () => {
  const t = lastResults && buildExceptionEmail(lastResults, emailSender);
  if (t) copyText(t, 'Exception reply');
  else toast('Nothing to report - no missing or ambiguous results.');
});

// List a Drive folder's files via the embedded-folder HTML view.
// Works for "anyone with link" folders without auth; the browser session
// covers restricted folders you can already open.
async function fetchDriveListing(folderId) {
  const url = 'https://drive.google.com/embeddedfolderview?id=' + folderId + '#list';
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const files = [];
  doc.querySelectorAll('.flip-entry').forEach(el => {
    const a = el.querySelector('a.flip-entry-title');
    const id = (el.id || '').replace('entry-', '');
    if (a && id) files.push({ id, name: (a.textContent || '').trim() });
  });
  return files;
}

// MediaSilo QuickLinks (ql.mediasilo.com/ql/<id>) are viewer pages, not
// files - downloading them yields the app's HTML shell. The site's own
// public proxy resolves the link to assets carrying signed source URLs.
// The n1 cookie is the request nonce: fetch the root to prime it, then
// echo it as a header the way the site's own bundle does.
async function resolveQuickLink(url) {
  const id = (url.match(/ql\.mediasilo\.com\/ql\/([0-9a-f]+)/i) || [])[1];
  if (!id) return { error: 'unrecognized link' };
  try {
    await fetch('https://ql.mediasilo.com/', { credentials: 'include' });
    let headers = {};
    try {
      const ck = await chrome.cookies.get({ url: 'https://ql.mediasilo.com/', name: 'n1' });
      if (ck && ck.value) headers.n1 = ck.value;
    } catch (e) { /* cookie carry alone may satisfy the nonce */ }
    const r = await fetch('https://ql.mediasilo.com/proxy/quicklinks/' + id + '/assets', { credentials: 'include', headers });
    if (!r.ok) return { error: 'HTTP ' + r.status + ' - link expired or revoked' };
    const assets = await r.json();
    const list = (Array.isArray(assets) ? assets : assets.items || assets.assets || [])
      .map(a => ({ name: a.fileName || a.name || a.title || '',
                   url: (a.source && a.source.url) || a.downloadUrl || a.url || '' }))
      .filter(a => /^https?:/i.test(a.url));
    if (!list.length) return { error: 'no downloadable asset on link' };
    return { assets: list };
  } catch (e) { return { error: String(e) }; }
}

// Pick the asset whose filename best matches the row's expected name/title.
function pickQuickLinkAsset(assets, m) {
  const want = [m.fileName, m.title, m.trackingId, m.id].filter(Boolean)
    .map(s => normalizeName(s).replace(/[^a-z0-9]/g, ''));
  for (const a of assets) {
    const have = normalizeName(a.name).replace(/[^a-z0-9]/g, '');
    if (want.some(w => w && (have.indexOf(w) >= 0 || w.indexOf(have) >= 0))) return a;
  }
  return assets[0];
}

// Rewrite share links into direct-download URLs where the pattern is known.
function directUrl(url) {
  // Google Drive single-file view links -> the same uc export form folders
  // use. Folder links are resolved file-by-file upstream (driveFolderId).
  const df = String(url || '').match(/drive\.google\.com\/file\/d\/([\w-]+)/i);
  if (df) return driveDownloadUrl(df[1]);
  if (/dropbox\.com/i.test(url)) {
    if (/[?&]dl=0/.test(url)) return url.replace(/dl=0/, 'dl=1');
    if (!/[?&]dl=1/.test(url)) return url + (url.includes('?') ? '&' : '?') + 'dl=1';
  }
  // SharePoint/OneDrive links open the viewer (an HTML page) - download=1
  // forces the binary stream, same as Dropbox's dl=1. Works on :v: share
  // links and /sites/... file paths; folder links are flagged, not queued.
  if (/\.sharepoint(-df)?\.com|1drv\.ms|onedrive\.live\.com/i.test(url) && !/[?&]download=1/i.test(url)) {
    return url + (url.includes('?') ? '&' : '?') + 'download=1';
  }
  return url;
}

// What a link cell actually points at. Folder views and viewer-only
// platforms can't become a binary by URL rewriting - flagging them with a
// real instruction beats downloading an HTML page onto disk.
function linkShape(url) {
  const u = String(url || '');
  if (driveFolderId(u)) return 'drive-folder';
  if (/\.sharepoint(-df)?\.com/i.test(u) && (/\/:f:\/s\//i.test(u) || /AllItems\.aspx|\/Forms\//i.test(u)))
    return 'sp-folder';
  if (/wetransfer\.com|\bwe\.tl\b|hightail\.com|frame\.io|\bf\.io\b|aspera|signiant|app\.box\.com|box\.com\/s\//i.test(u))
    return 'viewer';
  return 'file';
}

// Direct-download path for matched rows carrying real URLs (Drive folder,
// MediaSilo, Yangaroo, plain links). Queues files + manifest.
async function downloadLinked() {
  if (!matched || !matched.length) { toast('Run the match first.'); return false; }
  warnStale();
  const job = ($('jobLabel').value || 'job').replace(/[^\w.-]+/g, '-');
  const withLinks = matched.filter(m => m.link || m.yangarooUrl);
  if (!withLinks.length) {
    if (client && client.delivery !== 'links') {
      toast('No sheet links - expected for ' + client.name + '. ' + client.note);
    } else {
      toast('No links in the matched rows - is the Link column set?');
    }
    return false;
  }

  // Resolve Drive folder links -> the single matching file in each folder.
  const folderIds = [...new Set(withLinks.map(m => driveFolderId(m.link)).filter(Boolean))];
  const listings = {};
  if (folderIds.length) {
    toast('Listing ' + folderIds.length + ' Drive folder(s)…');
    for (const fid of folderIds) {
      try { listings[fid] = await fetchDriveListing(fid); }
      catch (e) { listings[fid] = { error: String(e) }; }
    }
  }

  // Resolve MediaSilo QuickLinks -> signed asset URLs (deduped per link).
  const qlLinks = [...new Set(withLinks.map(m => m.link)
    .filter(l => /ql\.mediasilo\.com\/ql\//i.test(l || '')))];
  const qlRes = {};
  if (qlLinks.length) {
    toast('Resolving ' + qlLinks.length + ' MediaSilo QuickLink(s)…');
    for (const l of qlLinks) qlRes[l] = await resolveQuickLink(l);
  }

  const jobs = [];
  const problems = [];
  for (const m of withLinks) {
    const base = { row: m.row, tracking_id: m.trackingId || m.id, title: m.title || '', expected_name: m.fileName || '', needs_espn: m.espn || tickerAlways() };
    // Yangaroo delivery link: no filename in the URL, so name by ID. The
    // real container may differ - ffmpeg probes content, not extension.
    if (m.yangarooUrl) {
      const yname = (base.tracking_id || 'spot').replace(/[^\w.-]+/g, '_') + '.mp4';
      jobs.push({ ...base, file: nameForIngest(base.tracking_id, base.title, yname), url: m.yangarooUrl });
      continue;
    }
    if (/ql\.mediasilo\.com\/ql\//i.test(m.link || '')) {
      const r = qlRes[m.link];
      if (!r || r.error) {
        problems.push('row ' + m.row + ' (' + (m.trackingId || m.id) + '): MediaSilo QuickLink dead - ' + (r && r.error || 'resolve failed') + ' - ask the sender to re-share');
        continue;
      }
      const pick = pickQuickLinkAsset(r.assets, m);
      jobs.push({ ...base, file: nameForIngest(base.tracking_id, base.title, pick.name), url: pick.url });
      continue;
    }
    const fid = driveFolderId(m.link);
    if (fid) {
      const listing = listings[fid];
      if (listing.error) { problems.push('row ' + m.row + ': folder listing failed - ' + listing.error); continue; }
      const pick = pickRowFile(m, listing);
      if (pick.status === 'ok') {
        m.resolvedFile = pick.file.name;
        jobs.push({ ...base, file: nameForIngest(base.tracking_id, base.title, pick.file.name), url: driveDownloadUrl(pick.file.id) });
      } else {
        problems.push('row ' + m.row + ' (' + (m.trackingId || m.id) + '): ' +
          (pick.status === 'ambiguous' ? 'multiple folder files match' : 'no matching file in folder'));
      }
    } else if (!/^https?:/i.test(m.link || '')) {
      // Display-text link cells ("Yangaroo", "Files provided to Inscape via
      // Extreme Reach") export only their label from Google Sheets - the
      // real URL lives behind the cell. Not downloadable; direct the user
      // to the delivery email/page instead of queueing a bogus URL.
      problems.push('row ' + m.row + ' (' + (m.trackingId || m.id) + '): link cell is label text "' +
        String(m.link).slice(0, 60) + '" - re-grab via the live Google Sheet (xlsx keeps embedded URLs) or the delivery email/page');
    } else {
      const shape = linkShape(m.link);
      if (shape === 'sp-folder') {
        problems.push('row ' + m.row + ' (' + (m.trackingId || m.id) + '): SharePoint folder link - open the folder, copy the file link (or download the folder manually)');
      } else if (shape === 'viewer') {
        problems.push('row ' + m.row + ' (' + (m.trackingId || m.id) + '): link is a ' +
          (m.link.match(/wetransfer|\bwe\.tl\b/i) ? 'WeTransfer' : m.link.match(/frame\.io|\bf\.io\b/i) ? 'Frame.io' :
           m.link.match(/hightail/i) ? 'Hightail' : m.link.match(/box\.com/i) ? 'Box' : 'viewer') +
          ' page - open it and download there (these links often expire)');
      } else {
        jobs.push({ ...base, file: nameForIngest(base.tracking_id, base.title, downloadName(m)), url: directUrl(m.link) });
      }
    }
  }

  if (!jobs.length) {
    toast('Nothing to download - ' + problems.length + ' problem row(s): ' + (problems[0] || 'no resolvable links'));
    $('matchResults').innerHTML += problems.map(p => '<div class="hint">' + esc(p) + '</div>').join('');
    setStage('sdDl', 'warn', problems.length + ' row(s) had unresolvable links');
    return false;
  }
  dbg('linked download queued', { files: jobs.map(j => j.file), problems: problems.length });
  flushLog(true);

  dlTotal = jobs.length; dlDone = 0; dlFailed = 0; htmlRejects = [];
  updateDlStatus();
  for (const j of jobs) {
    try {
      const id = await chrome.downloads.download({
        url: j.url,
        filename: 'Ingest/' + job + '/' + j.file,
        conflictAction: 'uniquify',
      });
      if (id != null) ourDlIds.add(id);
    } catch (e) { dlFailed++; updateDlStatus(); }
  }
  const blob = new Blob([buildManifest(job, jobs, clientInfo())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: 'Ingest/' + job + '/manifest.json' });
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setStage('sdDl', 'ok', jobs.length + ' file(s) queued to Ingest/' + job);
  toast('Queued ' + jobs.length + ' download(s) + manifest to ~/Downloads/Ingest/' + job + '/' +
    (problems.length ? ' — ' + problems.length + ' row(s) skipped' : ''));
  if (problems.length) {
    $('matchResults').innerHTML += problems.map(p => '<div class="hint">' + esc(p) + '</div>').join('');
  }
  return true;
}

$('download').addEventListener('click', downloadLinked);

function updateDlStatus() {
  const d = $('dateFilterHint');
  if (dlTotal) d.textContent = 'Downloads: ' + dlDone + '/' + dlTotal + ' complete' + (dlFailed ? ', ' + dlFailed + ' failed' : '');
}

// Downloads that came back as HTML (auth walls, SharePoint viewer wrappers,
// expired links) are deleted off disk and counted as failures - a .html file
// is never a successfully delivered asset.
let htmlRejects = [];
chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.state || !ourDlIds.has(delta.id)) return;
  if (delta.state.current === 'complete') {
    const [item] = await chrome.downloads.search({ id: delta.id });
    ourDlIds.delete(delta.id);
    const fname = (item && item.filename || '').toLowerCase();
    const mime = (item && item.mime || '').toLowerCase();
    if (/\.html?$/.test(fname) || /text\/html|application\/xhtml/.test(mime)) {
      try { await chrome.downloads.removeFile(delta.id); } catch (e) {}
      chrome.downloads.erase({ id: delta.id });
      dlFailed++;
      htmlRejects.push(fname.split('/').pop() || 'file');
      $('missingNote').innerHTML = 'rejected HTML download(s): ' +
        htmlRejects.map(esc).join(', ') +
        ' — link likely leads to a viewer/auth page, not media';
      dbg('html download rejected', { file: fname.split('/').pop(), mime });
    } else dlDone++;
  } else if (delta.state.current === 'interrupted') { ourDlIds.delete(delta.id); dlFailed++; }
  updateDlStatus();
});

// ---------- Section 4: verify files on share ----------

// Merge capture entries into the files box + URL map. Dedupes by name;
// fresh URLs always donate to already-held names so a re-grabbed page
// refreshes links a stale entry never had.
function mergeCaptured(entries) {
  const existing = filesEl.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const seen = new Set(existing);
  let linked = 0;
  const newNames = [];
  entries.forEach(e => {
    if (e.url) { if (!capturedByName[e.name]) linked++; capturedByName[e.name] = e; }
    if (!seen.has(e.name)) { seen.add(e.name); newNames.push(e.name); }
  });
  filesEl.value = existing.concat(newNames).join('\n');
  saveInputs();
  return { newNames, linked, total: seen.size };
}

// Grab the file list off a page (ER adapter or generic scraper) and merge
// into the files box. Takes a Tab so callers choose the source; no arg
// means the focused tab. Returns true when anything was captured.
async function capturePage(tab) {
  tab = tab || await activeTab();
  if (!tab || !/^https?:/.test(tab.url || '')) { toast('Focus a normal web page first.'); return false; }
  lastCapTab = tab;
  const isSpLib = /sharepoint/i.test(tab.url || '') && /AllItems\.aspx|\/Forms\//i.test(tab.url || '');
  const func = /extremereach\.com/i.test(tab.url || '') ? grabExtremeReach : isSpLib ? grabSharePointDocs : grabFileNames;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func });
    const result = res.result || {};
    let entries = result.files || [];
    if (!entries.length) { toast('No filename-like text found. Try selecting the list manually.'); return false; }
    // Captures MERGE into the list (deduped by name) - delivery pages like
    // Extreme Reach paginate, so each page grab adds to the batch rather than
    // replacing it.
    entries.forEach(e => (e.date = extractDates(e.line)[0] || null));
    let { kept, dropped } = filterByDates(entries, emailDates);
    // Advisory filter: if it would drop EVERYTHING, the email's dates are
    // a week-style range the row dates can't match - keep all and say so.
    let filterBypassed = false;
    if (!kept.length && dropped.length) { kept = entries; dropped = []; filterBypassed = true; }
    const { newNames, linked, total } = mergeCaptured(kept);
    dbg('capture', { page: /extremereach\.com/i.test(tab.url || '') ? 'extremereach' : isSpLib ? 'sharepoint-lib' : 'generic', kept: newNames.length, linked, total, hasMore: !!result.hasMore,
      urlsHeld: Object.keys(capturedByName).length,
      sample: newNames.slice(0, 5) });
    stamp('tsCapture');
    // Names held but still no URLs anywhere: the list is stale and nothing
    // on this page refreshed it - reconciling can match names but
    // downloads can never resolve.
    if (!newNames.length && !linked && total && !Object.keys(capturedByName).length) {
      $('capInfo').innerHTML = '<i>list holds ' + total + ' stale names with no links - press Clear (Manual lists) and re-grab this page</i>';
      toast(total + ' stale file names held, no links - Clear the list and grab again.');
      return true;
    }
    const host = (tab.url || '').replace(/^https?:\/\//, '').split('/')[0];
    $('capInfo').innerHTML = 'last grab: <b>' + esc(host) + '</b> · ' + total + ' rows held · ' + linked + ' with links · ' +
      new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
      (result.hasMore ? ' · <i>more pages on site</i>' : '');
    toast('Captured ' + newNames.length + ' new (' + total + ' total' + (linked ? ', ' + linked + ' links' : '') + ')' +
      (dropped.length ? ', ' + dropped.length + ' date-filtered' : '') +
      (filterBypassed ? ' - date filter bypassed (email dates unmatched)' : '') +
      (result.hasMore ? ' - MORE PAGES: set 100 records/page or flip to the next page and grab again' : '') + '.');
    return kept.length > 0 || total > 0;
  } catch (e) {
    dbg('capture fail', { err: String(e), page: (tab && tab.url || '').slice(0, 120) });
    toast('Cannot read this page. Select the list manually instead.');
    return false;
  }
}

// Capture across every plausible source tab at once: the focused page
// plus all open ER tabs. Entries merge + dedupe by name, so scanning
// several Spot Deliveries pages in one press just works.
async function captureTabs() {
  const cls = await stageTabs();
  const active = await activeTab();
  const cands = [];
  if (active && /^https?:/.test(active.url || '')) cands.push(active);
  cls.er.forEach(t => { if (!cands.some(c => c.id === t.id)) cands.push(t); });
  // SharePoint doc-library views are file sources (not tracker workbooks).
  cls.sharepoint.filter(t => /AllItems\.aspx|\/Forms\//i.test(t.url || ''))
    .forEach(t => { if (!cands.some(c => c.id === t.id)) cands.push(t); });
  if (!cands.length) { toast('Focus a web page (or open a delivery list) first.'); return false; }
  let got = false;
  for (const t of cands) got = (await capturePage(t)) || got;
  return got;
}

$('grabFiles').addEventListener('click', captureTabs);

// Short moniker for a file/ID in dense UI: the code-like token if there
// is one, else the basename sans extension, clipped.
function moniker(name) {
  const m = String(name || '').match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{7,14}\b/);
  if (m) return m[0];
  const base = String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  return base.length > 18 ? base.slice(0, 18) + '…' : base;
}

function runReconcile() {
  const ids = idsEl.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const files = filesEl.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!ids.length) { toast('No tracking IDs entered.'); return false; }
  if (!files.length) { toast('No file names entered.'); return false; }

  const { results, fileCount, extras } = reconcile(ids, files);

  // ER priority: ISCI/tracking-ID first. When a code misses entirely,
  // retry by the sheet row's title - delivery pages sometimes rename
  // files. Title hits cap at POSSIBLE since titles drift.
  const titleFor = {};
  (matched || []).forEach(m => {
    const k = String(m.id || m.trackingId || '').trim();
    if (k && m.title) titleFor[k] = m.title;
  });
  let titleHits = 0;
  results.forEach(r => {
    if (r.status !== 'MISSING' || !titleFor[r.id]) return;
    const sub = reconcile([titleFor[r.id]], files).results[0];
    if (sub.status === 'FOUND' || sub.status === 'POSSIBLE MATCH') {
      r.status = 'POSSIBLE MATCH';
      r.matched = sub.matched;
      r.notes = 'No code match - title hit, verify';
      titleHits++;
    }
  });

  const counts = {};
  results.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  lastResults = results;
  lastExtras = extras || [];
  dbg('reconcile', { ids: ids.length, files: files.length, ...counts, titleHits,
    found: results.filter(r => r.status === 'FOUND').map(r => r.id) });

  const order = ['FOUND', 'POSSIBLE MATCH', 'AMBIGUOUS', 'MISSING', 'DUPLICATE', 'BLANK', 'EXTRA'];
  $('counts').innerHTML =
    '<b>' + fileCount + '</b> files indexed &nbsp; ' +
    order.filter(k => counts[k])
      .map(k => `<span class="chip ${k.split(' ')[0]}">${k}: ${counts[k]}</span>`).join('');

  $('results').innerHTML =
    '<table><thead><tr><th>ID</th><th>Status</th><th>Matched file</th><th>Notes</th></tr></thead><tbody>' +
    results.map(r =>
      `<tr><td>${esc(r.id)}</td>` +
      `<td><span class="chip ${r.status.split(' ')[0]}">${r.status}</span></td>` +
      `<td><span class="trunc" title="${esc(r.matched)}">${esc(moniker(r.matched))}</span></td><td>${esc(r.notes)}</td></tr>`).join('') +
    '</tbody></table>' +
    (lastExtras.length
      ? '<div class="hint"><b>Extra on page:</b> ' +
        lastExtras.slice(0, 25).map(e => esc(moniker(e))).join(' · ') +
        (lastExtras.length > 25 ? ' +' + (lastExtras.length - 25) : '') + '</div>'
      : '');

  // Missing callout: requested files with no match yet - they may live on
  // another page of the delivery list or a wider sweep window.
  const missing = results.filter(r => r.status === 'MISSING').map(r => r.id);
  if (missing.length) {
    // One-click escalation: double the sweep window and re-run. ER
    // deliveries that missed this window (older delivery, different
    // page) land on the next pass; downloaded files dedupe away.
    const d2 = Math.min((parseInt($('erDays').value, 10) || 14) * 2, 90);
    $('missingNote').innerHTML = '<b>' + missing.length + ' not found</b> - grab the next page or ' +
      '<a href="#" id="widenSweep">sweep ' + d2 + ' days</a>: ' +
      missing.slice(0, 8).map(esc).join(', ') + (missing.length > 8 ? ' +' + (missing.length - 8) : '');
    const ws = $('widenSweep');
    if (ws) ws.addEventListener('click', e => {
      e.preventDefault();
      $('erDays').value = d2;
      chrome.storage.local.set({ erDays: String(d2) });
      sweepAndDownload();
    });
  } else {
    $('missingNote').innerHTML = '';
  }

  $('outRow').classList.remove('hidden');
  $('manualTools').open = true; // results actions live inside the manual section
  setStage('sdDl', missing.length ? 'warn' : 'ok',
    fileCount + ' files indexed · ' + (missing.length ? missing.length + ' still missing' : 'all requested found'));
  refreshReply();
  return true;
}

$('run').addEventListener('click', runReconcile);

function copyText(text, label) {
  if (!text) return toast('Nothing to copy - ' + label + ' is empty.');
  navigator.clipboard.writeText(text).then(() => toast(label + ' copied.'));
}

// Download the files that reconciled as FOUND, using URLs captured from
// the delivery page (SharePoint file lists carry real hrefs). ESPN flags
// join back through the sheet match where the IDs overlap.
// Injected into the captured page: outline the rows/links the extension
// matched (green = FOUND, amber = POSSIBLE) and scroll to the first - a
// visual check of exactly where matches were read from.
function ingestHighlight(codes) {
  document.querySelectorAll('[data-ingest-hl]').forEach(el => {
    el.style.outline = '';
    el.style.background = '';
    el.removeAttribute('data-ingest-hl');
  });
  const containers = [...document.querySelectorAll('tr, li')];
  const loose = [...document.querySelectorAll('a')].filter(a => !a.closest('tr,li'));
  // Normalize each element's text once up front - the per-code loop would
  // otherwise recompute it codes×elements times.
  const els = containers.concat(loose).map(el => ({
    el, txt: (el.textContent || '').toLowerCase().replace(/[\s:_\-]+/g, ''),
  }));
  let first = null, n = 0;
  for (const c of codes) {
    const norm = String(c.code).toLowerCase().replace(/[\s:_\-]+/g, '');
    if (!norm) continue;
    for (const { el, txt } of els) {
      if (el.getAttribute('data-ingest-hl')) continue;
      if (txt.includes(norm)) {
        el.setAttribute('data-ingest-hl', '1');
        el.style.outline = '2px solid ' + c.color;
        el.style.background = c.bg;
        n++;
        if (!first) first = el;
      }
    }
  }
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return n;
}

// Advisory: the email text changed after Match ran - ids/files may belong
// to an older request. Warns but doesn't block (manual edits and hand-seeded
// ids are legitimate).
function matchStale() {
  return !!(matched && matchedFor && emailEl.value !== matchedFor);
}
function warnStale() {
  if (matchStale()) {
    dbg('stale match: email text differs from match-time email');
    toast('Note: the email changed since Match - results may be from an older request.');
  }
}

async function downloadFound() {
  if (!lastResults) return false;
  warnStale();
  const espnMap = {};
  const titleMap = {};
  (matched || []).forEach(m => {
    const k1 = normalizeName(m.id).replace(/ /g, '');
    const k2 = normalizeName(m.trackingId).replace(/ /g, '');
    if (k1) { espnMap[k1] = m.espn; if (m.title) titleMap[k1] = m.title; }
    if (k2) { espnMap[k2] = m.espn; if (m.title) titleMap[k2] = m.title; }
  });
  // Email code+title pairs (and spot-block titles) fill titles when the
  // sheet has no title column.
  (emailPairs || []).concat(emailSpots || []).forEach(p => {
    const k = normalizeName(p.id).replace(/ /g, '');
    if (k && p.title && !titleMap[k]) titleMap[k] = p.title;
  });
  // Resolve any MediaSilo QuickLinks among captured URLs before queueing.
  const qlLinks = [...new Set(Object.values(capturedByName).map(e => e.url)
    .filter(u => /ql\.mediasilo\.com\/ql\//i.test(u || '')))];
  const qlRes = {};
  if (qlLinks.length) {
    toast('Resolving ' + qlLinks.length + ' MediaSilo QuickLink(s)…');
    for (const l of qlLinks) qlRes[l] = await resolveQuickLink(l);
  }
  // chrome.downloads can't send X-ApiKey: API-hosted URLs are fetched
  // with the key here, then queued as blob URLs.
  const apiLinks = [...new Set(Object.values(capturedByName).filter(e => e.apiAuth).map(e => e.url))];
  const apiRes = {};
  if (apiLinks.length && erApiKey) {
    toast('Fetching ' + apiLinks.length + ' API-authorized file(s)…');
    for (const l of apiLinks) {
      try {
        const r = await fetch(l, { headers: { 'X-ApiKey': erApiKey } });
        const u = r.ok ? URL.createObjectURL(await r.blob()) : null;
        apiRes[l] = u;
        if (u) setTimeout(() => URL.revokeObjectURL(u), 5 * 60 * 1000);
      } catch (e) { apiRes[l] = null; }
    }
  }
  const jobs = [];
  const noUrl = [];
  lastResults.filter(r => r.status === 'FOUND').forEach(r => {
    const e = capturedByName[r.matched.split(' | ')[0]];
    if (e && e.url) {
      const rid = normalizeName(r.id).replace(/ /g, '');
      let url = e.url, expected = e.name;
      if (e.apiAuth) {
        const res = apiRes[url];
        if (!res) { noUrl.push(r.matched + ' (API fetch failed)'); return; }
        url = res;
      }
      if (/ql\.mediasilo\.com\/ql\//i.test(url)) {
        const res = qlRes[url];
        if (!res || res.error) { noUrl.push(r.matched + ' (QuickLink dead)'); return; }
        const pick = pickQuickLinkAsset(res.assets, { fileName: e.name, title: titleMap[rid], trackingId: r.id, id: r.id });
        url = pick.url;
        expected = pick.name || expected;
      }
      // Captured names can lack an extension (ER rows are "Ad-ID + title") -
      // append .mp4 so the watcher treats the file as media. ffmpeg probes
      // content, so a wrong container guess is harmless.
      const shape = linkShape(url);
      if (shape === 'viewer' || shape === 'sp-folder') {
        noUrl.push(r.matched + ' (' + (shape === 'sp-folder' ? 'SharePoint folder - open it' : 'viewer link - open the page') + ')');
        return;
      }
      if (!e.apiAuth) url = directUrl(url);
      const fname = /\.(mp4|mov|mxf|mpg|mpeg|avi|wmv|webm|mkv|ts|m2ts|mp3|wav|aac|srt|vtt)$/i.test(expected)
        ? expected : expected + '.mp4';
      jobs.push({
        file: nameForIngest(r.id, titleMap[rid] || '', fname), url: url, dkey: e.url,
        tracking_id: r.id, title: titleMap[rid] || '', expected_name: expected, row: 0,
        needs_espn: !!espnMap[rid] || tickerAlways(),
      });
    } else noUrl.push(r.matched);
  });
  // Skip files already queued this session - re-running grab&download on a
  // later ER page shouldn't re-download page-1 matches into "name (1).mp4".
  // (marked only when actually queued below - a cancelled dialog run must
  // not burn the dedupe slots)
  let fresh = jobs.filter(j => !queuedUrls.has(j.dkey || j.url));
  const skipped = jobs.length - fresh.length;
  // Name-matched but no URL captured: surfaced by name so the user knows
  // exactly what a re-grab/sweep still needs to attach.
  if (noUrl.length) {
    // insertAdjacentHTML, not innerHTML += - appending must not rebuild
    // the node and drop the widen-sweep link's click handler.
    $('missingNote').insertAdjacentHTML('beforeend',
      ($('missingNote').innerHTML ? '<br>' : '') +
      '<b>' + noUrl.length + ' matched but no link held</b> - re-grab the page or sweep to attach URLs: ' +
      noUrl.slice(0, 5).map(s => esc(moniker(s))).join(', ') + (noUrl.length > 5 ? ' +' + (noUrl.length - 5) : ''));
  }
  // Already-ingested warning: matched rows flagged ingested get a three-way
  // choice before anything downloads - only-new, all, or cancel.
  const ingestedIds = new Set();
  (matched || []).forEach(m => {
    if (!m.ingested) return;
    [m.id, m.trackingId].filter(Boolean).forEach(v =>
      ingestedIds.add(normalizeName(v).replace(/ /g, '')));
  });
  const oldJobs = fresh.filter(j => ingestedIds.has(normalizeName(j.tracking_id).replace(/ /g, '')));
  if (oldJobs.length) {
    const choice = await askIngested(oldJobs.length, fresh.length - oldJobs.length);
    if (choice === 'cancel') { toast('Download cancelled.'); setStage('sdDl', 'warn', 'download cancelled'); return false; }
    if (choice === 'new') {
      fresh = fresh.filter(j => !ingestedIds.has(normalizeName(j.tracking_id).replace(/ /g, '')));
      if (!fresh.length) { toast('All matched files were already ingested - nothing to download.'); return false; }
    }
  }
  dbg('dlfound', { found: lastResults.filter(r => r.status === 'FOUND').length,
    jobs: jobs.length, noUrl: noUrl.length, statuses: lastResults.reduce((o, r) => (o[r.status] = (o[r.status] || 0) + 1, o), {}) });
  // Highlight matched rows on the captured page (debug aid).
  if (lastCapTab) {
    const payload = lastResults
      .filter(r => r.status === 'FOUND' || r.status === 'POSSIBLE MATCH')
      .map(r => ({
        code: r.id,
        color: r.status === 'FOUND' ? '#3fbf7f' : '#e8a13d',
        bg: r.status === 'FOUND' ? 'rgba(63,191,127,.18)' : 'rgba(232,161,61,.18)',
      }));
    if (payload.length) {
      try {
        const [hr] = await chrome.scripting.executeScript({ target: { tabId: lastCapTab.id }, func: ingestHighlight, args: [payload] });
        dbg('highlight', { codes: payload.length, rowsMarked: hr.result });
      } catch (e) { /* page may have navigated away */ }
    }
  }
  if (!fresh.length) { setStage('sdDl', 'warn', skipped ? 'all matches already downloaded' : 'no downloadable links captured'); toast((skipped ? 'All ' + skipped + ' match(es) already downloaded this session' : 'No downloadable links captured') + (noUrl.length ? ' - ' + noUrl.length + ' matched by name only' : '') + '.'); return false; }
  const job = ($('jobLabel').value || 'job').replace(/[^\w.-]+/g, '-');
  dlTotal = fresh.length; dlDone = 0; dlFailed = 0; htmlRejects = [];
  updateDlStatus();
  for (const j of fresh) {
    queuedUrls.add(j.dkey || j.url);
    try {
      const id = await chrome.downloads.download({ url: j.url, filename: 'Ingest/' + job + '/' + j.file, conflictAction: 'uniquify' });
      if (id != null) ourDlIds.add(id);
    } catch (e) { dlFailed++; updateDlStatus(); }
  }
  const blob = new Blob([buildManifest(job, fresh, clientInfo())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: 'Ingest/' + job + '/manifest.json' });
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  dbg('download found queued', { files: fresh.map(j => j.file), urls: fresh.map(j => j.url) });
  setStage('sdDl', 'ok', fresh.length + ' file(s) queued to Ingest/' + job);
  flushLog(true);
  toast('Queued ' + fresh.length + ' file(s)' +
    (skipped ? ' (' + skipped + ' already queued earlier)' : '') +
    (noUrl.length ? ' (' + noUrl.length + ' found but had no link)' : '') + '.');
  return true;
}

// Three-way prompt when some queued files belong to rows already marked
// ingested. Resolves 'new' | 'all' | 'cancel'.
function askIngested(nOld, nNew) {
  return new Promise(resolve => {
    $('confirmMsg').textContent = nOld + ' of ' + (nOld + nNew) +
      ' matched files were already ingested.' +
      (nNew ? ' Download only the ' + nNew + ' new one(s), or all?' : ' Download them again?');
    $('confirmNew').textContent = nNew ? 'Only new (' + nNew + ')' : 'Download anyway';
    $('confirmModal').classList.remove('hidden');
    const done = v => { $('confirmModal').classList.add('hidden'); resolve(v); };
    $('confirmNew').onclick = () => done(nNew ? 'new' : 'all');
    $('confirmAll').onclick = () => done('all');
    $('confirmCancel').onclick = () => done('cancel');
  });
}

$('dlFound').addEventListener('click', downloadFound);

// ---------- ER API ----------
// Direct API path: GET /deliveries?AdId={ISCI} with the X-ApiKey the ER
// admin page issues. Results merge into capturedByName + the files box
// exactly like a page grab, so reconcile/download/dedupe all reuse the
// same machinery - and only email-matched IDs ever reach the queue.
const ER_API = 'https://api.extremereach.com';
let erApiKey = '';

async function erApiGet(path) {
  const res = await fetch(ER_API + path + (path.includes('?') ? '&' : '?') + 'format=json',
    { headers: { 'X-ApiKey': erApiKey, 'Accept': 'application/json' } });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* HTML snapshot/error page */ }
  return { status: res.status, data, raw: text };
}

// Pull {name,url} pairs out of an unverified response shape: any object
// holding both an http(s) url-ish field and a name-ish field counts as an
// asset. Reconcile filters junk - only FOUND names ever download.
function erExtractEntries(node, out) {
  out = out || [];
  if (Array.isArray(node)) { node.forEach(n => erExtractEntries(n, out)); return out; }
  if (!node || typeof node !== 'object') return out;
  const keys = Object.keys(node);
  const urlK = keys.find(k => /^(downloadurl|fileuri|fileurl|resourceurl|uri|url|href|link)$/i.test(k));
  const nameK = keys.find(k => /^(filename|file|assetname|name|title|adid)$/i.test(k));
  if (urlK && nameK && /^https?:/i.test(String(node[urlK] || ''))) {
    out.push({ name: String(node[nameK]), url: String(node[urlK]), line: String(node[nameK]), apiAuth: /extremereach\.com/i.test(node[urlK]) });
    return out;
  }
  keys.forEach(k => erExtractEntries(node[k], out));
  return out;
}

// A delivery object with no direct URL gets a follow-up: the documented
// /assets/{AdID}/resources/{DestinationId} route carries the file URI.
async function erResolveDelivery(d, adId) {
  const got = erExtractEntries(d);
  if (got.length) return got;
  const dest = d.DestinationId || d.DestinationID;
  const asset = d.AssetId || d.AssetID;
  if (dest == null) return [];
  const r = await erApiGet('/assets/' + encodeURIComponent(d.AdId || adId) + '/resources/' + dest +
    (asset != null ? '&AssetId=' + encodeURIComponent(asset) : ''));
  if (r.status === 200 && r.data) return erExtractEntries(r.data);
  dbg('erApi resources fail', { adId, dest, status: r.status, raw: r.raw.slice(0, 300) });
  return [];
}

async function fetchErApi() {
  if (!erApiKey) { toast('Paste the ER API key first.'); return false; }
  const ids = idsEl.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const want = ids.length ? ids : (matched || []).map(m => m.id || m.trackingId).filter(Boolean);
  if (!want.length) { toast('No requested IDs - run Match first.'); return false; }
  toast('Querying ER API for ' + want.length + ' ID(s)…');
  const entries = [];
  const misses = [];
  let sampleLogged = false;
  for (const id of want) {
    const r = await erApiGet('/deliveries?AdId=' + encodeURIComponent(id));
    if (r.status === 401) { toast('API key rejected (401) - check the key.'); dbg('erApi', { id, status: 401 }); return false; }
    if (r.status !== 200 || !r.data) { failsafe(id, r); continue; }
    if (!sampleLogged) { sampleLogged = true; dbg('erApi sample', { raw: r.raw.slice(0, 2000) }); }
    const deliveries = r.data.Deliveries || r.data.deliveries || (Array.isArray(r.data) ? r.data : []);
    if (!deliveries.length) { misses.push(id); continue; }
    for (const d of deliveries) {
      const got = await erResolveDelivery(d, id);
      if (got.length) got.forEach(e => entries.push(e));
      else {
        const name = d.FileName || d.AssetName || d.AdId || id;
        entries.push({ name: String(name), url: '', line: String(name) });
      }
    }
  }
  function failsafe(id, r) {
    misses.push(id);
    dbg('erApi fail', { id, status: r.status, raw: r.raw.slice(0, 400) });
  }
  // Same merge as capturePage - apiAuth flag on entries survives for the
  // download step.
  const { linked } = mergeCaptured(entries);
  stamp('tsCapture');
  dbg('erApi', { ids: want.length, deliveries: entries.length, linked, misses,
    names: entries.map(e => e.name).slice(0, 10) });
  $('capInfo').innerHTML = 'ER API: <b>' + entries.length + '</b> file entries · ' + linked + ' with links' +
    (misses.length ? ' · <i>no delivery for ' + esc(misses.slice(0, 6).join(', ')) + (misses.length > 6 ? '…' : '') + '</i>' : '');
  if (!entries.length) { toast('API returned no deliveries for those IDs.'); return false; }
  return true;
}

$('erApiKey').addEventListener('input', e => {
  erApiKey = e.target.value.trim();
  chrome.storage.local.set({ erApiKey });
});

$('erApi').addEventListener('click', async () => {
  if (!await fetchErApi()) return;
  if (!runReconcile()) return;
  await downloadFound();
});

// ---------- ER search-endpoint sweep ----------
// Fetches /Delivery/Search pages directly with the logged-in session -
// no API key, no UI clicking. Sender filter reads "Trafficked By" off
// each row's /Delivery/Detail page (the only place ER exposes it).
const ER_APP = 'https://app.extremereach.com';
const ER_DEST_INSCAPE = '92780';

// Row parser for fetched search HTML - mirrors grabExtremeReach's row
// logic, but operates on a DOMParser Document (grabExtremeReach runs
// injected on the live page and must stay self-contained for the tests).
// Returns {name,url,line,detailId} rows.
function parseErRows(doc) {
  const CODE = /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{7,14}\b/;
  const files = [];
  doc.querySelectorAll('tr').forEach(tr => {
    const dl = tr.querySelector('a[href*="/Delivery/Download/"]');
    if (!dl) return;
    const cells = [...tr.querySelectorAll('td')]
      .map(td => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim());
    let code = '', ci = -1;
    for (let i = 0; i < cells.length; i++) {
      const m = cells[i].match(CODE);
      if (m) { code = m[0]; ci = i; break; }
    }
    const title = ci >= 0 && cells[ci + 1] ? cells[ci + 1] : '';
    const name = (code + (title ? ' ' + title : '')).trim();
    if (!name) return;
    const det = tr.querySelector('a[href*="/Delivery/Detail/"]');
    const dlHref = dl.getAttribute('href') || '';
    files.push({ name, brand: cells[2] || '', line: cells.join(' '),
      url: /^https?:/i.test(dlHref) ? dlHref : ER_APP + dlHref,
      detailId: det ? ((det.getAttribute('href') || '').match(/Detail\/(\d+)/) || [])[1] : '' });
  });
  return files;
}

// GET the deliveries page to mint a fresh anti-forgery token, then POST
// /Delivery/Search per page (server-side paging - no clicking).
async function erSearchPage(token, page, days) {
  const end = new Date(), start = new Date(Date.now() - days * 864e5);
  const fmt = d => (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  // Checkbox fields (getCSV, showHDOnly, MirrorOnly, isMediaIdPartialSearch)
  // are deliberately omitted - an unchecked HTML checkbox sends nothing,
  // and a present-but-'false' value could still trip presence checks.
  const body = new URLSearchParams({
    __RequestVerificationToken: token,
    destinationId: ER_DEST_INSCAPE, deliveryStatusId: '', mediaId: '',
    searchAdvertiserOrBrandOrProduct: '',
    searchTitle: '', drPhoneNumber: '',
    deliveryDateStart: fmt(start), deliveryDateEnd: fmt(end),
    sortColumn: 'DeliveryAvailableDateTime', sortDirection: '0',
    pageSize: '100', page: String(page),
  });
  const r = await fetch(ER_APP + '/Delivery/Search', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  return r.text();
}

function erSenderOf(html) {
  const txt = html.replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = txt.match(/Trafficked\s+By\s*:?\s*(.{2,80}?)\s+(?:Length|ISCI|Advertiser|Media Type|Order)/i);
  return m ? m[1].trim() : '';
}

async function sweepEr() {
  const senderFilter = $('erSender').value.trim().toLowerCase();
  const days = Math.min(Math.max(parseInt($('erDays').value, 10) || 14, 1), 90);
  toast('Sweeping ER deliveries (last ' + days + ' days)…');
  // Fresh anti-forgery token from the deliveries landing page.
  const landing = await (await fetch(ER_APP + '/Delivery', { credentials: 'include' })).text();
  const token = (landing.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) || [])[1];
  if (!token) { toast('No ER session - log into Extreme Reach in this browser first.'); return false; }
  // Pull every page in the window (pageSize is capped at 100 server-side).
  const entries = [];
  let p = 1;
  for (; p <= 12; p++) {
    const html = await erSearchPage(token, p, days);
    if (p === 1) dbg('erSweep page1', { len: html.length, head: html.slice(0, 200) });
    const rows = parseErRows(new DOMParser().parseFromString(html, 'text/html'));
    if (!rows.length) break;
    entries.push(...rows);
    if (rows.length < 100) break;
    if (p % 3 === 0) toast('Sweeping… ' + entries.length + ' rows so far (page ' + p + ')');
  }
  dbg('erSweep rows', { rows: entries.length, pages: p - 1, days, senderFilter });
  if (!entries.length) { toast('No deliveries in that window - widen the days or check the destination.'); return false; }

  // Sender filter via detail pages. When requested IDs exist, only check
  // the rows that already match them - a full sender sweep checks all.
  let kept = entries;
  if (senderFilter) {
    const ids = idsEl.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const wanted = ids.length ? new Set(ids.map(i => normalizeName(i).replace(/ /g, ''))) : null;
    const toCheck = wanted ? entries.filter(e => wanted.has(erCodeOf(e))) : entries;
    kept = [];
    for (let i = 0; i < toCheck.length; i += 5) {
      const batch = await Promise.all(toCheck.slice(i, i + 5).map(async e => {
        try {
          const h = await (await fetch(ER_APP + '/Delivery/Detail/' + e.detailId, { credentials: 'include' })).text();
          e.sender = erSenderOf(h);
        } catch (err) { e.sender = ''; }
        return e;
      }));
      batch.forEach(e => { if (e.sender && e.sender.toLowerCase().includes(senderFilter)) kept.push(e); });
      if (i % 20 === 0 && toCheck.length > 20) toast('Checking senders… ' + i + '/' + toCheck.length);
    }
    dbg('erSweep senders', { checked: toCheck.length, kept: kept.length,
      sample: toCheck.slice(0, 8).map(e => e.sender || '(none)') });
  }

  const { linked } = mergeCaptured(kept);
  stamp('tsCapture');
  $('capInfo').innerHTML = 'ER sweep: <b>' + entries.length + '</b> deliveries in window' +
    (senderFilter ? ' · <b>' + kept.length + '</b> from "' + esc(senderFilter) + '"' : '') +
    ' · ' + linked + ' with links';
  if (!kept.length) { toast(senderFilter ? 'Nothing from that sender in the window.' : 'Nothing captured.'); return false; }
  return kept;
}

// Tracking code out of a capture entry name, normalized for comparison.
function erCodeOf(e) {
  const m = (e.name || '').match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{7,14}\b/);
  return m ? normalizeName(m[0]).replace(/ /g, '') : '';
}

$('erSender').addEventListener('input', e => chrome.storage.local.set({ erSender: e.target.value }));
$('erDays').addEventListener('input', e => chrome.storage.local.set({ erDays: e.target.value }));

// The full sweep path: query ER, seed IDs when nothing else defines the
// wanted set, reconcile, download FOUND. Shared by the button and Run.
async function sweepAndDownload() {
  const kept = await sweepEr();
  if (!kept) return false;
  // Sender-only sweep (no requested IDs): treat every kept row as wanted
  // so reconcile marks them all FOUND and downloads the lot.
  const ids = idsEl.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!ids.length && !(matched || []).length) {
    idsEl.value = kept.map(erCodeOf).filter(Boolean).join('\n');
    saveInputs();
  }
  if (!runReconcile()) return false;
  return downloadFound();
}

$('erSweep').addEventListener('click', sweepAndDownload);

// One-shot delivery-page flow: scan every open delivery tab (focused page
// + all ER tabs), reconcile against the requested IDs already loaded from
// the sheet match, and queue every FOUND download.
$('grabAndDl').addEventListener('click', async () => {
  if (!await captureTabs()) return;
  if (!runReconcile()) return;
  await downloadFound();
});

// ---------- One-click run ----------
// The whole pipeline as one button: find the source tabs automatically
// (no focusing), fall back gracefully at every stage.
$('runAll').addEventListener('click', async () => {
  toast('Running the full pipeline…');
  dbg('runAll: start');
  fetchExceptions(true); // live exceptions must be current at run time
  const cls = await stageTabs();
  const active = ((await activeTab()) || {}).id;

  // 1 · Email: an open Outlook tab supplies it; already-pasted text is
  // kept when no Outlook tab is open.
  const ot = pickTab(cls.outlook, active);
  if (ot) await grabEmailFrom(ot);
  if (!emailEl.value.trim()) return toast('No request email - open it in Outlook or paste it.');

  // 2 · Sheet: open tracker tabs win - they ride the user's own session,
  // so no auth guessing. The email-linked doc fetch is the fallback when
  // no tracker tab is open (Airtable tabs feed the app's own copy).
  const st = pickTab(cls.sheet.concat(cls.sharepoint, cls.airtable), active);
  if (st) await grabTrackerTab(st);
  if (!sheet) {
    const ref = emailSheetRefs()[0];
    if (ref) {
      applyClient(detectClient({ sheetId: ref.id }), 'sheet');
      await loadSheetDoc(ref.id, ref.gid, '', 'email-linked tracker');
    }
  }
  if (!sheet) return toast('No tracking sheet - open its tab or load a file.');

  // 3 · Match ('guess' stops at the confirm picker - that's the user step).
  if (await doMatch() !== true) return;

  // 4 · Download: real sheet links go direct; else the ER search sweep;
  // open delivery pages are the fallback.
  const nDl = (matched || []).filter(m => /^https?:/i.test(m.link || '') || m.yangarooUrl).length;
  dbg('runAll: matched', { rows: matched.length, withLinks: nDl });
  if (nDl) { await downloadLinked(); return; }
  let swept = await sweepAndDownload();
  // Auto-widen once when the first window leaves IDs missing - a stale
  // delivery date is the common cause of "not found" after a good match.
  const missingNow = () => (lastResults || []).filter(r => r.status === 'MISSING').length;
  const days = parseInt($('erDays').value, 10) || 14;
  if (missingNow() > 0 && days < 30) {
    $('erDays').value = Math.min(days * 2, 30);
    chrome.storage.local.set({ erDays: String($('erDays').value) });
    toast(missingNow() + ' still missing - widening the sweep to ' + $('erDays').value + ' days…');
    swept = (await sweepAndDownload()) || swept;
  }
  if (swept) return;
  if (await captureTabs()) {
    if (runReconcile()) { await downloadFound(); return; }
  }
  toast('Matched ' + matched.length + ' row(s) but found no downloadable files - see the log.');
});

$('dlCsv').addEventListener('click', () => {
  if (!lastResults) return;
  const blob = new Blob([resultsToCsv(lastResults)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'ingest-reconcile-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
});

// ---------- Restore state + context-menu captures ----------

idsEl.addEventListener('input', saveInputs);
filesEl.addEventListener('input', saveInputs);

// Client playbook dropdown: one agency-level option per family (brand
// children fold up - the client name is entered at ingest time anyway).
// Manual choice always wins over auto-detection; inactive clients stay
// detectable but are hidden from the dropdown.
$('clientSel').innerHTML = '<option value="">(auto-detect)</option>' +
  Object.keys(agencyFamilies)
    .map(t => '<option value="' + repOf(agencyFamilies[t]).id + '">' + esc(t) + '</option>').join('');
$('clientSel').addEventListener('change', () => {
  client = CLIENTS.find(c => c.id === $('clientSel').value) || null;
  clientSource = client ? 'manual' : '';
  applyErPreset(client);
  renderClientNote();
});

// ---------- Section 5: ingest portal ----------

// Read-only probe injected into portal.cognet.tv: the customer name off
// the H2 plus every queued file's current cell values.
function portalProbe() {
  const h2 = [...document.querySelectorAll('h2')].find(h => /customer:/i.test(h.textContent));
  const customer = h2 ? (h2.textContent.match(/customer:\s*([a-z0-9_-]+)/i) || [])[1] || '' : '';
  const grab = (tr, cls) => { const td = tr.querySelector('td.' + cls); return td ? td.textContent.trim() : ''; };
  const rows = [...document.querySelectorAll('#fileingest_bulk tbody tr.upload_row')].map(tr => ({
    name: grab(tr, 'file_name'), type: grab(tr, 'file_type'), title: grab(tr, 'file_title'),
    reporting: grab(tr, 'file_reporting'), advertiser: grab(tr, 'file_comm_advertiser'),
    brand: grab(tr, 'file_comm_brand'), vertical: grab(tr, 'file_comm_vertical'),
    realm: grab(tr, 'file_realm'), fingerprint: grab(tr, 'file_fingerprint'),
  }));
  return { customer, rows, isPortal: /cognet\.tv/i.test(location.host) };
}

// Writes the plan into the portal queue. The portal reads every field off
// the row's cell TEXT at ingest time - including the 'non-editable'
// fingerprint cell - so per-row overrides are plain textContent writes.
// Ticker files (_ticker) force fingerprint=video; non-ticker rows keep
// whatever the bulk modal set. A MutationObserver re-fills files dropped
// after the push; tr.dataset.ingestFilled stops our own edits retriggering.
function portalFill(plan) {
  window.__ingestFill = plan;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const rows = plan.rows.map(r => ({ ...r, idN: norm(r.id), titleN: norm(r.title) }));
  const findRow = stem => {
    const s = norm(stem);
    return rows.find(r => r.idN && s.includes(r.idN)) ||
           rows.find(r => r.titleN.length >= 6 && s.includes(r.titleN)) || null;
  };
  const write = (tr, cls, v) => {
    const td = tr.querySelector('td.' + cls);
    if (!td) return;
    if (td.textContent.trim() !== String(v)) {
      td.textContent = v;
      // The page sanitizer listens on focusout/blur/change - fire it so our
      // text gets the same cleanup a typed edit would.
      ['change', 'blur', 'focusout'].forEach(t => td.dispatchEvent(new Event(t, { bubbles: true })));
    }
    td.style.outline = '1px solid #2e7d4f';
  };
  const fillRow = tr => {
    if (tr.dataset.ingestFilled) return;
    const nameTd = tr.querySelector('td.file_name');
    if (!nameTd || !nameTd.textContent.trim()) return;
    const stem = nameTd.textContent.trim().replace(/\.[^.]+$/, '');
    const ticker = /_ticker|_t$/i.test(stem);
    const r = findRow(stem.replace(/_ticker|_t$/i, '')) || findRow(stem);
    if (!r) { nameTd.style.outline = '1px solid #b06000'; tr.dataset.ingestFilled = 'miss'; return; }
    tr.dataset.ingestFilled = 'ok';
    // The ticker marker is preserved, the value behind it corrected:
    // CODE_t -> RealID_t, CODE_ticker -> RealID_ticker. Never stripped,
    // never doubled (marker appended only when the value lacks it).
    const marker = ticker ? (stem.match(/_ticker$|_t$/i) || stem.match(/_ticker|_t$/i))[0] : '';
    const withMarker = v => String(v).toLowerCase().endsWith(marker.toLowerCase()) ? v : v + marker;
    write(tr, 'file_reporting', ticker ? withMarker(r.id) : r.id);
    if (plan.opts.nameTitle && r.title) write(tr, 'file_title', ticker ? withMarker(r.title) : r.title);
    if (plan.opts.advertiser && r.brand) {
      write(tr, 'file_comm_advertiser', r.brand);
      write(tr, 'file_comm_brand', r.brand);
      write(tr, 'file_comm_vertical', r.brand);
    }
    if (ticker) write(tr, 'file_fingerprint', 'video');
  };
  const sweep = () => document.querySelectorAll('#fileingest_bulk tbody tr.upload_row').forEach(fillRow);
  // A fresh push clears fill flags so re-dropped/renamed files re-evaluate.
  document.querySelectorAll('#fileingest_bulk tbody tr.upload_row').forEach(tr => delete tr.dataset.ingestFilled);
  if (!window.__ingestObserver) {
    const body = document.querySelector('#fileingest_bulk tbody') || document.getElementById('fileingest_bulk');
    window.__ingestObserver = new MutationObserver(sweep);
    if (body) window.__ingestObserver.observe(body, { childList: true, subtree: true });
  }
  sweep();
  return { queued: document.querySelectorAll('#fileingest_bulk tbody tr.upload_row').length };
}

// Plan rows from the committed match table + the playbook's ingest block.
// reporting = the sheet's Tracking ID (distinct from Title for Horizon);
// adv/brand/vert = the sheet's Brand column; fingerprint decided per file
// at fill time (_ticker -> video).
function ingestPlan() {
  const ing = (client && client.ingest) || {};
  // Portal field rule (same as ingestFileName): letters/digits/dash/dot/
  // underscore/space survive; every other character is removed, not
  // replaced - "Kohl's" -> "Kohls", "Spot: Summer" -> "Spot Summer".
  const clean = s => String(s || '').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, ' ').trim();
  return {
    rows: (matched || [])
      .filter(m => m.matchType !== 'ROW (out of range)' && (m.trackingId || m.id))
      .map(m => ({
        id: clean(m.trackingId || m.id),
        title: clean(m.title),
        brand: clean(m.brand),
        espn: !!m.espn,
      })),
    opts: {
      advertiser: !!ing.advertiser,
      nameTitle: !!ing.nameTitle,
      tickerSuffix: ing.tickerSuffix || '_ticker',
      cidMap: ing.cidMap,
    },
  };
}

function ingestColName(key) {
  const i = currentCols()[key];
  return i >= 0 && sheet ? String(sheet.headers[i] || '').trim() : '';
}

// Preview: what WOULD be written, with column provenance - the user
// approves the mapping before Push touches the page.
function renderIngestPreview() {
  const plan = ingestPlan();
  if (!plan.rows.length) {
    $('ingestPreviewBox').innerHTML = '<div class="hint">no committed matches yet - run Match first</div>';
    return;
  }
  const ing = (client && client.ingest) || {};
  const lines = [
    "Reporting ID ← '" + (ingestColName('id') || '?') + "' col" + (plan.opts.tickerSuffix ? " (+" + plan.opts.tickerSuffix + " on _ticker files)" : ''),
    plan.opts.nameTitle ? "Title ← '" + (ingestColName('title') || '?') + "' col" : 'Title — playbook leaves default',
    plan.opts.advertiser ? "Advertiser/Brand/Vertical ← '" + (ingestColName('brand') || '?') + "' col" : 'Advertiser/Brand/Vertical — playbook leaves default',
    'Fingerprint — video on _ticker files, otherwise untouched',
    'Realm · Type · Retention — never touched',
  ];
  let html = '<div class="hint">' + lines.map(esc).join('<br>') + '</div>';
  html += '<table><tr><th>ID</th><th>Title</th><th>Brand→Adv/Vert</th><th></th></tr>' +
    plan.rows.map(r =>
      '<tr><td>' + esc(r.id) + '</td><td>' + esc(r.title).slice(0, 40) + '</td><td>' + esc(r.brand) + '</td><td>' +
      (r.espn ? '<span class="chip espn">ESPN</span>' : '') + '</td></tr>').join('') +
    '</table>';
  if (plan.rows.some(r => r.espn))
    html += '<div class="hint">ESPN-flagged rows expect a <b>_ticker</b> file in the drop (fingerprint=video auto-set).</div>';
  $('ingestPreviewBox').innerHTML = html;
  $('ingestPush').classList.toggle('hidden', !plan.rows.length);
}

// Verify: after the probe, line each queued file up against the plan and
// show actual vs expected.
function renderIngestVerify(probe) {
  const plan = ingestPlan();
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const findRow = stem => {
    const s = norm(stem);
    return plan.rows.find(r => s.includes(norm(r.id))) ||
           plan.rows.find(r => norm(r.title).length >= 6 && s.includes(norm(r.title))) || null;
  };
  let ok = 0, diff = 0, miss = 0;
  const html = '<table><tr><th>File</th><th>Reporting</th><th>Title</th><th>Adv</th><th>FP</th><th></th></tr>' +
    probe.rows.map(q => {
      const stem = q.name.replace(/\.[^.]+$/, '');
      const ticker = /_ticker|_t$/i.test(stem);
      const r = findRow(stem.replace(/_ticker|_t$/i, '')) || findRow(stem);
      if (!r) { miss++; return '<tr><td>' + esc(q.name) + '</td><td colspan="4"></td><td class="warn">no match</td></tr>'; }
      const marker = ticker ? (stem.match(/_ticker$|_t$/i) || stem.match(/_ticker|_t$/i))[0] : '';
      const withMarker = v => String(v).toLowerCase().endsWith(marker.toLowerCase()) ? v : v + marker;
      const wantRep = ticker ? withMarker(r.id) : r.id;
      const wantTitle = plan.opts.nameTitle && r.title ? (ticker ? withMarker(r.title) : r.title) : q.title;
      const wantFp = ticker ? 'video' : q.fingerprint;
      const bad = [];
      if (q.reporting !== wantRep) bad.push('rep');
      if (q.title !== wantTitle) bad.push('title');
      if (q.fingerprint !== wantFp) bad.push('fp');
      bad.length ? diff++ : ok++;
      return '<tr><td>' + esc(q.name) + '</td><td>' + esc(q.reporting) + '</td><td>' + esc(q.title).slice(0, 30) + '</td><td>' +
        esc(q.advertiser) + '</td><td>' + esc(q.fingerprint) + '</td><td>' +
        (bad.length ? '<span class="chip warn">' + bad.join(' ') + '</span>' : '<span class="chip ok">ok</span>') + '</td></tr>';
    }).join('') + '</table>';
  $('ingestPreviewBox').innerHTML = html;
  return { ok, diff, miss };
}

async function portalTab() {
  const cls = await stageTabs();
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return pickTab(cls.portal, active && active.id);
}

$('ingestCheck').addEventListener('click', async () => {
  const tab = await portalTab();
  if (!tab) { toast('No portal.cognet.tv tab open'); setStage('sdIngest', 'warn', 'no portal tab open'); return; }
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: portalProbe });
  const p = res && res.result;
  if (!p || !p.isPortal) { toast('Could not read the portal page'); setStage('sdIngest', 'fail', 'portal probe failed'); return; }
  const cidMap = (client && client.ingest && client.ingest.cidMap) || '';
  const cids = [].concat(cidMap).map(String);
  const custOk = !cids.length || cids.includes(p.customer);
  stamp('tsIngest');
  const cidTxt = cids.length
    ? (custOk ? ' customer "' + p.customer + '" matches cidMap ✓' : ' customer "' + p.customer + '" ≠ cidMap ' + cids.join('/'))
    : ' customer "' + p.customer + '"';
  $('ingestInfo').innerHTML = esc(cidTxt) + ' · ' + p.rows.length + ' file(s) queued';
  setStage('sdIngest', custOk ? 'ok' : 'warn',
    'customer "' + p.customer + '"' + (custOk ? ' matches cidMap' : ' does NOT match cidMap ' + cids.join('/')) + ' · ' + p.rows.length + ' queued');
  if (p.rows.length) renderIngestVerify(p);
  else $('ingestPreviewBox').innerHTML = '<div class="hint">queue empty - drop videos, then Check again</div>';
});

$('ingestPreview').addEventListener('click', renderIngestPreview);

$('ingestPush').addEventListener('click', async () => {
  const plan = ingestPlan();
  if (!plan.rows.length) { toast('No committed matches - run Match first'); return; }
  const tab = await portalTab();
  if (!tab) { toast('No portal.cognet.tv tab open'); setStage('sdIngest', 'warn', 'no portal tab open'); return; }
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: portalFill, args: [plan] });
  const n = (res && res.result && res.result.queued) || 0;
  const [pr] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: portalProbe });
  const p = pr && pr.result;
  stamp('tsIngest');
  if (p && p.rows.length) {
    const v = renderIngestVerify(p);
    setStage('sdIngest', v.diff || v.miss ? 'warn' : 'ok',
      v.ok + ' row(s) verified · ' + v.diff + ' differ · ' + v.miss + ' unmatched — watching for new drops');
    $('ingestInfo').textContent = 'fills pushed — new files dropped into the queue auto-fill; ' +
      v.ok + ' ok · ' + v.diff + ' differ · ' + v.miss + ' unmatched';
  } else {
    setStage('sdIngest', 'warn', 'plan armed (' + plan.rows.length + ' rows) — queue still empty, will fill on drop');
    $('ingestInfo').textContent = 'plan armed for ' + plan.rows.length + ' row(s) — drop the videos, fills apply automatically';
  }
  dbg('ingest push', { rows: plan.rows.length, queued: n });
});

chrome.storage.local.get(['pendingIds', 'pendingFiles', 'emailText', 'idsText', 'filesText', 'capturedByName', 'erApiKey', 'erSender', 'erDays'], data => {
  if (data.emailText) { emailEl.value = data.emailText; onEmailChange(); }
  if (data.pendingIds) { idsEl.value = data.pendingIds; chrome.storage.local.remove('pendingIds'); }
  else if (data.idsText) idsEl.value = data.idsText;
  if (data.pendingFiles) { filesEl.value = data.pendingFiles; chrome.storage.local.remove('pendingFiles'); }
  else if (data.filesText) filesEl.value = data.filesText;
  // The file box persists across panel reloads - so does its URL map,
  // otherwise names dedupe forever while download links are lost.
  if (data.capturedByName) capturedByName = data.capturedByName;
  if (data.erApiKey) { erApiKey = data.erApiKey; $('erApiKey').value = erApiKey; }
  if (data.erSender) $('erSender').value = data.erSender;
  if (data.erDays) $('erDays').value = data.erDays;
});

// Exceptions sheet: restore the cached snapshot, then refresh live.
chrome.storage.local.get('excData', d => {
  if (d.excData && d.excData.notes) {
    excByClient = mapExceptions(d.excData.notes);
    excFetchedAt = d.excData.ts || 0;
    renderClientNote();
  }
  fetchExceptions(false);
});

// Graph setup restore + first quiet poll so the inbox list is warm when
// the user has already signed in on a previous session.
msLoad().then(() => {
  if (MS.clientId) $('msClientId').value = MS.clientId;
  if (MS.tenant) $('msTenant').value = MS.tenant;
  if (MS.refreshToken) checkInbox(true);
});

// ---------- Panel settings (which optional modules show) ----------

const UI_OPTS = [
  ['graph', 'opt-graph'], ['emailExtra', 'opt-emailExtra'], ['excReply', 'opt-excReply'],
  ['colMap', 'opt-colMap'], ['erSweep', 'opt-erSweep'], ['manual', 'opt-manual'],
  ['log', 'opt-log'], ['hints', 'opt-hints'],
];

function applyUiOpts(o) {
  UI_OPTS.forEach(([k, cbId]) => {
    const on = o[k] !== false;
    document.querySelectorAll('[data-opt="' + k + '"]')
      .forEach(el => el.classList.toggle('opt-off', !on));
    const cb = $(cbId);
    if (cb) cb.checked = on;
  });
  document.body.classList.toggle('opt-off-hints', o.hints === false);
}

chrome.storage.local.get('uiOpts', d => applyUiOpts(d.uiOpts || {}));

$('settingsGear').addEventListener('click', e => {
  e.stopPropagation();
  const p = $('settingsPanel');
  p.classList.toggle('hidden');
  $('settingsGear').setAttribute('aria-expanded', String(!p.classList.contains('hidden')));
});
$('settingsPanel').addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => {
  $('settingsPanel').classList.add('hidden');
  $('settingsGear').setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    $('settingsPanel').classList.add('hidden');
    $('settingsGear').setAttribute('aria-expanded', 'false');
  }
});
UI_OPTS.forEach(([k, cbId]) => {
  $(cbId).addEventListener('change', () => {
    chrome.storage.local.get('uiOpts', d => {
      const o = d.uiOpts || {};
      o[k] = $(cbId).checked;
      chrome.storage.local.set({ uiOpts: o });
      applyUiOpts(o);
    });
  });
});
$('settingsReset').addEventListener('click', e => {
  e.preventDefault();
  chrome.storage.local.remove('uiOpts');
  applyUiOpts({});
});
