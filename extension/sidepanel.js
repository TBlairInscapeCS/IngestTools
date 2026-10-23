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
let specFails = null;      // watcher's spec rejects: null=unchecked, []=none
let specFailsJob = '';     // job slug the specFails list belongs to
let emailDates = new Set();
let emailSubject = '';
let emailSender = '';      // sender first name for reply greetings + job slug
let jobStampCache = null;  // slug time when the email's sent date won't parse
let emailDate = '';        // sent timestamp for the Jira ticket header
let emailGraphId = '';     // Graph message id when the email came via inbox
let emailFromAddr = '';    // sender address of the Graph-loaded email
let emailFolderName = '';  // Outlook folder the loaded email was filed into
let folderMap = {};        // folderId -> displayName (rules-based client map)
let customerFolderIds = []; // folder ids under the Customers tree
let folderActivity = {};   // client folder name -> latest mail ISO
let reqSenders = {};       // learned request senders (addr -> n, dom:x -> n)
let erBatchAt = 0;         // when a Tatari ER batch notice last surfaced
const ER_BATCH_WINDOW = 4 * 864e5; // Tatari batches land within a week
let selfAddr = '';         // user's own address - self-mail isn't a request
let selfDomain = '';       // own domain - never learned as a sender domain
let repliedConvs = new Set(); // conversationIds that already got a template reply
let erDeliveries = [];     // parsed ER "Spot Delivery Notification" registry
let capturedByName = {};   // file name -> {url, line} from last page capture
const queuedUrls = new Set(); // URLs already queued for download this session
const dlKeys = new Map();   // download id -> queuedUrls key, for unmarking interrupts
let portalLiveTimer = null; // 30s records-API poller in step 5
const portalFailAlerted = new Set(); // INGEST_FAILED ids already chimed this run
let matchCols = {};        // column picks in effect for the current match
let detectedAdvertiser = ''; // brand from delivery-notification subjects
let pendingRows = [];      // sheet rows with empty fill-back columns
let pendingIdxArr = [];    // their data-row indices (for real row numbers)
let emailPairs = [];       // code+title pairs from the email (Chief Media)
let emailSpots = [];       // row#/title/code/link blocks from the email (AMC)
let yangaroo = null;       // {spots, orderName, orderId} from delivery email
let deliveryWatch = null;  // setInterval id while polling for a delivery
let watchCtx = null;       // {why, clientId, codes} the watch verifies against
let watchSince = 0;        // watcher alert events already surfaced (epoch s)
let lastExtras = [];       // files present but not requested (reconcile)
let client = null;         // active playbook from clients.js
let clientSource = '';     // 'sheet' | 'email' | 'manual'
let sheetSource = '';      // where the loaded sheet came from (tab/file name)
let sheetBuf = null;       // raw xlsx of the whole workbook (all tabs)
let sheetTabs = [];        // tab names in that workbook
let sheetTabName = '';     // which tab was loaded
let sheetSourceTab = null; // the open Sheets tab the workbook came from
let sheetGids = {};        // tab name -> web gid (for #gid= navigation)
let lastSheetRef = null;   // {id, gid, tabName} - re-exportable w/o the tab
let sheetAutoLoaded = '';  // client.id whose tracker auto-pulled this run
let dlTotal = 0, dlDone = 0, dlFailed = 0;
let dlStop = false;          // Stop button: halt queueing + cancel in-flight
const dlRunIds = [];         // download ids started this run (cancel targets)
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
// Audible alerts fire only when the browser window is out of focus - if
// the user is looking at it, the stage dot/toast IS the alert. The chime
// gets attention; the spoken line (say) names WHAT broke. Every
// candidate is logged with the focus flag so a trial period can measure
// how often each kind would have fired before widening what triggers it.
// Every sound leaves a visible note: what kind, what it was for, the
// trigger it perceived, and whether it actually chimed - so a tone heard
// in the background is identifiable and false positives get caught.
function showAlertBox(kind, what, why, silent) {
  const el = $('alertBox');
  if (!el) return;
  el.className = kind;
  const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.innerHTML = '<a href="#">×</a><b>' + esc(kind) + ' alert</b> ' +
    '<span class="hint">' + t + (silent ? ' · window focused - silent' : ' · sounded') + '</span><br>' +
    esc(what || '') +
    (why ? '<div class="hint">trigger: ' + esc(why) + '</div>' : '');
  el.querySelector('a').addEventListener('click', e => { e.preventDefault(); el.classList.add('hidden'); });
}

async function alertSound(kind, reason, say) {
  let focused = true;
  try { focused = (await chrome.windows.getCurrent()).focused; } catch (e) {}
  dbg('alert:' + kind, { reason: String(reason || '').slice(0, 200), focused, sounded: !focused });
  showAlertBox(kind, say || reason, reason, focused);
  if (focused) return;
  chrome.runtime.sendMessage({ type: 'ding', kind }).catch(() => {});
  if (say) chrome.runtime.sendMessage({ type: 'speak', text: say }).catch(() => {});
}

let dlFailAlerted = false; // one fail chime per download batch

function setStage(id, cls, tip) {
  const el = $(id);
  if (!el) return;
  el.className = 'sdot' + (cls ? ' ' + cls : '');
  el.title = tip || '';
  if (cls === 'fail') alertSound('fail', id + ': ' + (tip || cls), 'Ingest error: ' + (tip || id));
}

// modstat: per-section live status under the buttons. modStat(id, text,
// frac) shows text + fills the thin bar when the work is countable;
// modStatDone leaves a full bar + final line; modStatOff hides it.
function modStat(id, txt, frac) {
  const el = $(id); if (!el) return;
  el.classList.add('on');
  el.classList.toggle('hidebar', frac == null);
  if (frac != null)
    el.querySelector('.bar i').style.width = Math.max(3, Math.round(frac * 100)) + '%';
  el.querySelector('.txt').textContent = txt;
}
function modStatDone(id, txt) { modStat(id, txt, 1); }
function modStatOff(id) { const el = $(id); if (el) el.classList.remove('on'); }

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

// Hosts the request email links to - SafeLinks unwrapped via url=,
// mimecast-style wrappers via their domain= param. Lets tab picking prefer
// the tracker the email actually names over any stray sheet tab.
function emailLinkHosts() {
  const hosts = [];
  extractLinks(latestSegment(emailEl.value)).forEach(l => {
    let u = l.url;
    const w = u.match(/[?&]url=([^&]+)/i);
    if (w && /safelinks|protection\.outlook/i.test(u)) u = decodeURIComponent(w[1]);
    const d = u.match(/[?&]domain=([a-z0-9.-]+)/i);
    if (d) hosts.push(d[1].toLowerCase());
    try { hosts.push(new URL(u).hostname.toLowerCase()); } catch (e) { /* malformed */ }
  });
  return hosts;
}

// Tracker-tab pick: focused tab > tab on a host the email links to > first.
// Without the host pass, any open Google Sheet shadows the real SharePoint
// tracker whenever the focused tab isn't a tracker.
function pickTrackerTab(cands, activeId) {
  const focused = cands.find(t => t.id === activeId);
  if (focused) return focused;
  const hosts = emailLinkHosts();
  const hit = cands.find(t =>
    hosts.some(h => h && (t.url || '').toLowerCase().includes(h)));
  return hit || cands[0] || null;
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

// SharePoint/OneDrive links in the request email (extractLinks already
// unwraps mimecast-style wrappers for typing; the raw URL is kept since a
// fetch follows the wrapper's redirect to the real sharepoint.com URL).
function emailSharePointUrls() {
  const out = [];
  extractLinks(latestSegment(emailEl.value)).forEach(l => {
    if (l.type !== 'sharepoint') return;
    let u = l.url;
    const w = u.match(/[?&]url=([^&]+)/i);
    if (w && /safelinks|protection\.outlook/i.test(u)) u = decodeURIComponent(w[1]);
    out.push(u);
  });
  return out;
}

// Fetch a workbook off a SharePoint URL with no tab open. Wrapper links
// (mimecast etc.) redirect to the real URL; guest-access share pages serve
// the file once ?download=1 is appended. lastSheetRef keeps the resolved
// URL so refreshSheet re-downloads the same way.
async function loadSharePointUrl(url) {
  try {
    const r = await fetch(url, { credentials: 'include' });
    const u = r.url || url;
    if (!/\.sharepoint(-df)?\.com/i.test(u)) return false;
    return await loadSpDownload(u, 'SharePoint (email link)', url);
  } catch (e) {
    dbg('sharepoint url fetch fail', { url: url.slice(0, 80), err: String(e) });
    return false;
  }
}

async function loadSpDownload(u, sourceLabel, src) {
  try {
    const dl = u + (u.includes('?') ? '&' : '?') + 'download=1';
    const r = await fetch(dl, { credentials: 'include' });
    const ab = await r.arrayBuffer();
    const b = new Uint8Array(ab);
    if (b[0] !== 0x50 || b[1] !== 0x4b) return false; // viewer page, not a workbook
    sheetBuf = ab;
    sheetSourceTab = null;
    sheetGids = {};
    scoreCache = { key: '', scores: null };
    const wb = await readXlsx(ab, '');
    sheetTabs = wb.sheetNames || [];
    sheetTabName = wb.sheetName;
    loadSheetRows(wb, sourceLabel);
    // spSrc = the email link that produced this load (wrapper URL) - a
    // request re-citing the same link can skip the redundant re-download.
    lastSheetRef = { spUrl: u, spSrc: src || u };
    chrome.storage.local.set({ msLastSheet: lastSheetRef });
    rememberSheet();
    return true;
  } catch (e) {
    dbg('sharepoint download fail', { url: u.slice(0, 80), err: String(e) });
    return false;
  }
}

// Last-resort sheet discovery: follow wrapped/short email links to their
// destination - a landing on docs.google.com or sharepoint.com turns the
// link into a loadable tracker ref. Wrapper-level clicks only (mimecast/
// proofpoint redirect pages); delivery/download links are skipped so no
// single-use tokens get consumed.
async function resolveSheetLinks() {
  const types = { 'wrapped-link': 1, 'link': 1, 'sharepoint': 1, 'google-drive': 1 };
  const links = extractLinks(latestSegment(emailEl.value))
    .filter(l => types[l.type]).slice(0, 6);
  for (const l of links) {
    let u = l.url;
    const w = u.match(/[?&]url=([^&]+)/i);
    if (w && /safelinks|protection\.outlook/i.test(u)) u = decodeURIComponent(w[1]);
    if (/docs\.google\.com|\.sharepoint(-df)?\.com/i.test(u)) continue; // direct paths handled elsewhere
    try {
      const r = await fetch(u, { credentials: 'include', redirect: 'follow' });
      const f = r.url || '';
      const gm = f.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (gm) {
        applyClient(detectClient({ sheetId: gm[1] }), 'sheet');
        if (await loadSheetDoc(gm[1], (f.match(/[#?&]gid=(\d+)/) || [])[1] || '', '', 'email-linked tracker')) return true;
      } else if (/\.sharepoint(-df)?\.com/i.test(f) && await loadSpDownload(f, 'SharePoint (email link)')) {
        return true;
      }
    } catch (e) { /* wrapper blocked or offline - skip */ }
  }
  return false;
}

// Persist the sheet that just loaded under the detected client profile -
// a small recency list (clients fan out into per-brand/per-format docs:
// WB theatrical vs TV, Horizon's brand sheets). Next request auto-loads
// the remembered trackers in order until one covers the request's codes.
// The client whose family owns a doc id per playbooks, else null - a doc
// detected for another agency must never be remembered under this client
// (a Horizon doc pulled mid-Kantar-job otherwise poisons every future
// Kantar auto-load).
function docOwner(id) {
  return CLIENTS.find(o => sheetIdsFor(o).includes(id));
}
function foreignDoc(id) {
  const o = id && docOwner(id);
  return !!(o && topName(o) !== topName(client));
}
function rememberSheet() {
  if (!client || !lastSheetRef || foreignDoc(lastSheetRef.id)) return;
  chrome.storage.local.get('sheetByClient', d => {
    const m = d.sheetByClient || {};
    const old = m[client.id];
    const prev = Array.isArray(old) ? old : old ? [old] : [];
    const ref = JSON.stringify(lastSheetRef);
    const list = [lastSheetRef]
      .concat(prev.filter(r => JSON.stringify(r) !== ref)).slice(0, 3);
    if (JSON.stringify(prev) === JSON.stringify(list)) return;
    m[client.id] = list;
    chrome.storage.local.set({ sheetByClient: m });
  });
  mineDocBrands();
}

// Brand -> doc catalog: the tracker's Client/Brand column, learned on
// every load into docBrands storage and seeded by playbook trackerBrands
// (Horizon's master doc carries ~80 brands). An email naming a known
// brand selects that doc - and implies its client when detection found
// nothing, since new brands land on the sheet before any playbook.
let docBrandsCache = {};
chrome.storage.local.get('docBrands', d => { docBrandsCache = d.docBrands || {}; });

function allDocBrands() {
  const m = {};
  CLIENTS.forEach(c => {
    const sid = sheetIdsFor(c)[0];
    if (sid && c.trackerBrands && c.trackerBrands.length)
      m[sid] = { client: c.id, brands: c.trackerBrands.slice() };
  });
  for (const id in docBrandsCache) {
    const e = docBrandsCache[id] || {};
    if (m[id]) m[id].brands = [...new Set(m[id].brands.concat(e.brands || []))];
    else m[id] = { client: e.client, brands: e.brands || [] };
  }
  return m;
}

function mineDocBrands() {
  if (!sheet || !lastSheetRef || !lastSheetRef.id || !client) return;
  const bi = currentCols().brand;
  if (!(bi >= 0)) return;
  const vals = new Set();
  (sheet.allRows || sheet.rows || []).forEach(r => {
    const v = String(r[bi] || '').trim();
    if (v.length > 1 && v.length < 60 && v.toLowerCase() !== 'client') vals.add(v);
  });
  if (!vals.size) return;
  const id = lastSheetRef.id;
  chrome.storage.local.get('docBrands', d => {
    const m = d.docBrands || {};
    const e = m[id] || { client: client.id, brands: [] };
    e.client = e.client || client.id;
    e.brands = [...new Set(e.brands.concat([...vals]))].slice(0, 200);
    m[id] = e; docBrandsCache = m;
    chrome.storage.local.set({ docBrands: m });
  });
}

const normBrand = s => ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/^ | $/g, '') + ' ';
function docForBrand(text) {
  const hay = normBrand(text);
  // A detected client narrows candidates to its agency's docs; nothing
  // detected means any doc may be the answer (the implication path).
  const fam = client ? topName(client) : '';
  let best = null, bestLen = 0;
  const m = allDocBrands();
  for (const id in m) {
    const dc = fam && CLIENTS.find(c => c.id === m[id].client);
    if (fam && dc && topName(dc) !== fam) continue;
    for (const b of m[id].brands) {
      const nb = normBrand(b);
      if (nb.trim().length >= 3 && hay.includes(nb) && nb.length > bestLen) {
        best = { id, client: m[id].client, brand: b };
        bestLen = nb.length;
      }
    }
  }
  return best;
}

// Can the loaded sheet plausibly cover this request? True when nothing
// was requested by code (no way to tell) or some tab/row holds one of
// the request's IDs - the wrong-doc check behind remembered loads.
async function sheetCoversRequest() {
  if (!sheet) return false;
  const codes = extractCodes(latestSegment(emailEl.value));
  if (!codes.length) return true;
  const scores = await sheetTabScores(codes);
  if (scores) return scores.some(s => s.hits > 0);
  const hay = normalizeName(sheet.allRows.map(r => r.join(' ')).join('\n')).replace(/[\s:_-]+/g, '');
  return codes.some(c => hay.includes(normalizeName(c).replace(/[\s:_-]+/g, '')));
}

// Job naming: flat ~/Downloads/Ingest/ layout - media lands at the top
// level, per-job metadata is <slug>-manifest.json. The slug is fixed
// format, no input and NO names (the requester's name must never end up
// on files that ship as Jira evidence): date+time the request was sent,
// client. The timestamp keeps same-day/same-client jobs from colliding.
function jobSlug() {
  const sent = Date.parse(emailDate);
  const t = isNaN(sent) ? (jobStampCache = jobStampCache || new Date()) : new Date(sent);
  const d = t.getFullYear() + String(t.getMonth() + 1).padStart(2, '0') + String(t.getDate()).padStart(2, '0');
  const ts = t.toTimeString().slice(0, 8).replace(/:/g, '');
  const cl = client ? client.name.split(' (')[0].split(' / ')[0].replace(/[^\w]+/g, '') : 'job';
  return (d + '-' + ts + '-' + cl).slice(0, 80);
}

function saveInputs() {
  // Request inputs are intentionally ephemeral - a panel reload is a
  // fresh run (the "start from scratch" the user expects). One-shot
  // pendingIds/pendingFiles handoffs and config keys persist via their
  // own writers, not here.
}

// "Clear all" - wipe every request artifact AND the loaded tracker back
// to a bare panel. Access config is deliberately untouched: Graph
// tokens, Jira creds, ER key, sweep prefs, learned senders, the
// deliveries registry and cached sheet refs for OTHER clients survive.
function clearAll() {
  resetRun();
  // Order matters: client and sheet clear BEFORE onEmailChange, or the
  // auto-pull sees the old client's sheetIds and re-fetches the tracker.
  client = null; clientSource = ''; $('clientSel').value = '';
  sheet = null; pendingRows = []; pendingIdxArr = []; lastSheetRef = null; sheetAutoLoaded = '';
  $('sheetInfo').style.display = 'none'; $('sheetInfo').innerHTML = '';
  $('colSummary').textContent = '';
  setStage('sdSheet'); $('tsSheet').textContent = '';
  // Email artifacts resetRun deliberately keeps for same-run re-requests
  emailEl.value = ''; emailDate = '';
  onEmailChange(); // resets sender/graph-id/derived state for empty text
  setStage('sdEmail'); $('tsEmail').textContent = '';
  renderClientNote();
  // Lookup-module inputs resetRun never touches - clear all means ALL.
  ['sheetPaste', 'recIds', 'impIds', 'recRealm', 'impRealm', 'impStart', 'impEnd']
    .forEach(id => { const el = $(id); if (el) el.value = ''; });
  ['recResults', 'impResults', 'dateFilterHint']
    .forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });
  $('erSender').value = ''; $('erDays').value = '14';
  ['watchInfo', 'tickerInfo'].forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });
  ['feedTicker', 'ingestPush'].forEach(id => { const el = $(id); if (el) el.classList.add('hidden'); });
  const pp = $('portalPick'); if (pp) pp.value = '';
  // Collapse to the fresh-load layout: sec1 open, every module and mini
  // toggle shut - the progressive unlocks re-apply from the cleared dots.
  document.querySelectorAll('details').forEach(d => { d.open = (d.id === 'sec1'); });
  // Persisted inputs must not resurrect on the next panel reload
  chrome.storage.local.remove(['emailText', 'idsText', 'filesText',
    'capturedByName', 'msLastSheet', 'pendingIds', 'pendingFiles',
    'recRealm', 'erSender', 'erDays']);
  toast('Cleared - fresh run.');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// New request = fresh run: wipe every artifact of the previous one
// (persisted ids/files/URL map restore on panel open, so stale state
// survives reloads unless actively cleared).
function resetRun() {
  matched = null; matchedFor = ''; lastResults = null; lastExtras = [];
  specFails = null; specFailsJob = '';
  disarmDeliveryWatch();
  yangaroo = null;
  idsEl.value = ''; filesEl.value = '';
  capturedByName = {}; queuedUrls.clear(); dlKeys.clear(); lastCapTab = null;
  $('matchResults').innerHTML = '';
  $('results').innerHTML = ''; $('counts').innerHTML = '';
  $('missingNote').innerHTML = '';
  $('download').classList.add('hidden');
  $('showSheet').classList.add('hidden');
  $('replyArea').classList.add('hidden'); $('replyPreview').value = '';
  const rk = $('replyKind'); if (rk) rk.value = 'auto';
  $('capInfo').innerHTML = '';
  ['stEmail', 'stSheet', 'stMatch', 'stDl', 'stIngest', 'stJira'].forEach(modStatOff);
  dlTotal = 0;
  stopPortalLive();
  portalFailAlerted.clear();
  const pl = $('portalLive'); if (pl) pl.textContent = '';
  ourDlIds.clear();
  // Request-specific draft/proof state must not bleed into the next job:
  // a dirty reply kept last request's text, a staged Jira run could post
  // the wrong ticket's comment, and stale records/dates attach wrongly.
  replyDirty = false; emailDate = ''; emailGraphId = ''; emailFromAddr = ''; emailFolderName = '';
  // Sender + slug-time are per-request: a stale greeting names the
  // previous requester, and a stale timestamp re-slugs the next job.
  emailSender = ''; jobStampCache = null;
  sheetAutoLoaded = ''; // next request may auto-pull a different tracker
  pendingJira = null; draftWithoutProof = false; lastIngestRecords = [];
  $('jiraBox').classList.add('hidden'); $('jiraApprove').classList.add('hidden');
  $('jiraPreview').value = ''; $('jiraStatus').innerHTML = '';
  $('verifyInfo').innerHTML = ''; $('saveRecords').classList.add('hidden');
  // Sheet/email dots keep their state (the sheet stays loaded across
  // requests); match/download dots reset with the data they described.
  ['sdMatch', 'sdDl', 'sdIngest', 'sdReply'].forEach(id => setStage(id));
  $('ingestInfo').innerHTML = ''; $('ingestPreviewBox').innerHTML = '';
  saveInputs();
}

// ---------- Client playbook (clients.js) ----------

// Live customer-exceptions sheet: link-shared Google doc, fetched as xlsx
// with no auth at all. Refresh on panel open, every 15 min while open,
// and force at the start of Run - it's rarely edited, but when it is the
// update must reach the next ingest. Last fetch is cached in storage so
// a dead network still shows the previous snapshot.
// The reference-sheet doc id lives in clients.js (REF_SHEET_ID) so the
// portable build can ship it blank - empty disables the feature.
const EXC_SHEET_ID = (typeof REF_SHEET_ID !== 'undefined' && REF_SHEET_ID) || '';
let excByClient = {};   // client id -> live exception note
let excFetchedAt = 0;

// Customer-name rows map onto clients by containment in either direction:
// "Horizon Media" covers every Horizon / <brand> child, "TubeMogul" sits
// inside "Adobe (TubeMogul)". The longest customer key wins on overlaps.
function mapExceptions(notes) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Tolerate the legacy 2-col snapshot (note as a bare string) and the
  // structured form ({note, tracker, files}) the header-aware parse writes.
  const rec = v => typeof v === 'string' ? { note: v } : (v || {});
  const custKeys = Object.keys(notes).map(k => ({ k, n: norm(k), rec: rec(notes[k]) }))
    .filter(c => c.n);
  const out = {};
  CLIENTS.forEach(c => {
    const names = [norm(topName(c)), norm(c.name), norm(c.id)];
    const hits = custKeys.filter(cu => names.some(nm => nm && (cu.n.includes(nm) || nm.includes(cu.n))));
    if (hits.length) out[c.id] = hits.sort((a, b) => b.n.length - a.n.length)[0].rec;
  });
  return out;
}

async function fetchExceptions(force) {
  if (!EXC_SHEET_ID) return;
  if (!force && Date.now() - excFetchedAt < 15 * 60 * 1000) return;
  try {
    const r = await fetch(
      'https://docs.google.com/spreadsheets/d/' + EXC_SHEET_ID + '/export?format=xlsx',
      { credentials: 'omit' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const wb = await readXlsx(await r.arrayBuffer(), '');
    // Header-driven: Customer | Exceptions & rules | Tracker | Files / share.
    // Extra columns are ignored; a legacy 2-col sheet (no header) still
    // reads as customer+note. Rows need only ONE field to count - a row
    // that only carries a tracker link is a valid reference.
    const rows = wb.rows;
    const hi = rows.findIndex(r => /^customer$/i.test(String(r[0] || '').trim()));
    const hdr = hi >= 0 ? rows[hi].map(h => String(h || '').toLowerCase()) : null;
    const colOf = re => hdr ? hdr.findIndex(h => re.test(h)) : -1;
    const ci = {
      note: colOf(/except|note|rule|caveat/) >= 0 ? colOf(/except|note|rule|caveat/) : 1,
      tracker: colOf(/tracker|tracking|sheet/),
      files: colOf(/file|share|folder|deliver/),
    };
    const notes = {};
    rows.slice(hi >= 0 ? hi + 1 : 0).forEach(row => {
      const cust = String(row[0] || '').trim();
      if (!cust || /^customer$/i.test(cust)) return;
      const rec = {
        note: String(row[ci.note] || '').trim(),
        tracker: ci.tracker >= 0 ? String(row[ci.tracker] || '').trim() : '',
        files: ci.files >= 0 ? String(row[ci.files] || '').trim() : '',
      };
      if (rec.note || rec.tracker || rec.files) notes[cust] = rec;
    });
    excByClient = mapExceptions(notes);
    excFetchedAt = Date.now();
    chrome.storage.local.set({ excData: { ts: excFetchedAt, notes } });
    dbg('exceptions sheet', { customers: Object.keys(notes).length, matched: Object.keys(excByClient).length });
    renderClientNote();
  } catch (e) { dbg('exceptions fetch fail', { err: String(e) }); }
}
setInterval(() => fetchExceptions(false), 15 * 60 * 1000);

let noteSheetsFor = '', noteSheets = [];   // remembered tracker refs for the shown client
function renderClientNote() {
  const el = $('clientNote');
  if (!client) { el.style.display = 'none'; noteSheetsFor = ''; noteSheets = []; return; }
  el.style.display = 'block';
  // Remembered trackers surface as click-to-open links - for clients whose
  // sheets/files sit behind auth the tool can't pass (NFL's 2FA SharePoint),
  // the previously shared link is the way back in.
  if (noteSheetsFor !== client.id) {
    noteSheetsFor = client.id; noteSheets = [];
    chrome.storage.local.get('sheetByClient', d => {
      if (!client || client.id !== noteSheetsFor) return;
      const v = (d.sheetByClient || {})[client.id];
      noteSheets = Array.isArray(v) ? v : v ? [v] : [];
      renderClientNote();
    });
  }
  const ing = ingestSummary(client);
  // The exceptions sheet is the authoritative caveat source - live text
  // wins over the static playbook note (which stays behind the ? bubble).
  const liveRec = excByClient[client.id] || {};
  const live = liveRec.note;
  const caveat = live
    ? live.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0]
    : (client.note || '').split(/\s+[–-]\s+|\.\s/)[0];
  // The extracted advertiser is only surfaced when the client's ingest spec
  // needs it as metadata, or on notify profiles where the brand is the only
  // identity we have for which agency is about to send a request.
  const showAdv = detectedAdvertiser &&
    ((client.ingest && client.ingest.advertiser) ||
     client.id === 'er-notify' || client.id === 'yangaroo-delivery');
  // Known tracking sheets -> one-click open (then "scrape sheet" picks up
  // the match from there). First sheetId wins; extras stay in detect.
  const trackerIds = sheetIdsFor(client);
  // Remembered trackers the playbook doesn't name (or can't reach): the
  // last shared link is the way back in when access needs a human (2FA,
  // re-share). Google ids already in detect are skipped.
  const lastTrackerLinks = known => noteSheets.map(mem => {
    if (mem.id && known.includes(mem.id)) return '';
    const u = mem.id ? 'https://docs.google.com/spreadsheets/d/' + mem.id
      : (mem.viewUrl || mem.spUrl || '');
    if (!u) return '';
    return '<a href="' + esc(u) + '" target="_blank" title="previously used tracker - open it to re-share or re-grant access">last shared tracker' +
      (mem.tabName ? ' · ' + esc(mem.tabName) : '') + '</a>';
  }).filter(Boolean);
  // Last-mail date from the weekly folder-activity scan - quiet clients
  // surface their staleness right in the note.
  const lastMail = Object.keys(CLIENT_FOLDERS)
    .filter(f => CLIENT_FOLDERS[f] === client.id)
    .map(f => folderActivity[f]).filter(Boolean).sort().pop();
  el.innerHTML = '<b>' + esc(client.name) + (client.inactive ? ' (inactive)' : '') + '</b> - ' +
    esc(caveat) +
    ((live || (client.note && caveat !== client.note)) ? ' <span class="ib" data-bubble="clientFull">?</span>' : '') +
    (showAdv ? '<br><b>Advertiser:</b> ' + esc(detectedAdvertiser) : '') +
    (client.delivery ? '<br><b>Delivery:</b> ' + esc(client.delivery) : '') +
    (lastMail ? ' <i>· last mail ' + esc(lastMail.slice(0, 10)) + '</i>' : '') +
    (trackerIds.length
      ? '<br>' + trackerIds.map(id =>
          '<a href="https://docs.google.com/spreadsheets/d/' + esc(id) +
          '" target="_blank">open tracker sheet</a>').join(' · ')
      : '') +
    (liveRec.tracker
      ? '<br><b>Tracker:</b> <a href="' + esc(liveRec.tracker) + '" target="_blank" title="from the customer reference sheet">open reference tracker</a>'
      : '') +
    (liveRec.files
      ? (liveRec.tracker ? ' · ' : '<br>') + '<b>Files:</b> <a href="' + esc(liveRec.files) + '" target="_blank" title="file share from the customer reference sheet">open file share</a>'
      : '') +
    (lastTrackerLinks(trackerIds).length
      ? '<br><b>Last used:</b> ' + lastTrackerLinks(trackerIds).join(' · ')
      : '') +
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
  // Path separators can't live inside a filename - chrome.downloads reads
  // "/" as a directory break, which interrupts the download (WB's
  // "ONLY IN THEATERS / FRIDAY / ..." titles failed all four files).
  const safe = s => String(s || '').replace(/[/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!client || !client.ingest || !client.ingest.nameTitle) return safe(deliveredName);
  const ext = (String(deliveredName).match(/\.[a-z0-9]{2,5}$/i) || ['.mp4'])[0];
  return ingestFileName(trackingId, title, ext) || safe(deliveredName);
}

// Ingest fields for the manifest + whether every file needs a ticker.
// The live exception text rides along so ingest_watch's report shows the
// rules in effect at download time.
function clientInfo() {
  return client ? { name: client.name, ...(client.ingest || {}), exceptions: (excByClient[client.id] || {}).note || '' } : null;
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

// Effective tracker ids for a playbook: its own sheetIds win; brand
// profiles without one inherit the agency umbrella's tracker (every
// Horizon brand lives on the NEXT master sheet).
function sheetIdsFor(c) {
  const own = (c && c.detect && c.detect.sheetIds) || [];
  if (own.length) return own;
  const fam = c && agencyFamilies[topName(c)];
  const rep = fam && repOf(fam);
  return (rep && rep !== c && rep.detect && rep.detect.sheetIds) || [];
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
  // A sheetless detection is anchor-strength: a tracker doc's sheetIds can
  // never belong to it, so no sheet signal may override it (only a manual
  // pick or an email signal can).
  if (client && client.sheetless && via === 'sheet' && clientSource !== 'manual')
    { renderClientNote(); return; }
  const agencyOf = x => x.name.split(' / ')[0].split(' ')[0];
  const refine = (base, cand) => {
    const agency = agencyOf(base);
    const hit = detectClient({ emailText: emailEl.value, subject: emailSubject, folderName: emailFolderName });
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
  // Sheetless clients have no tracker stage - dim its dot to 'skip' so the
  // empty section reads as intentional, not unfinished.
  if (c.sheetless) setStage('sdSheet', 'skip', c.name + ': no tracking sheet - the email is the manifest');
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
  const sd = (location.search + location.href).match(/sourcedoc=(?:%7B|\{)?([0-9a-fA-F-]{36})/i)
    // Guest-access viewer pages carry no sourcedoc in the URL - the file's
    // GUID sits in embedded viewer markup/scripts instead.
    || document.documentElement.innerHTML.match(/sourcedoc[^0-9a-fA-F-]{0,20}([0-9a-fA-F-]{36})/i);
  const site = location.pathname.match(/(\/(?:sites|teams)\/[^/]+)/i) ||
               location.href.match(/sharepoint\.com\/((?:sites|teams)\/[^/:]+)/i);
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
  if (sndEl) {
    // Attributes first - a matched [title] node's innerText can be the
    // whole message body. Then strip role words and any address so only
    // the display name survives.
    sender = (sndEl.getAttribute('title') || sndEl.getAttribute('aria-label') || sndEl.innerText || '')
      .replace(/^(mail from|sender|from)\s*[:.\-]?\s*/i, '')
      .replace(/<[^>]*>/g, '').replace(/\S+@\S+/g, '').trim()
      .slice(0, 60);
  }
  // Sent timestamp off the reading-pane header - best effort, three passes:
  // a <time> element, an aria-label/title carrying date+time, then any small
  // header-shaped element whose text is date-ish.
  let date = '';
  const tEl = document.querySelector('time[datetime]');
  if (tEl) date = (tEl.getAttribute('datetime') || tEl.innerText || '').trim();
  if (!date) {
    const lbl = [...document.querySelectorAll('[aria-label],[title]')]
      .map(el => el.getAttribute('aria-label') || el.getAttribute('title') || '')
      .find(s => s.length < 90 && /\d{1,2}:\d{2}/.test(s) &&
        /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun|\d{1,2}\/\d{1,2}\//i.test(s));
    if (lbl) date = lbl.trim();
  }
  if (!date) {
    document.querySelectorAll('div,span').forEach(el => {
      const t = (el.innerText || '').trim();
      if (!date && t.length > 8 && t.length < 70 &&
          /\d{1,2}:\d{2}\s*(am|pm)?/i.test(t) &&
          /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}\/\d{1,2}\//i.test(t))
        date = t;
    });
  }
  return { text: text.slice(0, 80000), subject, sender, date: date.slice(0, 90) };
}

// Inside Outlook: Yangaroo "ADVERTISING DELIVERY" notifications carry a
// per-spot Download link - the email IS the delivery manifest. Pair each
// Download anchor with the Ad-ID/ISCI in its table row so files can be
// queued straight from the email, no portal scraping. Only anchors
// literally labelled "Download" are taken - never Confirm Delivery /
// Stream / Support, which have remote side effects.
// Yangaroo "New Media Available" deliveries: per-spot Download anchors,
// each row carrying the ISCI + title. Runs against any document - the
// live Outlook tab or a DOMParser'd Graph message body.
function yangarooFromDoc(doc) {
  const CODE = '\\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\\d)[A-Z0-9]{7,14}\\b';
  const codeRe = new RegExp(CODE);
  const codeReG = new RegExp(CODE, 'g');
  const spots = [];
  const seen = new Set();
  doc.querySelectorAll('a[href]').forEach(a => {
    if ((a.innerText || a.textContent || '').trim().toLowerCase() !== 'download') return;
    const row = a.closest('tr') || a.closest('li') || a.closest('td') || a.parentElement;
    const txt = row ? (row.innerText || row.textContent || '') : '';
    // If a row carries more than one Download link, pair them positionally.
    let idx = 0;
    if (row) {
      const dls = [...row.querySelectorAll('a[href]')]
        .filter(x => (x.innerText || x.textContent || '').trim().toLowerCase() === 'download');
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
  const body = (doc.body && (doc.body.innerText || doc.body.textContent)) || '';
  const om = body.match(/Order Name:\s*([^\n]+)/i);
  const oi = body.match(/Order ID:\s*([^\n]+)/i);
  return { spots, orderName: om ? om[1].trim() : '', orderId: oi ? oi[1].trim() : '' };
}
function grabYangarooDelivery() { return yangarooFromDoc(document); }

// Same delivery parse for a Graph-loaded email - no Outlook tab needed.
function parseYangarooHtml(html) {
  if (!/yangaroo|new media available/i.test(String(html || ''))) return null;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const r = yangarooFromDoc(doc);
    return r.spots.length ? r : null;
  } catch (e) { return null; }
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

  // Yangaroo/DMDS list pages name spots by bare ad-id and wire download
  // links that don't end in a media extension (/advideo/, /Download?id=)
  // - accept ISCI-ish tokens as entries and carry each anchor's href.
  if (/dmds|yangaroo/i.test(location.host)) {
    const codeRe = /\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{7,14}\b/;
    text.split(/\r?\n/).forEach(line => {
      const m = line.trim().match(codeRe);
      if (m && !entries.has(m[0])) {
        entries.set(m[0], { name: m[0], line: line.trim().slice(0, 500) });
      }
    });
    document.querySelectorAll('a[href]').forEach(a => {
      try {
        const m = (a.innerText || '').match(codeRe) || a.href.match(codeRe);
        if (!m) return;
        const url = new URL(a.getAttribute('href'), location.href).href;
        const cur = entries.get(m[0]);
        if (cur) { if (!cur.url) cur.url = url; }
        else entries.set(m[0], { name: m[0], line: (a.innerText || a.href).slice(0, 500), url });
      } catch (e) { /* skip */ }
    });
  }

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
  let okCopy = false, cellId = '';
  if (doCopy) {
    // Only a DATA cell registers the app's selection model - the earlier
    // container fallback landed on header/row-actions cells and the click
    // went nowhere (log showed focus:BODY, selected:0). Interface pages
    // have no role=grid/dataRows wrapper, so address the cell directly.
    const cell = document.querySelector('.dataRow [data-testid="gridCell-0:0"]')
              || document.querySelector('.dataRow [data-testid^="gridCell-"]');
    if (cell) {
      cellId = cell.getAttribute('data-testid') || '';
      const r = cell.getBoundingClientRect();
      const ev = { bubbles: true, cancelable: true, view: window, button: 0,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(type => {
        cell.dispatchEvent(type.startsWith('pointer')
          ? new PointerEvent(type, ev) : new MouseEvent(type, ev));
      });
      cell.click();
      cell.focus();
      const keyA = t => {
        const kev = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', metaKey: true, bubbles: true, cancelable: true });
        Object.defineProperty(kev, 'keyCode', { value: 65 });
        Object.defineProperty(kev, 'which', { value: 65 });
        t.dispatchEvent(kev);
      };
      keyA(cell);
      if (document.activeElement && document.activeElement !== cell) keyA(document.activeElement);
      keyA(document);
      okCopy = document.execCommand('copy');
    }
  }
  return { okCopy, headers, cellId,
    selected: document.querySelectorAll('[aria-selected="true"], .selected, [class*="cellSelected"]').length,
    focus: document.activeElement ? document.activeElement.tagName + ':' + (document.activeElement.getAttribute && document.activeElement.getAttribute('data-testid') || '') : '',
    domSel: String(window.getSelection ? window.getSelection() : '').length };
}

// ---------- Section 1: request email ----------

// Read the request email (+ Yangaroo delivery links) off an Outlook tab.
// Takes a Tab object so callers pick the source tab, not focus.
async function grabEmailFrom(tab) {
  modStat('stEmail', 'Grabbing email…');
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
  setEmailText(text, (res.result && res.result.subject) || '', (res.result && res.result.sender) || '',
    (res.result && res.result.date) || '');
  modStatDone('stEmail', extractCodes(latestSegment(text)).length + ' code(s) cited');
  return true;
}

// Email intake shared by the Outlook grab, clipboard paste, and .eml load.
// Anything that arrives as plain text loses the delivery-page anchor
// scrape - callers null yangaroo themselves.
function setEmailText(text, subject, sender, date, graphId) {
  if (text !== emailEl.value) resetRun(); // new request = fresh run state
  emailEl.value = text;
  emailSubject = subject || '';
  emailGraphId = graphId || '';
  // Reply greeting: explicit sender name wins (Outlook DOM / .eml From:),
  // else parse a leading From: line (Graph inbox / pasted headers).
  emailSender = senderFirstName(sender) || senderFirstName(text) || '';
  // Timestamp: explicit probe wins, else a pasted header line carries it.
  emailDate = String(date || '').trim() ||
    ((text.match(/^(?:sent|date|received):\s*(.+)$/im) || [])[1] || '').trim().slice(0, 90);
  detectedAdvertiser = extractAdvertiser(emailSubject);
  applyClient(detectClient({ emailText: text, subject: emailSubject, folderName: emailFolderName }), 'email');
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

$('clearEmail').addEventListener('click', () => { emailEl.value = ''; emailDate = ''; onEmailChange(); saveInputs(); });
$('clearAll').addEventListener('click', clearAll);
$('helpLink').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

// Inbox-offline chip: msAccessToken flags msAuthDown when the refresh
// token dies - background poll can flag it while the panel is closed,
// so listen to storage rather than local call results.
chrome.storage.local.get('msAuthDown', d => setMsStatus(!!d.msAuthDown));
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && 'msAuthDown' in ch) setMsStatus(!!ch.msAuthDown.newValue);
});
function setMsStatus(down) {
  $('msStatus').classList.toggle('hidden', !down);
}
// Sign-in setup lives in the settings panel now - revealing it has to
// open that panel or it unhides inside a closed flyout.
function showMsSetup() {
  const su = $('msSetup');
  su.classList.remove('hidden');
  su.style.display = 'block'; // .info is display:none in CSS
  $('settingsPanel').classList.remove('hidden');
  $('settingsGear').setAttribute('aria-expanded', 'true');
}
$('msStatus').addEventListener('click', e => {
  e.preventDefault();
  e.stopPropagation(); // the document click handler would instantly re-close the panel
  showMsSetup();
  $('msSignIn').focus();
});

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
    setEmailText(String(eml.body || '').trim(), eml.subject, senderFirstName(eml.from), eml.date);
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
let msWantWrite = false; // write call 403'd - next sign-in asks Mail.ReadWrite

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
    window.open(msAuthorizeUrl(pk.challenge, redirect, msWantWrite ? MS_SCOPE_WRITE : MS_SCOPE), '_blank');
    $('msCodeRow').classList.remove('hidden');
    msg.textContent = ' sign in on the page that opened, then paste the code (or full URL) below.';
  } catch (e) { msg.textContent = ' failed: ' + e.message; }
});

$('msCodeGo').addEventListener('click', async () => {
  const raw = $('msCode').value.trim();
  if (!raw || !msPkceCtx) return toast('Paste the code from the sign-in page.');
  // A failed sign-in still redirects - the URL carries error/error_
  // description. Surface the real Microsoft error instead of trying to
  // exchange garbage.
  const em = raw.match(/[?&]error=([^&\s]+)/);
  if (em) {
    const dm = raw.match(/[?&]error_description=([^&\s]+)/);
    $('msMsg').textContent = ' sign-in failed: ' + decodeURIComponent(em[1]) +
      (dm ? ' - ' + decodeURIComponent(dm[1]).replace(/\+/g, ' ').slice(0, 200) : '');
    dbg('ms auth error', { error: em[1], desc: dm ? decodeURIComponent(dm[1]).replace(/\+/g, ' ').slice(0, 300) : '' });
    return;
  }
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
    const d = await msDeviceCode(msWantWrite ? MS_SCOPE_WRITE : MS_SCOPE);
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

// Verify the notification + siren path without waiting for a real request.
$('testAlert').addEventListener('click', async e => {
  e.preventDefault();
  const r = await chrome.runtime.sendMessage({ type: 'test-alert' });
  if (r !== true) toast('Alert test failed: ' + r);
});

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
      showMsSetup();
      toast('Sign in to read the inbox - setup is in ⚙ Settings.');
    }
    return { n: 0, hits: [] };
  }
  let msgs;
  try { msgs = await graphUnread(25); }
  catch (e) {
    dbg('graph inbox fail', { err: String(e) });
    if (!quiet) toast('Inbox check failed: ' + e);
    return { n: 0, hits: [] };
  }
  return renderInbox(msgs || [], quiet);
}

// Graph bodies arrive as HTML: anchors carry the real hrefs that innerText
// loses ("Download" text with the URL behind it). Re-inject each href after
// its link text and unwrap O365 SafeLinks wrappers while doing so.
function stripHtmlKeepLinks(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('a[href]').forEach(a => {
    let h = a.getAttribute('href') || '';
    const m = h.match(/safelinks\.protection\.outlook\.com\/\?url=([^&]+)/i);
    if (m) h = decodeURIComponent(m[1]);
    const t = (a.textContent || '').trim();
    a.replaceWith(doc.createTextNode(/^https?:/i.test(h) ? (t && t !== h ? t + ' ' + h : h) : t));
  });
  return stripHtml(doc.body.innerHTML);
}

// If the request email carries the tracker as an attachment, load it
// straight into section 2 - no SharePoint tab needed.
async function tryLoadTrackerAttachment(msgId) {
  try {
    const atts = await graphAttachments(msgId);
    const wb = atts.find(a => /\.xlsx?$/i.test(a.name || ''));
    const others = atts.filter(a => a !== wb && !/\.(png|jpe?g|gif|bmp|svg|webp|ico)$/i.test(a.name || ''));
    if (others.length)
      $('emailInfo').innerHTML = 'attachments: ' + others.map(a => esc(a.name)).join(', ');
    if (!wb) return;
    const ab = await graphAttachmentBytes(msgId, wb.id);
    const w = await readXlsx(ab, '');
    sheetBuf = ab;
    sheetTabs = w.sheetNames || [];
    sheetTabName = w.sheetName;
    loadSheetRows(w, 'email attachment');
    toast('Tracker loaded from email attachment: ' + wb.name);
  } catch (e) { dbg('attachment load fail', { err: String(e) }); }
}

// Unread mail scored by the same detectors the rest of the pipeline uses
// (extractCodes + delivery vocabulary). Each candidate gets a Load link.
function renderInbox(msgs, quiet) {
  const el = $('inboxList');
  const cands = [];
  let erDirty = false;
  msgs.forEach(m => {
    const body = stripHtmlKeepLinks((m.body && m.body.content) || '');
    const fromAddr = m.from && m.from.emailAddress && m.from.emailAddress.address;
    // Every ER "Spot Delivery Notification" gets parsed into the deliveries
    // registry as it passes through (unread) - agency/advertiser/order +
    // the ISCI list. The match stage can then check what was actually
    // delivered when the request mail lands.
    const er = parseErNotice(m.subject, body, fromAddr);
    if (er && !erDeliveries.some(x => x.id === m.id)) {
      erDeliveries.push({ id: m.id, when: m.receivedDateTime, ...er });
      erDirty = true;
    }
    // Comcast AdDelivery manifests register the same way - their ISCI
    // lists become the delivery ground truth for the agency's request.
    const cm = parseComcastNotice(m.subject, body);
    if (cm && !erDeliveries.some(x => x.id === m.id)) {
      erDeliveries.push({ id: m.id, when: m.receivedDateTime, ...cm });
      erDirty = true;
    }
    const erNotice = isTatariErNotice(m.subject, body, fromAddr) &&
      Date.now() - erBatchAt > ER_BATCH_WINDOW;
    const html = (m.body && m.body.content) || '';
    const yd = parseYangarooHtml(html);
    let dl = yd ? yd.spots : null;
    if (!dl) {
      const cd = parseComcastNotice(m.subject, body), links = comcastDlLinks(html);
      // spot rows and "Spot" anchors share document order - zip them, but
      // never reuse a link: unlinked rows are better skipped than
      // downloaded under a wrong ISCI name.
      if (cd && links.length)
        dl = cd.spots.map((s, i) => ({ id: s.isci || s.id, url: links[i] }))
          .filter(s => s.url);
    }
    // dl present (Yangaroo/Comcast) means live download links - the
    // notice IS the request, even from a no-reply sender.
    if (erNotice || dl || isRequestCandidate(m.subject, body, fromAddr, reqSenders, selfAddr))
      cands.push({ m, body, erNotice, yd, dl });
  });
  if (erDirty) {
    if (erDeliveries.length > 300) erDeliveries = erDeliveries.slice(-300);
    chrome.storage.local.set({ erDeliveries });
  }
  // First Tatari ER notice of the batch is shown once - mark the batch so
  // the ~99 delivery notices behind it stay quiet.
  if (cands.some(c => c.erNotice)) {
    erBatchAt = Date.now();
    chrome.storage.local.set({ erBatchAt });
  }
  if (!cands.length) {
    el.style.display = 'none';
    if (!quiet) toast('No unread request-like emails.');
    return;
  }
  // Deliveries-registry summary: how many ER spot deliveries landed per
  // agency this week. Context for the request mails that follow them.
  const weekAgo = Date.now() - 7 * 864e5;
  const erByAgency = {};
  erDeliveries.forEach(x => {
    if (new Date(x.when).getTime() < weekAgo) return;
    const a = x.agency || 'unknown agency';
    erByAgency[a] = (erByAgency[a] || 0) + (x.codes.length || 1);
  });
  const erTally = Object.keys(erByAgency).length
    ? ' <i>· ER spots delivered this week: ' +
      Object.entries(erByAgency).map(([a, n]) => esc(a) + ' ×' + n).join(', ') + '</i>'
    : '';
  el.style.display = 'block';
  lastInboxCands = cands; // kept for loadMailById (notification deep-links)
  el.innerHTML = '<b>' + cands.length + ' unread request-like email(s):</b>' + erTally +
    cands.map((c, i) => {
      const from = (c.m.from && c.m.from.emailAddress && c.m.from.emailAddress.name) || '';
      const when = String(c.m.receivedDateTime || '').replace('T', ' ').slice(5, 16);
      const folder = folderMap[c.m.parentFolderId] || '';
      const replied = c.m.conversationId && repliedConvs.has(c.m.conversationId);
      // Request-shaped mail filed under a Customers folder we don't have a
      // playbook for: mapped-but-null = known unclassified, absent = a rule
      // folder we've never seen = probably a new client.
      const unmapped = folder &&
        (CLIENT_FOLDERS[folder] === null
          ? ' · <b>unmapped folder</b>'
          : (!(folder in CLIENT_FOLDERS) && customerFolderIds.includes(c.m.parentFolderId)
            ? ' · <b>new client?</b>' : ''));
      return '<div><a href="#" data-ib="' + i + '"><b>load</b></a> ' +
        esc(c.m.subject || '(no subject)') + ' <i>' + esc(from) + ' · ' + esc(when) +
        (folder ? ' · <b>' + esc(folder) + '</b>' : '') + unmapped +
        (replied ? ' · <b>replied ✓</b>' : '') +
        (c.dl ? ' <a href="#" data-ydl="' + i + '"><b>dl ' + c.dl.length + ' spot(s)</b></a>' : '') +
        '</i></div>';
    }).join('');
  el.querySelectorAll('a[data-ib]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    loadInboxCand(cands[parseInt(a.dataset.ib, 10)]);
  }));
  // One-click delivery download: every spot's direct link (Yangaroo or
  // Comcast cad-api) queues into Ingest/ without ever opening the email.
  el.querySelectorAll('a[data-ydl]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    const c = cands[parseInt(a.dataset.ydl, 10)];
    const yc = detectClient({ emailText: c.body, subject: c.m.subject,
      folderName: folderMap[c.m.parentFolderId] || '' });
    const brand = (extractAdvertiser(c.m.subject) || 'delivery')
      .replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
    const d = String(c.m.receivedDateTime || '').slice(0, 10).replace(/-/g, '');
    const cl = yc ? yc.name.split(' (')[0].split(' / ')[0].replace(/[^\w]+/g, '') :
      (c.yd ? 'yangaroo' : 'comcast');
    const job = (d + '-' + cl + '-' + brand).slice(0, 80);
    let n = 0;
    c.dl.forEach(s => {
      const nm = ((s.id || 'spot').replace(/[^\w.-]+/g, '_')) + '.mp4';
      chrome.downloads.download({ url: s.url, filename: 'Ingest/' + nm,
        conflictAction: 'uniquify' }).then(id => ourDlIds.add(id)).catch(() => {});
      n++;
    });
    toast('Queued ' + n + ' spot(s) to Ingest/.');
    dbg('delivery dl', { job, spots: n, order: (c.yd && c.yd.orderId) || '' });
  }));
  // Quiet background polls announce only genuinely new candidates.
  const fresh = cands.filter(c => !inboxSeen.has(c.m.id));
  inboxSeen = new Set(cands.map(c => c.m.id));
  if (quiet && fresh.length) toast(fresh.length + ' new request-like email(s) in inbox.');
  // Structured hits for the delivery watch: what each fresh mail cites
  // (codes/spot ids) and which client it looks like - an unrelated
  // request mail must NOT count as 'delivery arrived'.
  return {
    n: fresh.length,
    hits: fresh.map(c => ({
      subject: c.m.subject || '',
      clientId: (detectClient({ emailText: c.body, subject: c.m.subject,
        folderName: folderMap[c.m.parentFolderId] || '' }) || {}).id || '',
      codes: extractCodes(c.body).concat((c.dl || []).map(s => s.id)).filter(Boolean),
      hasDl: !!c.dl,
      erNotice: !!c.erNotice,
    })),
  };
}

let lastInboxCands = [];
function loadInboxCand(c) {
  if (!c) return;
  const from = c.m.from && c.m.from.emailAddress;
  // Yangaroo deliveries parse off the raw HTML - the Graph body carries
  // the same Download anchors the Outlook-tab scrape looks for.
  yangaroo = parseYangarooHtml((c.m.body && c.m.body.content) || '');
  emailFolderName = folderMap[c.m.parentFolderId] || '';
  setEmailText('From: ' + (from ? (from.name + ' <' + from.address + '>') : '') +
    '\nSubject: ' + (c.m.subject || '') + '\n\n' + c.body, c.m.subject || '', '',
    String(c.m.receivedDateTime || '').replace('T', ' ').slice(0, 16), c.m.id);
  emailFromAddr = (from && from.address) || '';
  // Sheet pops in a background tab - pulls/match run from the export,
  // but the open tab stays ready for "Show on sheet" highlights.
  const sids = sheetIdsFor(client);
  if (sids[0]) chrome.tabs.create({
    url: 'https://docs.google.com/spreadsheets/d/' + sids[0], active: false });
  tryLoadTrackerAttachment(c.m.id);
  toast('Email loaded from inbox.');
}
// A notification deep-link names a message id - load it from the cached
// inbox list, or fetch it directly when the list changed since.
async function loadMailById(id) {
  let c = lastInboxCands.find(x => x.m && x.m.id === id);
  if (!c && MS.refreshToken) {
    try {
      const m = await graphFetch('/me/messages/' + id +
        '?$select=subject,from,receivedDateTime,parentFolderId,conversationId,body');
      c = { m, body: (m.body && m.body.content) || '' };
    } catch (e) { dbg('pendingAction mail fetch fail', { err: String(e) }); }
  }
  if (c) loadInboxCand(c);
  else toast('That email is no longer in the inbox list - use Check inbox.');
}

// While the panel is open, poll quietly every 5 min so a fresh request
// surfaces without the user pressing anything.
setInterval(() => { if (MS.refreshToken) checkInbox(true); }, 5 * 60 * 1000);
// Keep a doc-loaded tracker near-real-time: re-export every 5 min in the
// background. Safe because loadSheetDoc only needs the stored doc id.
setInterval(() => { if (lastSheetRef) refreshSheet(true); }, 5 * 60 * 1000);

// Learned request senders: each confirmed ingest bumps the sender's address
// (trusted at 1) and their domain (trusted at 3), stored across sessions.
function noteConfirmedSender(addr) {
  const a = String(addr || '').toLowerCase();
  if (!a.includes('@') || isAutoSender(a) || a === selfAddr) return;
  const d = a.split('@')[1];
  reqSenders[a] = (reqSenders[a] || 0) + 1;
  // Own domain is never learned - it would bless every colleague's mail at
  // weak-signal level, and real requests still score on content.
  if (d && d !== selfDomain) reqSenders['dom:' + d] = (reqSenders['dom:' + d] || 0) + 1;
  chrome.storage.local.set({ reqSenders });
}
chrome.storage.local.get('reqSenders', d => { reqSenders = d.reqSenders || {}; });
chrome.storage.local.get('erBatchAt', d => { erBatchAt = d.erBatchAt || 0; });
chrome.storage.local.get('msRepliedConvs', d => { repliedConvs = new Set(d.msRepliedConvs || []); });
chrome.storage.local.get('erDeliveries', d => { erDeliveries = d.erDeliveries || []; });
chrome.storage.local.get('msCustomerFolderIds', d => { customerFolderIds = d.msCustomerFolderIds || []; });
chrome.storage.local.get('msFolderActivity', d => { folderActivity = d.msFolderActivity || {}; });
// msLastSheet is deliberately NOT restored - a panel reload is a fresh
// run, so last batch's tracker shouldn't quietly re-pull itself.
// Folder map powers the client tagging on inbox candidates; refresh weekly
// (the folder tree rarely changes). The activity scan rides along - one
// latest-mail call per Customers subfolder feeds the "quiet client" date.
chrome.storage.local.get(['msFolderMap', 'msFolderMapAt'], d => {
  folderMap = d.msFolderMap || {};
  const stale = !d.msFolderMapAt || Date.now() - d.msFolderMapAt > 7 * 864e5;
  if (stale && MS.refreshToken)
    graphFolderMap().then(r => {
      folderMap = r.map || r;
      customerFolderIds = r.custIds || customerFolderIds;
      chrome.storage.local.set({ msFolderMapAt: Date.now() });
      graphFolderActivity(customerFolderIds, folderMap)
        .then(a => { folderActivity = a; })
        .catch(() => {});
    }).catch(() => {});
});
// Sent-template learning: once a day, scan Sent Items for template replies
// and learn every sender on those threads (real confirmed requests).
chrome.storage.local.get('lastLearnAt', d => {
  const due = !d.lastLearnAt || Date.now() - d.lastLearnAt > 864e5;
  if (!due || !MS.refreshToken) return;
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  graphLearnedSenders(since).then(r => {
    (r.senders || []).forEach(noteConfirmedSender);
    (r.convs || []).forEach(c => repliedConvs.add(c));
    if (repliedConvs.size > 500) repliedConvs = new Set([...repliedConvs].slice(-500));
    chrome.storage.local.set({ msRepliedConvs: [...repliedConvs] });
    chrome.storage.local.set({ lastLearnAt: Date.now() });
    dbg('sender learning', { senders: (r.senders || []).length, convs: (r.convs || []).length, scanned: r.scanned });
  }).catch(e => dbg('sender learning fail', { err: String(e) }));
});
chrome.storage.local.get(['msSelfDomain', 'msSelfAddr'], d => {
  selfDomain = d.msSelfDomain || '';
  selfAddr = d.msSelfAddr || '';
  // Learn it once per session if a token exists but it was never captured.
  if (!selfAddr && MS.refreshToken)
    graphSelfDomain().then(() => chrome.storage.local.get(['msSelfDomain', 'msSelfAddr'], x => {
      selfDomain = x.msSelfDomain || ''; selfAddr = x.msSelfAddr || '';
    })).catch(() => {});
});

$('copyLog').addEventListener('click', () => {
  const text = dbgLog.map(e => e.t + ' ' + e.msg + (e.data ? ' ' + JSON.stringify(e.data) : '')).join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Log copied.'));
});
$('clearLog').addEventListener('click', () => { dbgLog = []; chrome.storage.local.set({ dbgLog }); renderDbg(); flushLog(); });
emailEl.addEventListener('input', () => { stamp('tsEmail'); onEmailChange(); saveInputs(); });

// ER-deliveries registry entries that plausibly belong to this request:
// same trafficking agency as the detected client's er.sender, or an
// advertiser/brand the notice names appearing in the email text.
// Window is the client's er.days (Tatari 14d) so stale batches don't leak.
function erRegistryHits(req) {
  const days = (client && client.er && client.er.days) || 14;
  const cutoff = Date.now() - days * 864e5;
  const sender = (client && client.er && client.er.sender || '').toLowerCase();
  const hay = ((emailSubject || '') + '\n' + req).toLowerCase();
  return erDeliveries.filter(x => {
    if (new Date(x.when).getTime() < cutoff) return false;
    if (sender && (x.agency || '').toLowerCase().includes(sender)) return true;
    return [x.advertiser, x.brand].filter(Boolean)
      .some(v => v.length > 3 && hay.includes(v.toLowerCase()));
  });
}

function onEmailChange() {
  const text = emailEl.value;
  // Paste-into-the-box skips setEmailText - recompute the greeting name
  // here too, or replies go out nameless. Cleared when the box empties.
  if (!text.trim()) emailSender = '';
  else if (!emailSender) emailSender = senderFirstName(text);
  if (text.trim()) applyClient(detectClient({ emailText: text, subject: emailSubject, folderName: emailFolderName }), 'email');
  // Brand->doc: an email naming a brand that lives in a known tracker
  // selects that doc; when nothing detected a client at all, the doc's
  // client is the answer (Turo/Zocdoc land on Horizon's doc first).
  const brandHit = docForBrand((emailSubject || '') + '\n' + text);
  if (!client && brandHit) {
    const bc = CLIENTS.find(c => c.id === brandHit.client);
    if (bc) {
      applyClient(bc, 'brand');
      toast('"' + brandHit.brand + '" lives on the ' + bc.name + ' tracker.');
    }
  }
  // Auto-pull the client's known tracker off its mined sheet id - the
  // request email no longer needs to carry the sheet link. Skipped when
  // the right doc (or a manual load) is already in place.
  const sids = sheetIdsFor(client);
  // The reference sheet's Tracker column is the live-editable source of
  // truth: it outranks static playbook ids (a re-share never needs a
  // release) but falls through to them when it can't load.
  const refTr = client && excByClient[client.id] && excByClient[client.id].tracker;
  const refGid = refTr && refTr.match(/\/d\/([\w-]+)/);
  const loadRefTracker = () => !refTr ? Promise.resolve(false)
    : refGid ? loadSheetDoc(refGid[1], 0, '', client.name + ' tracker (reference)')
    : /sharepoint|onedrive/i.test(refTr) ? loadSharePointUrl(refTr)
    : Promise.resolve(false);
  // A loaded sheet counts as current when it's the playbook doc, the
  // reference doc, an Airtable pull, or any SharePoint load - auto-pull
  // must not stomp a tracker already put in place.
  const sheetIsCurrent = sheet && lastSheetRef &&
    (sids.includes(lastSheetRef.id) || (refGid && lastSheetRef.id === refGid[1]) ||
     (brandHit && lastSheetRef.id === brandHit.id) ||
     lastSheetRef.airtable || lastSheetRef.spUrl);
  // A&E keeps its tracker in Airtable - pull the pending views via API
  // when a token is configured, same auto-load slot as doc trackers.
  const aeApi = client && client.id === 'ae-media' && hasAtToken() && !sheetIsCurrent;
  if (client && !client.sheetless && !sheetIsCurrent && sheetAutoLoaded !== client.id) {
    sheetAutoLoaded = client.id;
    // Fallback when the playbook has no doc (or its pull fails): remembered
    // trackers for this client profile, most recent first - but a doc only
    // counts when it actually covers the request's IDs (theatrical vs TV
    // docs can share one family).
    const tryRemembered = async () => {
      const list = await new Promise(res => chrome.storage.local.get('sheetByClient', d => {
        const v = (d.sheetByClient || {})[client.id];
        res(Array.isArray(v) ? v : v ? [v] : []);
      }));
      const label = client.name + ' tracker (remembered)';
      for (const mem of list) {
        if (foreignDoc(mem.id)) continue;
        const ok = mem.spUrl ? await loadSpDownload(mem.spUrl, label, mem.spSrc)
                 : mem.airtable ? await fetchAirtableTracker(label)
                 : mem.id ? await loadSheetDoc(mem.id, mem.gid, '', label) : false;
        if (ok && await sheetCoversRequest()) return true;
      }
      return false;
    };
    const rest = () => sids.length
      ? loadSheetDoc(sids[0], 0, '', client.name + ' tracker').then(ok2 => ok2 || tryRemembered())
      : tryRemembered();
    (aeApi ? fetchAirtableTracker(client.name + ' tracker')
           : loadRefTracker().then(ok => ok ||
             (brandHit ? loadSheetDoc(brandHit.id, 0, '', 'brand-matched tracker (' + brandHit.brand + ')')
                       : Promise.resolve(false))).then(ok => ok || rest()))
      .then(ok => {
        if (!ok) return;
        toast('Auto-loaded the ' + client.name + ' tracker.');
        // The whole point of auto-pull: with codes in the email and a
        // fresh sheet, match can run itself - files are ready to rename
        // and download the moment the user looks at the panel.
        if (!matched && extractCodes(latestSegment(emailEl.value)).length) doMatch();
      });
  }
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
  if (emailSender) bits.push('sender: <b>' + esc(emailSender) + '</b>');
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
  // ER registry cross-check: what the agency actually delivered (ER
  // notices) vs what this request cites. Delivered-but-uncited spots get
  // surfaced; "use delivered IDs" seeds the requested-IDs box from the
  // registry when the request mail is vague ("the batch from this week").
  const erHits = erRegistryHits(req);
  const erCodes = [...new Set(erHits.flatMap(x => x.codes || []))];
  if (erHits.length) {
    const uncited = erCodes.filter(c => !emailCodes.includes(c));
    bits.push('ER registry: <b>' + erHits.length + '</b> notice(s) / ' +
      erCodes.length + ' spot(s) from ' + esc(erHits[0].agency || 'agency') +
      (uncited.length ? ' · <b>' + uncited.length + ' not cited in email</b>' : ' · all cited'));
    if (erCodes.length) bits.push('<a href="#" id="useDeliveredCodes">use delivered IDs</a>');
  }
  // ER-delivered clients: files won't be in the email - the sweep is the
  // path. Preset already applied; note when the registry has no delivery
  // evidence yet so a missing file isn't a surprise.
  if (client && client.delivery === 'extreme-reach' && client.er)
    bits.push('files arrive via Extreme Reach - sweep preset: sender "' +
      esc(client.er.sender) + '"' + (erHits.length ? '' : ' · <b>no delivered registry hits yet</b>'));
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
  const ud = $('useDeliveredCodes');
  if (ud) ud.addEventListener('click', e => {
    e.preventDefault();
    const codes = [...new Set(erRegistryHits(req).flatMap(x => x.codes || []))];
    idsEl.value = codes.join('\n');
    saveInputs();
    toast(codes.length + ' ER-delivered code(s) set as requested IDs.');
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
  modStat('stSheet', 'Loading ' + (sourceLabel || 'tracker') + '…');
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
    // The doc id is all a refresh needs - the open tab going through
    // reloads, navigation, or being closed can't break the pull anymore.
    lastSheetRef = { id, gid: gid || 0, tabName: wb.sheetName };
    chrome.storage.local.set({ msLastSheet: lastSheetRef });
    rememberSheet();
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

// Re-export the last doc-loaded sheet. The tab is irrelevant - refresh,
// navigation, even closing it can't break this, and Match calls it so
// the data is always current at the moment it matters.
async function refreshSheet(quiet) {
  if (!lastSheetRef) return false;
  if (lastSheetRef.airtable) {
    const ok = await fetchAirtableTracker('sheet refresh');
    if (!quiet) toast(ok ? 'Sheet refreshed from Airtable.' : 'Sheet refresh failed.');
    return ok;
  }
  if (lastSheetRef.spUrl) {
    const ok = await loadSpDownload(lastSheetRef.spUrl, 'sheet refresh', lastSheetRef.spSrc);
    if (!quiet) toast(ok ? 'Sheet refreshed from SharePoint.' : 'Sheet refresh failed.');
    return ok;
  }
  const ok = await loadSheetDoc(lastSheetRef.id, lastSheetRef.gid, lastSheetRef.tabName, 'sheet refresh');
  if (!quiet) toast(ok ? 'Sheet refreshed from Google.' : 'Sheet refresh failed.');
  return ok;
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
    // Excel "view" URLs often carry the real file path
    // (/sites/x/Shared Documents/tracker.xlsx) - fetchable via the
    // server-relative REST endpoint.
    try {
      const p = decodeURIComponent(new URL(loc.pageUrl).pathname);
      if (/\.xlsx?$/i.test(p)) {
        const api = "/_api/web/GetFileByServerRelativeUrl('" + encodeURI(p) + "')/$value";
        if (loc.site) cands.push(loc.origin + loc.site + api);
        cands.push(loc.origin + api);
      }
    } catch (e) { /* odd URL - skip */ }
    cands.push(loc.pageUrl + (loc.pageUrl.includes('?') ? '&' : '?') + 'download=1');
    // The classic doc-download endpoint accepts a full doc URL.
    cands.push(loc.origin + '/_layouts/15/download.aspx?SourceUrl=' + encodeURIComponent(loc.pageUrl));
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
          sheetGids = {};
          scoreCache = { key: '', scores: null };
          loadSheetRows(wb, 'SharePoint workbook');
          // The winning download URL IS the refresh handle - without it the
          // stale prior ref (e.g. another client's Google doc) re-fetches
          // and clobbers this sheet on every match-time refresh.
          lastSheetRef = { spUrl: u, viewUrl: loc.pageUrl };
          chrome.storage.local.set({ msLastSheet: lastSheetRef });
          rememberSheet();
          sheetSourceTab = tab;
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

// An open Airtable tab's URL carries base/table/view ids - with a PAT we
// can pull exactly that view via the API instead of fighting the grid's
// clipboard. No token (or API failure) falls through to the copy path.
function airtableUrlIds(url) {
  const m = String(url || '').match(/airtable\.com\/(app\w+)\/(tbl\w+)\/(viw\w+)/);
  return m && { base: m[1], table: m[2], view: m[3] };
}
async function fetchAirtableView(tab) {
  const ids = airtableUrlIds(tab.url);
  if (!ids || !hasAtToken()) return false;
  try {
    const schema = await airtableApi('meta/bases/' + ids.base + '/tables');
    const t = (schema.tables || []).find(x => x.id === ids.table);
    if (!t) throw new Error('table ' + ids.table + ' not in base schema');
    const headers = [], hdr = {};
    (t.fields || []).forEach(f => { hdr[f.name] = headers.length; headers.push(f.name); });
    const urlCols = new Set((t.fields || []).filter(f => f.type === 'url').map(f => hdr[f.name]));
    const rows = [headers], links = {};
    let offset = '', recs = 0;
    do {
      const page = await airtableApi(ids.base + '/' + encodeURIComponent(ids.table) +
        '?view=' + encodeURIComponent(ids.view) + '&pageSize=100' +
        (offset ? '&offset=' + encodeURIComponent(offset) : ''));
      for (const rec of page.records || []) {
        const row = new Array(headers.length).fill('');
        for (const [fname, val] of Object.entries(rec.fields || {})) {
          const ci = hdr[fname];
          if (ci == null) continue;
          const v = Array.isArray(val)
            ? val.map(x => (x && (x.url || x.text || x.filename)) || String(x)).join(', ')
            : (val && typeof val === 'object' ? (val.url || val.text || '') : val);
          row[ci] = String(v == null ? '' : v);
        }
        const ri = rows.length;
        urlCols.forEach(ci => { if (/^https?:/i.test(row[ci])) links[ri + ',' + ci] = row[ci]; });
        rows.push(row); recs++;
      }
      offset = page.offset || '';
    } while (offset);
    if (rows.length < 2) throw new Error('view returned no records');
    sheetBuf = null; sheetTabs = []; sheetTabName = ''; sheetSourceTab = null; sheetGids = {};
    loadSheetRows({ rows, links, sheetName: t.name }, 'Airtable ' + t.name);
    lastSheetRef = { airtable: true, baseName: t.name };
    rememberSheet();
    dbg('airtable view loaded', { table: t.name, view: ids.view, records: recs, links: Object.keys(links).length });
    return true;
  } catch (e) {
    dbg('airtable view api fail', { err: String((e && e.message) || e) });
    return false;
  }
}

// An open Airtable tracker: API pull first (exact view from the tab URL
// when a token is set), else drive the grid's own select-all + copy and
// pull the TSV back off the clipboard with its DOM headers prepended.
// Falls back to manual paste if the app swallows the synthetic events.
async function grabAirtableTab(tab) {
  if (await fetchAirtableView(tab)) return true;
  const noTok = hasAtToken() ? '' : ' - or add an Airtable token in Settings for a direct API pull';
  let res;
  try {
    [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: airtableCopyAll, args: [true] });
  } catch (e) { dbg('airtable inject fail', { err: String(e) }); return false; }
  const r = (res && res.result) || {};
  dbg('airtable copy attempt', { okCopy: r.okCopy, cell: r.cellId, headers: (r.headers || []).length, selected: r.selected, focus: r.focus, domSel: r.domSel });
  if (!r.okCopy) {
    toast('Airtable blocked the auto-copy - click the grid, Cmd+A, Cmd+C, then Paste tracker' + noTok + '.');
    setStage('sdSheet', 'warn', 'Airtable needs a manual copy-paste');
    return false;
  }
  await new Promise(x => setTimeout(x, 600)); // the app writes the clipboard async
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !/\t/.test(text)) {
      dbg('airtable clipboard not TSV', { len: (text || '').length });
      toast('Airtable copy produced nothing - try Cmd+A, Cmd+C on the grid, then Paste tracker' + noTok + '.');
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

// ---------- Airtable REST API ----------
// The clipboard path is fragile and drops link hrefs; the API needs only
// a personal access token. For each table in the base (the three brand
// tabs) we pull the view named like "pending" - the grid is pre-filtered
// to actionable rows - so all three brands arrive in one sheet, tagged
// by table, with real URLs in link fields.
function hasAtToken() { return !!(($('atToken') || {}).value || '').trim(); }

async function airtableApi(path) {
  const tok = $('atToken').value.trim();
  const r = await fetch('https://api.airtable.com/v0/' + path,
    { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

async function fetchAirtableTracker(label) {
  label = label || 'Airtable';
  try {
    const meta = await airtableApi('meta/bases');
    const bases = meta.bases || [];
    const want = ($('atBase').value || '').trim();
    // The A&E tracker base is known - its interface URL gave the id up.
    const base = (want && bases.find(b => b.id === want)) ||
      bases.find(b => b.id === 'appGgCqIhAQcNBCTX') ||
      bases.find(b => /inscape|tracker/i.test(b.name)) ||
      (bases.length === 1 ? bases[0] : null);
    if (!base) throw new Error('no matching base - set Base ID in Settings (' +
      bases.map(b => b.name).join(', ') + ')');
    const schema = await airtableApi('meta/bases/' + base.id + '/tables');
    const tables = schema.tables || [];
    // Pass 1: union headers across tables + pick each table's pending view.
    const headers = ['Table'], hdr = {};
    const plan = [];
    for (const t of tables) {
      (t.fields || []).forEach(f => {
        if (!(f.name in hdr)) { hdr[f.name] = headers.length; headers.push(f.name); }
      });
      const view = (t.views || []).find(v => /pending/i.test(v.name)) ||
        (t.views || [])[0];
      if (!view) { dbg('airtable: no view', { table: t.name }); continue; }
      // Pending filtering may live in the Interface page, not a named
      // grid view - in that case find a status-ish select field whose
      // options name a pending state and filter server-side.
      let formula = '';
      if (!/pending/i.test(view.name)) {
        const sf = (t.fields || []).find(f =>
          (f.type === 'singleSelect' || f.type === 'multipleSelects') &&
          /status|state|stage|queue|ingest/i.test(f.name));
        const opt = sf && (sf.options && sf.options.choices || [])
          .find(c => /pend|queue|new|to.?ingest|await/i.test(c.name || ''));
        if (sf && opt) formula = '{' + sf.name + '}="' + opt.name + '"';
        else dbg('airtable: no pending view or status field', { table: t.name, view: view.name });
      }
      plan.push({ t, view, formula,
        urlCols: (t.fields || []).filter(f => f.type === 'url').map(f => hdr[f.name]) });
      dbg('airtable table', { table: t.name, view: view.name, formula });
    }
    // Pass 2: pull records per table/view (paged), tag rows with the tab.
    const rows = [headers], links = {};
    let recs = 0;
    for (const { t, view, formula, urlCols } of plan) {
      let offset = '';
      do {
        const page = await airtableApi(base.id + '/' + encodeURIComponent(t.id) +
          '?view=' + encodeURIComponent(view.id) + '&pageSize=100' +
          (formula ? '&filterByFormula=' + encodeURIComponent(formula) : '') +
          (offset ? '&offset=' + encodeURIComponent(offset) : ''));
        for (const rec of page.records || []) {
          const row = new Array(headers.length).fill('');
          row[0] = t.name;
          for (const [fname, val] of Object.entries(rec.fields || {})) {
            const ci = hdr[fname];
            if (ci == null) continue;
            const v = Array.isArray(val)
              ? val.map(x => (x && (x.url || x.text || x.filename)) || String(x)).join(', ')
              : (val && typeof val === 'object' ? (val.url || val.text || '') : val);
            row[ci] = String(v == null ? '' : v);
          }
          const ri = rows.length;
          urlCols.forEach(ci => { if (/^https?:/i.test(row[ci])) links[ri + ',' + ci] = row[ci]; });
          rows.push(row); recs++;
        }
        offset = page.offset || '';
      } while (offset);
    }
    if (rows.length < 2) throw new Error('pending views returned no records');
    sheetBuf = null; sheetTabs = []; sheetTabName = ''; sheetSourceTab = null; sheetGids = {};
    loadSheetRows({ rows, links, sheetName: base.name }, label + ' (' + base.name + ')');
    lastSheetRef = { airtable: true, baseName: base.name };
    rememberSheet();
    dbg('airtable loaded', { base: base.name, tables: plan.length, records: recs, links: Object.keys(links).length });
    return true;
  } catch (e) {
    dbg('airtable api fail', { err: String((e && e.message) || e) });
    setStage('sdSheet', 'fail', 'Airtable: ' + ((e && e.message) || e));
    return false;
  }
}

// files.com share pages (aenetworks.files.com/...) are viewers - the real
// binary sits behind a Download click. Open the share in a hidden tab,
// look for a direct download anchor; when the page only exposes a
// scripted button, click it, capture the download's finalUrl, then
// cancel so the caller can re-queue it with the manifest's filename.
async function resolveFileShare(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    for (let i = 0; i < 24; i++) { // ~12s for the SPA to render controls
      await new Promise(r => setTimeout(r, 500));
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const MEDIA = /\.(mp4|mov|mxf|mpg|mpeg|mkv|avi|wmv|m2ts|ts|zip)(\?|#|"|$)/i;
          for (const a of document.querySelectorAll('a[href]')) {
            if (MEDIA.test(a.href) || /\/download|\bdownload=/.test(a.href))
              return { url: a.href, name: decodeURIComponent(a.href.split('/').pop().split('?')[0]) };
          }
          const btn = [...document.querySelectorAll('a,button,[role="button"],input[type="button"],input[type="submit"]')]
            .find(b => /download/i.test((b.innerText || b.value || b.getAttribute('aria-label') || '').trim()));
          return btn ? { click: true } : { pending: true };
        }});
      const r = res && res[0] && res[0].result;
      if (r && r.url) return r;
      if (r && r.click) {
        const got = new Promise(resolve => {
          const onDl = item => { chrome.downloads.onCreated.removeListener(onDl); resolve(item); };
          chrome.downloads.onCreated.addListener(onDl);
          setTimeout(() => { chrome.downloads.onCreated.removeListener(onDl); resolve(null); }, 15000);
        });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
          const btn = [...document.querySelectorAll('a,button,[role="button"],input[type="button"],input[type="submit"]')]
            .find(b => /download/i.test((b.innerText || b.value || b.getAttribute('aria-label') || '').trim()));
          if (btn) btn.click();
        }});
        const item = await got;
        if (item) {
          const out = { url: item.finalUrl || item.url,
                        name: (item.filename || '').split(/[\\/]/).pop() };
          await chrome.downloads.cancel(item.id).catch(() => {});
          await chrome.downloads.erase({ id: item.id }).catch(() => {});
          if (out.url && /^https?:/i.test(out.url)) return out;
        }
        return { error: 'download click produced nothing' };
      }
      if (!await chrome.tabs.get(tab.id).catch(() => null)) break;
    }
    return { error: 'no download control on share page' };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
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
  // A&E's tracker is an Airtable base - with a token the API pulls every
  // brand tab's pending view directly (no copy-paste, real link URLs).
  if (client && client.id === 'ae-media' && hasAtToken() &&
      await fetchAirtableTracker('Airtable API')) return;
  // A tab on a host the email links to IS the email's doc in view - grab
  // it before reaching for the email ref itself.
  const hosts = emailLinkHosts();
  const linked = cands.find(t =>
    hosts.some(h => h && (t.url || '').toLowerCase().includes(h)));
  if (linked) { await grabTrackerTab(linked); return; }
  // The email's own tracker link outranks stray tracker tabs - the doc it
  // names is the doc this request means.
  const ref = emailSheetRefs()[0];
  if (ref) {
    applyClient(detectClient({ sheetId: ref.id }), 'sheet');
    if (await loadSheetDoc(ref.id, ref.gid, '', 'email-linked tracker')) return;
  }
  for (const u of emailSharePointUrls()) {
    if (await loadSharePointUrl(u)) return;
  }
  if (cands.length) { await grabTrackerTab(cands[0]); return; }
  if (await resolveSheetLinks()) return;
  setStage('sdSheet', 'fail', 'no tracker found');
  toast('No tracker found - open the sheet tab or load a file.');
});

let loadTarget = null;
$('loadSheet').addEventListener('click', () => { loadTarget = 'sheet'; $('fileInput').click(); });

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

$('fileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  if (loadTarget === 'email') {
    const r = new FileReader();
    r.onload = () => {
      const eml = /\.eml$/i.test(f.name) ? parseEml(r.result) : { subject: '', body: r.result };
      yangaroo = null;
      setEmailText(String(eml.body || '').trim(), eml.subject, senderFirstName(eml.from), eml.date);
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
        lastSheetRef = null;
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
  r.onload = () => { if (loadTarget === 'sheet') loadSheetText(r.result, f.name); };
  r.readAsText(f);
  e.target.value = '';
});

function loadSheetText(text, sourceLabel) {
  sheetBuf = null; sheetTabs = []; sheetTabName = '';
  sheetSourceTab = null; sheetGids = {};
  lastSheetRef = null;
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
  const fresh = !sheet;   // first load vs a refresh - only collapse on fresh
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
  pendingIdxArr = fbCols.length ? pendingRowIndices(liveRows, fbCols) : [];
  // Pending is a live queue, not all-time unclaimed: trackers carry
  // hundreds of never-filled stale rows (350 "pending" vs 118 real).
  // Keep unclaimed rows dated within ~2 weeks of the NEWEST unclaimed
  // request date; undated rows survive only when nothing unclaimed is
  // dated at all.
  const unclaimedAll = pendingIdxArr.length;
  const dcPend = parseInt($('colDate').value, 10);
  if (pendingIdxArr.length > 1 && dcPend >= 0) {
    const dated = pendingIdxArr.map(i => ({ i, ms: cellDateMs(liveRows[i][dcPend]) }))
      .filter(x => !isNaN(x.ms));
    if (dated.length) {
      const cutoff = Math.max.apply(null, dated.map(x => x.ms)) - 14 * 864e5;
      pendingIdxArr = dated.filter(x => x.ms >= cutoff).map(x => x.i);
    }
  }
  pendingRows = pendingIdxArr.map(i => liveRows[i]);
  modStatDone('stSheet', liveRows.length + ' rows · ' + pendingRows.length + ' pending');
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
      ? ' <a href="#" id="usePending"><b>' + pendingRows.length + '</b> pending row(s)' +
        (unclaimedAll > pendingRows.length ? ' (of ' + unclaimedAll + ' unclaimed - recent dates only)' : ' (fill-back empty)') +
        ' - use as requested IDs</a>'
      : '');
  // Clean fresh load (ID column mapped) -> collapse step 2, matching is next.
  // Stays open on a column-pick need or a background refresh.
  if (fresh && idcNow >= 0) $('sec2').open = false;
  const up = $('usePending');
  if (up) up.addEventListener('click', e => {
    e.preventDefault();
    const idc = parseInt($('colId').value, 10);
    if (idc < 0) return toast('Pick the ID column first.');
    idsEl.value = pendingRows.map(r => String(r[idc] || '').trim()).filter(Boolean).join('\n');
    saveInputs();
    // Get-ahead mode (Tatari trafficks files before the request email):
    // with no email yet, commit the pending rows as the match set so
    // download, portal fill and the Jira draft all run off the sheet
    // alone - the email can land whenever it wants.
    if (!emailEl.value.trim()) {
      const c = currentCols(), hRow = Math.max(1, parseInt($('headerRow').value, 10) || 1);
      const fresh = pendingRows.map((r, k) => {
        const get = kk => c[kk] >= 0 ? String(r[c[kk]] || '').trim() : '';
        const id = get('id'), title = get('title');
        return {
          row: pendingIdxArr[k] + hRow + 1, id, title,
          trackingId: (id.trim() && !/^\d+\.\d+$/.test(id.trim()) ? id.trim() : '') || title || id,
          fileName: get('file'), brand: get('brand'),
          matchType: 'PENDING',
          linkText: get('link'), link: firstUrl(get('link')),
          access: c.access >= 0 ? truthyFlag(get('access')) : null,
          espn: (c.espn >= 0 && truthyFlag(get('espn'))) || tickerAlways(),
          date: get('date'),
        };
      }).filter(m => m.id || m.trackingId);
      if (fresh.length) {
        matched = mergeMatches(fresh);
        matchedFor = emailEl.value;
        presentMatches();
        setStage('sdMatch', 'ok', fresh.length + ' pending row(s) committed (no email yet)');
      }
    }
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
    // Playbook column pin overrides the guess: amcn's sheet carries an
    // ISCI column of source codes while a further-right 'Tracking ID'
    // column waits for OUR confirmation - the pin picks ISCI every time.
    const pin = client && client.cols && client.cols[c.key];
    if (pin) {
      const p = sheet.headers.findIndex(h => pin.test(String(h)));
      if (p >= 0) sel.value = p;
    }
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
  modStat('stMatch', 'Matching…');
  if (!sheet) {
    // Sheetless path (Comscore + tracker-less clients): the email's own
    // cited IDs become the match set - downloads, portal fill, Jira and
    // replies all consume `matched` downstream either way.
    if (!emailEl.value.trim()) { toast('Add the request email first (step 1).'); setStage('sdMatch', 'warn', 'needs the request email'); return false; }
    return doEmailMatch();
  }
  if (!emailEl.value.trim()) { toast('Add the request email first (step 1).'); setStage('sdMatch', 'warn', 'needs the request email'); return false; }
  let cols = currentCols();
  // Wrong-tab guard: score every workbook tab against the requested
  // codes BEFORE matching - a tab holding none of them produces only
  // guesswork that looks like matches. Best coverage wins; the open
  // sheet follows the switch so the flip is visible, not silent.
  // Score the email's own cited codes only: idsEl is repopulated from the
  // previous match's IDs, and those stale codes can out-score the freshly
  // grabbed tab and drag the sheet back to the old request's tab.
  const emailCodes = extractCodes(latestSegment(emailEl.value));
  const reqCodes = [...new Set(emailCodes.length ? emailCodes
    : idsEl.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
  const scores = await sheetTabScores(reqCodes);
  if (scores) {
    const cur = scores.find(s => s.name === sheetTabName) || { name: sheetTabName, hits: 0 };
    const best = [...scores].sort((a, b) => b.hits - a.hits)[0];
    if (best && best.hits > cur.hits) {
      await switchSheetTab(best.name,
        cur.hits + ' of ' + reqCodes.length + ' requested IDs were on "' + cur.name +
        '", ' + best.hits + ' are on "' + best.name + '"');
      cols = currentCols();
    } else if (reqCodes.length && best && best.hits === 0) {
      dbg('match guard: requested codes appear on no tab',
        { codes: reqCodes.length, tabs: scores.map(s => s.name) });
    }
  }

  // An unmapped ID column must not block matching - code needles hit
  // whole rows regardless. The user picks it afterward for clean IDs.
  const idUnmapped = cols.id < 0;
  if (idUnmapped) toast('No ID column mapped - matching anyway; pick it for correct tracking IDs.');

  const headerRow = Math.max(1, parseInt($('headerRow').value, 10) || 1);
  const dataRows = sheet.allRows.slice(headerRow);

  // Column sanity: the resolved ID/title columns must actually hold
  // ID-shaped / title-shaped values. A stale or shifted pick (observed:
  // 'Spot Length' mapped as ID -> every tracking ID read as '30.0')
  // poisons file names, the manifest, and portal fills - so when the
  // values fail the shape test and the vocab guess disagrees, re-guess.
  const pinId = client && client.cols && client.cols.id;
  const idFix = guessField(sheet.headers, 'trackingId', dataRows, sheet.groupRow);
  if (cols.id >= 0 && idFix >= 0 && idFix !== cols.id && !pinId &&
      !colLooksLike(dataRows, cols.id, 'trackingId') &&
      colLooksLike(dataRows, idFix, 'trackingId')) {
    dbg('col fix', { field: 'id', was: sheet.headers[cols.id], now: sheet.headers[idFix] });
    toast('ID column was "' + sheet.headers[cols.id] + '" - using "' + sheet.headers[idFix] + '"');
    cols.id = idFix; $('colId').value = idFix;
  }
  const tFix = guessField(sheet.headers, 'spotTitle', dataRows, sheet.groupRow);
  if (cols.title >= 0 && tFix >= 0 && tFix !== cols.title &&
      !colLooksLike(dataRows, cols.title, 'spotTitle') &&
      colLooksLike(dataRows, tFix, 'spotTitle')) {
    dbg('col fix', { field: 'title', was: sheet.headers[cols.title], now: sheet.headers[tFix] });
    cols.title = tFix; $('colTitle').value = tFix;
  }

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
  if (!fresh.length) {
    // A cited code above the detected header row gets sliced out of
    // dataRows before matching - say so instead of a bare no-match.
    const ndl = extractCodes(matchText)
      .map(c => normalizeName(c).replace(/[\s:_-]+/g, '')).filter(n => n.length >= 6);
    const sliced = sheet.allRows.slice(0, headerRow)
      .map((r, i) => ndl.some(n => normalizeName(r.join(' ')).replace(/[\s:_-]+/g, '').includes(n)) ? i + 1 : 0)
      .filter(Boolean);
    setStage('sdMatch', 'fail', 'no rows matched');
    modStat('stMatch', 'No rows matched.');
    toast(sliced.length
      ? 'Cited code(s) sit at row ' + sliced.slice(0, 5).join(', ') + ' - above the detected header (row ' +
        headerRow + '). Lower the Header row and re-match.'
      : ndl.length
        ? 'No rows matched - the email cites ' + ndl.length +
          ' code(s) absent from this sheet. Wrong tracker, or rows not added yet?'
        : 'No sheet rows matched anything in that email.');
    return false;
  }
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
  modStatDone('stMatch', fresh.length + ' row(s) matched' +
    (fresh.some(m => m.matchType === 'GUESS') ? ' (some guessed)' : ''));
  if (idUnmapped) {
    setStage('sdMatch', 'warn', 'matched, but no ID column mapped - pick it for correct tracking IDs');
  }
  return true;
}

// Sheetless matching: no tracker at all. Build pseudo-rows from the
// email itself - spot blocks (code+title+link), code+title pairs, bare
// codes, then filename-style ids (Comscore "File Name" lists). Richest
// sources first so titles/links land on the same row object. Everything
// downstream (downloads, manifest, portal fill, Jira, replies) reads
// `matched` generically - row 0 just means "not a sheet row".
function doEmailMatch() {
  const matchText = latestSegment(emailEl.value) || emailEl.value;
  const found = new Map();
  const put = (id, o) => {
    const k = normalizeName(id).replace(/[\s:_-]+/g, '');
    if (!k) return;
    const cur = found.get(k) ||
      { id, trackingId: id, title: '', link: '', fileName: String(id), matchType: 'EMAIL', row: 0, espn: tickerAlways() };
    if (o && o.title && !cur.title) cur.title = o.title;
    if (o && o.link && !cur.link) cur.link = o.link;
    found.set(k, cur);
  };
  (emailSpots || []).forEach(s => put(s.id, { title: s.title, link: s.url }));
  (emailPairs || []).forEach(p => put(p.id, { title: p.title }));
  extractCodes(matchText).forEach(c => put(c));
  extractFileIds(matchText).forEach(c => put(c));
  // Direct-link manifests (DataPlusMath, generic "ID link" lines): a line
  // holding exactly one URL and one-or-more codes pairs them, covering
  // layouts the spot-block scan doesn't know. put() never overwrites a
  // link the block pass already found.
  matchText.split(/\r?\n/).forEach(line => {
    const urls = extractLinks(line);
    // Never let a tracker/portal/boilerplate URL pose as a file download.
    if (urls.length !== 1 ||
        /docs\.google|spreadsheets|sharepoint\.com\/sites|airtable\.com|cognet\.tv|unsubscribe|support\.|privacy|terms\./i.test(urls[0])) return;
    extractCodes(line).concat(extractFileIds(line)).forEach(c => put(c, { link: urls[0] }));
  });
  const fresh = [...found.values()];
  // Sheetless brand: subject-derived advertiser wins; the playbook's
  // emailBrand regex (DPM's "fingerprint for GM") is the fallback, since
  // there's no sheet column to supply Advertiser/Brand/Vertical.
  const ing = (client && client.ingest) || {};
  if (ing.advertiser) {
    const eb = detectedAdvertiser ||
      (client && client.emailBrand ? String(((matchText.match(client.emailBrand) || [])[1] || '')).replace(/[.!,;:]+$/, '').trim() : '');
    if (eb) fresh.forEach(m => { if (!m.brand) m.brand = eb; });
  }
  if (!fresh.length) {
    setStage('sdMatch', 'warn', 'email cites no IDs');
    toast('Nothing citable in that email - no IDs or filenames to build rows from.');
    return false;
  }
  matchCols = {};
  stamp('tsMatch');
  dbg('email match', { rows: fresh.length, client: client && client.id,
    ids: fresh.slice(0, 15).map(m => m.id) });
  matched = mergeMatches(fresh);
  presentMatches();
  setStage('sdMatch', 'ok', fresh.length + ' row(s) from email (no tracker)');
  modStatDone('stMatch', fresh.length + ' row(s) from email (no tracker)');
  return true;
}

// Sheetless clients never run a sheet match - any stage that needs rows
// (ingest push, verify, Jira) builds them from the email on demand.
function ensureMatchRows() {
  if ((!matched || !selectedMatches().length) && client && client.sheetless)
    doEmailMatch();
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
  // 'ROW (out of range)' rows carry no identity - they're placeholders
  // from citing line numbers that didn't exist on the sheet then
  // loaded. Carrying them into a re-match just litters the table.
  const carried = matched.filter(m => !m.excluded && !freshKeys.has(key(m)) &&
    m.matchType !== 'ROW (out of range)')
    .map(m => ({ ...m, offSheet: true }));
  return fresh.concat(carried);
}

$('match').addEventListener('click', async () => {
  // Fresh data at match time - the sheet may have gained rows since the
  // last manual pull, and doc-loaded sheets can always re-export by id.
  await refreshSheet(true);
  doMatch();
});

// Row exclusion toggle: the flag lives on the match object; re-presenting
// re-derives every downstream surface (ids box, download button, reply,
// portal feed) from the still-selected rows.
$('matchResults').addEventListener('click', e => {
  // Row number -> highlight that row on the tracker (opens it in a
  // background tab when it isn't open).
  const rl = e.target.closest('a.rowlink');
  if (rl) {
    e.preventDefault();
    const m = (matched || []).find(x => x.row === +rl.dataset.srow);
    highlightSheetRows([+rl.dataset.srow], m && (m.id || m.trackingId || ''));
    return;
  }
  const x = e.target.closest('[data-xi]');
  if (!x || !matched) return;
  const m = matched[+x.dataset.xi];
  if (!m) return;
  m.excluded = !m.excluded;
  presentMatches(true);
});

// Everything that runs once `matched` is final: link/spot joins, results
// table, requested-ID seeding, and the delivery-path pick. Rows the user
// excluded (x in the first column) stay listed but drive nothing -
// `sel` is what every downstream stage sees.
const selectedMatches = () => (matched || []).filter(m => !m.excluded);
// Row numbers deep-link into the tracker when a Google Sheet backs the
// match (the range anchor selects them); offSheet rows came from an
// earlier workbook - their numbers would highlight the wrong line.
const sheetRowCell = m => m.row > 0 && !m.offSheet && sheetRef()
  ? '<a href="#" class="rowlink" data-srow="' + m.row + '" title="highlight row ' + m.row + ' on the tracker">' + m.row + '</a>'
  : m.row;
function presentMatches(quiet) {
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
      // Mapped link column first; any other hyperlink on the row after
      // (InMarket's tracker carries links in H/I/J - a strict column map
      // drops rows whose link lives in a neighbor).
      const rk = (m.row - 1) + ',';
      const u = sheet.links[rk + matchCols.link] ||
        Object.keys(sheet.links).filter(k => k.startsWith(rk))
          .map(k => sheet.links[k]).find(u => /^https?:/i.test(u));
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
  const rows = matched.map((m, i) =>
    '<tr' + (m.excluded ? ' class="excl"' : '') + '>' +
    '<td class="xcell"><span class="xbtn" data-xi="' + i + '" title="' +
      (m.excluded ? 'include this row in the run' : 'exclude this row - downloads, manifest, portal and replies will skip it') + '">' +
      (m.excluded ? '&#8635;' : '&#10005;') + '</span></td>' +
    '<td>' + sheetRowCell(m) + '</td><td>' + esc(m.id || '(no id)') + '</td>' +
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
    '<table><thead><tr><th></th><th>Row</th><th>ID</th><th>Title</th><th>Match</th><th>ESPN/Access</th><th>Date</th><th>Link</th></tr></thead><tbody>' +
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
  const sel = selectedMatches();
  const nDl = sel.filter(m => /^https?:/i.test(m.link || '') || m.yangarooUrl).length;
  const dlBtn = $('download');
  if (nDl) {
    dlBtn.textContent = '↓ Download ' + nDl + ' linked';
    dlBtn.classList.remove('hidden');
    $('sec4').open = false;
  } else if (sel.length) {
    // No downloadable links but rows are committed: the button still
    // writes the manifest so the watcher reconciles manual drops (FTP,
    // portal, viewer downloads) and builds ticker versions on arrival.
    dlBtn.textContent = 'Write manifest - ' + sel.length + ' file(s) manual';
    dlBtn.classList.remove('hidden');
    $('sec4').open = true;
  } else {
    dlBtn.classList.add('hidden');
    $('sec4').open = true;
  }
  // Live verification button: Google docs get native row selection,
  // SharePoint workbooks open positioned at the row with the ID staged
  // for Cmd+F. Only file-uploaded sheets have nothing to open.
  $('showSheet').classList.toggle('hidden', !(sheetRef() && sel.length));

  // Feed the reconcile box + suggest a job folder name.
  idsEl.value = sel.map(m => m.id).filter(Boolean).join('\n');
  const nLinks = sel.filter(m => m.link).length;
  const nEspn = sel.filter(m => m.espn).length;
  const nCarried = sel.filter(m => m.offSheet).length;
  const nExcl = matched.length - sel.length;
  const newCount = extractNewCount(emailEl.value);
  setStage('sdMatch', sel.length ? 'ok' : 'warn', sel.length + ' row(s) selected' +
    (nExcl ? ' · ' + nExcl + ' excluded' : '') +
    (missed.length ? ' · ' + missed.length + ' cited code(s) not on this tab' : '') +
    (nCarried ? ' · ' + nCarried + ' carried from earlier sheet(s)' : ''));
  if (!quiet) toast(sel.length + ' rows matched (' + nLinks + ' with links, ' + nEspn + ' ESPN)' +
    (nExcl ? ', ' + nExcl + ' excluded' : '') +
    (nCarried ? ', ' + nCarried + ' carried from earlier sheet(s)' : '') +
    (newCount && newCount !== sel.length ? ' — note: email said ' + newCount + ' new' : '') + '.');
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

// Live verification: what workbook sits behind the loaded sheet.
// Google docs get the #gid=&range= anchor (rows selected natively);
// SharePoint workbooks get their page URL + ?activeCell= positioning -
// Excel web has no range anchor, so the cursor lands on the row and the
// ID goes on the clipboard for a Cmd+F fallback.
function sheetRef() {
  if (lastSheetRef && lastSheetRef.id) return { kind: 'google', id: lastSheetRef.id };
  if (lastSheetRef && (lastSheetRef.viewUrl || lastSheetRef.spUrl)) {
    const u = spViewUrl(lastSheetRef);
    if (u) return { kind: 'sp', url: u };
  }
  if (sheetSourceTab) {
    const g = sheetSourceTab.url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (g) return { kind: 'google', id: g[1] };
    if (/sharepoint\.com/i.test(sheetSourceTab.url)) return { kind: 'sp', url: sheetSourceTab.url };
  }
  return null;
}
function spViewUrl(ref) {
  if (ref.viewUrl) return ref.viewUrl;
  try {
    const m = (ref.spUrl || '').match(/GetFileByServerRelativeUrl\('([^']+)/i);
    if (m) return new URL(ref.spUrl).origin + decodeURIComponent(m[1]);
    const g = (ref.spUrl || '').match(/GetFileById\((?:guid')?([0-9a-fA-F-]{36})/i);
    if (g) return new URL(ref.spUrl).origin + '/_layouts/15/Doc.aspx?sourcedoc={' + g[1] + '}';
    const s = (ref.spUrl || '').match(/SourceUrl=([^&]+)/i);
    if (s) return decodeURIComponent(s[1]);
  } catch (e) { /* odd URL - no view */ }
  return '';
}
function sheetTabGid() {
  const g = (sheetGids || {})[sheetTabName] ??
    (lastSheetRef && lastSheetRef.tabName === sheetTabName ? lastSheetRef.gid : '');
  return g == null ? '' : String(g);
}
async function highlightSheetRows(rows, search) {
  rows = (rows || []).filter(r => r > 0).sort((a, b) => a - b);
  if (!rows.length) return null;
  const lo = rows[0], hi = Math.min(rows[rows.length - 1], lo + 199);
  const ref = sheetRef();
  if (!ref) return null;
  if (ref.kind === 'sp') {
    // No range anchor for Excel web: ?activeCell= aims the cursor at the
    // top row (best-effort - ignored where the editor doesn't honor it),
    // and the ID lands on the clipboard for Cmd+F + Cmd+V.
    const url = ref.url.split('#')[0] +
      (ref.url.includes('?') ? '&' : '?') +
      'activeCell=' + encodeURIComponent(sheetTabName + '!A' + lo);
    let opened = false;
    if (sheetSourceTab && /sharepoint\.com/i.test(sheetSourceTab.url || '')) {
      try { await chrome.tabs.update(sheetSourceTab.id, { url, active: true }); }
      catch (e) { sheetSourceTab = null; }
    }
    if (!sheetSourceTab) {
      sheetSourceTab = await chrome.tabs.create({ url, active: false });
      opened = true;
    }
    if (search) try { await navigator.clipboard.writeText(search); } catch (e) {}
    return { lo, hi, opened, kind: 'sp', search: search || '' };
  }
  const gid = sheetTabGid();
  if (sheetSourceTab && gid !== '') {
    try {
      await chrome.tabs.update(sheetSourceTab.id, {
        url: sheetSourceTab.url.split('#')[0] + '#gid=' + gid + '&range=' + lo + ':' + hi,
        active: true });
      return { lo, hi, opened: false, kind: 'google' };
    } catch (e) { sheetSourceTab = null; } // tab died - reopen below
  }
  const url = 'https://docs.google.com/spreadsheets/d/' + ref.id + '/edit' +
    (gid !== '' ? '#gid=' + gid + '&range=' + lo + ':' + hi : '');
  const t = await chrome.tabs.create({ url, active: false });
  // It becomes the live tab: later highlights navigate it in place.
  sheetSourceTab = t;
  if (gid !== '') sheetGids[sheetTabName] = String(gid);
  return { lo, hi, opened: true, kind: 'google', targeted: gid !== '' };
}
async function showOnSheet() {
  if (!(matched || []).length) return false;
  const sel = matched.filter(m => !m.excluded && !m.offSheet && m.row > 0);
  if (!sel.length) return toast('Nothing on the loaded sheet to highlight.');
  const r = await highlightSheetRows(sel.map(m => m.row), sel[0].id || sel[0].trackingId || '');
  if (!r) return toast('No tracker workbook behind this match.');
  toast(r.kind === 'sp'
    ? 'Workbook ' + (r.opened ? 'opened in a background tab' : 'focused') + ' at row ' + r.lo +
      (r.search ? ' - Cmd+F then paste jumps to "' + r.search + '"' : '')
    : 'Highlighting rows ' + r.lo + '-' + r.hi + ' on tab "' + sheetTabName + '"' +
      (r.opened ? (r.targeted ? ' - opened in a background tab.' : ' - opened; pick the "' + sheetTabName + '" tab there.') : '.'));
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
      '<td>' + sheetRowCell(m) + '</td><td>' + esc(m.id || '(no id)') + '</td><td>' + esc(m.title) + '</td>' +
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
// The draft is editable - once the user touches it, auto-refresh keeps
// their text and only updates the self-check line. "↻ Redraft" clears the
// dirty flag to regenerate from current state.
let replyDirty = false;
function updateReplyCheck() {
  const wanted = [...new Set(extractCodes(latestSegment(emailEl.value)))];
  const body = normalizeName($('replyPreview').value).replace(/ /g, '');
  const missing = wanted.filter(c => !body.includes(normalizeName(c).replace(/ /g, '')));
  $('replyCheck').innerHTML =
    (emailSender ? 'greeting: "Hi ' + esc(emailSender) + ',"' : 'greeting: "Hi," (sender unknown)') +
    ' · ' + (wanted.length
      ? (missing.length
        ? '<span style="color:#ec9a9a">' + missing.length + ' requested ID(s) NOT in reply: ' + missing.map(esc).join(', ') + '</span>'
        : 'all ' + wanted.length + ' requested ID(s) in reply')
      : 'no IDs cited in email');
}

// Where the reconcile just looked for files - for the "not available"
// reply ("not yet available on Extreme Reach"). Playbook delivery route
// names it; the ER sweep is the common case.
function dlChannelName() {
  const d = (client && client.delivery) || '';
  return ({ 'extreme-reach': 'Extreme Reach', yangaroo: 'Yangaroo', vimeo: 'Vimeo',
    links: 'the emailed download links',
    dropbox: 'Dropbox', egnyte: 'Egnyte', onedrive: 'OneDrive', sharepoint: 'SharePoint',
    box: 'Box', 'google-drive': 'Google Drive' })[d] || 'Extreme Reach';
}

// Manual draft variants - the escape hatch for when the run state doesn't
// match reality (files ARE delivered but the sweep/page couldn't see
// them). Sources IDs from matched rows first, email codes second.
// The watcher ffprobes each landed file; failures land here so the reply
// can cite them. Returns true when the list changed (draft should rebuild).
async function checkSpecFails() {
  const job = jobSlug();
  let list = null;
  try {
    const r = await fetch('http://127.0.0.1:8770/spec-failures?job=' + encodeURIComponent(job));
    list = ((await r.json()) || {}).failures || [];
  } catch (e) { list = null; }
  if (list === null) return false;      // watcher not reachable - keep stale
  const prevIds = new Set((specFails || []).map(f => f.id));
  const fresh = list.filter(f => !prevIds.has(f.id));
  const changed = specFailsJob !== job ||
    JSON.stringify(list.map(f => f.id)) !== JSON.stringify((specFails || []).map(f => f.id));
  specFails = list; specFailsJob = job;
  if (fresh.length) {
    const msg = fresh.map(f => f.id).join(', ') + ' failed the spec check';
    setStage('sdDl', 'warn', msg);
    toast('Spec check: ' + msg + ' - "Spec failure" reply variant covers it.');
    alertSound('warn', 'spec_fail ' + fresh.map(f => f.id).join(','),
      'Spec check failed on ' + fresh.map(f => f.id).join(', '));
  }
  return changed;
}

// Spec rejects land in the watcher while the panel sits open - poll so
// the warning (and the unfocused chime) surfaces without a refresh.
setInterval(() => { if (jobSlug()) checkSpecFails(); pollWatchEvents(); }, 30000);

// Watcher-side alert events (notification pops, afplay verdicts) make
// sound with no in-panel explanation - surface each in the alert box so
// a heard tone is identifiable after the fact. Panel-open timestamp
// seeds `since` so historical events don't flood the box.
watchSince = Date.now() / 1000;
async function pollWatchEvents() {
  try {
    const r = await fetch('http://127.0.0.1:8770/watch-events?since=' + watchSince);
    if (!r.ok) return;
    const j = await r.json();
    (j.events || []).forEach(e => {
      watchSince = Math.max(watchSince, e.t);
      showAlertBox('watcher', e.msg, 'watcher ' + e.kind + ' · already sounded', false);
    });
  } catch (e) { /* watcher down - stay silent */ }
}

function manualReply(kind) {
  const rows = (matched || []).filter(m => !m.excluded && m.matchType !== 'ROW (out of range)');
  const ids = rows.length
    ? rows.map(m => m.trackingId || m.title || m.id).filter(Boolean)
    : [...new Set(extractCodes(latestSegment(emailEl.value)))];
  if (kind === 'specfail') {
    // Refetch - the watcher may have probed more files since last check.
    checkSpecFails().then(changed => { if (changed) refreshReply(true); });
    const failIds = new Set((specFails || []).map(f => f.id));
    return buildSpecFailReply(specFails || [], ids.filter(i => !failIds.has(i)), emailSender);
  }
  if (kind === 'missing')
    return buildNotAvailableReply(
      (ids.length ? ids : ['(request)', '(request)']).map(id => ({ id, status: 'MISSING' })),
      dlChannelName(), emailSender);
  if (!ids.length) return null;
  if (kind === 'received')
    return buildConfirmationEmail(ids.map(id => ({ id, status: 'FOUND' })), emailSender);
  // 'ingest' - matched rows carry espn/title extras; bare IDs still draft
  return buildMatchConfirmation(rows.length ? rows : ids.map(id => ({ trackingId: id })), emailSender);
}

function refreshReply(force) {
  const area = $('replyArea');
  const kind = ($('replyKind') && $('replyKind').value) || 'auto';
  let text = null;
  if (kind !== 'auto') {
    text = manualReply(kind);
    if (!text) toast('Nothing to draft - no IDs or rows to cite.');
  } else if (lastResults) {
    // Spec rejects trump other drafts - a bad file is the actionable news.
    // Refetch quietly; a change rebuilds the preview unless user edited.
    checkSpecFails().then(changed => { if (changed) refreshReply(true); });
    const espnIds = new Set();
    (matched || []).forEach(m => {
      if (m.excluded || !m.espn) return;
      [m.id, m.trackingId].filter(Boolean).forEach(v =>
        espnIds.add(normalizeName(v).replace(/ /g, '')));
    });
    const okIds = lastResults.filter(r => r.status === 'FOUND').map(r => r.id);
    // All-missing must NOT fall through to the "I've ingested" draft -
    // nothing was downloaded, the reply says so instead.
    text = buildSpecFailReply(specFails || [], okIds, emailSender) ||
      buildNotAvailableReply(lastResults, dlChannelName(), emailSender) ||
      buildReconConfirmation(lastResults, espnIds, emailSender) ||
      buildConfirmationEmail(lastResults, emailSender);
  }
  if (!text && matched && kind === 'auto' && selectedMatches().length)
    text = buildMatchConfirmation(selectedMatches(), emailSender);
  // Bare request, nothing matched or downloaded yet: still draft the
  // receipt ack - a partial reply beats an empty box.
  if (!text && kind === 'auto')
    text = buildAckReply([...new Set(extractCodes(latestSegment(emailEl.value)))], emailSender);
  if (!text) { area.classList.add('hidden'); setStage('sdReply'); return; }
  area.classList.remove('hidden');
  const det = area.closest('details');
  if (det && !det.open) det.open = true;
  setStage('sdReply', 'ok', 'reply drafted');
  if (force || !replyDirty) { $('replyPreview').value = text; replyDirty = false; }
  updateReplyCheck();
}

$('replyPreview').addEventListener('input', () => { replyDirty = true; updateReplyCheck(); });
$('redraftReply').addEventListener('click', () => refreshReply(true));
$('replyKind').addEventListener('change', () => { replyDirty = false; refreshReply(true); });
$('clearReply').addEventListener('click', () => {
  $('replyPreview').value = ''; replyDirty = false; updateReplyCheck();
});

$('copyReply').addEventListener('click', () => {
  const t = $('replyPreview').value;
  if (t) copyText(t, 'Reply');
});

// Posts the draft (with any user edits) as a reply draft on the source
// thread. Only works when the email came via the Graph inbox - the user
// reviews and sends in Outlook.
$('draftReplyOut').addEventListener('click', async () => {
  const t = $('replyPreview').value.trim();
  if (!t) return toast('No reply draft to send.');
  if (!emailGraphId) return toast('Only for emails loaded via Check inbox - this one has no thread id.');
  try {
    await graphReplyDraft(emailGraphId, t);
    toast('Reply draft created - review and send it in Outlook.');
  } catch (e) {
    toast('Reply draft failed: ' + e.message);
    // Consent gap: the next Sign in asks for Mail.ReadWrite on top of the
    // already-approved Mail.Read.
    if (/403|401|re-consent|readwrite/i.test(String(e.message))) {
      msWantWrite = true;
      showMsSetup();
      $('msMsg').textContent = ' write access needs one more consent - hit Sign in again.';
    }
  }
});
$('copyExcReply').addEventListener('click', () => {
  const t = lastResults && buildExceptionEmail(lastResults, emailSender);
  if (t) copyText(t, 'Exception reply');
  else toast('Nothing to report - no missing or ambiguous results.');
});

// List a Drive folder's files by scraping the real folder page in a
// hidden tab. embeddedfolderview is dead (Google retired the endpoint);
// the live page renders entries as [data-id] rows under the user's own
// Google session, which covers both link-shared and account-shared
// folders. Tab closes when done.
async function fetchDriveListing(folderId) {
  const tab = await chrome.tabs.create({
    url: 'https://drive.google.com/drive/folders/' + folderId, active: false });
  try {
    for (let i = 0; i < 20; i++) { // ~10s budget - entries stream in as Drive renders
      await new Promise(r => setTimeout(r, 500));
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => [...document.querySelectorAll('[data-id]')].map(el => {
          let name = '';
          const tt = el.querySelector('[data-tooltip]');
          if (tt) name = (tt.getAttribute('data-tooltip') || '').trim();
          // Deepest element whose text ends in a filename extension -
          // isolates the file name from dates/owners in the same row.
          if (!name || !/\.\w{2,5}$/.test(name)) {
            const leaf = [...el.querySelectorAll('*')]
              .find(n => !n.children.length && /\.\w{2,5}$/.test((n.textContent || '').trim()));
            if (leaf) name = leaf.textContent.trim();
          }
          return { id: el.getAttribute('data-id'), name };
        }).filter(x => /^[\w-]{20,}$/.test(x.id || '') && /\.\w{2,5}$/.test(x.name || ''))
          .slice(0, 200),
      }).catch(() => null);
      const files = res && res[0] && res[0].result;
      if (files && files.length) return files;
      if (!await chrome.tabs.get(tab.id).catch(() => null)) break;
    }
    return [];
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
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
  if (/egnyte\.com/i.test(u) && /\/(fl|fs|dd|hs|fsc|ul)\//i.test(u)) return 'egnyte';
  if (/wetransfer\.com|\bwe\.tl\b|hightail\.com|frame\.io|\bf\.io\b|aspera|signiant|app\.box\.com|box\.com\/s\//i.test(u))
    return 'viewer';
  return 'file';
}

// Direct-download path for matched rows carrying real URLs (Drive folder,
// MediaSilo, Yangaroo, plain links). Queues files + manifest.
// URL-protector wrappers (Mimecast, SafeLinks, Proofpoint urldefense):
// unwrap to the real file URL before chrome.downloads - the browser
// follows 302s but NOT JS/meta-refresh interstitials, which would save
// HTML junk that the spec check then (correctly) fails. SafeLinks and
// urldefense decode locally; Mimecast needs the redirect chain followed
// and, when it stalls on the protector, the interstitial mined for the
// landing URL. Anything unresolvable falls back to the original URL -
// the downloader's own redirect handling may still land it.
const DL_WRAP_RE = /mimecastprotect|urldefense|safelinks\.protection|proofpoint\.com/i;
function unwrapDlUrl(u) {
  try {
    const p = new URL(u);
    if (/safelinks\.protection\.(outlook|office)/i.test(p.hostname)) {
      const t = p.searchParams.get('url');
      if (t && /^https?:/i.test(t)) return t;
    }
    if (/urldefense/i.test(p.hostname)) {
      const m = p.pathname.match(/\/v3\/?__(https?:[^;]+?)__/i);
      if (m) return decodeURIComponent(m[1]);
    }
    return u;
  } catch (e) { return u; }
}
// Last-resort unwrap: open the link in a hidden tab and let the
// protector's own portal JS resolve it (Mimecast's TTP page computes the
// destination via API - it isn't in the HTML). Two outcomes: the tab
// navigates off the protector (grab its URL), or the destination is a
// file and navigation becomes a download (grab its URL, cancel it, and
// re-download under the job's own name). Returns '' on timeout.
async function resolveViaTab(u) {
  let t;
  try { t = await chrome.tabs.create({ url: u, active: false }); }
  catch (e) { return ''; }
  try {
    return await new Promise(res => {
      const done = v => {
        clearTimeout(to);
        chrome.tabs.onUpdated.removeListener(lis);
        chrome.downloads.onCreated.removeListener(onDl);
        chrome.downloads.onChanged.removeListener(onDlCh);
        res(v || '');
      };
      const to = setTimeout(() => done(''), 20000);
      const lis = (id, ch) => {
        if (id !== t.id || !ch.url || DL_WRAP_RE.test(ch.url)) return;
        done(ch.url);
      };
      // Navigation-turned-download: the item's url may still be the
      // protector at onCreated; finalUrl resolves as redirects run.
      // Only wrapped-origin items are tracked, so an unrelated download
      // in the window can't be hijacked.
      let pendingDl = 0;
      const kill = (id, dest) => {
        chrome.downloads.cancel(id).then(() => chrome.downloads.erase({ id })).catch(() => {});
        done(dest);
      };
      const onDl = item => {
        if (!item) return;
        const dest = [item.finalUrl, item.url].find(x => x && !DL_WRAP_RE.test(x)) || '';
        if (dest) return kill(item.id, dest);
        if (item.url && DL_WRAP_RE.test(item.url)) pendingDl = item.id;
      };
      const onDlCh = d => {
        if (!pendingDl || d.id !== pendingDl) return;
        const x = (d.finalUrl && d.finalUrl.current) || '';
        if (x && !DL_WRAP_RE.test(x)) kill(pendingDl, x);
      };
      chrome.tabs.onUpdated.addListener(lis);
      chrome.downloads.onCreated.addListener(onDl);
      chrome.downloads.onChanged.addListener(onDlCh);
    });
  } finally {
    try { chrome.tabs.remove(t.id); } catch (e) {}
  }
}
async function resolveDlUrl(u, cache) {
  const un = unwrapDlUrl(u);
  if (un !== u) { cache.set(u, un); return un; }
  if (!DL_WRAP_RE.test(u)) return u;
  if (cache.has(u)) return cache.get(u);
  let out = u;
  try {
    const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(12000) });
    const fin = r.url || '';
    const ct = r.headers.get('content-type') || '';
    if (fin && !DL_WRAP_RE.test(fin)) out = fin;
    else if (/html/i.test(ct)) {
      const html = (await r.text()).slice(0, 80000);
      const dom = (new URL(u).searchParams.get('domain') || '').replace(/^www\./, '');
      const cands = [
        /content=["']?\s*\d+\s*;\s*url=([^"'> \]]+)/i,
        /window\.location(?:\.href)?\s*=\s*["']([^"']+)/i,
        /location\.replace\(["']([^"']+)/i,
        /href=["'](https?:\/\/[^"']+)["']/i,
      ];
      for (const re of cands) {
        const x = (re.exec(html) || [])[1];
        if (x && /^https?:/i.test(x) && !DL_WRAP_RE.test(x) && (!dom || x.toLowerCase().includes(dom.toLowerCase()))) { out = x; break; }
      }
      if (out === u && dom) {
        const m2 = new RegExp('https?://[^"\'<> ]*' + dom.replace(/\./g, '\\.') + '[^"\'<> ]*', 'i').exec(html);
        if (m2 && !DL_WRAP_RE.test(m2[0])) out = m2[0];
      }
    }
    if (r.body && r.body.cancel) r.body.cancel();
  } catch (e) { dbg('link unwrap fail', { err: String(e), url: u.slice(0, 140) }); }
  if (out === u) out = (await resolveViaTab(u)) || u;
  if (out !== u) dbg('link unwrapped', { from: u.slice(0, 90), to: out.slice(0, 140) });
  cache.set(u, out);
  return out;
}

async function downloadLinked() {
  if (!matched || !matched.length) { toast('Run the match first.'); return false; }
  const sel = selectedMatches();
  if (!sel.length) { toast('Every matched row is excluded - nothing to send.'); setStage('sdDl', 'warn', 'all rows excluded'); return false; }
  warnStale();
  const job = jobSlug();
  const withLinks = sel.filter(m => m.link || m.yangarooUrl);
  // No links at all isn't fatal anymore: every matched row becomes a
  // manifest entry below so the watcher reconciles manual drops.
  if (!withLinks.length && client && client.delivery !== 'links') {
    toast('No sheet links - expected for ' + client.name + '. ' + client.note);
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

  // files.com share links (A&E's aenetworks.files.com) and CreativeHub
  // Share links (AMC's creativehub.amcnetworks.com/Share/...) are viewer
  // pages - the "second click" on their Download button. Resolve each in
  // a hidden tab to the real file URL (deduped per link).
  const SHARE_PAGE_RE = /files\.com\/|creativehub\.|amcnetworks\.com\/Share/i;
  const fsLinks = [...new Set(withLinks.map(m => m.link)
    .filter(l => SHARE_PAGE_RE.test(l || '')))];
  const fsRes = {};
  if (fsLinks.length) {
    toast('Resolving ' + fsLinks.length + ' share page link(s)…');
    for (const l of fsLinks) fsRes[l] = await resolveFileShare(l);
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
    if (SHARE_PAGE_RE.test(m.link || '')) {
      const r = fsRes[m.link];
      if (!r || !r.url) {
        problems.push('row ' + m.row + ' (' + (m.trackingId || m.id) + '): share page could not be resolved - ' +
          (r && r.error || 'no download URL') + ' - open the link and download manually');
        continue;
      }
      jobs.push({ ...base, file: nameForIngest(base.tracking_id, base.title, r.name || base.expected_name || 'download'), url: r.url });
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
      } else if (shape === 'egnyte') {
        problems.push('row ' + m.row + ' (' + (m.trackingId || m.id) + '): Egnyte share link - open it (password is in the email) and download there');
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

  // Matched rows that produced no download (no link, or an unresolvable
  // one) still get manifest entries - the watcher reconciles manual drops
  // (FTP/CyberDuck, portal, viewer downloads) against expected names and
  // builds ticker versions on arrival. Sheetless clients like Comscore
  // run entirely on this path.
  const queuedIds = new Set(jobs.map(j => normalizeName(j.tracking_id || '').replace(/[\s:_-]+/g, '')));
  const manual = [];
  sel.forEach(m => {
    const tid = m.trackingId || m.id;
    const k = normalizeName(tid || '').replace(/[\s:_-]+/g, '');
    if (!k || queuedIds.has(k) || manual.some(x => x._k === k)) return;
    const df = /\.[a-z0-9]{2,5}$/i.test(m.fileName || '') ? m.fileName : String(m.fileName || tid || 'file') + '.mp4';
    manual.push({ row: m.row, tracking_id: tid, title: m.title || '', expected_name: m.fileName || '',
      needs_espn: m.espn || tickerAlways(), url: null, _k: k, file: nameForIngest(tid, m.title || '', df) });
  });
  manual.forEach(x => delete x._k);
  const entries = jobs.concat(manual);

  if (!entries.length) {
    toast('Nothing to download - ' + problems.length + ' problem row(s): ' + (problems[0] || 'no resolvable links'));
    $('matchResults').innerHTML += problems.map(p => '<div class="hint">' + esc(p) + '</div>').join('');
    setStage('sdDl', 'warn', problems.length + ' row(s) had unresolvable links');
    return false;
  }
  dbg('linked download queued', { files: jobs.map(j => j.file), manual: manual.length, problems: problems.length });
  flushLog(true);

  dlTotal = jobs.length; dlDone = 0; dlFailed = 0; dlFailAlerted = false; htmlRejects = [];
  updateDlStatus();
  const dlUrlCache = new Map();
  for (const j of jobs) {
    try {
      j.url = await resolveDlUrl(j.url, dlUrlCache);
      const id = await chrome.downloads.download({
        url: j.url,
        filename: 'Ingest/' + j.file,
        conflictAction: 'uniquify',
      });
      if (id != null) ourDlIds.add(id);
    } catch (e) { dlFailed++; updateDlStatus(); }
  }
  const blob = new Blob([buildManifest(job, entries, clientInfo())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: 'Ingest/' + job + '-manifest.json' });
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  setStage('sdDl', 'ok', jobs.length + ' file(s) queued to Ingest/' +
    (manual.length ? ' · ' + manual.length + ' awaiting manual drop' : ''));
  const nEspnJobs = entries.filter(j => j.needs_espn).length;
  toast((jobs.length ? 'Queued ' + jobs.length + ' download(s) + manifest to ~/Downloads/Ingest/' :
      'Manifest written to ~/Downloads/Ingest/ - drop the file(s) in there') +
    (manual.length && jobs.length ? ' — ' + manual.length + ' row(s) awaiting manual drop' : '') +
    (nEspnJobs ? ' — ' + nEspnJobs + ' ticker version(s) auto-build on arrival' : '') +
    (problems.length ? ' — ' + problems.length + ' row(s) skipped' : ''));
  if (problems.length) {
    $('matchResults').innerHTML += problems.map(p => '<div class="hint">' + esc(p) + '</div>').join('');
  }
  return true;
}

$('download').addEventListener('click', downloadLinked);

function updateDlStatus() {
  const d = $('dateFilterHint');
  if (dlTotal) {
    const fin = dlDone + dlFailed;
    d.textContent = 'Downloads: ' + dlDone + '/' + dlTotal + ' complete' + (dlFailed ? ', ' + dlFailed + ' failed' : '');
    modStat('stDl', 'Downloading ' + fin + '/' + dlTotal + ' (' + Math.round(fin / dlTotal * 100) + '%)' +
      (dlFailed ? ' · ' + dlFailed + ' failed' : ''), fin / dlTotal);
  }
  if (dlTotal && dlFailed && dlDone + dlFailed >= dlTotal && !dlFailAlerted) {
    dlFailAlerted = true;
    alertSound('fail', dlFailed + ' of ' + dlTotal + ' download(s) failed',
      dlFailed + ' of ' + dlTotal + ' downloads failed');
  }
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
    dlKeys.delete(delta.id);
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
  } else if (delta.state.current === 'interrupted') {
    ourDlIds.delete(delta.id);
    // A failed download must not stay "already downloaded" - release the
    // queued slot so a retry actually re-downloads instead of skipping.
    const key = dlKeys.get(delta.id);
    if (key) { queuedUrls.delete(key); dlKeys.delete(delta.id); }
    dlFailed++;
    dbg('download interrupted', { error: (delta.error && delta.error.current) || '' });
  }
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
    toast(/extremereach\.com/i.test(tab && tab.url || '')
      ? 'Cannot read this ER page - if it just bounced to a login/SSO screen, sign into Extreme Reach first, then grab again.'
      : 'Cannot read this page. Select the list manually instead.');
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
  if (!cands.length) { toast('Focus a page that lists files - delivery list, share folder, link page.'); return false; }
  let got = false;
  for (const t of cands) got = (await capturePage(t)) || got;
  return got;
}

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

  // AMBIGUOUS resolution: a code can appear in several captured names -
  // SharePoint activity-feed lines ("User added X.mp4", "[EXTERNAL] X")
  // repeat the real library row under different display text. When the
  // candidates hold exactly one download URL between them, that linked
  // entry is the file the sender means; name-only duplicates were never
  // downloadable anyway. Distinct URLs stay ambiguous - real ambiguity.
  let linkResolved = 0;
  results.forEach(r => {
    if (r.status !== 'AMBIGUOUS') return;
    const cands = r.matched.split(' | ');
    const linked = cands.filter(n => /^https?:/i.test((capturedByName[n] || {}).url || ''));
    const urls = [...new Set(linked.map(n => capturedByName[n].url))];
    if (linked.length && urls.length === 1) {
      r.status = 'FOUND';
      r.matched = linked[0];
      r.notes = cands.length + ' files match - picked the one with a link';
      linkResolved++;
    }
  });

  const counts = {};
  results.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  lastResults = results;
  lastExtras = extras || [];
  dbg('reconcile', { ids: ids.length, files: files.length, ...counts, titleHits, linkResolved,
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
      ? '<details class="hint" style="margin-top:4px"><summary style="font-weight:400;text-transform:none;letter-spacing:0;display:inline;cursor:pointer">' +
        '<b>' + lastExtras.length + '</b> surplus file(s) on page - other deliveries, not this request</summary><div style="margin-top:2px">' +
        lastExtras.slice(0, 40).map(e => esc(moniker(e))).join(' · ') +
        (lastExtras.length > 40 ? ' +' + (lastExtras.length - 40) : '') + '</div></details>'
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
      '<a href="#" id="widenSweep">sweep ' + d2 + ' days</a> · ' +
      '<a href="#" id="watchBatch">watch for arrival</a>: ' +
      missing.slice(0, 8).map(esc).join(', ') + (missing.length > 8 ? ' +' + (missing.length - 8) : '');
    const ws = $('widenSweep');
    if (ws) ws.addEventListener('click', e => {
      e.preventDefault();
      $('erDays').value = d2;
      chrome.storage.local.set({ erDays: String(d2) });
      sweepAndDownload();
    });
    const wb = $('watchBatch');
    if (wb) wb.addEventListener('click', e => {
      e.preventDefault();
      // Delivery notices (ER, Comcast manifests, Yangaroo) carry ISCI
      // codes in their bodies - the poll scans every unread mail, so a
      // watched code appearing there IS the arrival signal. One alert
      // per batch, then the batch un-arms itself.
      const batch = {
        codes: missing.map(c => c.toUpperCase()),
        clientName: client ? client.name : '',
        advertiser: extractAdvertiser(emailSubject) || '',
        addedAt: Date.now(),
      };
      chrome.storage.local.get('watchedBatches', d => {
        const live = (d.watchedBatches || [])
          .filter(b => Date.now() - (b.addedAt || 0) < 14 * 864e5 &&
            !b.codes.every(c => batch.codes.includes(c)));
        live.push(batch);
        chrome.storage.local.set({ watchedBatches: live.slice(-10) });
      });
      wb.outerHTML = '<b>watching ' + missing.length + ' file(s) - alert on arrival' +
        (erApiKey ? ' (mail + ER API)' : ' (mail scan)') + '</b>';
      dbg('watch armed', { codes: missing.length, client: batch.clientName });
    });
  } else {
    $('missingNote').innerHTML = '';
  }

  setStage('sdDl', missing.length ? 'warn' : 'ok',
    fileCount + ' files indexed · ' + (missing.length ? missing.length + ' still missing' : 'all requested found'));
  // Watched-batch arrival can come from the sweep itself: deliveries that
  // land silently (no notice mail - e.g. the SeaWorld batch) still get
  // their "arrived" moment when a reconcile finds the watched IDs.
  const foundIds = new Set(results.filter(r => r.status === 'FOUND')
    .map(r => String(r.id).toUpperCase()));
  if (foundIds.size) chrome.storage.local.get('watchedBatches', d => {
    const live = (d.watchedBatches || [])
      .filter(b => Date.now() - (b.addedAt || 0) < 14 * 864e5);
    const hit = live.filter(b => b.codes.some(c => foundIds.has(c)));
    if (!hit.length) return;
    chrome.storage.local.set({ watchedBatches: live.filter(b => !hit.includes(b)) });
    chrome.runtime.sendMessage({ type: 'ding', kind: 'arrived' }).catch(() => {});
    toast('Watched batch arrived: ' +
      hit.map(b => [b.clientName, b.advertiser].filter(Boolean).join(' - ') || 'batch').join(', ') +
      ' - un-armed.');
  });
  refreshReply();
  return true;
}

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
  const seenFiles = new Set(); // same file under two deliveries = one download, never "x (1).mp4"
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
      if (shape === 'viewer' || shape === 'sp-folder' || shape === 'egnyte') {
        noUrl.push(r.matched + ' (' + (shape === 'sp-folder' ? 'SharePoint folder - open it'
          : shape === 'egnyte' ? 'Egnyte share - open it (password in email)' : 'viewer link - open the page') + ')');
        return;
      }
      if (!e.apiAuth) url = directUrl(url);
      const fname = /\.(mp4|mov|mxf|mpg|mpeg|avi|wmv|webm|mkv|ts|m2ts|mp3|wav|aac|srt|vtt)$/i.test(expected)
        ? expected : expected + '.mp4';
      const finalName = nameForIngest(r.id, titleMap[rid] || '', fname);
      if (!seenFiles.has(finalName.toLowerCase())) {
        seenFiles.add(finalName.toLowerCase());
        jobs.push({
          file: finalName, url: url, dkey: e.url,
          tracking_id: r.id, title: titleMap[rid] || '', expected_name: expected, row: 0,
          needs_espn: !!espnMap[rid] || tickerAlways(),
        });
      }
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
    if (m.excluded || !m.ingested) return;
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
  const job = jobSlug();
  dlTotal = fresh.length; dlDone = 0; dlFailed = 0; dlFailAlerted = false; htmlRejects = [];
  dlStop = false; dlRunIds.length = 0; $('stopDl').classList.remove('hidden');
  updateDlStatus();
  const dlUrlCache2 = new Map();
  for (const j of fresh) {
    if (dlStop) break;
    try {
      j.url = await resolveDlUrl(j.url, dlUrlCache2);
      const id = await chrome.downloads.download({ url: j.url, filename: 'Ingest/' + j.file, conflictAction: 'uniquify' });
      // Mark only on a live download id - a thrown call or dead queue
      // leaves the URL free so the next attempt can actually retry.
      if (id != null) { ourDlIds.add(id); queuedUrls.add(j.dkey || j.url); dlKeys.set(id, j.dkey || j.url); dlRunIds.push(id); }
      else dlFailed++;
    } catch (e) { dlFailed++; updateDlStatus(); }
  }
  $('stopDl').classList.add('hidden');
  if (dlStop) {
    toast('Stopped - cancelled ' + dlRunIds.length + ' in-flight download(s).');
    setStage('sdDl', 'warn', 'stopped by user');
    dlStop = false;
  }
  const blob = new Blob([buildManifest(job, fresh, clientInfo())], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: 'Ingest/' + job + '-manifest.json' });
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  specFails = null; specFailsJob = ''; checkSpecFails();
  dbg('download found queued', { files: fresh.map(j => j.file), urls: fresh.map(j => j.url) });
  setStage('sdDl', 'ok', fresh.length + ' file(s) queued to Ingest/');
  flushLog(true);
  const nEspnFresh = fresh.filter(j => j.needs_espn).length;
  toast('Queued ' + fresh.length + ' file(s)' +
    (skipped ? ' (' + skipped + ' already queued earlier)' : '') +
    (noUrl.length ? ' (' + noUrl.length + ' found but had no link)' : '') +
    (nEspnFresh ? ' - ' + nEspnFresh + ' ESPN ticker version(s) auto-build on arrival' : '') + '.');
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
  const want = ids.length ? ids : (matched || []).filter(m => !m.excluded).map(m => m.id || m.trackingId).filter(Boolean);
  if (!want.length) { toast('No requested IDs - run Match first.'); return false; }
  toast('Querying ER API for ' + want.length + ' ID(s)…');
  const entries = [];
  const misses = [];
  let sampleLogged = false, authDead = false;
  // Four IDs in flight: hundreds of Tatari codes stay quick without
  // hammering the API. A 401 aborts the whole batch.
  for (let i = 0; i < want.length && !authDead; i += 4) {
    await Promise.all(want.slice(i, i + 4).map(async id => {
      const r = await erApiGet('/deliveries?AdId=' + encodeURIComponent(id));
      if (r.status === 401) { authDead = true; return; }
      if (r.status !== 200 || !r.data) { failsafe(id, r); return; }
      if (!sampleLogged) { sampleLogged = true; dbg('erApi sample', { raw: r.raw.slice(0, 2000) }); }
      const deliveries = r.data.Deliveries || r.data.deliveries || (Array.isArray(r.data) ? r.data : []);
      if (!deliveries.length) { misses.push(id); return; }
      for (const d of deliveries) {
        const got = await erResolveDelivery(d, id);
        if (got.length) got.forEach(e => entries.push(e));
        else {
          const name = d.FileName || d.AssetName || d.AdId || id;
          entries.push({ name: String(name), url: '', line: String(name) });
        }
      }
    }));
    modStat('stDl', 'Querying ER API… ' + Math.min(i + 4, want.length) + '/' + want.length, (i + 4) / want.length);
    if (want.length > 8 && i % 40 === 0 && i)
      toast('Querying ER API… ' + i + '/' + want.length);
  }
  if (authDead) { toast('API key rejected (401) - check the key.'); dbg('erApi', { status: 401 }); return false; }
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

// ER's ASP.NET login page ALSO carries a __RequestVerificationToken field,
// so a truthy token can't prove a session - detect the login form itself.
function erLoggedOut(html) {
  return /type=["']password|\/Account\/Log(on|in)|login\.aspx|\bsign[\s-]?in\b/i.test(String(html || ''));
}

async function sweepEr(daysOverride) {
  const senderFilter = $('erSender').value.trim().toLowerCase();
  const days = Math.min(Math.max(parseInt(daysOverride != null ? daysOverride : $('erDays').value, 10) || 14, 1), 90);
  toast('Sweeping ER deliveries (last ' + days + ' days)…');
  // Fresh anti-forgery token from the deliveries landing page.
  const landing = await (await fetch(ER_APP + '/Delivery', { credentials: 'include' })).text();
  const token = (landing.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) || [])[1];
  if (!token || erLoggedOut(landing)) {
    toast('No ER session - log into Extreme Reach in this browser first.');
    $('capInfo').innerHTML = '<i>ER sweep needs a signed-in Extreme Reach session - log in, then sweep again.</i>';
    return null; // null = don't retry wider; [] = empty window, keep escalating
  }
  // Pull every page in the window (pageSize is capped at 100 server-side).
  const entries = [];
  let p = 1;
  for (; p <= 12; p++) {
    const html = await erSearchPage(token, p, days);
    if (p === 1) dbg('erSweep page1', { len: html.length, head: html.slice(0, 200) });
    if (erLoggedOut(html)) {
      toast('ER session expired mid-sweep - log into Extreme Reach and try again.');
      return null;
    }
    const rows = parseErRows(new DOMParser().parseFromString(html, 'text/html'));
    if (!rows.length) break;
    entries.push(...rows);
    modStat('stDl', 'Sweeping ER… ' + entries.length + ' deliveries (page ' + p + ')', Math.min(p / 12, 0.95));
    if (rows.length < 100) break;
    if (p % 3 === 0) toast('Sweeping… ' + entries.length + ' rows so far (page ' + p + ')');
  }
  dbg('erSweep rows', { rows: entries.length, pages: p - 1, days, senderFilter });
  if (!entries.length) { toast('No deliveries in the last ' + days + ' day(s) - widening or check the destination.'); return []; }

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
      modStat('stDl', 'Checking senders… ' + Math.min(i + 5, toCheck.length) + '/' + toCheck.length, (i + 5) / toCheck.length);
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
  if (!kept.length) { toast(senderFilter ? 'Nothing from that sender in the window.' : 'Nothing captured.'); return []; }
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
// windows: the day ranges to try in order (auto path escalates 2 -> 7 ->
// configured; a manual ER-search press honors the typed window exactly).
// Missing IDs widen the window; an empty window widens too - files often
// land days before the request email does.
async function sweepAndDownload(windows) {
  // Surgical first: per-ID API queries pull ONLY the requested codes -
  // no trawling the whole delivery window. The broad scrape stays the
  // fallback for IDs the API misses and for sender-only (no IDs) sweeps.
  const want = idsEl.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const wanted = want.length ? want : (matched || []).filter(m => !m.excluded).map(m => m.id || m.trackingId).filter(Boolean);
  if (erApiKey && wanted.length && await fetchErApi()) {
    if (!runReconcile()) return false;
    if (!(lastResults || []).some(r => r.status === 'MISSING')) return downloadFound();
    toast('API missed some IDs - falling back to the delivery sweep for the rest…');
  }
  const wins = (windows || [parseInt($('erDays').value, 10) || 14])
    .map(d => Math.min(Math.max(parseInt(d, 10) || 14, 1), 90));
  let anyKept = null;
  for (let w = 0; w < wins.length; w++) {
    const kept = await sweepEr(wins[w]);
    if (kept === null) return false;          // session lost - widening won't help
    if (!kept.length) continue;               // empty window - try wider
    anyKept = kept;
    // Sender-only sweep (no requested IDs): treat every kept row as wanted
    // so reconcile marks them all FOUND and downloads the lot.
    const ids = idsEl.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!ids.length && !(matched || []).length) {
      idsEl.value = kept.map(erCodeOf).filter(Boolean).join('\n');
      saveInputs();
    }
    if (!runReconcile()) return false;
    const missing = (lastResults || []).filter(r => r.status === 'MISSING').length;
    if (w === wins.length - 1 || !missing) return downloadFound();
    toast(missing + ' still missing - widening the sweep to ' + wins[w + 1] + ' days…');
    modStat('stDl', missing + ' missing - widening to ' + wins[w + 1] + ' days…');
  }
  // Nothing delivered yet and a request is pending -> keep re-checking
  // every 5 min; the 'arrived' chime fires when files land.
  maybeArmWatch();
  return false;
}

$('erSweep').addEventListener('click', sweepAndDownload);

// ---------- Delivery watch ----------
// A delivery search that comes back empty arms a 5-minute re-check: the
// poll runs while the panel is open and sounds 'arrived' when files
// land. resetRun disarms it - a new email is a different wait.
// Mail-channel watches VERIFY the arrival: a fresh inbox mail only counts
// when it cites the watched IDs, or carries delivery evidence (download
// links / an ER notice) under the watched client - an unrelated request
// mail must never ring the bell.

function watchCtxFor() {
  const codes = [...new Set(
    (matched || []).filter(m => !m.excluded).map(m => m.id || m.trackingId)
      .concat(idsEl.value.split(/\r?\n/).map(s => s.trim()))
      .filter(Boolean))];
  return { why: client ? client.name : 'request',
           clientId: client ? client.id : '', codes };
}

const normWatchCode = c => normalizeName(c).replace(/[\s:_-]+/g, '');

async function recheckDelivery(quiet) {
  if (!quiet) toast('Re-checking for deliveries…');
  let arrived = null;
  if (client && client.delivery === 'extreme-reach') {
    if (await sweepAndDownload()) arrived = 'ER delivery sweep';
  } else {
    const inbox = await checkInbox(quiet) || { n: 0, hits: [] };
    const w = watchCtx || watchCtxFor();
    const wc = (w.codes || []).map(normWatchCode);
    const hit = (inbox.hits || []).find(h => {
      const hc = (h.codes || []).map(normWatchCode);
      return (wc.length && hc.some(c => wc.includes(c))) ||
             (w.clientId && h.clientId === w.clientId && (h.hasDl || h.erNotice));
    });
    if (hit) arrived = 'mail: ' + (hit.subject || '(no subject)');
    else if (!w.clientId && !wc.length && inbox.n) arrived = 'new request-like mail';
  }
  const pending = (selectedMatches().length > 0) || !!idsEl.value.trim();
  if (!arrived && pending) armDeliveryWatch(watchCtxFor());
  else if (arrived) disarmDeliveryWatch();
  return arrived;
}

function maybeArmWatch() {
  const pending = (selectedMatches().length > 0) || !!idsEl.value.trim();
  if (pending) armDeliveryWatch(watchCtxFor());
}

function armDeliveryWatch(ctx) {
  if (deliveryWatch) return;
  watchCtx = ctx;
  const w = $('watchInfo'); if (w) w.textContent = 'watching every 5 min for ' + ctx.why;
  deliveryWatch = setInterval(async () => {
    const arrived = await recheckDelivery(true);
    if (arrived) {
      disarmDeliveryWatch();
      alertSound('arrived', 'delivery found for ' + ctx.why + ' (' + arrived + ')',
        'Delivery arrived for ' + ctx.why);
      toast('Delivery arrived - ' + ctx.why + ' - ' + arrived);
    }
  }, 5 * 60 * 1000);
}

function disarmDeliveryWatch() {
  if (deliveryWatch) { clearInterval(deliveryWatch); deliveryWatch = null; }
  watchCtx = null;
  const w = $('watchInfo'); if (w) w.textContent = '';
}

$('recheck').addEventListener('click', () => recheckDelivery(false));

// One-shot delivery-page flow: scan every open delivery tab (focused page
// + all ER tabs), reconcile against the requested IDs already loaded from
// the sheet match, and queue every FOUND download.
// The automatic download cascade: real sheet links go direct; else the
// ER delivery search (auto-widening once on missing IDs); open delivery
// pages are the last fallback. Shared by "Find & download" and Run all.
async function autoDownload() {
  const nDl = selectedMatches().filter(m => /^https?:/i.test(m.link || '') || m.yangarooUrl).length;
  if (nDl) { await downloadLinked(); return; }
  // Narrow-first sweep: fresh deliveries usually landed within 2 days,
  // so trawl a small window before paying for the full 14-day scrape.
  const days = parseInt($('erDays').value, 10) || 14;
  const swept = await sweepAndDownload([...new Set([2, 7, days])].sort((a, b) => a - b));
  if (swept) return;
  if (await captureTabs()) {
    if (runReconcile()) { await downloadFound(); return; }
  }
  toast('Matched ' + selectedMatches().length + ' row(s) but found no downloadable files - see the log.');
}

$('grabAndDl').addEventListener('click', autoDownload);
$('stopDl').addEventListener('click', () => {
  dlStop = true;
  dlRunIds.forEach(id => chrome.downloads.cancel(id).catch(() => {}));
  toast('Stopping downloads…');
});

// Open-pages-only override (lives under the "overrides" dropdown): read
// every open delivery page, reconcile, queue FOUND - no ER search.
$('dlPages').addEventListener('click', async () => {
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

  // 2 · Sheet: the email's own tracker link is request-scoped - it
  // outranks open tabs and remembered sheets (WB theatrical vs TV, or two
  // Horizon brand docs, can share one client family). Tabs come next
  // (host-matched to the email), then remembered docs, then resolution.
  // Sheetless clients (DataPlusMath, Comscore) skip this ENTIRE stage -
  // no tab grab, no remembered doc, nothing may re-detect them through a
  // stale open tracker. The email IS the manifest.
  if (!(client && client.sheetless)) {
    const st = pickTrackerTab(cls.sheet.concat(cls.sharepoint, cls.airtable), active);
    const ref = emailSheetRefs()[0];
    if (ref && (!sheet || !lastSheetRef || lastSheetRef.id !== ref.id)) {
      applyClient(detectClient({ sheetId: ref.id }), 'sheet');
      await loadSheetDoc(ref.id, ref.gid, '', 'email-linked tracker');
    }
    for (const u of emailSharePointUrls()) {
      // SharePoint/guest-access links resolve at fetch - skip only when the
      // loaded sheet provably came from THIS link already.
      if (sheet && lastSheetRef && lastSheetRef.spSrc === u) continue;
      if (await loadSharePointUrl(u)) break;
    }
    if (!sheet && st) await grabTrackerTab(st);
    if (!sheet) await resolveSheetLinks();
    if (!sheet)
      return toast('No tracking sheet - open its tab or load a file.');
  }

  // 3 · Match ('guess' stops at the confirm picker - that's the user step).
  if (await doMatch() !== true) return;

  // 4 · Download: the shared cascade - links, sweep, pages.
  dbg('runAll: matched', { rows: selectedMatches().length,
    withLinks: selectedMatches().filter(m => /^https?:/i.test(m.link || '') || m.yangarooUrl).length });
  await autoDownload();
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
  // Ticker markers: _ticker, _t, or the playbook's custom tickerSuffix.
  const sfxRe = new RegExp('(' + ['_ticker', '_t', plan.opts.tickerSuffix]
    .filter(Boolean).filter((s, i, a) => a.indexOf(s) === i)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$', 'i');
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
    const tk = stem.match(sfxRe);
    const ticker = !!tk;
    const r = findRow(stem.replace(sfxRe, '')) || findRow(stem);
    if (!r) { nameTd.style.outline = '1px solid #b06000'; tr.dataset.ingestFilled = 'miss'; return; }
    tr.dataset.ingestFilled = 'ok';
    // The ticker marker is preserved, the value behind it corrected:
    // CODE_t -> RealID_t, CODE_ticker -> RealID_ticker. Never stripped,
    // never doubled (marker appended only when the value lacks it).
    const marker = ticker ? tk[0] : '';
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
      .filter(m => !m.excluded && m.matchType !== 'ROW (out of range)' && (m.trackingId || m.id))
      .map(m => ({
        id: clean(m.trackingId || m.id),
        title: clean(m.title),
        brand: clean(ing.brandFixed) || clean(m.brand),
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
    "Reporting ID ← '" + (ingestColName('id') || 'email') + "'" + (plan.opts.tickerSuffix ? " (+" + plan.opts.tickerSuffix + " on _ticker files)" : ''),
    plan.opts.nameTitle ? "Title ← '" + (ingestColName('title') || '?') + "' col" : 'Title — playbook leaves default',
    plan.opts.advertiser
      ? (ing.brandFixed
        ? "Advertiser/Brand/Vertical ← '" + String(ing.brandFixed) + "' (playbook - not on the sheet)"
        : "Advertiser/Brand/Vertical ← '" + (ingestColName('brand') || '?') + "' col")
      : 'Advertiser/Brand/Vertical — playbook leaves default',
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
  const sfxRe = new RegExp('(' + ['_ticker', '_t', plan.opts.tickerSuffix]
    .filter(Boolean).filter((s, i, a) => a.indexOf(s) === i)
    .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$', 'i');
  const findRow = stem => {
    const s = norm(stem);
    return plan.rows.find(r => s.includes(norm(r.id))) ||
           plan.rows.find(r => norm(r.title).length >= 6 && s.includes(norm(r.title))) || null;
  };
  let ok = 0, diff = 0, miss = 0;
  const html = '<table><tr><th>File</th><th>Reporting</th><th>Title</th><th>Adv</th><th>FP</th><th></th></tr>' +
    probe.rows.map(q => {
      const stem = q.name.replace(/\.[^.]+$/, '');
      const tk = stem.match(sfxRe);
      const ticker = !!tk;
      const r = findRow(stem.replace(sfxRe, '')) || findRow(stem);
      if (!r) { miss++; return '<tr><td>' + esc(q.name) + '</td><td colspan="4"></td><td class="warn">no match</td></tr>'; }
      const marker = ticker ? tk[0] : '';
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
  // One click = check + preview: rows already queued get the
  // actual-vs-expected verify; an empty queue shows the fill plan.
  $('ingestPush').classList.toggle('hidden', !ingestPlan().rows.length);
  if (p.rows.length) renderIngestVerify(p);
  else renderIngestPreview();
  refreshTickerStatus();
});

$('ingestPush').addEventListener('click', async () => {
  ensureMatchRows();
  const plan = ingestPlan();
  if (!plan.rows.length) { toast('No committed matches - run Match first'); return; }
  const tab = await portalTab();
  if (!tab) { toast('No portal.cognet.tv tab open'); setStage('sdIngest', 'warn', 'no portal tab open'); return; }
  modStat('stIngest', 'Writing ' + plan.rows.length + ' fills into the portal…');
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: portalFill, args: [plan] });
  const n = (res && res.result && res.result.queued) || 0;
  modStatDone('stIngest', 'Queued ' + n + '/' + plan.rows.length + ' fill(s)');
  const [pr] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: portalProbe });
  const p = pr && pr.result;
  stamp('tsIngest');
  if (p && p.rows.length) {
    const v = renderIngestVerify(p);
    setStage('sdIngest', v.diff || v.miss ? 'warn' : 'ok',
      v.ok + ' row(s) verified · ' + v.diff + ' differ · ' + v.miss + ' unmatched — watching for new drops');
    $('ingestInfo').textContent = 'fills pushed — new files dropped into the queue auto-fill; ' +
      v.ok + ' ok · ' + v.diff + ' differ · ' + v.miss + ' unmatched';
    startPortalLive();
  } else {
    setStage('sdIngest', 'warn', 'plan armed (' + plan.rows.length + ' rows) — queue still empty, will fill on drop');
    $('ingestInfo').textContent = 'plan armed for ' + plan.rows.length + ' row(s) — drop the videos, fills apply automatically';
  }
  dbg('ingest push', { rows: plan.rows.length, queued: n });
  refreshTickerStatus();
});

// Runs INSIDE the portal tab: pulls this job's downloaded files from the
// watcher's loopback server (http://127.0.0.1:8770, manifest-scoped) and
// assigns them to the page's bulk file input - same as a manual pick.
// The armed portalFill observer then writes metadata as rows appear.
async function feedJobFiles(job, base, kind) {
  try {
    const lst = await (await fetch(base + '/ingest-files?job=' + encodeURIComponent(job) +
      (kind && kind !== 'all' ? '&kind=' + kind : ''))).json();
    const names = (lst && lst.files) || [];
    if (!names.length) return { error: 'watcher has no ' + (kind === 'ticker' ? 'ticker ' : '') +
      'files for job ' + job };
    const input = document.getElementById('multifile') ||
      document.querySelector('#bulkdrop input[type=file], input.bulk-btn-upload');
    if (!input) return { error: 'no bulk file input found - open the File Ingest view' };
    const MIME = { mp4: 'video/mp4', mov: 'video/quicktime', mxf: 'application/mxf', mpg: 'video/mpeg' };
    const before = document.querySelectorAll('#fileingest_bulk tbody tr.upload_row').length;
    const dt = new DataTransfer();
    const skipped = [];
    for (const name of names) {
      try {
        const r = await fetch(base + '/ingest-file?job=' + encodeURIComponent(job) +
          '&name=' + encodeURIComponent(name));
        if (!r.ok) { skipped.push(name); continue; }
        const b = await r.blob();
        const ext = (name.match(/\.(\w+)$/) || ['mp4'])[0].slice(1).toLowerCase();
        dt.items.add(new File([b], name, { type: MIME[ext] || 'video/mp4' }));
      } catch (e) { skipped.push(name); }
    }
    if (!dt.files.length) return { error: 'watcher served 0 of ' + names.length + ' file(s) - is ingest_watch running?' };
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 2500));
    const after = document.querySelectorAll('#fileingest_bulk tbody tr.upload_row').length;
    return { fed: dt.files.length, skipped, rowsAdded: after - before, rowsTotal: after };
  } catch (e) { return { error: String(e) }; }
}

// Feeds whatever the watcher has for this job into the portal picker.
// Shared by "Feed files" (job-dir downloads) and "Pick & feed" (after
// the picked files have been uploaded into the job dir).
async function feedPortalNow(tab, job, kind) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, func: feedJobFiles,
    args: [job, 'http://127.0.0.1:8770', kind || 'standard'] });
  const r = (res && res.result) || {};
  if (r.error) { $('ingestInfo').textContent = r.error; toast(r.error); return r; }
  stamp('tsIngest');
  $('ingestInfo').textContent = 'Fed ' + r.fed + (kind === 'ticker' ? ' ticker' : '') +
    ' file(s) - ' + r.rowsAdded + ' new queue row(s), ' +
    r.rowsTotal + ' total' + (r.rowsAdded ? ' - Check & preview to verify' :
    ' - no new rows appeared; the page may need a manual drop') +
    (r.skipped && r.skipped.length ? ' · skipped: ' + r.skipped.join(', ') : '');
  dbg('feed portal', r);
  return r;
}

$('feedPortal').addEventListener('click', async () => {
  const tab = await portalTab();
  if (!tab) { toast('No portal.cognet.tv tab open - open the ingest page first'); return; }
  $('ingestInfo').textContent = 'Streaming job files from Ingest/ into the portal picker…';
  try { await feedPortalNow(tab, jobSlug(), 'standard'); } catch (e) { toast(e.message); }
  refreshTickerStatus();
});

// Ticker builds are the second, video-only ingest: feed just the _ticker
// outputs, then re-run the fill so their rows get id+suffix and
// fingerprint=video. The armed observer would fill them anyway - the
// explicit re-push covers a reloaded portal tab that lost __ingestFill.
$('feedTicker').addEventListener('click', async () => {
  const tab = await portalTab();
  if (!tab) { toast('No portal.cognet.tv tab open - open the ingest page first'); return; }
  $('ingestInfo').textContent = 'Streaming ticker versions into the portal picker…';
  const r = await feedPortalNow(tab, jobSlug(), 'ticker');
  if (!r || r.error) return;
  const plan = ingestPlan();
  if (plan.rows.length) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: portalFill, args: [plan] });
    const [pr] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: portalProbe });
    if (pr && pr.result && pr.result.rows.length) renderIngestVerify(pr.result);
    $('ingestInfo').textContent += ' · ticker fills applied - BEGIN INGEST starts the video-only batch';
  }
  refreshTickerStatus();
});

// Ticker build status for the module's status line + the feed button's
// visibility. Expected count mirrors the manifest's needs_espn rule
// (row flag OR client's ticker-always playbook).
async function refreshTickerStatus() {
  const box = $('tickerInfo'), btn = $('feedTicker');
  if (!box || !btn) return;
  const nEspn = (matched || [])
    .filter(m => !m.excluded && m.matchType !== 'ROW (out of range)' && (m.trackingId || m.id))
    .filter(m => m.espn || tickerAlways()).length;
  if (!nEspn) { box.textContent = ''; btn.classList.add('hidden'); return; }
  try {
    const t = await (await fetch('http://127.0.0.1:8770/ticker-status?job=' +
      encodeURIComponent(jobSlug()))).json();
    if (!t.expected) {
      box.textContent = nEspn + ' ticker version(s) expected - watcher has no manifest yet';
      btn.classList.add('hidden');
      return;
    }
    const ready = (t.ready || []).length, building = (t.building || []).length,
      waiting = (t.waiting || []).length, failed = (t.failed || []).length,
      filed = (t.done || []).length;
    btn.classList.toggle('hidden', !ready);
    box.innerHTML = 'ticker versions: <b>' + ready + '/' + t.expected + ' ready</b>' +
      (building ? ' · ' + building + ' building…' : '') +
      (waiting ? ' · ' + waiting + ' awaiting download' : '') +
      (filed ? ' · ' + filed + ' already built &amp; filed' : '') +
      (failed ? ' · <span style="color:#ec9a9a">' + failed + ' failed - see watcher log</span>' : '') +
      (ready ? ' - feed them as the second, video-only batch' : '');
  } catch (e) {
    box.textContent = nEspn + ' ticker version(s) expected - watcher unreachable';
    btn.classList.add('hidden');
  }
}
// Tick while the section is open: a build finishing flips the status to
// ready and reveals Feed ticker files without a click.
setInterval(() => { if ($('sec5').open) refreshTickerStatus(); }, 15000);

// Manual fallback for deliveries that never came through the extension:
// pick media anywhere -> upload into the job folder (watcher pairs each
// to its manifest row by stem) -> feed the portal picker as usual.
$('pickPortal').addEventListener('click', () => $('portalPick').click());
$('portalPick').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const job = jobSlug();
  $('ingestInfo').textContent = 'Uploading ' + files.length + ' file(s) into ' + job + '…';
  const paired = [], unpaired = [], failed = [];
  for (const f of files) {
    try {
      const r = await fetch('http://127.0.0.1:8770/ingest-upload?job=' +
        encodeURIComponent(job) + '&name=' + encodeURIComponent(f.name),
        { method: 'POST', body: f });
      const d = r.ok ? await r.json() : null;
      if (d && d.saved) (d.paired ? paired : unpaired).push(d.saved);
      else failed.push(f.name);
    } catch (e2) { failed.push(f.name); }
  }
  $('ingestInfo').textContent = 'Landed ' + paired.length + unpaired.length + ' of ' + files.length +
    ' file(s)' + (unpaired.length ? ' · unpaired: ' + unpaired.join(', ') : '') +
    (failed.length ? ' · failed: ' + failed.join(', ') : '');
  if (failed.length === files.length) { toast('Upload failed - is ingest_watch running?'); return; }
  if (unpaired.length) toast('Some files matched no manifest row - they stay in the job folder unpaired.');
  const tab = await portalTab();
  if (!tab) { toast('Files are in the job folder - open the portal ingest page, then Feed files.'); return; }
  try { await feedPortalNow(tab, job, 'standard'); } catch (e3) { toast(e3.message); }
  refreshTickerStatus();
});

// ---------- live portal ingest status (records API while panel is open) ----------
const PORTAL_STAGE = { INGEST_STARTED: 'uploading', INGEST_COMPLETED: 'queued for detection',
  DETECTION_STARTED: 'detecting', PROCESSING: 'processing' };

async function portalLiveTick() {
  const box = $('portalLive');
  if (!box) return;
  const realm = ingestRealm();
  const wanted = ingestReportIds();
  if (!realm || !wanted.length) { box.textContent = ''; return; }
  try {
    const all = await fetchRealmRecords(realm, 1);
    const idx = new Map(all.map(r => [normalizeName(r.reportingId || '').replace(/ /g, ''), r]));
    const info = wanted.map(w => {
      const rec = idx.get(normalizeName(w.reporting).replace(/ /g, ''));
      const st = rec ? (rec.status || '?') : 'no record';
      const stage = PORTAL_STAGE[st];
      const pct = rec && rec.admin_visible && rec.admin_visible.detection_percentage != null
        ? ' ' + Math.round(rec.admin_visible.detection_percentage) + '%' : '';
      const res = rec && rec.detection_result && rec.detection_result !== 'pass'
        ? '/' + rec.detection_result : '';
      const failed = !!rec && (st.indexOf('INGEST_FAILED') === 0 ||
        (!!rec.detection_result && rec.detection_result !== 'pass'));
      return { id: w.reporting, st: st + (stage ? ' (' + stage + ')' : '') + pct + res, failed,
        done: !!rec && (st === 'DETECTION_COMPLETED' || st.indexOf('INGEST_FAILED') === 0) };
    });
    const done = info.filter(i => i.done).length;
    const fails = info.filter(i => i.failed);
    // Failed records used to count silently as "done" - a ticker ingest
    // could die with zero surfacing. Name them and chime once per ID.
    fails.forEach(f => {
      if (portalFailAlerted.has(f.id)) return;
      portalFailAlerted.add(f.id);
      alertSound('warn', 'portal ingest failed: ' + f.id,
        'Portal ingest ' + f.id + ' - ' + f.st);
    });
    box.innerHTML = 'portal ingest: <b>' + done + '/' + wanted.length + '</b>' +
      (fails.length ? ' · <span style="color:#ec9a9a">' + fails.length + ' failed: ' +
        esc(fails.map(f => f.id).join(', ')) + '</span>' : '') +
      (done < wanted.length ? '<br>' + info.filter(i => !i.done).slice(0, 10).map(i => esc(i.id + ' · ' + i.st)).join('<br>') : ' · all in');
    if (done === wanted.length) stopPortalLive();
  } catch (e) { box.textContent = 'portal status: ' + e.message; }
}
function stopPortalLive() {
  if (portalLiveTimer) { clearInterval(portalLiveTimer); portalLiveTimer = null; }
}
function startPortalLive() {
  stopPortalLive();
  portalLiveTick();
  portalLiveTimer = setInterval(portalLiveTick, 30000);
}

// Panel reload = fresh run: only one-shot handoffs (pendingIds/pendingFiles)
// and config keys (ER key + sweep prefs) restore. Email/ids/files/sheet are
// request data - they belong to a completed batch, not a new session.
chrome.storage.local.get(['pendingIds', 'pendingFiles', 'erApiKey', 'erSender', 'erDays'], data => {
  if (data.pendingIds) { idsEl.value = data.pendingIds; chrome.storage.local.remove('pendingIds'); }
  if (data.pendingFiles) { filesEl.value = data.pendingFiles; chrome.storage.local.remove('pendingFiles'); }
  if (data.erApiKey) { erApiKey = data.erApiKey; $('erApiKey').value = erApiKey; }
  if (data.erSender) $('erSender').value = data.erSender;
  if (data.erDays) $('erDays').value = data.erDays;
});

// Dependency gate + health: the panel is unusable until the required
// install-side deps (watcher + ffprobe) pass once - then depsOk latches
// and the gate never shows again. A later regression (watcher dies)
// surfaces as the non-blocking depWarn strip instead.
async function watcherHealth() {
  try {
    const r = await fetch('http://127.0.0.1:8770/health', { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}
function showDepWarn(msg) {
  const el = $('depWarn');
  if (!el) return;
  el.innerHTML = esc(msg) + ' <a href="#" id="depWarnHelp">setup guide</a>';
  el.classList.remove('hidden');
  $('depWarnHelp').addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  });
}
async function depWarnCheck() {
  const h = await watcherHealth();
  if (h && h.ffprobe) return; // everything the panel can't do itself is up
  showDepWarn(h && !h.ffprobe
    ? 'ffprobe not found - spec checks and _ticker builds are off (brew install ffmpeg).'
    : 'download watcher not running - downloads, tickers and portal feed are offline.');
}
let gateTimer = null;
async function gateCheck() {
  const h = await watcherHealth();
  const okWatch = !!h;
  const okProbe = !!(h && h.ffprobe);
  const rows = [
    { ok: okWatch, label: 'download watcher', fix: okWatch ? 'listening on 127.0.0.1:8770'
      : 'run watcher/install.command from the full package (double-click)' },
    { ok: okProbe, label: 'ffprobe - spec checks + ticker builds', fix: !okWatch ? 'needs the watcher running first'
      : okProbe ? 'found' : 'brew install ffmpeg' },
  ];
  $('gateList').innerHTML = rows.map(r =>
    '<div class="gateRow"><span class="cbx ' + (r.ok ? 'ok' : '') + '">' + (r.ok ? '✓' : '') +
    '</span><span><b>' + esc(r.label) + '</b><br><span class="fix">' + esc(r.fix) + '</span></span></div>').join('');
  if (rows.every(r => r.ok)) {
    chrome.storage.local.set({ depsOk: 1 });
    $('depGate').classList.add('hidden');
    clearInterval(gateTimer); gateTimer = null;
    depWarnCheck(); // strip stays off - all green - but keep the check consistent
  }
}
chrome.storage.local.get('depsOk', d => {
  if (d.depsOk) { $('depGate').classList.add('hidden'); depWarnCheck(); return; }
  gateCheck();
  gateTimer = setInterval(gateCheck, 4000);
});
$('gateGuide').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});
$('openSetup').addEventListener('click', e => {
  e.preventDefault();
  e.stopPropagation();
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

// Connection dots in ⚙ Settings: green = verified live, amber = set but
// only partially working, red = set but failing, empty = not configured.
// Runs each time the settings panel opens - cheap probes only.
function credDot(id, state, title) {
  const d = $(id);
  if (!d) return;
  d.className = 'sdot cred' + (state ? ' ' + state : '');
  d.title = title || '';
}
async function checkConns() {
  ['sdWatch', 'sdMs', 'sdJira', 'sdAt', 'sdEr', 'sdDbx'].forEach(id => credDot(id, 'chk', 'checking…'));
  const jobs = [];

  jobs.push(watcherHealth().then(h => credDot('sdWatch',
    h ? (h.ffprobe ? 'ok' : 'warn') : 'fail',
    h ? (h.ffprobe ? 'watcher running - all deps present' : 'watcher running, but ffprobe missing')
      : 'watcher unreachable - run watcher/install.command')));

  jobs.push(msLoad().then(async () => {
    if (!MS.refreshToken) return credDot('sdMs', '', 'not signed in');
    try { await msAccessToken(); credDot('sdMs', 'ok', 'inbox sign-in works'); }
    catch (e) { credDot('sdMs', 'fail', 'sign-in expired - sign in again'); }
  }).catch(() => credDot('sdMs', 'fail', 'sign-in check failed')));

  jobs.push((async () => {
    if (!$('jiraEmail').value.trim() && !$('jiraToken').value.trim()) return credDot('sdJira', '', 'no credentials set');
    try { await jiraFetch('/rest/api/3/myself'); credDot('sdJira', 'ok', 'Jira credentials verified'); }
    catch (e) { credDot('sdJira', 'fail', e.message); }
  })());

  jobs.push((async () => {
    const t = $('atToken').value.trim();
    if (!t) return credDot('sdAt', '', 'no token set');
    try {
      const r = await fetch('https://api.airtable.com/v0/meta/whoami', { headers: { Authorization: 'Bearer ' + t } });
      credDot('sdAt', r.ok ? 'ok' : 'fail', r.ok ? 'Airtable token verified' : 'Airtable ' + r.status + ' - token rejected?');
    } catch (e) { credDot('sdAt', 'fail', 'Airtable unreachable'); }
  })());

  jobs.push((async () => {
    if (!erApiKey) return credDot('sdEr', '', 'no API key set');
    try {
      // Any non-auth response means the key was accepted - a deliberate
      // bogus path gives 401/403 only when the key itself is rejected.
      const r = await erApiGet('/ping');
      credDot('sdEr', r.status === 401 || r.status === 403 ? 'fail' : 'ok',
        r.status === 401 || r.status === 403 ? 'ER API key rejected (' + r.status + ')' : 'ER API key accepted');
    } catch (e) { credDot('sdEr', 'fail', 'ER API unreachable'); }
  })());

  jobs.push((async () => {
    const c = dbxCfg();
    if (!c.host && !c.tok) return credDot('sdDbx', '', 'no credentials set');
    if (!dbxReady(c)) return credDot('sdDbx', 'warn', 'host/warehouse/token incomplete');
    try { await dbxApi('/api/2.0/sql/warehouses?page_size=1', 'GET'); credDot('sdDbx', 'ok', 'Databricks connected'); }
    catch (e) { credDot('sdDbx', 'fail', e.message); }
  })());

  await Promise.allSettled(jobs);
}

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

// Notification clicks carry intent: the service worker stashes a
// pendingAction so the panel opens in context - the request mail loads,
// a delivery arrival re-runs the check. Applied on load and live.
async function applyPendingAction() {
  const d = await chrome.storage.local.get('pendingAction');
  const pa = d.pendingAction;
  if (!pa) return;
  await chrome.storage.local.remove('pendingAction');
  if (Date.now() - (pa.at || 0) > 10 * 60e3) return; // stale - ignore
  if (pa.type === 'mail' && pa.id) await loadMailById(pa.id);
  else if (pa.type === 'recheck') $('recheck').click();
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.pendingAction && ch.pendingAction.newValue) applyPendingAction();
});
applyPendingAction();

// Next-step guidance: the stage dots already know where the run stands -
// read the first non-ok one and name its action. Clicking jumps there.
const NEXT_STEPS = [
  ['sdEmail', 'sec1', 'load the request email - Run all, Check inbox, or Grab from Outlook'],
  ['sdSheet', 'sec2', 'load the tracker - auto-pulls from the email link, or Grab sheet tab'],
  ['sdMatch', 'sec3', 'press Match to pair the codes with rows'],
  ['sdDl', 'sec4', 'download the media - any file page, a delivery search, or the watch'],
  ['sdIngest', 'sec5', 'fill the portal queue, verify, draft Jira'],
  ['sdReply', 'sec6', 'draft the reply'],
];
// Progressive disclosure: a section opens once the step above it has
// run (ok or warn - fail keeps focus where the problem is). Opens only;
// never closes anything the user opened by hand.
const SEC_CHAIN = [
  ['sec2', 'sdEmail'], ['sec3', 'sdSheet'], ['sec4', 'sdMatch'],
  ['sec5', 'sdDl'], ['sec6', 'sdIngest'],
];
setInterval(() => {
  const el = $('nextStep');
  if (!el) return;
  SEC_CHAIN.forEach(([sec, sd]) => {
    const s = $(sd), d = $(sec);
    if (s && d && /(^| )(ok|warn)( |$)/.test(s.className)) d.open = true;
  });
  const step = NEXT_STEPS.find(([sd]) => !/(^| )ok( |$)/.test(($(sd) || {}).className || ''));
  const tip = step && $(step[0]) && $(step[0]).title;
  el.innerHTML = !step ? '&#10003; all steps done - ready for the next request'
    : '&rarr; next: <a href="#" data-sec="' + step[1] + '">' + esc(step[2]) + '</a>' +
      (tip ? ' <i>(' + esc(tip) + ')</i>' : '');
}, 2500);
$('nextStep').addEventListener('click', e => {
  const sec = e.target.getAttribute && e.target.getAttribute('data-sec');
  if (!sec) return;
  e.preventDefault();
  const d = $(sec);
  if (d) { d.open = true; d.scrollIntoView({ block: 'nearest' }); }
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
  if (!p.classList.contains('hidden')) checkConns();
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

// ---------- Jira ticket + ingest proof (fileingest.cognet.tv) ----------

// The portal's records API - same read-only endpoint the detection-engine
// mirror uses. Records are authoritative proof of ingest (status +
// detection result), better evidence than a queue screenshot.
const FI_BASE = 'https://fileingest.cognet.tv';
const FI_AUTH = 'Basic Y3Jvb21pYW46c1pJUiNVWmVkNVVNZzQ4Sg==';
const FI_ALIASES = { horizon: 'horizonmedia', 'in-market': 'inmarket', itn: 'itnnetworks', chief: 'chiefmedia' };

function ingestRealm() {
  const cid = (client && client.ingest && client.ingest.cidMap) || '';
  const first = Array.isArray(cid) ? cid[0] : cid;
  const n = String(first).toLowerCase().replace(/ /g, '');
  return FI_ALIASES[n] || n;
}

// Rare blocking ask: a stage missing exactly one datum prompts for it
// instead of dead-ending on a toast. Cancel returns ''.
function askFor(what, hint) {
  return (prompt('Ingest needs ' + what + (hint ? '\n(' + hint + ')' : '') + ':') || '').trim();
}

// Verify/Jira realm: playbook cidMap first, then the persisted records-
// lookup realm, then - rarely - ask once and save it for next time.
function resolveRealm() {
  const v = (ingestRealm() || $('recRealm').value.trim() || $('impRealm').value.trim() ||
    '').toLowerCase().replace(/ /g, '');
  if (v) return FI_ALIASES[v] || v;
  const a = askFor('the portal customer realm', 'e.g. discovery, horizonmedia');
  if (!a) return '';
  const realm = (FI_ALIASES[a.toLowerCase()] || a).toLowerCase();
  $('recRealm').value = $('impRealm').value = realm;
  chrome.storage.local.set({ recRealm: realm });
  return realm;
}

// Learned epic overrides: an epic keyed in at ask-time sticks to that
// client id, so the prompt is once per client, not once per run.
let epicOverrides = {};
chrome.storage.local.get('epicOverrides', d => { epicOverrides = d.epicOverrides || {}; });

// Reporting IDs exactly as pushed to the portal: bare id per row, plus
// id+suffix for rows flagged for a ticker version.
// Standalone record lookup: "was this creative ingested / is it
// detecting?" for arbitrary IDs, independent of any run. The separate
// "impression counts" block below it resolves reporting IDs to
// commercial_cids through the same records API, then counts impressions
// in the Databricks firehose (or hands back the SQL when unconfigured).
// Both share one persisted "last customer" realm.
{
  const realms = new Set();
  (typeof CLIENTS !== 'undefined' ? CLIENTS : []).forEach(c =>
    [].concat((c.ingest && c.ingest.cidMap) || []).forEach(v => v && realms.add(String(v).toLowerCase())));
  Object.keys(FI_ALIASES).forEach(k => { realms.add(k); realms.add(FI_ALIASES[k]); });
  $('realmList').innerHTML = [...realms].sort().map(v => '<option value="' + esc(v) + '">').join('');
}
chrome.storage.local.get('recRealm', d => {
  if (d.recRealm) { $('recRealm').value = d.recRealm; $('impRealm').value = d.recRealm; }
});
['recRealm', 'impRealm'].forEach(id => $(id).addEventListener('input',
  e => chrome.storage.local.set({ recRealm: e.target.value.trim() })));
function lookupRealm() {
  const v = ($('recRealm').value.trim() || $('impRealm').value.trim() ||
    (client ? ingestRealm() : '') || '').toLowerCase().replace(/ /g, '');
  if (!v) return '';
  $('recRealm').value = $('impRealm').value = v;
  return FI_ALIASES[v] || v;
}
// IDs lead filenames in this workflow ("DSBK2966000H SBK_..._30.mp4") -
// codes/file-ids first, first-token-per-line as the fallback.
function parseLookupIds(raw) {
  let ids = extractCodes(raw).concat(extractFileIds(raw));
  if (!ids.length) ids = raw.split(/[\r\n,;]+/).map(s => (s.trim().split(/\s+/)[0] || '')).filter(Boolean);
  return [...new Set(ids.map(s => s.replace(/\.[a-z0-9]{2,5}$/i, '')).filter(Boolean))];
}

$('recGo').addEventListener('click', async () => {
  const ids = parseLookupIds($('recIds').value);
  if (!ids.length) { toast('Paste one or more reporting IDs / file names first.'); return; }
  const realm = lookupRealm();
  if (!realm) { toast('Which customer? e.g. horizonmedia, discovery'); return; }
  const out = $('recResults');
  out.textContent = 'Looking up ' + ids.length + ' ID(s) in ' + realm + '…';
  try {
    const all = await fetchRealmRecords(realm, 2);
    const byRid = new Map(), byTitle = new Map();
    all.forEach(r => {
      byRid.set(normalizeName(r.reportingId || '').replace(/[\s:_-]+/g, ''), r);
      byTitle.set(normalizeName(r.contentTitle || '').replace(/[\s:_-]+/g, ''), r);
    });
    out.innerHTML = ids.map(id => {
      const n = normalizeName(id).replace(/[\s:_-]+/g, '');
      const rec = byRid.get(n) || byTitle.get(n);
      if (!rec) {
        return '<div>' + esc(id) + ' · <i>no record in ' + esc(realm) +
          ' - wrong customer, or never ingested</i></div>';
      }
      const st = rec.status || '';
      const dr = rec.detection_result;
      const pct = rec.admin_visible && rec.admin_visible.detection_percentage != null
        ? 'detected ' + Math.round(rec.admin_visible.detection_percentage) + '%' : '';
      const when = (rec.ingestDatetime || rec.datetime || '').replace('T', ' ').slice(5, 16);
      const bad = st === 'INGEST_FAILED' || (!!dr && dr !== 'pass');
      const label = st === 'DETECTION_COMPLETED' ? 'done' + (dr ? ' · ' + dr : '')
        : st === 'INGEST_FAILED' ? 'ingest failed'
        : PORTAL_STAGE[st] || st || 'unknown state';
      return '<div>' + esc(id) + ' · ' +
        '<span style="color:' + (bad ? '#ec9a9a' : '#3fbf7f') + '">' + esc(label) + '</span>' +
        (pct ? ' · ' + esc(pct) : '') + (when ? ' · ingested ' + esc(when) : '') + '</div>';
    }).join('');
  } catch (e) {
    out.textContent = 'Lookup failed: ' + e.message + ' - check the customer name / records API token';
  }
});

// A record's admin_visible.cid is "C(^.~)c_Commercial_<commercial_cid>";
// the firehose table keys on the suffix only.
function recordCommercialCid(rec) {
  const raw = (rec.admin_visible && rec.admin_visible.cid) || '';
  const i = raw.indexOf('Commercial_');
  return i < 0 ? '' : raw.slice(i + 'Commercial_'.length);
}
function recordImprWindow(rec) {
  return {
    start: (rec.ingestDatetime || rec.create_datetime || '').slice(0, 10) ||
      new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10),
    end: new Date(Date.now() + 864e5).toISOString().slice(0, 10)
  };
}
function dbxLit(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function dbxResolveSql(ccid) {
  return 'SELECT a.commercial_cid, a.commercial_id AS filterable_id, b.title, b.brand_name, c.client_name\n' +
    'FROM detection.commercial_ids_firehose a\n' +
    '         JOIN detection.commercial_id_external_firehose b\n' +
    '              ON b.fk_commercial_id = a.commercial_id\n' +
    '         JOIN detection.clients c\n' +
    '              ON c.client_id = b.fk_client_id\n' +
    'WHERE a.commercial_cid = ' + dbxLit(ccid) + '\n' +
    'LIMIT 1000;';
}
function dbxCountSql(fid, start, end, raw) {
  return 'SELECT COUNT(*)\n' +
    'FROM detection.viewing_commercials_firehose vcf\n' +
    'WHERE vcf.session_start >= ' + dbxLit(start + ' 00:00:00') + '\n' +
    '  AND vcf.session_end < ' + dbxLit(end + ' 00:00:00') + '\n' +
    '  AND vcf.fk_commercial_id ' + (raw ? fid : '= ' + dbxLit(fid)) + ';';
}
function impressionsSql(label, ccid, start, end) {
  return '-- ' + label + ' (resolve commercial_id, then count impressions)\n' +
    dbxResolveSql(ccid) + '\n\n' +
    dbxCountSql('<filterable_id from the query above>', start, end) + '\n\n' +
    '-- single-run variant (no manual join):\n' +
    dbxCountSql('IN (SELECT commercial_id FROM detection.commercial_ids_firehose WHERE commercial_cid = ' +
      dbxLit(ccid) + ')', start, end, true);
}
// Direct Databricks SQL via the Statements API. With host + warehouse +
// PAT configured, Count runs the queries live; without, per-row links
// copy the same SQL for a manual paste.
['dbxHost', 'dbxWh', 'dbxTok'].forEach(id => {
  chrome.storage.local.get(id, d => { if (d[id]) $(id).value = d[id]; });
  $(id).addEventListener('input', e => chrome.storage.local.set({ [id]: e.target.value.trim() }));
});
function dbxCfg() {
  return {
    host: $('dbxHost').value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    wh: $('dbxWh').value.trim(),
    tok: $('dbxTok').value.trim()
  };
}
const dbxReady = c => c.host && c.wh && c.tok;
async function dbxApi(path, method, body) {
  const c = dbxCfg();
  const r = await fetch('https://' + c.host + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + c.tok, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body)
  });
  if (!r.ok) throw new Error('Databricks ' + r.status +
    (r.status === 401 || r.status === 403 ? ' - token rejected' : r.status === 404 ? ' - check host/path' : ''));
  return r.json();
}
async function dbxQuery(sql) {
  const c = dbxCfg();
  let r = await dbxApi('/api/2.0/sql/statements', 'POST',
    { warehouse_id: c.wh, statement: sql, wait_timeout: '50s' });
  // Cold warehouses can outlast the 50s wait - poll until terminal state.
  for (let i = 0; r.statement_id && r.status && !/^(SUCCEEDED|FAILED|CANCELED|CLOSED)$/.test(r.status.state) && i < 40; i++) {
    await new Promise(x => setTimeout(x, 3000));
    r = await dbxApi('/api/2.0/sql/statements/' + r.statement_id, 'GET');
  }
  if (!r.status || r.status.state !== 'SUCCEEDED') {
    const em = r.status && r.status.error && r.status.error.message;
    throw new Error('query ' + ((r.status && r.status.state) || 'no response') + (em ? ': ' + em : ''));
  }
  return (r.result && r.result.data_array) || [];
}
$('dbxPing').addEventListener('click', async () => {
  const c = dbxCfg();
  if (!c.host || !c.tok) { toast('Set the workspace host + token first.'); return; }
  try {
    const d = await dbxApi('/api/2.0/sql/warehouses?page_size=50', 'GET');
    const whs = (d.warehouses || []).map(w => w.id + ' ' + w.name + ' [' + (w.state || '?') + ']');
    dbg('databricks warehouses', whs);
    toast(whs.length ? whs.length + ' warehouse(s) - ids in the debug log'
      : 'Connected - no warehouses listed');
    credDot('sdDbx', 'ok', 'Databricks connected');
  } catch (e) { toast('Databricks: ' + e.message); credDot('sdDbx', 'fail', e.message); }
});

// Impression counts: separate from the run flow - paste reporting IDs
// (resolved through the records API) or bare commercial_cids. Every
// state is spelled out: no record, no cid yet, firehose lag, live count.
let lastImpLookup = new Map();
const CCID_RE = /^[a-z0-9]+-\d{9,}-[0-9a-f]{8,}$/i;
$('impResults').addEventListener('click', e => {
  const k = e.target.getAttribute && e.target.getAttribute('data-impsql');
  if (k == null) return;
  e.preventDefault();
  const j = lastImpLookup.get(k);
  if (!j) return;
  navigator.clipboard.writeText(impressionsSql(j.id, j.ccid, j.start, j.end))
    .then(() => toast('Impressions queries copied - paste into Databricks.'))
    .catch(() => toast('Copy failed.'));
});
$('impGo').addEventListener('click', async () => {
  const raw = $('impIds').value;
  let toks = parseLookupIds(raw);
  if (!toks.length) toks = raw.split(/[\r\n,;\s]+/).map(s => s.trim()).filter(Boolean);
  const cids = [], ids = [];
  [...new Set(toks)].forEach(t => (CCID_RE.test(t) ? cids : ids).push(t));
  if (!ids.length && !cids.length) { toast('Paste reporting IDs or commercial_cids first.'); return; }
  const realm = lookupRealm();
  if (ids.length && !realm) { toast('Which customer? needed to resolve reporting IDs.'); return; }
  const out = $('impResults');
  // Optional window override: "from" is inclusive; "to" is a day the user
  // expects included, so translate to the exclusive end the SQL uses.
  const ovStart = $('impStart').value;
  const ovEnd = $('impEnd').value
    ? new Date(new Date($('impEnd').value + 'T00:00:00Z').getTime() + 864e5).toISOString().slice(0, 10)
    : '';
  const jobs = [];
  if (ids.length) {
    out.textContent = 'Resolving ' + ids.length + ' ID(s) in ' + realm + '…';
    let recs;
    try { recs = await fetchRealmRecords(realm, 2); }
    catch (e) { out.textContent = 'Records fetch failed: ' + e.message; return; }
    const byRid = new Map();
    recs.forEach(r => byRid.set(normalizeName(r.reportingId || '').replace(/[\s:_-]+/g, ''), r));
    ids.forEach(id => {
      const rec = byRid.get(normalizeName(id).replace(/[\s:_-]+/g, ''));
      if (!rec) { jobs.push({ id, err: 'no record in ' + realm + ' - wrong customer or never ingested' }); return; }
      const ccid = recordCommercialCid(rec);
      if (!ccid) { jobs.push({ id, err: 'record exists, but no commercial cid assigned yet' }); return; }
      const w = recordImprWindow(rec);
      jobs.push({ id, ccid, start: ovStart || w.start, end: ovEnd || w.end });
    });
  }
  cids.forEach(ccid => jobs.push({
    id: ccid, ccid,
    start: ovStart || new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10),
    end: ovEnd || new Date(Date.now() + 864e5).toISOString().slice(0, 10)
  }));
  lastImpLookup = new Map();
  jobs.forEach(j => { if (j.ccid) lastImpLookup.set(j.id, j); });
  const sqlLink = j => ' · <a href="#" data-impsql="' + esc(j.id) +
    '" title="Copy the Databricks queries for this ID">sql</a>';
  if (!dbxReady(dbxCfg())) {
    out.innerHTML = jobs.map(j => '<div>' + esc(j.id) + ' · ' +
      (j.err ? '<i>' + esc(j.err) + '</i>' : '<a href="#" data-impsql="' + esc(j.id) +
        '">copy impression queries</a>') + '</div>').join('') +
      '<div class="hint">Databricks not configured - links copy SQL for a manual paste.</div>';
    return;
  }
  const lines = [];
  const push = html => { lines.push(html); out.innerHTML = lines.join(''); };
  for (const j of jobs) {
    if (j.err) { push('<div>' + esc(j.id) + ' · <i>' + esc(j.err) + '</i></div>'); continue; }
    push('<div>' + esc(j.id) + ' · running…</div>');
    try {
      const rows = await dbxQuery(dbxResolveSql(j.ccid));
      const fid = rows[0] && rows[0][1];
      if (!fid) {
        lines[lines.length - 1] = '<div>' + esc(j.id) +
          ' · <i>not in firehose yet - cids stream in ~1-2h after ingest, nothing to count</i>' + sqlLink(j) + '</div>';
      } else {
        const title = rows[0][2] ? ' <i>(' + esc(rows[0][2]) + ')</i>' : '';
        const cnt = await dbxQuery(dbxCountSql(String(fid), j.start, j.end));
        const n = (cnt[0] && cnt[0][0]) != null ? cnt[0][0] : '?';
        lines[lines.length - 1] = '<div>' + esc(j.id) + ' · <b style="color:#3fbf7f">' +
          esc(String(n)) + ' impressions</b> (' + esc(j.start) + ' → ' + esc(j.end) + ')' +
          title + sqlLink(j) + '</div>';
      }
    } catch (e) {
      lines[lines.length - 1] = '<div>' + esc(j.id) +
        ' · <span style="color:#ec9a9a">query failed: ' + esc(e.message) + '</span></div>';
    }
    out.innerHTML = lines.join('');
  }
});

function ingestReportIds() {
  const plan = ingestPlan();
  const ids = [];
  plan.rows.forEach(r => {
    if (!r.id) return;
    ids.push({ reporting: r.id, title: r.title, espn: false });
    if (r.espn) ids.push({ reporting: r.id + plan.opts.tickerSuffix, title: r.title, espn: true });
  });
  return ids;
}

async function fetchRealmRecords(realm, pages) {
  const out = [];
  for (let p = 0; p < (pages || 1); p++) {
    const r = await fetch(FI_BASE + '/v1/' + realm + '/content?offset=' + (p * 500 + 1) + '&limit=500',
      { headers: { Authorization: FI_AUTH } });
    if (!r.ok) throw new Error('records API ' + r.status);
    const j = await r.json();
    out.push(...(j.content || []));
    if ((j.content || []).length < 500) break;
  }
  return out;
}

let lastIngestRecords = [];

// Query the realm's records for the wanted reporting IDs, paint the result,
// and leave lastIngestRecords set for the Jira proof. Returns the filtered
// records (empty on API failure - caller treats it as "no records proof").
async function runVerify(wanted) {
  const realm = resolveRealm();
  if (!realm) throw new Error('no ingest realm (cidMap) on this playbook');
  $('verifyInfo').textContent = 'Querying ' + realm + ' records…';
  try {
    // Pages scale with batch size: records return newest-first, and a big
    // Tatari push can bury older IDs under today's other ingests.
    const all = await fetchRealmRecords(realm, Math.max(2, Math.ceil(wanted.length / 500) + 1));
    const want = new Map(wanted.map(w => [normalizeName(w.reporting).replace(/ /g, ''), w.reporting]));
    lastIngestRecords = all.filter(r => want.has(normalizeName(r.reportingId || '').replace(/ /g, '')));
    const hitIds = new Set(lastIngestRecords.map(r => normalizeName(r.reportingId).replace(/ /g, '')));
    const missed = wanted.filter(w => !hitIds.has(normalizeName(w.reporting).replace(/ /g, '')));
    $('verifyInfo').innerHTML =
      '<b>' + lastIngestRecords.length + '/' + wanted.length + '</b> reporting ID(s) in ' + esc(realm) + ' records' +
      (missed.length ? ' - <span style="color:#ec9a9a">not found: ' + missed.slice(0, 8).map(m => esc(m.reporting)).join(', ') + (missed.length > 8 ? ' +' + (missed.length - 8) : '') + '</span>' : '') +
      (lastIngestRecords.length ? '<br>' + lastIngestRecords.slice(0, 10).map(r =>
        esc(r.reportingId) + ' · ' + esc(r.status || '?') + ' · ' + esc(String(r.datetime || '').slice(0, 19).replace('T', ' '))).join('<br>') : '');
    $('saveRecords').classList.toggle('hidden', !lastIngestRecords.length);
    return lastIngestRecords;
  } catch (e) {
    lastIngestRecords = [];
    $('verifyInfo').textContent = 'records query failed: ' + e.message;
    dbg('verify failed', e.message);
    return [];
  }
}

$('verifyIngest').addEventListener('click', async () => {
  const realm = resolveRealm();
  if (!realm) return toast('No ingest realm (cidMap) on this playbook.');
  ensureMatchRows();
  const wanted = ingestReportIds();
  if (!wanted.length) return toast('No matched rows - run Match first.');
  try {
    modStat('stJira', 'Checking ' + realm + ' records…');
    await runVerify(wanted);
    modStatDone('stJira', lastIngestRecords.length + '/' + wanted.length + ' record(s) found');
    startPortalLive();
  } catch (e) { toast(e.message); }
});

// Filtered records JSON = the attach-able proof for the Jira ticket -
// same artifact the Tatari/large-batch workflow already uses.
$('saveRecords').addEventListener('click', async () => {
  if (!lastIngestRecords.length) return;
  const job = jobSlug();
  const payload = JSON.stringify({
    job, realm: ingestRealm(), queried_at: new Date().toISOString(),
    records: lastIngestRecords,
  }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: 'Ingest/_previous jobs/' + job + '-ingest-records.json' });
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast('Saved ' + job + '-ingest-records.json to Ingest/_previous jobs/ - attach it to the ticket.');
});

function buildJiraTicket() {
  const wanted = ingestReportIds();
  // Timestamp rides above the request as a header line - searchable and
  // provenance-clear, without rewriting the email itself.
  const eml = (emailDate ? 'Date: ' + emailDate + '\n' : '') + ticketEmail(emailEl.value);
  const lines = [eml, '', '----', '', 'Ingest:'];
  if (!wanted.length) lines.push('(no IDs cited yet - add lines here)');
  wanted.forEach(w => lines.push(w.reporting + (w.title ? ' - ' + w.title : '') + (w.espn ? ' (ESPN)' : '')));
  return lines.join('\n');
}

$('rebuildTicket').addEventListener('click', () => {
  $('jiraPreview').value = buildJiraTicket();
});
$('clearTicket').addEventListener('click', () => { $('jiraPreview').value = ''; });
$('copyTicket').addEventListener('click', () => copyText($('jiraPreview').value, 'Jira ticket'));

// Capture the portal tab (activates it for a moment). Throws with the real
// reason on failure - callers decide whether that's fatal.
async function capturePortalShot() {
  const tabs = await chrome.tabs.query({ url: '*://portal.cognet.tv/*' });
  if (!tabs.length) throw new Error('no portal.cognet.tv tab open');
  await chrome.tabs.update(tabs[0].id, { active: true });
  await chrome.windows.update(tabs[0].windowId, { focused: true });
  await new Promise(r => setTimeout(r, 800));
  return chrome.tabs.captureVisibleTab(tabs[0].windowId, { format: 'png' });
}

// Visual proof when wanted: captures the portal tab, saves into the job folder.
$('shotPortal').addEventListener('click', async () => {
  try {
    const dataUrl = await capturePortalShot();
    const job = jobSlug();
    await chrome.downloads.download({ url: dataUrl, filename: 'Ingest/_previous jobs/' + job + '-ingest-screenshot.png' });
    toast('Screenshot saved to Ingest/_previous jobs/');
  } catch (e) {
    dbg('screenshot failed', e.message);
    toast('Screenshot failed: ' + e.message);
  }
});

// ---------- Jira weekly-repository comment ----------

const JIRA_BASE = 'https://vizio.atlassian.net';

function jiraAuth() {
  const e = $('jiraEmail').value.trim(), t = $('jiraToken').value.trim();
  return e && t ? 'Basic ' + btoa(e + ':' + t) : null;
}
async function jiraFetch(path, opts) {
  opts = opts || {};
  const a = jiraAuth();
  if (!a) throw new Error('set Jira email + API token in the Settings (gear) panel');
  const r = await fetch(JIRA_BASE + path, {
    ...opts,
    headers: { Authorization: a, Accept: 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error('Jira ' + r.status + ': ' + (await r.text()).slice(0, 160));
  return r.status === 204 ? null : r.json();
}
function jiraEpicFor() {
  if (client && epicOverrides[client.id]) return epicOverrides[client.id];
  const ing = (client && client.ingest) || {};
  if (ing.jiraEpic) return ing.jiraEpic;
  return JIRA_EPICS[ingestRealm()] || null;
}
// Weekly repository tickets are named "<Client> - File Ingests - Week of
// MM/DD/YY" for that week's Monday - but the convention drifts per epic
// (Discovery/Kantar use lowercase "file ingests - week of" and a 4-digit
// year), so matching tolerates both year forms and case, and new tickets
// clone the previous week's naming verbatim.
function weekMonday(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  return t;
}
function weekLabel(d, longYear) {
  const t = weekMonday(d);
  return (t.getMonth() + 1) + '/' + String(t.getDate()).padStart(2, '0') + '/' +
    (longYear ? t.getFullYear() : String(t.getFullYear()).slice(2));
}
async function jiraWeeklyTicket(epic) {
  const j = await jiraFetch('/rest/api/3/search/jql?jql=' +
    encodeURIComponent('parent = ' + epic + ' ORDER BY created DESC') +
    '&maxResults=12&fields=summary,created');
  const kids = j.issues || [];
  const l2 = 'week of ' + weekLabel(new Date()), l4 = 'week of ' + weekLabel(new Date(), true);
  const hit = kids.find(i => {
    const s = (i.fields.summary || '').toLowerCase();
    return s.includes(l2) || s.includes(l4);
  });
  return { issue: hit || null, newest: kids[0] || null };
}
// Name a new weekly task by cloning the newest sibling's convention and
// swapping its week date for this week's (same year format). Falls back
// to the canonical "File Ingests - Week of MM/DD/YY" shape.
function weeklyTicketName(newest, epicSummary) {
  const s = newest && newest.fields && newest.fields.summary;
  const m = s && s.match(/week of (\d{1,2}\/\d{1,2})\/(\d{2,4})/i);
  if (!m) return epicSummary + ' - File Ingests - Week of ' + weekLabel(new Date());
  return s.replace(/week of \d{1,2}\/\d{1,2}\/\d{2,4}/i,
    'week of ' + weekLabel(new Date(), m[2].length === 4));
}
// ADF built from the PREVIEW TEXT (user-editable): everything above the
// first "----" line posts as the received email, each line under it joins
// the hardBreak-separated ingest list after "ingest:". Edits in the
// textarea are what actually post.
function jiraCommentAdf(text, atts, withMedia) {
  const para = t => ({ type: 'paragraph', content: [{ type: 'text', text: t || ' ' }] });
  const content = [para('Received the following email:')];
  const lines = String(text || '').split(/\r?\n/);
  const sep = lines.findIndex(l => /^-{3,}\s*$/.test(l.trim()));
  const emailLines = sep >= 0 ? lines.slice(0, sep) : lines;
  const items = (sep >= 0 ? lines.slice(sep + 1) : [])
    .map(l => l.trim())
    .filter(l => l && !/^ingest:/i.test(l));
  emailLines.forEach(l => content.push(para(l.trim() ? l : ' ')));
  content.push({ type: 'rule' }, { type: 'rule' });
  content.push({ type: 'paragraph', content: [{ type: 'text', text: 'ingest:' }]
    .concat(items.flatMap(l => [{ type: 'hardBreak' }, { type: 'text', text: l }])) });
  // Proofs sit INSIDE the comment, right after the ingest list: a media
  // card per attachment (image renders inline, JSON renders a file card)
  // plus a plain link line as the universal readable reference.
  if (atts && atts.length) {
    if (withMedia) atts.forEach(a => content.push({
      type: 'mediaSingle', attrs: { layout: 'center' },
      content: [{ type: 'media',
        attrs: { type: 'file', id: String(a.id), collection: '' } }],
    }));
    content.push({ type: 'paragraph', content:
      [{ type: 'text', text: 'proof: ' }].concat(atts.flatMap((a, i) =>
        (i ? [{ type: 'text', text: ' + ' }] : []).concat({
          type: 'text', text: a.name,
          marks: [{ type: 'link', attrs: {
            href: JIRA_BASE + '/secure/attachment/' + a.id + '/' + encodeURIComponent(a.name) } }],
        }))) });
  }
  return { version: 1, type: 'doc', content };
}
async function jiraAttach(key, name, blob) {
  const fd = new FormData();
  fd.append('file', blob, name);
  const r = await fetch(JIRA_BASE + '/rest/api/3/issue/' + key + '/attachments', {
    method: 'POST',
    headers: { Authorization: jiraAuth(), 'X-Atlassian-Token': 'no-check' },
    body: fd,
  });
  if (!r.ok) throw new Error('attach ' + r.status + ': ' + (await r.text()).slice(0, 120));
  return r.json();
}

// Attach the collected proofs (records JSON + portal screenshot) then post
// the ADF comment. Proofs were gathered BEFORE this ran - posting never
// proceeds on an empty proof set (the handler gates on it).
async function postJiraComment(issue, wanted, st, proof) {
  const day = new Date().toISOString().slice(0, 10);
  // Attachments upload first so the comment can reference their ids
  // inline (media cards + links), not just pile them at the ticket top.
  const atts = [];
  if (proof.records.length) {
    st.textContent = 'Attaching records JSON to ' + issue.key + '…';
    const rn = 'ingest-records-' + day + '.json';
    const r = await jiraAttach(issue.key, rn, new Blob([JSON.stringify({
      realm: ingestRealm(), queried_at: new Date().toISOString(), records: proof.records,
    }, null, 2)], { type: 'application/json' }));
    if (r && r[0] && r[0].id) atts.push({ id: r[0].id, name: rn });
  }
  if (proof.shotBlob) {
    st.textContent = 'Attaching portal screenshot to ' + issue.key + '…';
    const sn = 'ingest-proof-' + day + '.png';
    const r = await jiraAttach(issue.key, sn, proof.shotBlob);
    if (r && r[0] && r[0].id) atts.push({ id: r[0].id, name: sn });
  }
  st.textContent = 'Posting comment on ' + issue.key + '…';
  try {
    await jiraFetch('/rest/api/3/issue/' + issue.key + '/comment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: jiraCommentAdf($('jiraPreview').value, atts, true) }),
    });
  } catch (e) {
    // Media nodes can reject on some Jira versions - retry with the
    // inline links only (still inside the comment, still clickable).
    await jiraFetch('/rest/api/3/issue/' + issue.key + '/comment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: jiraCommentAdf($('jiraPreview').value, atts, false) }),
    });
  }
  st.innerHTML = 'Posted to <a href="' + JIRA_BASE + '/browse/' + issue.key + '" target="_blank"><b>' + issue.key + '</b></a> - ' +
    [proof.records.length ? proof.records.length + ' record(s) JSON' : null,
     proof.shotBlob ? 'screenshot' : null].filter(Boolean).join(' + ') + ' attached' +
    (proof.records.length < wanted.length ? ' <span style="color:#ec9a9a">(verify: only ' + proof.records.length + '/' + wanted.length + ' found)</span>' : '');
  // Loop closed - the request stops surfacing as an unread candidate, and
  // the confirmed sender teaches future detection (addr now, domain at 3).
  if (emailFromAddr) noteConfirmedSender(emailFromAddr);
  if (emailGraphId) graphMarkRead(emailGraphId).then(() => {
    st.innerHTML += ' · request marked read';
  }).catch(e => dbg('mark-read fail', { err: String(e) }));
}

// Staged Jira run: "Verify & draft Jira" verifies, gathers proofs, finds
// the weekly ticket and prints the exact comment - nothing writes to Jira
// until "Post to Jira" approves the staged run.
let pendingJira = null, draftWithoutProof = false;
$('postJira').addEventListener('click', async () => {
  let epic = jiraEpicFor();
  if (!epic) {
    const v = askFor('a Jira epic for ' + (client ? client.name : 'this client'),
      'the weekly-ticket parent key, e.g. DD-726');
    if (!v) return toast('No Jira epic mapped for this client - tell Devin the epic key.');
    epic = v.toUpperCase();
    if (client) {
      epicOverrides[client.id] = epic;
      chrome.storage.local.set({ epicOverrides });
    }
  }
  ensureMatchRows();
  const wanted = ingestReportIds();
  if (!wanted.length && !emailEl.value.trim())
    return toast('Nothing to draft - no request email or IDs.');
  const st = $('jiraStatus');
  $('jiraApprove').classList.add('hidden');
  pendingJira = null;
  try {
    modStat('stJira', wanted.length ? 'Checking records…' : 'Drafting…', 0.15);
    const records = wanted.length ? await runVerify(wanted) : [];
    let shotUrl = null, shotErr = null;
    try {
      st.textContent = 'Capturing portal screenshot…';
      shotUrl = await capturePortalShot();
    } catch (e) { shotErr = e; dbg('screenshot failed', e.message); }

    const proof = { records, shotBlob: shotUrl ? await (await fetch(shotUrl)).blob() : null };
    if (!records.length && !proof.shotBlob && !draftWithoutProof && wanted.length) {
      draftWithoutProof = true;
      st.innerHTML = '<span style="color:#ec9a9a"><b>No proof captured</b> - 0 records found' +
        (shotErr ? ' and screenshot failed (' + esc(shotErr.message) + ')' : '') +
        '.</span> Click <b>Verify &amp; draft Jira</b> again to draft anyway.';
      return;
    }
    draftWithoutProof = false;

    // Keep the same artifacts locally - the job folder gets the proofs too.
    const job = jobSlug();
    if (records.length) {
      const blob = new Blob([JSON.stringify({ job, realm: ingestRealm(),
        queried_at: new Date().toISOString(), records }, null, 2)], { type: 'application/json' });
      const u = URL.createObjectURL(blob);
      chrome.downloads.download({ url: u, filename: 'Ingest/_previous jobs/' + job + '-ingest-records.json' });
      setTimeout(() => URL.revokeObjectURL(u), 30000);
    }
    if (shotUrl)
      chrome.downloads.download({ url: shotUrl, filename: 'Ingest/_previous jobs/' + job + '-ingest-screenshot.png' });

    st.textContent = 'Finding this week\'s ticket under ' + epic + '…';
    modStat('stJira', 'Finding this week\'s ticket…', 0.7);
    const { issue, newest } = await jiraWeeklyTicket(epic);
    let createName = null;
    if (!issue) {
      const epi = await jiraFetch('/rest/api/3/issue/' + epic + '?fields=summary');
      createName = weeklyTicketName(newest, epi.fields.summary);
    }
    pendingJira = { epic, wanted, proof, issue, createName };
    modStatDone('stJira', 'Staged - review the draft');
    $('jiraPreview').value = buildJiraTicket();
    $('jiraBox').classList.remove('hidden');
    $('jiraApprove').classList.remove('hidden');
    st.innerHTML = '<b>Staged - review the comment below.</b> Target: ' +
      (issue
        ? '<a href="' + JIRA_BASE + '/browse/' + issue.key + '" target="_blank"><b>' + issue.key + '</b></a>'
        : '<span style="color:#ec9a9a">will create weekly task "' + esc(createName) + '" under ' + esc(epic) + '</span>') +
      ' · attaching ' + [proof.records.length ? proof.records.length + ' record(s) JSON' : null,
        proof.shotBlob ? 'screenshot' : null].filter(Boolean).join(' + ') +
      (proof.records.length < wanted.length
        ? ' <span style="color:#ec9a9a">(verify: only ' + proof.records.length + '/' + wanted.length + ' found)</span>' : '') +
      (!wanted.length ? ' <span style="color:#ec9a9a">(no IDs cited - add lines under "Ingest:")</span>' : '');
  } catch (e) {
    st.textContent = 'Jira: ' + e.message;
  }
});

// Approval: the only path that writes to Jira. Consumes the staged run so a
// double-click can't post twice.
$('jiraApprove').addEventListener('click', async () => {
  const p = pendingJira;
  if (!p) return;
  if (!$('jiraPreview').value.trim()) return toast('Comment preview is empty - rebuild or re-draft first.');
  pendingJira = null;
  $('jiraApprove').classList.add('hidden');
  const st = $('jiraStatus');
  try {
    if (p.issue) return await postJiraComment(p.issue, p.wanted, st, p.proof);
    st.textContent = 'Creating weekly ticket…';
    const created = await jiraFetch('/rest/api/3/issue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        project: { key: p.epic.split('-')[0] },
        summary: p.createName,
        issuetype: { name: 'Task' },
        parent: { key: p.epic },
      } }),
    });
    await postJiraComment({ key: created.key }, p.wanted, st, p.proof);
  } catch (e) {
    st.textContent = 'Jira: ' + e.message;
  }
});

// Jira creds persist like the Graph setup values.
chrome.storage.local.get(['jiraEmail', 'jiraToken', 'atToken', 'atBase'], d => {
  if (d.jiraEmail) $('jiraEmail').value = d.jiraEmail;
  if (d.jiraToken) $('jiraToken').value = d.jiraToken;
  if (d.atToken) $('atToken').value = d.atToken;
  if (d.atBase) $('atBase').value = d.atBase;
});
$('jiraEmail').addEventListener('input', e => chrome.storage.local.set({ jiraEmail: e.target.value }));
$('jiraToken').addEventListener('input', e => chrome.storage.local.set({ jiraToken: e.target.value }));
$('atToken').addEventListener('input', e => chrome.storage.local.set({ atToken: e.target.value }));
$('atBase').addEventListener('input', e => chrome.storage.local.set({ atBase: e.target.value }));
